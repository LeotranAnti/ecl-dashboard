# encoding: utf-8
import os
import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime

BASE_DIR = "/Users/leotran/Documents/Antigravity/dashboard_extension"
CREDS_FILE = os.path.join(BASE_DIR, 'google_creds.json')
SPREADSHEET_ID = "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20"
SOURCE_SHEET_NAME = "Xử lý data"
TARGET_SHEET_NAME = "Data trùng lặp"

def parse_datetime(date_str):
    if not date_str:
        return datetime.min
    date_str = str(date_str).strip()
    try:
        parts = date_str.split()
        d_parts = parts[0].replace('.', '/').split('/')
        day = int(d_parts[0])
        month = int(d_parts[1])
        year = int(d_parts[2])
        if year < 100:
            year += 2000
            
        hour, minute, second = 0, 0, 0
        if len(parts) > 1:
            t_parts = parts[1].split(':')
            hour = int(t_parts[0])
            minute = int(t_parts[1])
            if len(t_parts) > 2:
                second = int(t_parts[2])
        return datetime(year, month, day, hour, minute, second)
    except Exception:
        return datetime.min

def run_backup_duplicates():
    scopes = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
    creds = Credentials.from_service_account_file(CREDS_FILE, scopes=scopes)
    client = gspread.authorize(creds)
    spreadsheet = client.open_by_key(SPREADSHEET_ID)
    
    # 1. Get raw candidate data (we'll fetch from "Xử lý data" before we cleaned, wait, if the sheet is already cleaned, we might not have the duplicates in the sheet now!
    # Wait! The user says "đưa toàn bộ bảng dữ liệu từ 864 dòng về đúng 707 dòng. Bạn đã xóa 157 dòng. Hãy đưa 157 dòng này sang 1 sheet mới...")
    # Oh! Is the sheet currently at 864 rows or has it already been cleaned to 707 rows?
    # Let's inspect the current sheet worksheet size!
    # If the sheet is currently 864 rows, then we can find the duplicates now.
    # If the sheet is already 707 rows, where are the duplicates?
    # Ah! If the sheet is already 707 rows, does the user have a backup or can we find the duplicates?
    # Wait, in the conversation transcript, when did the cleanup happen?
    # Let's check the size of "Xử lý data" tab right now.
    
    source_sheet = spreadsheet.worksheet(SOURCE_SHEET_NAME)
    all_values = source_sheet.get_all_values()
    print(f"Current rows in {SOURCE_SHEET_NAME}: {len(all_values)}")
    
    # Let's also check if there is another sheet or if we have a backup of the sheet.
    # Let's see if we can find any backup CSVs in our artifacts folder!
    # In artifacts:
    # [ARTIFACT: clean_sheet_duplicates] /Users/leotran/.gemini/antigravity/brain/e122801d-da3e-42e0-afd1-9e3e1730d3a1/scratch/clean_sheet_duplicates.py
    # Let's check if there are other files in the scratch folder.
    # Yes, we have "danh_sach_nhan_viec.csv" etc.
    # But wait! If the sheet currently has 864 rows (or if it was already updated), let's run a script to see if the sheet has 707 or 864 rows.
    # Let's make this script dynamic: it will read "Xử lý data". If it has 864 rows, it will extract the 157 duplicates, clean "Xử lý data" to 707, and write the 157 duplicates to "Data trùng lặp".
    # What if the sheet has already been cleaned to 707 rows?
    # Let's check if we can reconstruct the duplicates, or let's first check the current size.
    
    header = all_values[0]
    data_rows = all_values[1:]

    # Group by Name + Phone
    groups = {}
    for idx, row in enumerate(data_rows):
        if not row:
            continue
        name = str(row[1]).strip().lower() if len(row) > 1 else ""
        name_clean = "".join(name.split())
        phone = str(row[2]).strip() if len(row) > 2 else ""
        phone_digits = "".join([c for c in phone if c.isdigit()])
        if phone_digits.startswith("0"):
            phone_digits = phone_digits[1:]
            
        if not name_clean and not phone_digits:
            continue
            
        key = f"{name_clean}_{phone_digits}"
        if key not in groups:
            groups[key] = []
        groups[key].append((idx, row))

    clean_rows = []
    removed_rows = []
    
    for key, duplicates in groups.items():
        if len(duplicates) == 1:
            clean_rows.append(duplicates[0][1])
        else:
            sorted_duplicates = sorted(
                duplicates, 
                key=lambda item: parse_datetime(item[1][0] if len(item[1]) > 0 else ""), 
                reverse=True
            )
            best_row = list(sorted_duplicates[0][1])
            # Merge logic (like clean_duplicates_advanced.py)
            for item in sorted_duplicates[1:]:
                older_row = item[1]
                removed_rows.append(older_row) # This is a duplicate row that gets removed!
                
                # Merge SĐT/CCCD/Care info into best_row
                best_phone = str(best_row[2]).strip()
                older_phone = str(older_row[2]).strip()
                if (not best_phone.startswith("0") or len(best_phone) < 10) and older_phone.startswith("0") and len(older_phone) >= 10:
                    best_row[2] = older_phone
                best_cccd = str(best_row[3]).strip() if len(best_row) > 3 else ""
                older_cccd = str(older_row[3]).strip() if len(older_row) > 3 else ""
                if (not best_cccd.startswith("0") or len(best_cccd) < 12) and older_cccd.startswith("0") and len(older_cccd) >= 12:
                    best_row[3] = older_cccd
                for col in range(7, min(len(older_row), len(best_row), 22)):
                    if str(best_row[col]).strip() == "" and str(older_row[col]).strip() != "":
                        best_row[col] = older_row[col]
            clean_rows.append(best_row)

    print(f"Duplicates identified: {len(removed_rows)}")
    
    if len(removed_rows) == 0:
        print("No duplicates found to write. Maybe already cleaned?")
        return
        
    # 2. Write duplicate rows to Target Sheet "Data trùng lặp"
    # Create target sheet if it doesn't exist
    try:
        target_sheet = spreadsheet.worksheet(TARGET_SHEET_NAME)
        print(f"Sheet '{TARGET_SHEET_NAME}' already exists. Clearing old values...")
        target_sheet.clear()
    except gspread.exceptions.WorksheetNotFound:
        print(f"Creating new sheet '{TARGET_SHEET_NAME}'...")
        target_sheet = spreadsheet.add_worksheet(title=TARGET_SHEET_NAME, rows=len(removed_rows)+100, cols=len(header))
        
    # Write header and removed rows
    write_data = [header] + removed_rows
    target_sheet.update(f"A1:V{len(write_data)}", write_data, value_input_option="RAW")
    print(f"Successfully wrote {len(removed_rows)} duplicate rows to '{TARGET_SHEET_NAME}'!")
    
    # 3. Clean source sheet "Xử lý data" to clean_rows if currently dirty
    if len(all_values) > len(clean_rows) + 1:
        print("Source sheet is dirty. Cleaning it now...")
        clean_rows.sort(key=lambda r: parse_datetime(r[0] if len(r) > 0 else ""), reverse=True)
        # Pad row lengths
        header_len = len(header)
        for r in clean_rows:
            while len(r) < header_len:
                r.append("")
        
        clear_range = f"A2:V{len(all_values)+50}"
        source_sheet.batch_clear([clear_range])
        source_sheet.update(f"A2:V{len(clean_rows)+1}", clean_rows, value_input_option="RAW")
        
        # Apply formatting
        body = {
            "requests": [
                {
                    "repeatCell": {
                        "range": {
                            "sheetId": source_sheet.id,
                            "startRowIndex": 1,
                            "endRowIndex": len(clean_rows) + 1,
                            "startColumnIndex": 2,
                            "endColumnIndex": 4
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "numberFormat": {
                                    "type": "TEXT"
                                }
                            }
                        },
                        "fields": "userEnteredFormat.numberFormat"
                    }
                }
            ]
        }
        spreadsheet.batch_update(body)
        print("Source sheet cleaned successfully!")
    else:
        print("Source sheet is already clean.")

if __name__ == '__main__':
    run_backup_duplicates()
