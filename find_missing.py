import os
import re
from datetime import datetime, timedelta

def get_missing_days(data_dir):
    # Pattern to match sunnyportal_YYYY-MM-DD.csv
    pattern = re.compile(r'sunnyportal_(\d{4}-\d{2}-\d{2})\.csv')
    
    existing_dates = set()
    removed_count = 0
    for filename in os.listdir(data_dir):
        match = pattern.match(filename)
        if match:
            filepath = os.path.join(data_dir, filename)
            # Check file size: if less than 1KB, remove it
            if os.path.getsize(filepath) < 1024:
                print(f"Removing small file ({os.path.getsize(filepath)} bytes): {filename}")
                os.remove(filepath)
                removed_count += 1
                continue
            existing_dates.add(datetime.strptime(match.group(1), '%Y-%m-%d').date())
    
    if removed_count > 0:
        print(f"Removed {removed_count} small files for re-download.")
            
    if not existing_dates:
        print("No data files found in the data folder.")
        return []

    first_day = min(existing_dates)
    last_day = max(existing_dates)
    
    missing_days = []
    current_day = first_day
    while current_day <= last_day:
        if current_day not in existing_dates:
            missing_days.append(current_day.strftime('%Y-%m-%d'))
        current_day += timedelta(days=1)
        
    return missing_days

def main():
    data_dir = 'data'
    if not os.path.exists(data_dir):
        print(f"Directory '{data_dir}' not found.")
        return

    missing = get_missing_days(data_dir)
    
    if not missing:
        print("No missing days found between the first and last recorded dates.")
    else:
        print(f"Found {len(missing)} missing days.")
        # Group missing days into ranges if they are continuous, 
        # but the request asks for "node download.js ......." to download all.
        # If I modify download.js to accept --dates, I can output a single command.
        
        print("\nTo download missing files, run:")
        print(f"node download.js --dates {','.join(missing)}")

if __name__ == '__main__':
    main()
