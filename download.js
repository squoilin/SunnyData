#!/usr/bin/env node
/**
 * SunnyData — Automated CSV downloader for SMA Sunny Portal
 *
 * Logs in to the portal (local device or cloud), iterates over a date range,
 * and downloads one CSV export per day into the data/ folder.
 * Files are named  sunnyportal_YYYY-MM-DD.csv.
 * Days that have already been downloaded are skipped automatically.
 *
 * Usage:
 *   node download.js [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--config PATH] [--headless]
 *
 * Defaults are read from sunnydata.conf (see sunnydata.conf.default).
 *
 * ─── CSS selectors ────────────────────────────────────────────────────────────
 *  These selectors target the ennexOS-based local Sunny Portal UI.
 *  If the portal is updated and downloads break, use record.js to capture a
 *  fresh recording and compare the selectors below against the recording output.
 *
 *  | Selector                                      | Purpose              |
 *  |-----------------------------------------------|----------------------|
 *  | input#mat-input-0                             | Username field       |
 *  | input#mat-input-1                             | Password field       |
 *  | ennexos-button#login button.action-primary-base| Login button        |
 *  | input#mat-input-2                             | Date picker          |
 *  | #mat-expansion-panel-header-1                 | "Details" panel      |
 *  | sma-async-export-button button.action-secondary-base | Export button |
 *  | mat-dialog-container button.action-primary-base | Confirm export     |
 * ─────────────────────────────────────────────────────────────────────────────
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

// ─── CLI arguments ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if      (argv[i] === '--start'    && argv[i + 1]) args.start    = argv[++i];
    else if (argv[i] === '--end'      && argv[i + 1]) args.end      = argv[++i];
    else if (argv[i] === '--config'   && argv[i + 1]) args.config   = argv[++i];
    else if (argv[i] === '--headless')                args.headless = true;
  }
  return args;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function toISO(date)        { return date.toISOString().slice(0, 10); }
function toPickerStr(date)  {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${date.getFullYear()}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Portal automation ────────────────────────────────────────────────────────

async function loginIfNeeded(page, username, password) {
  await sleep(2000);
  const onLoginPage =
    page.url().includes('login') ||
    (await page.$('input#mat-input-0')) !== null;

  if (!onLoginPage) {
    console.log('Already logged in or no login required.');
    return;
  }

  console.log('Login page detected — entering credentials...');
  await page.waitForSelector('input#mat-input-0', { timeout: 15000 });
  await page.type('input#mat-input-0', username, { delay: 50 });
  await page.type('input#mat-input-1', password, { delay: 50 });
  await page.click('ennexos-button#login button.action-primary-base');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
  console.log('Login successful.');
}

async function selectDay(page, date) {
  const dateStr = toPickerStr(date);
  await page.waitForSelector('input#mat-input-2', { timeout: 30000 });
  await page.click('input#mat-input-2', { clickCount: 3 });
  await page.type('input#mat-input-2', dateStr, { delay: 30 });
  await page.evaluate(() => {
    document.querySelector('input#mat-input-2').dispatchEvent(new Event('blur'));
  });
  await sleep(1500);
}

async function expandDetailsPanel(page) {
  await page.waitForSelector('#mat-expansion-panel-header-1', { timeout: 20000 });
  const expanded = await page.$eval(
    '#mat-expansion-panel-header-1',
    el => el.getAttribute('aria-expanded') === 'true'
  );
  if (!expanded) {
    await page.click('#mat-expansion-panel-header-1');
    await sleep(1000);
  }
}

async function triggerExport(page) {
  await page.waitForSelector(
    'sma-async-export-button button.action-secondary-base',
    { timeout: 30000 }
  );
  await page.click('sma-async-export-button button.action-secondary-base');
  await page.waitForSelector('mat-dialog-container', { timeout: 10000 });
  await page.waitForSelector(
    'mat-dialog-container button.action-primary-base',
    { timeout: 10000 }
  );
  await page.click('mat-dialog-container button.action-primary-base');
}

async function waitForDownload(page, dataDir, date) {
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: dataDir,
  });

  const before = new Set(fs.readdirSync(dataDir));
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const diff = fs
      .readdirSync(dataDir)
      .filter(f => !before.has(f) && !f.endsWith('.crdownload'));
    if (diff.length > 0) {
      const newName = `sunnyportal_${toISO(date)}.csv`;
      fs.renameSync(path.join(dataDir, diff[0]), path.join(dataDir, newName));
      return newName;
    }
  }
  throw new Error(`Download timed out for ${toISO(date)}`);
}

async function downloadDay(page, dataDir, date) {
  await selectDay(page, date);
  await expandDetailsPanel(page);
  await triggerExport(page);
  return waitForDownload(page, dataDir, date);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args       = parseArgs(process.argv);
  const configPath = args.config || path.join(__dirname, 'sunnydata.conf');
  const config     = loadConfig(configPath);

  const portalUrl = config.portal?.url;
  const username  = config.credentials?.username;
  const password  = config.credentials?.password;
  const dataDir   = path.resolve(__dirname, config.download?.data_dir || 'data');

  if (!portalUrl || !username || !password) {
    console.error(
      'Missing required config values: portal.url, credentials.username, credentials.password'
    );
    process.exit(1);
  }

  const today     = new Date().toISOString().slice(0, 10);
  const startDate = new Date(args.start || config.download?.start_date || today);
  const endDate   = new Date(args.end   || config.download?.end_date   || today);

  if (isNaN(startDate) || isNaN(endDate)) {
    console.error('Invalid date. Use YYYY-MM-DD format.');
    process.exit(1);
  }
  if (startDate > endDate) {
    console.error('--start must be before --end.');
    process.exit(1);
  }

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  console.log(`Portal   : ${portalUrl}`);
  console.log(`Range    : ${toISO(startDate)} → ${toISO(endDate)}`);
  console.log(`Data dir : ${dataDir}\n`);

  const browser = await puppeteer.launch({
    headless: args.headless || false,
    defaultViewport: { width: 1400, height: 900 },
    args: ['--ignore-certificate-errors'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(portalUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await loginIfNeeded(page, username, password);

    console.log('Waiting for chart and date picker to load...');
    await page.waitForSelector('sma-advanced-chart',   { timeout: 60000 });
    await page.waitForSelector('input#mat-input-2',    { timeout: 60000 });

    let downloaded = 0;
    let skipped    = 0;
    let failed     = 0;

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const day      = new Date(d);
      const isoDate  = toISO(day);
      const destFile = path.join(dataDir, `sunnyportal_${isoDate}.csv`);

      if (fs.existsSync(destFile)) {
        process.stdout.write(`  [skip]  ${isoDate}\n`);
        skipped++;
        continue;
      }

      process.stdout.write(`  [fetch] ${isoDate} ... `);
      try {
        const filename = await downloadDay(page, dataDir, day);
        process.stdout.write(`saved as ${filename}\n`);
        downloaded++;
      } catch (err) {
        process.stdout.write(`FAILED: ${err.message}\n`);
        failed++;
      }
      await sleep(800);
    }

    console.log(`\nDone.  Downloaded: ${downloaded}  Skipped: ${skipped}  Failed: ${failed}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
