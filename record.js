#!/usr/bin/env node
/**
 * SunnyData — Recording mode
 *
 * Opens the Sunny Portal in a visible browser and records every user interaction
 * (clicks, form changes, downloads, navigation) to a timestamped JSON file inside
 * the recordings/ folder.
 *
 * Usage:
 *   node record.js [--config PATH] [--output FILENAME]
 *
 * ─── When to use this ─────────────────────────────────────────────────────────
 *  • The portal UI has changed and download.js no longer works.
 *    → Run a recording while you perform the download manually, then compare the
 *      "selector" fields in the JSON against the selectors listed in download.js
 *      and update any that have changed.
 *
 *  • You want to understand how the portal works before writing new automation.
 *    → Interact with the portal and study the recorded events.
 *
 *  • You want to verify which network endpoints are called during an export.
 *    → Look for "network_response" entries in the recording JSON.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Output: recordings/recording_YYYY-MM-DDTHH-MM-SS.json
 *
 * Each event in the file has the shape:
 *   { type, timestamp, selector?, tagName?, id?, text?, value?, url?, ... }
 *
 * Passwords are replaced with "***" in the recording.
 */

'use strict';

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\n` +
      `Copy sunnydata.conf.default to sunnydata.conf and fill in your details.`
    );
  }
  const content = fs.readFileSync(configPath, 'utf8');
  const config  = {};
  let section   = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      config[section] = {};
    } else if (section) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key   = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim();
        config[section][key] = value;
      }
    }
  }
  return config;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if      (argv[i] === '--config' && argv[i + 1]) args.config = argv[++i];
    else if (argv[i] === '--output' && argv[i + 1]) args.output = argv[++i];
  }
  return args;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args       = parseArgs(process.argv);
  const configPath = args.config || path.join(__dirname, 'sunnydata.conf');
  const config     = loadConfig(configPath);

  const portalUrl = config.portal?.url;
  if (!portalUrl) {
    console.error('Missing portal.url in config.');
    process.exit(1);
  }

  const recordingsDir = path.join(__dirname, 'recordings');
  if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputFile = args.output || path.join(recordingsDir, `recording_${timestamp}.json`);

  const recordedEvents = [];
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--ignore-certificate-errors'],
  });

  const page = await browser.newPage();

  // Expose a function so injected page scripts can push events into Node.js
  await page.exposeFunction('_recordEvent', event => {
    recordedEvents.push({ ...event, timestamp: Date.now() });
  });

  // Inject the event recorder into every document (runs before any page script)
  await page.evaluateOnNewDocument(() => {
    function buildSelector(el) {
      const parts = [];
      let node = el;
      while (node && node !== document.body) {
        let desc = node.tagName.toLowerCase();
        if (node.id) {
          desc += `#${node.id}`;
        } else if (node.className && typeof node.className === 'string') {
          const classes = node.className.trim().split(/\s+/).join('.');
          if (classes) desc += `.${classes}`;
        }
        parts.unshift(desc);
        node = node.parentElement;
      }
      return parts.join(' > ');
    }

    // Clicks
    document.addEventListener('click', e => {
      window._recordEvent({
        type: 'click',
        selector: buildSelector(e.target),
        tagName: e.target.tagName,
        id: e.target.id || null,
        className: e.target.className || null,
        text: (e.target.innerText || '').slice(0, 120),
        x: e.clientX,
        y: e.clientY,
      });

      // Extra event for download links
      const anchor = e.target.closest('a[download], a[href^="blob:"]');
      if (anchor) {
        window._recordEvent({
          type: 'download_click',
          selector: buildSelector(anchor),
          href: anchor.href,
          download: anchor.getAttribute('download'),
        });
      }
    }, true);

    // Input / select changes
    document.addEventListener('change', e => {
      window._recordEvent({
        type: 'change',
        selector: buildSelector(e.target),
        tagName: e.target.tagName,
        id: e.target.id || null,
        // Redact password fields
        value: e.target.type === 'password' ? '***' : e.target.value,
      });
    }, true);

    // Form submissions
    document.addEventListener('submit', e => {
      window._recordEvent({
        type: 'form_submit',
        selector: buildSelector(e.target),
        action: e.target.action || null,
      });
    }, true);

    // Page navigations
    window.addEventListener('beforeunload', () => {
      window._recordEvent({ type: 'navigation', url: window.location.href });
    });
  });

  // Capture network responses that look like data / export endpoints
  page.on('response', response => {
    const url = response.url();
    if (
      url.includes('export') ||
      url.includes('download') ||
      url.includes('csv') ||
      url.includes('/data')
    ) {
      recordedEvents.push({
        type: 'network_response',
        url,
        status: response.status(),
        timestamp: Date.now(),
      });
    }
  });

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║         SunnyData — Recording mode       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\nPortal  : ${portalUrl}`);
  console.log(`Output  : ${outputFile}`);
  console.log('\nInteract with the portal normally.');
  console.log('Close the browser window when you are done.\n');

  await page.goto(portalUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // Write the recording when the browser is closed
  browser.on('disconnected', () => {
    fs.writeFileSync(outputFile, JSON.stringify(recordedEvents, null, 2));
    console.log(`\nRecording saved: ${outputFile}  (${recordedEvents.length} events)`);
    console.log('\nNext steps:');
    console.log('  1. Open the JSON file and look for "click" and "change" events near any');
    console.log('     download action you performed.');
    console.log('  2. Compare the "selector" values against those listed at the top of');
    console.log('     download.js and update any that have changed.');
  });
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
