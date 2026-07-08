# encoding: utf-8
import os
import sys
import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CREDS_FILE = os.path.join(BASE_DIR, 'google_creds.json')

# Cấu hình tất cả các file cần sắp xếp
SHEETS_CONFIG = {
    "Pegatron": {
        "id": "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20",
        "worksheets": ["Xử lý data"]
    },
    "Brother": {
        "id": "1MQ_M_l_Vugn-_eURR4qmCHylfpiM_pYfPTooJRsAut4",
        "worksheets": ["Câu trả lời biểu mẫu 1"]
    },
    "LG": {
        "id": "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk",
        "worksheets": ["Xử lý data", "Xử lý Data LG", "Xử lý Data CTV", "Xử Lý data Đại Lý", "Xử lý Data ADS", "Xử lý data CTV GO - LUX - Wis"]
    },
    "Usi": {
        "id": "1539PRjUCZu98VQAQOrMdlcd6OcQftdony2J4wVQAFEU",
        "worksheets": ["Xử lý data", "Theo dõi ứng viên"]
    },
    "Fox QN": {
        "id": "1QS41MPzfsv5-_nNqjlTX4YDtze5jtM-UqZTnT-NwoQw",
        "worksheets": ["Xử lý data"]
    }
}

def parse_datetime(date_str):
    if not date_str:
        return datetime.min
    date_str = date_str.strip()
    try:
        parts = date_str.split()
        d_parts = parts[0].replace('.', '/').split('/')
        day = int(d_parts[0])
        month = int(d_parts[1])
        
        # Default to current dataset year (2026) if year is missing (e.g. '7/4')
        if len(d_parts) == 2:
            year = 2026
        else:
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

def normalize_phone_cccd(row_data):
    r = list(row_data)
    # Cột Số điện thoại ở index 2 (Cột C)
    if len(r) > 2:
        phone = str(r[2]).strip()
        # Chỉ thêm số 0 đầu khi SĐT có đúng 9 chữ số và chưa có số 0
        if phone.isdigit() and len(phone) == 9 and not phone.startswith('0'):
            r[2] = '0' + phone
        # Nếu đã có đủ 10 chữ số hoặc có nội dung khác → giữ nguyên
    
    # Cột CCCD ở index 3 (Cột D)
    if len(r) > 3:
        cccd = str(r[3]).strip()
        if cccd.isdigit() and len(cccd) > 1:
            # CCCD mới 12 chữ số: chỉ thêm 0 nếu đang có 11 chữ số chưa có số 0 đầu
            if len(cccd) == 11 and not cccd.startswith('0'):
                r[3] = '0' + cccd
            # CMND cũ 9 chữ số: chỉ thêm 0 nếu có 8 chữ số chưa có số 0 đầu
            elif len(cccd) == 8 and not cccd.startswith('0'):
                r[3] = '0' + cccd
            # Các trường hợp khác (10, 12 chữ số...) → giữ nguyên như người dùng nhập
    return r


def sort_single_worksheet(client, doc_id, doc_name, ws_name):
    print(f"[{doc_name} -> {ws_name}] Đang tải dữ liệu...")
    try:
        spreadsheet = client.open_by_key(doc_id)
        sheet = spreadsheet.worksheet(ws_name)
    except Exception as e:
        print(f"⚠️ Lỗi truy cập trang tính {ws_name} của {doc_name}: {e}")
        return False

    try:
        all_values = sheet.get_all_values()
        num_rows = len(all_values)
        if num_rows <= 1:
            print(f"[{doc_name} -> {ws_name}] Bảng tính trống hoặc chỉ có tiêu đề. Bỏ qua.")
            return True

        header = all_values[0]
        data_rows = all_values[1:]
        
        # Sắp xếp theo Dấu thời gian (Cột A - index 0) mới nhất lên đầu
        data_rows.sort(key=lambda r: parse_datetime(r[0] if len(r) > 0 else ""), reverse=True)
        
        print(f"[{doc_name} -> {ws_name}] Đang ghi cập nhật dữ liệu sắp xếp mới lên sheet...")
        updates = []
        header_len = len(header)

        for row_idx, row in enumerate(data_rows, 2): # Dòng dữ liệu bắt đầu từ dòng 2
            new_row = normalize_phone_cccd(row)
            
            # Đảm bảo new_row có độ dài bằng header_len
            while len(new_row) < header_len:
                new_row.append("")
            
            # Cắt ngắn nếu row dư thừa cột
            new_row = new_row[:header_len]

            # Ghi đè toàn bộ dòng để đảm bảo tất cả thông tin chăm sóc đi cùng với thông tin ứng viên khi đổi vị trí dòng
            end_col_name = gspread.utils.rowcol_to_a1(row_idx, header_len)
            updates.append({
                'range': f'A{row_idx}:{end_col_name}',
                'values': [new_row]
            })

        # Xóa các dòng trống dôi dư ở cuối
        if num_rows > len(data_rows) + 1:
            clear_range = f"A{len(data_rows)+2}:{gspread.utils.rowcol_to_a1(num_rows, header_len)}"
            sheet.batch_clear([clear_range])
            
        # ĐẶT ĐỊNH DẠNG PLAIN TEXT CHO CỘT C (SĐT) VÀ D (CCCD) TRƯỚC KHI GHI
        # để tránh Google Sheets xóa mất số 0 ở đầu
        try:
            text_format_body = {
                "requests": [
                    {
                        "repeatCell": {
                            "range": {
                                "sheetId": sheet.id,
                                "startRowIndex": 1,         # Từ dòng 2
                                "endRowIndex": num_rows,    # Đến hết dữ liệu
                                "startColumnIndex": 2,      # Cột C (SĐT) - 0-indexed
                                "endColumnIndex": 4         # Đến hết cột D (CCCD)
                            },
                            "cell": {
                                "userEnteredFormat": {
                                    "numberFormat": {"type": "TEXT"}
                                }
                            },
                            "fields": "userEnteredFormat.numberFormat"
                        }
                    }
                ]
            }
            spreadsheet.batch_update(text_format_body)
        except Exception as fmt_err:
            print(f"⚠️ Không thể set định dạng TEXT cho cột C/D: {fmt_err}")

        sheet.batch_update(updates)

        
        # COPY DROPDOWN & FORMAT CHO DÒNG MỚI (Áp dụng cho toàn bộ các dòng dữ liệu để đảm bảo không bị sót)
        # Sử dụng dòng 15 làm mẫu format/dropdown vì đây là dòng luôn có dữ liệu hoàn chỉnh
        print(f"[{doc_name} -> {ws_name}] Đang khôi phục Dropdown và định dạng cho các dòng mới...")
        try:
            max_rows = len(data_rows) + 1
            
            # Tìm dòng có dữ liệu đầy đủ nhất để làm mẫu (tránh dùng dòng trống)
            best_row_idx = 15  # fallback mặc định
            best_count = 0
            for i, row in enumerate(data_rows[:30], 2):  # Kiểm tra 30 dòng đầu
                filled = sum(1 for c in row if str(c).strip())
                if filled > best_count:
                    best_count = filled
                    best_row_idx = i
            
            if best_row_idx > 1 and max_rows > 1:
                # Copy dropdowns and formats only starting from row 2 (startRowIndex=1) up to max_rows.
                # To avoid APIError 400 when spreadsheet has active filters, we target destination row 2 to max_rows.
                body = {
                    "requests": [
                        {
                            "copyPaste": {
                                "source": {
                                    "sheetId": sheet.id,
                                    "startRowIndex": best_row_idx - 1,
                                    "endRowIndex": best_row_idx,
                                    "startColumnIndex": 1,   # Từ cột B - bao gồm cả cột G (Nguồn data)
                                    "endColumnIndex": header_len
                                },
                                "destination": {
                                    "sheetId": sheet.id,
                                    "startRowIndex": 1,
                                    "endRowIndex": max_rows,
                                    "startColumnIndex": 1,
                                    "endColumnIndex": header_len
                                },
                                "pasteType": "PASTE_DATA_VALIDATION",
                                "pasteOrientation": "NORMAL"
                            }
                        },
                        {
                            "copyPaste": {
                                "source": {
                                    "sheetId": sheet.id,
                                    "startRowIndex": best_row_idx - 1,
                                    "endRowIndex": best_row_idx,
                                    "startColumnIndex": 1,
                                    "endColumnIndex": header_len
                                },
                                "destination": {
                                    "sheetId": sheet.id,
                                    "startRowIndex": 1,
                                    "endRowIndex": max_rows,
                                    "startColumnIndex": 1,
                                    "endColumnIndex": header_len
                                },
                                "pasteType": "PASTE_FORMAT",
                                "pasteOrientation": "NORMAL"
                            }
                        }
                    ]
                }
                spreadsheet.batch_update(body)
        except Exception as format_err:
            print(f"⚠️ Bỏ qua copy format/dropdown cho {ws_name}: {format_err}")
            
        print(f"✅ Sắp xếp thành công cho [{doc_name} -> {ws_name}]!")
        return True
    except Exception as e:
        print(f"❌ Thất bại khi sắp xếp [{doc_name} -> {ws_name}]: {e}")
        return False

def sort_all_sheets(target_doc=None, target_ws=None):
    if not os.path.exists(CREDS_FILE):
        print(f"Lỗi: Không tìm thấy file credentials {CREDS_FILE}")
        return False
        
    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
    ]
    creds = Credentials.from_service_account_file(CREDS_FILE, scopes=scopes)
    client = gspread.authorize(creds)

    for doc_name, config in SHEETS_CONFIG.items():
        if target_doc and target_doc != doc_name:
            continue
        for ws_name in config["worksheets"]:
            if target_ws and target_ws != ws_name:
                continue
            sort_single_worksheet(client, config["id"], doc_name, ws_name)
    return True

if __name__ == '__main__':
    # Cho phép gọi chạy riêng lẻ cho 1 file hoặc 1 sheet qua đối số dòng lệnh
    t_doc = sys.argv[1] if len(sys.argv) > 1 else None
    t_ws = sys.argv[2] if len(sys.argv) > 2 else None
    sort_all_sheets(t_doc, t_ws)
