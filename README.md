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

Run headlessly (no visible browser window):

```bash
node download.js --headless
```

Files are saved to `data/sunnyportal_YYYY-MM-DD.csv`.  
Days that already exist in `data/` are skipped automatically.

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

`download.js` targets the **ennexOS-based local Sunny Portal** — typically  
accessible at a link-local address such as `169.254.12.3` or `192.168.x.x`.

| CSS selector | Purpose |
|---|---|
| `input#mat-input-0` | Username field |
| `input#mat-input-1` | Password field |
| `ennexos-button#login button.action-primary-base` | Login button |
| `input#mat-input-2` | Date picker |
| `#mat-expansion-panel-header-1` | "Details" expansion panel |
| `sma-async-export-button button.action-secondary-base` | Export button |
| `mat-dialog-container button.action-primary-base` | Confirm export dialog |

If any of these change after a firmware update, use **recording mode** to  
rediscover them.

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
