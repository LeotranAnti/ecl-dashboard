import urllib.request
import csv
import json
import os
import sys
from datetime import datetime

# Load Config
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'telegram_config.json')

def load_config():
    if not os.path.exists(CONFIG_PATH):
        # Create empty template
        default_config = {
            "bot_token": "NHẬP_TOKEN_BOT_VÀO_ĐÂY",
            "chat_id": "NHẬP_CHAT_ID_VÀO_ĐÂY"
        }
        with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(default_config, f, indent=2, ensure_ascii=False)
        print(f"Đã tạo file cấu hình mẫu tại: {CONFIG_PATH}. Vui lòng điền thông tin Telegram.")
        return None
    
    with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

def send_telegram_message(token, chat_id, text):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML"
    }).encode('utf-8')
    
    req = urllib.request.Request(
        url, 
        data=data, 
        headers={'Content-Type': 'application/json'}
    )
    try:
        with urllib.request.urlopen(req) as response:
            return response.read()
    except Exception as e:
        print(f"Lỗi gửi Telegram: {e}", file=sys.stderr)
        return None

def main():
    config = load_config()
    if not config or config.get("bot_token") == "NHẬP_TOKEN_BOT_VÀO_ĐÂY":
        print("Vui lòng cấu hình bot_token và chat_id trong telegram_config.json")
        return

    bot_token = config["bot_token"]
    chat_id = config["chat_id"]

    # Google Sheets Candidate URL
    sheet_url = "https://docs.google.com/spreadsheets/d/1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20/export?format=csv&gid=1671069143"
    
    # Tự động sắp xếp và đánh số thứ tự trước khi lấy dữ liệu để gửi cảnh báo
    try:
        from sort_and_number import sort_and_number_sheet
        print("Đang tự động sắp xếp và đánh số thứ tự bảng tính...")
        sort_and_number_sheet()
    except Exception as e:
        print(f"Không thể tự động sắp xếp bảng tính: {e}")

    try:
        response = urllib.request.urlopen(sheet_url)
        lines = [line.decode('utf-8') for line in response.readlines()]
        reader = csv.reader(lines)
        rows = list(reader)
    except Exception as e:
        print(f"Lỗi tải dữ liệu từ Google Sheets: {e}", file=sys.stderr)
        return

    if len(rows) <= 1:
        print("Bảng tính trống hoặc không tải được dữ liệu.")
        return

    # Check current time
    now = datetime.now()
    current_hour = now.hour
    today_str_short = f"{now.day}/{now.month}"
    today_str_full = f"{now.day:02d}/{now.month:02d}"

    # We will accumulate warnings
    hourly_warnings = []
    time_specific_warnings = []
    care_mismatch_warnings = []

    # Skip header
    for idx, row in enumerate(rows[1:], 1):
        if len(row) < 18:
            continue
        
        name = row[1].strip() if row[1] else "Ẩn danh"
        status = row[13].strip().lower() if row[13] else ""
        interview_date = row[12].strip() if row[12] else ""
        next_care = row[14].strip() if row[14] else ""
        crm = row[10].strip() if row[10] else ""
        hire_date = row[16].strip() if row[16] else ""
        last_care = row[17].strip() if row[17] else ""
        process = row[19].strip() if row[19] else ""
        
        phone = row[2].strip() if len(row) > 2 and row[2] else "Trống SĐT"
        recruiter = row[8].strip() if len(row) > 8 and row[8] else "Chưa phân công"

        # 1. Nếu tình trạng là "Hẹn phỏng vấn" nhưng ngày hẹn phỏng vấn bị bỏ trống
        if status == "hẹn phỏng vấn" and not interview_date:
            hourly_warnings.append(f"• Dòng {idx+1}: UV <b>{name}</b> ({phone}) - CS: <b>{recruiter}</b> - Tình trạng 'Hẹn phỏng vấn' nhưng ngày hẹn bị trống.")

        # 2. Nếu tình trạng là "Chăm sóc tiếp" nhưng ngày chăm sóc tiếp theo bị thiếu
        if status == "chăm sóc tiếp" and not next_care:
            hourly_warnings.append(f"• Dòng {idx+1}: UV <b>{name}</b> ({phone}) - CS: <b>{recruiter}</b> - Tình trạng 'Chăm sóc tiếp' nhưng thiếu ngày chăm sóc tiếp theo.")

        # 3. Nếu cột hẹn phỏng vấn có ngày và cột tình trạng là hẹn phỏng vấn mà cột CRM ko có ngày
        if interview_date and status == "hẹn phỏng vấn" and not crm:
            hourly_warnings.append(f"• Dòng {idx+1}: UV <b>{name}</b> ({phone}) - CS: <b>{recruiter}</b> - Đã có ngày hẹn PV nhưng thiếu thông tin CRM.")

        # 3b. Nếu tình trạng là "Đã nhận việc" nhưng ngày nhận việc bị trống
        if status == "đã nhận việc" and not hire_date:
            hourly_warnings.append(f"• Dòng {idx+1}: UV <b>{name}</b> ({phone}) - CS: <b>{recruiter}</b> - Tình trạng 'Đã nhận việc' nhưng ngày nhận việc bị trống.")

        # 4. Cảnh báo vào lúc 16h00 và 9h00 với các cột Tình trạng, Ngày CS cuối, Tiến trình chăm sóc bị bỏ trống (chỉ check các dòng được tạo/cập nhật gần đây hoặc hôm nay để tránh spam)
        # Để chính xác, chỉ quét các dòng có ngày CS cuối là hôm nay hoặc trống nhưng có tên
        if current_hour in [9, 16]:
            if not status or not last_care or not process:
                # Chỉ cảnh báo nếu dòng này có dữ liệu tên và là dòng hoạt động (ví dụ có người chăm sóc hoặc nguồn dữ liệu)
                if name and (row[7] or row[8]):
                    missing_fields = []
                    if not status: missing_fields.append("Tình trạng")
                    if not last_care: missing_fields.append("Ngày CS cuối")
                    if not process: missing_fields.append("Tiến trình CS")
                    time_specific_warnings.append(f"• Dòng {idx+1}: UV <b>{name}</b> ({phone}) - CS: <b>{recruiter}</b> - Thiếu: {', '.join(missing_fields)}")

        # 5. Cảnh báo lúc 9h00, 13h00, 16h00 nếu cột ngày chăm sóc tiếp theo là hôm nay nhưng cột ngày chăm sóc cuối không trùng với ngày hôm nay.
        if current_hour in [9, 13, 16]:
            is_next_care_today = next_care in [today_str_short, today_str_full] or next_care.startswith(today_str_full)
            is_last_care_today = last_care in [today_str_short, today_str_full] or last_care.startswith(today_str_full)
            if is_next_care_today and not is_last_care_today:
                care_mismatch_warnings.append(f"• Dòng {idx+1}: UV <b>{name}</b> ({phone}) - CS: <b>{recruiter}</b> - Hẹn CS tiếp theo là hôm nay nhưng chưa cập nhật Ngày CS cuối hôm nay.")

    # Construct and send Telegram Alerts
    # A. Gửi cảnh báo hàng giờ (Chạy mỗi tiếng 1 lần)
    if hourly_warnings:
        msg = f"⚠️ <b>CẢNH BÁO SAI LỆCH DỮ LIỆU HÀNG GIỜ</b> ⚠️\n\n" + "\n".join(hourly_warnings[:30])
        if len(hourly_warnings) > 30:
            msg += f"\n<i>...và {len(hourly_warnings) - 30} dòng khác.</i>"
        send_telegram_message(bot_token, chat_id, msg)
        print("Đã gửi cảnh báo hàng giờ.")

    # B. Gửi cảnh báo khung giờ 9h00 / 16h00 (Thiếu Tình trạng / Ngày CS cuối / Tiến trình)
    if current_hour in [9, 16] and time_specific_warnings:
        msg = f"⚠️ <b>CẢNH BÁO BỎ TRỐNG CỘT THÔNG TIN (Khung giờ {current_hour}h00)</b> ⚠️\n\n" + "\n".join(time_specific_warnings[:30])
        if len(time_specific_warnings) > 30:
            msg += f"\n<i>...và {len(time_specific_warnings) - 30} dòng khác.</i>"
        send_telegram_message(bot_token, chat_id, msg)
        print("Đã gửi cảnh báo thiếu cột.")

    # C. Gửi cảnh báo khung giờ 9h00 / 13h00 / 16h00 (Hẹn CS hôm nay nhưng chưa CS)
    if current_hour in [9, 13, 16] and care_mismatch_warnings:
        msg = f"⚠️ <b>CẢNH BÁO HẸN CHĂM SÓC HÔM NAY CHƯA THỰC HIỆN (Khung giờ {current_hour}h00)</b> ⚠️\n\n" + "\n".join(care_mismatch_warnings[:30])
        if len(care_mismatch_warnings) > 30:
            msg += f"\n<i>...và {len(care_mismatch_warnings) - 30} dòng khác.</i>"
        send_telegram_message(bot_token, chat_id, msg)
        print("Đã gửi cảnh báo lệch ngày CS.")

if __name__ == '__main__':
    main()
