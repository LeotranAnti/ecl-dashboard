# encoding: utf-8
import os
import sys
import time
import socket
import subprocess
import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime

# Thiết lập timeout để tránh tiến trình bị treo khi mạng lỗi
socket.setdefaulttimeout(30)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SORT_SCRIPT = os.path.join(BASE_DIR, 'sort_sheet.py')
CREDS_FILE = os.path.join(BASE_DIR, 'google_creds.json')
LOG_FILE = os.path.join(BASE_DIR, 'auto_sort_listener.log')

# Danh sách tất cả file và sheet cần giám sát sự thay đổi
MONITORED_SHEETS = [
    {"doc_name": "Pegatron", "id": "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20", "ws_name": "Xử lý data"},
    {"doc_name": "Brother", "id": "1MQ_M_l_Vugn-_eURR4qmCHylfpiM_pYfPTooJRsAut4", "ws_name": "Câu trả lời biểu mẫu 1"},
    {"doc_name": "LG", "id": "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk", "ws_name": "Xử lý data"},
    {"doc_name": "LG", "id": "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk", "ws_name": "Xử lý Data LG"},
    {"doc_name": "LG", "id": "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk", "ws_name": "Xử lý Data CTV"},
    {"doc_name": "LG", "id": "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk", "ws_name": "Xử Lý data Đại Lý"},
    {"doc_name": "LG", "id": "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk", "ws_name": "Xử lý Data ADS"},
    {"doc_name": "LG", "id": "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk", "ws_name": "Xử lý data CTV GO - LUX - Wis"},
    {"doc_name": "Usi", "id": "1539PRjUCZu98VQAQOrMdlcd6OcQftdony2J4wVQAFEU", "ws_name": "Xử lý data"},
    {"doc_name": "Usi", "id": "1539PRjUCZu98VQAQOrMdlcd6OcQftdony2J4wVQAFEU", "ws_name": "Theo dõi ứng viên"},
    {"doc_name": "Fox QN", "id": "1QS41MPzfsv5-_nNqjlTX4YDtze5jtM-UqZTnT-NwoQw", "ws_name": "Xử lý data"}
]

def log_message(msg):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[{timestamp}] {msg}\n"
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(log_line)
    print(msg)

def get_gspread_client():
    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
    ]
    creds = Credentials.from_service_account_file(CREDS_FILE, scopes=scopes)
    return gspread.authorize(creds)

def check_and_run_sort(doc_name, ws_name):
    log_message(f"⚡ Đang chạy sắp xếp dữ liệu cho [{doc_name} -> {ws_name}]...")
    result = subprocess.run(
        [sys.executable, SORT_SCRIPT, doc_name, ws_name],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    if result.returncode == 0:
        log_message(f"⚡ Đã sắp xếp thành công dòng mới cho [{doc_name} -> {ws_name}].")
        return True
    else:
        log_message(f"❌ Lỗi chạy script sắp xếp [{doc_name} -> {ws_name}]: {result.stderr}")
        return False

def run_listener():
    log_message("🚀 Khởi động dịch vụ tự động sắp xếp an toàn đa file (Pegatron, Brother, LG, Usi)...")
    
    # Khởi tạo API client
    client = None
    while client is None:
        try:
            client = get_gspread_client()
        except Exception as e:
            log_message(f"❌ Lỗi kết nối API ban đầu: {e}. Thử lại sau 10 giây...")
            time.sleep(10)

    # Lưu trữ số lượng dòng hiện tại của từng trang tính để làm mốc so sánh
    last_known_state = {}
    for item in MONITORED_SHEETS:
        key = f"{item['doc_name']}_{item['ws_name']}"
        try:
            doc = client.open_by_key(item["id"])
            ws = doc.worksheet(item["ws_name"])
            row_count = len(ws.col_values(1))
            last_known_state[key] = row_count
            log_message(f"   [Khởi tạo] {item['doc_name']} -> {item['ws_name']}: {row_count} dòng")
        except Exception as e:
            log_message(f"⚠️ Không thể khởi tạo mốc dòng cho {key}: {e}")
            last_known_state[key] = 0

    log_message("⚡ Hệ thống giám sát đã sẵn sàng. Bắt đầu vòng lặp quét (30 giây/lần)...")

    while True:
        try:
            # Tạo mới client mỗi vòng quét lớn để tránh hết hạn phiên kết nối Google API
            client = get_gspread_client()
            
            for item in MONITORED_SHEETS:
                key = f"{item['doc_name']}_{item['ws_name']}"
                try:
                    doc = client.open_by_key(item["id"])
                    ws = doc.worksheet(item["ws_name"])
                    
                    # Đọc số lượng dòng hiện có dựa trên cột A
                    current_rows = len(ws.col_values(1))
                    last_rows = last_known_state.get(key, 0)
                    
                    if current_rows > last_rows:
                        log_message(f"🔔 Phát hiện form mới chèn vào trang [{item['doc_name']} -> {item['ws_name']}] ({last_rows} -> {current_rows} dòng).")
                        if check_and_run_sort(item['doc_name'], item['ws_name']):
                            # Fetch lại số lượng dòng sau khi đã sắp xếp thành công để cập nhật mốc chính xác
                            try:
                                doc_after = client.open_by_key(item["id"])
                                ws_after = doc_after.worksheet(item["ws_name"])
                                last_known_state[key] = len(ws_after.col_values(1))
                            except Exception:
                                last_known_state[key] = current_rows
                        else:
                            last_known_state[key] = current_rows
                    else:
                        # Cập nhật số dòng nếu dòng giảm đi (do thao tác xóa tay của quản trị viên)
                        last_known_state[key] = current_rows
                except Exception as sheet_err:
                    log_message(f"⚠️ Lỗi khi quét trạng thái của {key}: {sheet_err}")

        except Exception as e:
            log_message(f"⚠️ Lỗi hệ thống trong vòng lặp chính: {e}")
            
        # Kiểm tra sự thay đổi của tất cả các file sau mỗi 45 giây (tăng nhẹ thời gian nghỉ để tránh vượt quá quota API)
        time.sleep(45)

if __name__ == '__main__':
    run_listener()
