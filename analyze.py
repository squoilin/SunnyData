#!/usr/bin/env python3
import pandas as pd
import glob
import os
import argparse
import configparser

try:
    import plotly.graph_objects as go
    HAS_PLOTLY = True
except ImportError:
    HAS_PLOTLY = False

# --- Config & Setup ---

def load_config(config_path='sunnydata.conf'):
    cfg = configparser.ConfigParser()
    if os.path.exists(config_path):
        cfg.read(config_path)
    elif os.path.exists('sunnydata.conf.default'):
        cfg.read('sunnydata.conf.default')
    return cfg

def detect_unit(filepath):
    """Detect W or kW from file header (first 25 lines)."""
    with open(filepath, encoding='utf-8', errors='replace') as f:
        for i, line in enumerate(f):
            if i > 25: break
            if 'Power [W]' in line or 'Puissance [W]' in line: return 'W'
            if 'Power [kW]' in line or 'Puissance [kW]' in line: return 'kW'
    return 'kW'

def read_pv_csv(filepath):
    unit = detect_unit(filepath)
    # The SMA CSV has a preamble. Skip 13 lines to reach the header.
    df = pd.read_csv(filepath, sep=';', skiprows=13, names=['time', 'value'], usecols=[0, 1], encoding='utf-8')
    df = df.dropna(subset=['time', 'value'])
    
    # Process numeric value
    # Handle both thousand separators (comma or space) and decimal dots/commas
    # Case: "2,580" with unit W or kW. We need to handle this correctly.
    def parse_sunny_value(val_str):
        val_str = str(val_str).strip()
        if not val_str or val_str.lower() == 'nan':
            return None
        
        # Remove any spaces
        val_str = val_str.replace(' ', '')
        
        # Detect format: "2,580" or "2.580". 
        # If there's a comma and NO dot, or the comma is at index -4 (e.g., 2,580 or 12,000)
        # It's a thousand separator common in English SunnyPortal exports.
        # If there's a comma and a dot, comma is usually the thousand separator.
        
        # We assume SMA standard: comma as thousand separator (e.g. 1,068) for English locale.
        # But if the value is e.g. 2,1 it's likely decimal. 
        # If we see 3 decimals after a comma like ",580", it's almost certainly a thousand separator.
        
        if ',' in val_str:
            # If comma at index -4, it's a thousand separator (e.g. 1,234)
            if len(val_str) - val_str.rfind(',') == 4:
                val_str = val_str.replace(',', '')
            else:
                # Fallback: assume it's decimal if not 3 digits following
                val_str = val_str.replace(',', '.')
        
        try:
            return float(val_str)
        except:
            return None

    df['value'] = df['value'].apply(parse_sunny_value)
    df = df.dropna(subset=['value'])
    
    if unit == 'W':
        df['value'] = df['value'] / 1000.0
        
    date_str = os.path.basename(filepath).split('_')[1].split('.')[0]
    df['time_fixed'] = df['time'].str.replace('.', ':', regex=False)
    # Be explicit about the format for stability
    df['datetime'] = pd.to_datetime(date_str + ' ' + df['time_fixed'], errors='coerce')
    df = df.dropna(subset=['datetime'])
    
    return df.set_index('datetime')[['value']].rename(columns={'value': 'pv_kw'})

def main():
    parser = argparse.ArgumentParser(description='Simplify SunnyPortal data analysis.')
    parser.add_argument('--data-dir', default=None)
    parser.add_argument('--output-dir', default='output')
    args = parser.parse_args()

    config = load_config()
    data_dir = args.data_dir or config.get('download', 'data_dir', fallback='data')
    output_dir = args.output_dir
    os.makedirs(output_dir, exist_ok=True)

    files = sorted(glob.glob(os.path.join(data_dir, 'sunnyportal_*.csv')))
    if not files:
        print(f"No files found in {data_dir}")
        return

    print(f"Processing {len(files)} files...")
    all_chunks = []
    for f in files:
        if os.path.getsize(f) < 500: continue
        try:
            chunk = read_pv_csv(f)
            if not chunk.empty:
                all_chunks.append(chunk)
        except:
            pass

    if not all_chunks:
        print("No data parsed.")
        return

    df_raw = pd.concat(all_chunks).sort_index()
    df_raw = df_raw[~df_raw.index.duplicated(keep='first')]
    raw_path = os.path.join(output_dir, 'pv_original.csv')
    df_raw.to_csv(raw_path)
    print(f"Saved original data to {raw_path} ({len(df_raw)} rows)")

    start, end = df_raw.index.min(), df_raw.index.max()
    idx_5m = pd.date_range(start=start, end=end, freq='5min')
    df_5m = df_raw.reindex(df_raw.index.union(idx_5m)).interpolate(method='time').reindex(idx_5m)
    path_5m = os.path.join(output_dir, 'pv_5min.csv')
    df_5m.to_csv(path_5m)
    print(f"Saved 5-min interpolated data to {path_5m}")

    df_15m = df_raw.resample('15min').mean()
    path_15m = os.path.join(output_dir, 'pv_15min.csv')
    df_15m.to_csv(path_15m)
    print(f"Saved 15-min averaged data to {path_15m}")

    if HAS_PLOTLY:
        try:
            fig = go.Figure()
            fig.add_trace(go.Scatter(x=df_15m.index, y=df_15m['pv_kw'], name='PV (15min avg)', fill='tozeroy', line=dict(color='seagreen')))
            fig.update_layout(title='PV Generation (15-min Average)', xaxis_title='Time', yaxis_title='Power (kW)')
            plot_path = os.path.join(output_dir, 'pv_plot.html')
            fig.write_html(plot_path)
            print(f"Saved plot to {plot_path}")
        except Exception as e:
            print(f"Plotting failed: {e}")

    # Final Verification based on user input
    print("\n--- User Input Verification (12/8/2024 -> August 12, 2024) ---")
    ts = pd.Timestamp('2024-08-12 12:00:00')
    if ts in df_raw.index:
        val = df_raw.loc[ts, 'pv_kw']
        print(f"Timestamp: {ts}")
        print(f"  Processed value: {val:.3f} kW")
        print(f"  Target value: 2.580 kW")
        print(f"  Match: {abs(val - 2.580) < 1e-5}")
    else:
        print(f"Timestamp {ts} not found in output!")

if __name__ == "__main__":
    main()
