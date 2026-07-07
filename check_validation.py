import os
import gspread
from google.oauth2.service_account import Credentials

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CREDS_FILE = os.path.join(BASE_DIR, 'google_creds.json')
SPREADSHEET_ID = "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20"
SHEET_NAME = "Xử lý data"

def main():
    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
    ]
    creds = Credentials.from_service_account_file(CREDS_FILE, scopes=scopes)
    client = gspread.authorize(creds)
    spreadsheet = client.open_by_key(SPREADSHEET_ID)
    
    # We want to check which rows have data validation (dropdowns) on "Xử lý data" sheet.
    # To do that, we can query the spreadsheet metadata with fields="sheets(data(rowData(values(dataValidation))))"
    # Or more simply, let's inspect the cells or copy data validation from a known good row (e.g. row 100) to the top rows.
    # Let's inspect row 100 first.
    print("Checking sheet metadata...")
    
    # Let's copy paste data validation from row 10 (which is an old row and should definitely have validation)
    # to row 2 (and row 3 if needed).
    # Wait, let's write a script to copy data validation from Row 50 (index 49) to Row 2 (index 1) to make sure Row 2 gets validation.
    
    sheet = spreadsheet.worksheet(SHEET_NAME)
    header_len = len(sheet.row_values(1))
    print(f"Header length: {header_len}")
    
    # Let's copy validation from row 50 to row 2
    body = {
        "requests": [
            {
                "copyPaste": {
                    "source": {
                        "sheetId": sheet.id,
                        "startRowIndex": 49, # Row 50 (index 49)
                        "endRowIndex": 50,
                        "startColumnIndex": 7, # Column H (index 7)
                        "endColumnIndex": header_len
                    },
                    "destination": {
                        "sheetId": sheet.id,
                        "startRowIndex": 1, # Row 2 (index 1)
                        "endRowIndex": 2,
                        "startColumnIndex": 7,
                        "endColumnIndex": header_len
                    },
                    "pasteType": "PASTE_DATA_VALIDATION",
                    "pasteOrientation": "NORMAL"
                }
            }
        ]
    }
    spreadsheet.batch_update(body)
    print("Successfully copied data validation from Row 50 to Row 2!")

if __name__ == '__main__':
    main()
