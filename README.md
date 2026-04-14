# SunnyData

A Node.js + Python toolkit for **automated data collection and analysis from SMA Sunny Portal** — both local (direct on-device) and the cloud web interface.

## Features

| Feature | Script | Language |
|---|---|---|
| Automated daily CSV download | `download.js` | Node.js / Puppeteer |
| Recording mode for debugging | `record.js` | Node.js / Puppeteer |
| PV data analysis & visualisation | `analyze.py` | Python |

- Credentials and portal URL live in a local config file that is **never committed**.
- Already-downloaded days are skipped automatically.
- Self-consumption and self-sufficiency rates computed when a consumption file is provided.
- Interactive HTML charts via [Plotly](https://plotly.com/python/).

---

## Requirements

### Downloader & recorder

- [Node.js](https://nodejs.org/) ≥ 16
- npm (bundled with Node.js)

### Analyser

- Python ≥ 3.9
- `pip install pandas numpy plotly`

---

## Installation

```bash
git clone git@github.com:squoilin/SunnyData.git
cd SunnyData
npm install
```

---

## Configuration

Copy the default config and fill in your details:

```bash
cp sunnydata.conf.default sunnydata.conf
```

Edit `sunnydata.conf`:

```ini
[portal]
# URL of your monitoring page — local device or cloud portal
url = https://192.168.1.100/webui/Plant:1/monitoring/view-energy-and-power

[credentials]
username = your_username
password = your_password

[download]
start_date = 2024-01-01   # default start; override with --start on the CLI
end_date =                 # leave blank to use today

[analysis]
peak_power_kw = 10         # used for sanity checks
```

`sunnydata.conf` is listed in `.gitignore` and will never be committed.

---

## Usage

### Download daily CSV files

```bash
node download.js
```

Override the date range on the command line:

```bash
node download.js --start 2024-06-01 --end 2024-06-30
```

Download a specific list of dates (useful for filling gaps):

```bash
node download.js --dates 2024-09-09,2024-09-12,2025-01-02
```

Run headlessly (no visible browser window):

```bash
node download.js --headless
```

Files are saved to `data/sunnyportal_YYYY-MM-DD.csv`.  
Days that already exist in `data/` are skipped automatically.

---

### Find missing data

To automatically identify gaps in your `data/` folder and generate the command to download them:

```bash
python3 find_missing.py
```

It will scan the date range between your first and last file and output the exact `node download.js --dates ...` command needed.

---

### Analyse data

```bash
python analyze.py
```

With a household consumption file (e.g. an Enedis export):

```bash
python analyze.py --consumption my_consumption_data.csv
```

All options:

```
--data-dir   DIR    Directory with CSV files  (default: data/)
--consumption FILE  Optional consumption CSV
--output-dir DIR    Where to write outputs    (default: output/)
--config FILE       Config file path
```

Outputs are written to `output/`:

| File | Description |
|---|---|
| `analysis.csv` | Combined time series |
| `pv_generation.html` | Interactive chart (PV only) |
| `pv_consumption.html` | Interactive chart (PV + consumption, when provided) |

Printed statistics include total PV generation, consumption, and — when a  
consumption file is provided — self-consumption rate and self-sufficiency rate.

---

### Recording mode

Use recording mode when:

- The portal UI has changed and `download.js` no longer works.
- You want to understand which CSS selectors the portal uses.
- You want to inspect which network endpoints are called during an export.

```bash
node record.js
```

A browser window opens on the portal URL.  Interact with it manually  
(e.g. navigate to a date and trigger the CSV export).  Close the browser  
when finished.

The recording is saved to `recordings/recording_<timestamp>.json`.  
Each entry has the shape:

```json
{ "type": "click", "selector": "sma-async-export-button > button.action-secondary-base", "timestamp": 1718000000000 }
```

**Updating download.js after a portal change:**

1. Run `node record.js` and perform the download steps manually.  
2. Open the resulting JSON file.  
3. Find the `click` events that correspond to the export action.  
4. Compare the `selector` values against the selector table at the top of  
   `download.js` and update any that have changed.

---

## Data folder

Downloaded files are stored in `data/` as `sunnyportal_YYYY-MM-DD.csv`.  
The folder is tracked by git (via `data/.gitkeep`) but all CSV files are  
git-ignored.

---

## Compatibility

`download.js` targets the **SMA cloud portal** (`ennexos.sunnyportal.com`), updated for the UI as of the April 2026 recording.

| CSS selector | Purpose |
|---|---|
| `ennexos-button#login button.action-primary-base` | Landing page "Login" button |
| `input#username` | Keycloak username field |
| `input#password` | Keycloak password field |
| `button.btn-primary` | Keycloak "Log in" submit button |
| `ennexos-dialog-actions ennexos-button.ennexos-button-primary button` | Post-login banner "Close" |
| `input#mat-input-0` | Date picker |
| `#mat-expansion-panel-header-2` | "Details" expansion panel |
| `sma-async-export-button button.action-secondary-base` | Export button |
| `mat-dialog-container button.action-primary-base` | Confirm export dialog |

If any of these change after a portal update, use **recording mode** to rediscover them.

### Legacy: local ennexOS device (recording `PVmanon_250716.json`)

The original version targeting the local device (e.g. `https://169.254.12.3/...`) is preserved as
`download_local_ennexos_250716.js`.  Its selectors differ as follows:

| What | Local device (250716) | Cloud portal (2026-04-14) |
|---|---|---|
| Login | local form `input#mat-input-0/1` + `ennexos-button#login` | landing → Keycloak `input#username/password` + `button.btn-primary` |
| Post-login dialog | none | banner "Close" button |
| Date picker | `input#mat-input-2` | `input#mat-input-0` |
| Details panel | `#mat-expansion-panel-header-1` | `#mat-expansion-panel-header-2` |

---

## Consumption CSV format

The `--consumption` flag accepts any CSV file that has:

- A date/time column whose header contains `date`, `time`, or `heure`.
- An energy column whose header contains `kwh` or `consommation`.
- Separator: comma or semicolon.
- Dates in European format (DD/MM/YYYY).

Enedis hourly-export files (`.csv`, comma-separated) are supported  
out of the box.

---

## Licence

MIT — see [LICENSE](LICENSE).
