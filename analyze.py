#!/usr/bin/env python3
"""
SunnyData — Analysis and visualisation script
=============================================

Reads the daily CSV exports produced by download.js, assembles a continuous
time series, and optionally combines it with a household consumption file to
compute self-consumption and self-sufficiency rates.

Usage
-----
    python analyze.py [options]

Options
-------
    --data-dir   DIR     Directory containing sunnyportal_YYYY-MM-DD.csv files.
                         Defaults to the value in sunnydata.conf, or ./data.
    --consumption FILE   Optional consumption CSV (e.g. an Enedis export).
                         When provided, real consumption and self-consumption
                         metrics are computed.
    --output-dir DIR     Where to write analysis.csv and the HTML plot.
                         Defaults to ./output.
    --config FILE        Path to the config file.
                         Defaults to sunnydata.conf (or sunnydata.conf.default).

Dependencies
------------
    pip install pandas numpy plotly

CSV format expected by --consumption
-------------------------------------
The script attempts to auto-detect the format.  It looks for:
  • A date/time column containing "date", "time", or "heure" (case-insensitive).
  • A consumption column containing "kwh" or "consommation" (case-insensitive).
Supported separators: comma or semicolon.
The date column is parsed with dayfirst=True (European format DD/MM/YYYY).
"""

import argparse
import configparser
import glob
import os
import sys

import numpy as np
import pandas as pd
import plotly.graph_objects as go

# ─── Config ───────────────────────────────────────────────────────────────────

_DEFAULT_CONFIG_CANDIDATES = ['sunnydata.conf', 'sunnydata.conf.default']


def load_config(config_path=None):
    cfg = configparser.ConfigParser()
    if config_path:
        cfg.read(config_path)
    else:
        for candidate in _DEFAULT_CONFIG_CANDIDATES:
            if os.path.exists(candidate):
                cfg.read(candidate)
                break
    return cfg


# ─── Reading SMA CSV exports ──────────────────────────────────────────────────

def _detect_unit(filepath):
    """Return 'W' or 'kW' by scanning the file header (first 25 lines)."""
    with open(filepath, encoding='utf-8', errors='replace') as fh:
        for i, line in enumerate(fh):
            if i > 24:
                break
            if 'Puissance [W]' in line or 'Power [W]' in line:
                return 'W'
            if 'Puissance [kW]' in line or 'Power [kW]' in line:
                return 'kW'
    return None


def read_pv_csv(filepath):
    """Read a single SMA Sunny Portal daily CSV export.

    Parameters
    ----------
    filepath : str
        Path to a file named ``sunnyportal_YYYY-MM-DD.csv``.

    Returns
    -------
    pd.DataFrame
        DatetimeIndex, single column ``pv_kw``.
    """
    unit = _detect_unit(filepath)
    if unit is None:
        print(f"  Warning: cannot detect unit in {os.path.basename(filepath)}, assuming kW.")
        unit = 'kW'

    # The SMA CSV has a variable-length preamble followed by a header row
    # ("Période";"Puissance [kW]") and then the time-series data.
    # skiprows=13 skips the preamble + header, names provides column labels.
    df = pd.read_csv(
        filepath,
        sep=';',
        skiprows=13,
        names=['time', 'value'],
        usecols=[0, 1],
        encoding='utf-8',
        errors='replace',
    )
    df = df.dropna(subset=['time', 'value'])
    df['value'] = (
        df['value'].astype(str)
        .str.replace(r'\s+', '', regex=True)
        .str.replace(',', '.')
        .pipe(pd.to_numeric, errors='coerce')
    )
    df = df.dropna(subset=['value'])

    if unit == 'W':
        df['value'] = df['value'] / 1000.0

    # Parse the date from the filename: sunnyportal_YYYY-MM-DD.csv
    basename = os.path.basename(filepath)
    date_str = basename.replace('.csv', '').split('_')[1]  # YYYY-MM-DD

    df['datetime'] = pd.to_datetime(
        date_str + ' ' + df['time'],
        format='%Y-%m-%d %H:%M',
        errors='coerce',
    )
    df = df.dropna(subset=['datetime'])
    df = df.set_index('datetime')[['value']].rename(columns={'value': 'pv_kw'})
    return df


def assemble_pv_data(data_dir, target_index=None):
    """Load all daily CSV files and concatenate into one time series.

    Parameters
    ----------
    data_dir : str
        Directory containing ``sunnyportal_YYYY-MM-DD.csv`` files.
    target_index : pd.DatetimeIndex, optional
        When provided the PV series is interpolated onto this index.

    Returns
    -------
    pd.DataFrame  –  columns: ``pv_kw``
    """
    files = sorted(glob.glob(os.path.join(data_dir, 'sunnyportal_*.csv')))
    if not files:
        print(f"  No sunnyportal_*.csv files found in '{data_dir}'.")
        return pd.DataFrame(columns=['pv_kw'])

    parts = []
    for f in files:
        try:
            parts.append(read_pv_csv(f))
        except Exception as exc:
            print(f"  Warning: skipping {os.path.basename(f)}: {exc}")

    if not parts:
        return pd.DataFrame(columns=['pv_kw'])

    pv = pd.concat(parts).sort_index()
    pv = pv[~pv.index.duplicated(keep='first')]

    if target_index is not None:
        combined = target_index.union(pv.index)
        pv = pv.reindex(combined).interpolate('time').reindex(target_index)
        pv = pv.fillna(0.0)

    return pv


# ─── Reading consumption CSV ──────────────────────────────────────────────────

def read_consumption(filepath):
    """Read a household consumption CSV and return a DataFrame with ``consumption_kw``.

    The function tries to auto-detect:
      - separator (, or ;)
      - date/time column
      - energy column (kWh)
    Time intervals are inferred from the data and used to convert kWh → kW.

    Returns
    -------
    pd.DataFrame  –  DatetimeIndex, columns: ``consumption_kw``
    """
    for sep in (',', ';'):
        try:
            df = pd.read_csv(filepath, sep=sep, encoding='utf-8', errors='replace')

            date_col = next(
                (c for c in df.columns
                 if any(kw in c.lower() for kw in ('date', 'time', 'heure'))),
                None,
            )
            kwh_col = next(
                (c for c in df.columns
                 if any(kw in c.lower() for kw in ('kwh', 'consommation'))),
                None,
            )

            if date_col is None or kwh_col is None:
                continue

            df['datetime'] = pd.to_datetime(
                df[date_col], dayfirst=True, errors='coerce'
            )
            df = df.dropna(subset=['datetime']).set_index('datetime')
            df['consumption_kwh'] = (
                df[kwh_col].astype(str).str.replace(',', '.')
                .pipe(pd.to_numeric, errors='coerce')
            )
            df = df.dropna(subset=['consumption_kwh'])

            # Infer interval duration from median gap between timestamps
            if len(df) > 1:
                median_delta = pd.Series(df.index).diff().median()
                interval_h   = median_delta.total_seconds() / 3600.0
            else:
                interval_h = 0.5  # assume 30-minute intervals as fallback

            df['consumption_kw'] = df['consumption_kwh'] / interval_h
            return df[['consumption_kw']]
        except Exception:
            continue

    raise ValueError(
        f"Could not parse consumption file '{filepath}'.  "
        "Ensure it has a date/time column and a kWh column, "
        "separated by comma or semicolon."
    )


# ─── Analysis ─────────────────────────────────────────────────────────────────

def compute_analysis(pv, consumption=None, peak_power_kw=None):
    """Merge PV and optionally consumption data and compute derived metrics.

    Returns
    -------
    pd.DataFrame with columns:
      pv_kw, and when consumption is passed:
        consumption_kw, real_consumption_kw, self_consumed_kw
    """
    if peak_power_kw:
        cap = float(peak_power_kw) * 1.2
        over = pv['pv_kw'] > cap
        if over.any():
            print(
                f"  Warning: {over.sum()} records exceed {cap:.1f} kW "
                f"(120 % of peak power {peak_power_kw} kW).  Capping."
            )
            pv = pv.copy()
            pv.loc[over, 'pv_kw'] = cap

    if consumption is not None:
        df = consumption.join(pv, how='inner')
        df['real_consumption_kw'] = df['consumption_kw'] + df['pv_kw']
        df['self_consumed_kw']    = np.minimum(df['pv_kw'], df['real_consumption_kw'])
        df['self_consumed_kw']    = np.minimum(df['self_consumed_kw'], df['consumption_kw'])
    else:
        df = pv.copy()

    return df


# ─── Plotting ─────────────────────────────────────────────────────────────────

def plot_results(df, output_dir):
    """Save an interactive HTML Plotly chart to output_dir."""
    os.makedirs(output_dir, exist_ok=True)
    has_consumption = 'consumption_kw' in df.columns

    fig = go.Figure()

    if has_consumption:
        fig.add_trace(go.Scatter(
            x=df.index, y=df['real_consumption_kw'],
            name='Total consumption (kW)', fill='tozeroy',
            line=dict(color='firebrick'),
        ))
        fig.add_trace(go.Scatter(
            x=df.index, y=df['pv_kw'],
            name='PV generation (kW)', fill='tozeroy',
            line=dict(color='seagreen'),
        ))
        fig.add_trace(go.Scatter(
            x=df.index, y=df['self_consumed_kw'],
            name='Self-consumed PV (kW)', fill='tozeroy',
            line=dict(color='darkorange'),
        ))
        fig.update_layout(
            title='PV Generation vs Consumption',
            xaxis_title='Time',
            yaxis_title='Power (kW)',
        )
        out = os.path.join(output_dir, 'pv_consumption.html')
    else:
        fig.add_trace(go.Scatter(
            x=df.index, y=df['pv_kw'],
            name='PV generation (kW)', fill='tozeroy',
            line=dict(color='seagreen'),
        ))
        fig.update_layout(
            title='PV Generation',
            xaxis_title='Time',
            yaxis_title='Power (kW)',
        )
        out = os.path.join(output_dir, 'pv_generation.html')

    fig.write_html(out)
    print(f"  Plot saved : {out}")


# ─── Statistics ───────────────────────────────────────────────────────────────

def print_statistics(df):
    """Print overall and daily statistics to stdout."""
    has_consumption = 'consumption_kw' in df.columns

    # Infer interval from the first two timestamps
    if len(df) > 1:
        delta_h = (df.index[1] - df.index[0]).total_seconds() / 3600.0
    else:
        delta_h = 0.5

    daily = df.resample('D').sum() * delta_h  # kW × h = kWh
    daily.columns = [c.replace('_kw', '_kwh') for c in daily.columns]

    print('\n=== Statistics ===')
    if 'pv_kwh' in daily:
        total_pv = daily['pv_kwh'].sum()
        print(f"Total PV generation     : {total_pv:>10.1f} kWh")

    if has_consumption:
        col = (
            'real_consumption_kwh'
            if 'real_consumption_kwh' in daily
            else 'consumption_kwh'
        )
        total_cons = daily[col].sum()
        print(f"Total consumption       : {total_cons:>10.1f} kWh")

        if 'self_consumed_kwh' in daily and 'pv_kwh' in daily:
            total_sc = daily['self_consumed_kwh'].sum()
            print(f"Self-consumed PV        : {total_sc:>10.1f} kWh")
            if total_pv > 0:
                print(f"Self-consumption rate   : {total_sc / total_pv:>9.1%}")
            if total_cons > 0:
                print(f"Self-sufficiency rate   : {total_sc / total_cons:>9.1%}")


def _check_integrity(pv, df, data_dir, consumption=None):
    """Basic sanity checks; prints warnings but does not abort."""
    files       = sorted(glob.glob(os.path.join(data_dir, 'sunnyportal_*.csv')))
    cons_days   = set(consumption.index.date) if consumption is not None else None
    issues      = 0

    for f in files:
        date_str = os.path.basename(f).replace('.csv', '').split('_')[1]
        try:
            day = pd.to_datetime(date_str).date()
        except Exception:
            print(f"  Warning: cannot parse date from {os.path.basename(f)}")
            continue

        if cons_days is not None and day not in cons_days:
            print(f"  Info: {day} has PV data but no consumption data → skipped in join.")
            continue

        day_pv = pv[pv.index.date == day]
        if day_pv.empty or (day_pv['pv_kw'] == 0).all():
            print(f"  Warning: no non-zero PV values found for {day}.")
            issues += 1

    nan_cols = [c for c in df.columns if df[c].isna().any()]
    if nan_cols:
        print(f"  Warning: NaN values in columns: {nan_cols}")
        issues += 1

    if issues == 0:
        print("  Integrity check passed.")


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Analyse and visualise SMA Sunny Portal data.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument('--data-dir',    default=None,     help='Directory with downloaded CSVs')
    parser.add_argument('--consumption', default=None,     help='Optional consumption CSV file')
    parser.add_argument('--output-dir',  default='output', help='Output directory (default: output)')
    parser.add_argument('--config',      default=None,     help='Config file path')
    args = parser.parse_args()

    cfg      = load_config(args.config)
    data_dir = args.data_dir or cfg.get('download', 'data_dir', fallback='data')
    peak_kw  = cfg.get('analysis', 'peak_power_kw', fallback=None)

    print(f"Data directory : {data_dir}")

    # ── PV data
    pv = assemble_pv_data(data_dir)
    if pv.empty:
        print("No PV data found.  Run download.js first.")
        sys.exit(1)
    print(f"  Loaded {len(pv)} PV records ({pv.index.min().date()} → {pv.index.max().date()})")

    # ── Consumption data (optional)
    consumption = None
    if args.consumption:
        print(f"Consumption file: {args.consumption}")
        consumption = read_consumption(args.consumption)
        print(f"  Loaded {len(consumption)} consumption records")

    # ── Merge & compute
    pv_aligned = assemble_pv_data(
        data_dir,
        target_index=consumption.index if consumption is not None else None,
    )
    df = compute_analysis(pv_aligned, consumption, peak_kw)

    # ── Save CSV
    os.makedirs(args.output_dir, exist_ok=True)
    csv_out = os.path.join(args.output_dir, 'analysis.csv')
    df.to_csv(csv_out)
    print(f"  CSV saved  : {csv_out}")

    # ── Plot
    plot_results(df, args.output_dir)

    # ── Print summary
    print_statistics(df)

    # ── Integrity check
    print('\n=== Integrity check ===')
    _check_integrity(pv_aligned, df, data_dir, consumption)


if __name__ == '__main__':
    main()
