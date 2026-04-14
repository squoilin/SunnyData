#!/usr/bin/env node
/**
 * SunnyData — Automated CSV downloader for SMA Sunny Portal
 *
 * Logs in to the cloud portal (ennexos.sunnyportal.com), iterates over a date
 * range, and downloads one CSV export per day into the data/ folder.
 * Files are named  sunnyportal_YYYY-MM-DD.csv.
 * Days that have already been downloaded are skipped automatically.
 *
 * Usage:
 *   node download.js [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--config PATH] [--headless]
 *
 * Defaults are read from sunnydata.conf (see sunnydata.conf.default).
 *
 * For the older LOCAL ennexOS device UI (recording PVmanon_250716.json) use:
 *   node download_local_ennexos_250716.js
 *
 * ─── CSS selectors (ennexos.sunnyportal.com, recording 2026-04-14) ───────────
 *  If the portal is updated and downloads break, use record.js to capture a
 *  fresh recording and compare the selectors below against the recording output.
 *
 *  | Selector                                             | Purpose            |
 *  |------------------------------------------------------|--------------------|
 *  | ennexos-button#login button.action-primary-base      | Landing "Login"    |
 *  | input#username                                       | Keycloak username  |
 *  | input#password                                       | Keycloak password  |
 *  | button.btn-primary                                   | Keycloak submit    |
 *  | ennexos-dialog-actions ennexos-button.ennexos-button-primary button | Post-login banner |
 *  | input#mat-input-0                                    | Date picker        |
 *  | #mat-expansion-panel-header-2                        | "Details" panel    |
 *  | sma-async-export-button button.action-secondary-base | Export button      |
 *  | mat-dialog-container button.action-primary-base      | Confirm export     |
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
    else if (argv[i] === '--dates'    && argv[i + 1]) args.dates    = argv[++i].split(',');
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

  // Step 1 — Landing page "Login" button (ennexos.sunnyportal.com start page)
  const landingBtn = await page.$('ennexos-button#login button.action-primary-base');
  if (landingBtn) {
    console.log('Landing page detected — clicking Login...');
    await landingBtn.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1500);
  }

  // Step 2 — Keycloak login form (login.sma.energy)
  if (
    page.url().includes('login.sma.energy') ||
    (await page.$('input#username')) !== null
  ) {
    console.log('Keycloak login page detected — entering credentials...');
    await page.waitForSelector('input#username', { timeout: 15000 });
    await page.type('input#username', username, { delay: 50 });
    await page.type('input#password', password, { delay: 50 });
    await page.click('button.btn-primary');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    console.log('Login successful.');
    await sleep(1500);
  }

  // Step 3 — Dismiss post-login banner / welcome dialog (if any)
  try {
    const closeBtn = await page.waitForSelector(
      'ennexos-dialog-actions ennexos-button.ennexos-button-primary button.action-primary-base',
      { timeout: 5000 }
    );
    if (closeBtn) {
      console.log('Dismissing post-login banner dialog...');
      await closeBtn.click();
      await sleep(1000);
    }
  } catch (_) { /* no dialog — that's fine */ }
}

async function selectDay(page, date) {
  const dateStr = toPickerStr(date);
  // Cloud portal: date picker is input#mat-input-0 (was input#mat-input-2 on local device)
  await page.waitForSelector('input#mat-input-0', { timeout: 30000 });
  await page.click('input#mat-input-0', { clickCount: 3 });
  await page.type('input#mat-input-0', dateStr, { delay: 30 });
  
  // Pressing TAB to move focus instead of ENTER, as it's more common in MUI for 'blur' event
  await page.keyboard.press('Tab');
  await sleep(1000);

  // Fallback: If still today, try clicking the actual date picker icon or a random place
  await page.evaluate(() => {
    const input = document.querySelector('input#mat-input-0');
    if (input) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    }
  });

  // Wait for the "Loading" overlay if it appears
  try {
    await page.waitForSelector('sma-loading-spinner-overlay', { visible: true, timeout: 2000 });
    await page.waitForSelector('sma-loading-spinner-overlay', { hidden: true, timeout: 20000 });
  } catch (e) {
    // If spinner didn't appear, just wait for network
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
  }
  await sleep(2000);
}

async function expandDetailsPanel(page) {
  // Find the "Details" expansion panel by text content — the generated ID
  // (mat-expansion-panel-header-N) is dynamic and changes across portal versions.
  await page.waitForFunction(
    () => [...document.querySelectorAll('mat-expansion-panel-header')]
      .some(el => /details/i.test(el.textContent)),
    { timeout: 20000 }
  );

  const isExpanded = await page.evaluate(() => {
    const header = [...document.querySelectorAll('mat-expansion-panel-header')]
      .find(el => /details/i.test(el.textContent));
    return header ? header.getAttribute('aria-expanded') === 'true' : false;
  });

  if (!isExpanded) {
    await page.evaluate(() => {
      const header = [...document.querySelectorAll('mat-expansion-panel-header')]
        .find(el => /details/i.test(el.textContent));
      if (header) header.click();
    });
    await sleep(2000);
  }
}

async function triggerExport(page) {
  await page.waitForSelector(
    'sma-async-export-button button.action-secondary-base',
    { timeout: 30000 }
  );
  // Ensure the button is visible and stable before clicking
  await page.evaluate(() => {
    const btn = document.querySelector('sma-async-export-button button.action-secondary-base');
    if (btn) btn.scrollIntoView();
  });
  await sleep(1000);
  await page.click('sma-async-export-button button.action-secondary-base');
  
  // Wait for the Download Format dialog
  await page.waitForSelector('mat-dialog-container', { timeout: 15000 });
  
  // Find the "CSV" option if multiple are present, or just the primary button
  // In ennexOS, the primary button is "Download"
  const downloadBtnSelector = 'mat-dialog-container button.action-primary-base';
  await page.waitForSelector(downloadBtnSelector, { timeout: 10000 });
  
  // Click the final download button in the dialog
  await page.click(downloadBtnSelector);
}

async function waitForNewFile(dataDir, before, date) {
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
  // Set download directory BEFORE triggering the export to avoid race conditions.
  // page.createCDPSession() is the current Puppeteer v20+ API.
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: dataDir,
  });

  await selectDay(page, date);
  await expandDetailsPanel(page);

  const before = new Set(fs.readdirSync(dataDir));
  await triggerExport(page);
  return waitForNewFile(dataDir, before, date);
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

  let datesToDownload = [];
  if (args.dates) {
    datesToDownload = args.dates.map(d => new Date(d.trim()));
  } else {
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

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      // Ensure we create a new Date object at midnight local time to avoid 
      // DST/timezone shifts when iterating
      const current = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      datesToDownload.push(current);
    }
  }

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  console.log(`Portal   : ${portalUrl}`);
  if (args.dates) {
    console.log(`Dates    : ${args.dates.join(', ')}`);
  } else {
    console.log(`Range    : ${toISO(datesToDownload[0])} → ${toISO(datesToDownload[datesToDownload.length - 1])}`);
  }
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
    await page.waitForSelector('input#mat-input-0',    { timeout: 60000 });

    // Warm-up: Select the first date twice and wait for the chart title to update
    // from the initial "today" view to the requested date. This ensures the portal
    // has correctly refreshed its internal state before we trigger the export.
    if (datesToDownload.length > 0) {
      console.log('Performing warm-up date selection...');
      // First, select a "buffer" date that is NOT the first date we want,
      // and NOT today, to ensure the UI has to switch.
      const bufferDate = new Date(2023, 0, 1); 
      await selectDay(page, bufferDate);
      await sleep(2000);
      
      // Now select the actual first date
      await selectDay(page, datesToDownload[0]);
      await page.waitForFunction((isoDate) => {
        const title = document.querySelector('sma-advanced-chart div.sma-tab-content-header-title');
        const [y, m, d] = isoDate.split('-');
        // Title usually contains Month Year or Day Month Year format
        return title && (title.textContent.includes(y) || title.textContent.includes(m));
      }, { timeout: 15000 }, toISO(datesToDownload[0])).catch(() => {});
      await sleep(3000);
    }

    let downloaded = 0;
    let skipped    = 0;
    let failed     = 0;

    for (const day of datesToDownload) {
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
