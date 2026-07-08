# encoding: utf-8
"""
Máy chủ web cục bộ cho Pegatron HR Dashboard
Chạy: python3 server.py
Mở trình duyệt: http://localhost:8989
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import urllib.parse
import os
import json
from datetime import datetime

PORT = 8989
EXTENSION_DIR = os.path.dirname(os.path.abspath(__file__))
SPREADSHEET_ID = "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20"
# Sheet tên lấy từ gid=1671069143 (tab "Xử lý data")
SHEET_NAME_CANDIDATES = "Xử lý data"
# Cột M = Ngày DK/PV / Hẹn phỏng vấn (index 12, bắt đầu từ 0)
# Range M1:M5000 để lấy màu nền cột Ngày DK/PV
INTERVIEW_DATE_COL_RANGE = f"'{SHEET_NAME_CANDIDATES}'!M1:M5000"

SHEET_URLS = {
    "candidates":   f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/export?format=csv&gid=1671069143",
    "recruitments": f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/export?format=csv&gid=1084935408",
}

def load_api_key():
    """Đọc Google API Key từ api_config.json"""
    config_path = os.path.join(EXTENSION_DIR, "api_config.json")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
            return config.get("google_api_key", "").strip()
    except Exception:
        return ""

def is_yellow(color_obj):
    """
    Phát hiện ô màu vàng từ object màu của Sheets API.
    Google Sheets trả về màu dạng {"red": 1.0, "green": 1.0, "blue": 0.0}
    Màu vàng = red cao, green cao, blue thấp.
    """
    if not color_obj:
        return False
    r = color_obj.get("red", 0)
    g = color_obj.get("green", 0)
    b = color_obj.get("blue", 0)
    # Điều kiện màu vàng: đỏ > 0.7, xanh lá > 0.7, xanh dương < 0.5
    return r > 0.7 and g > 0.7 and b < 0.5


class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=EXTENSION_DIR, **kwargs)

    def log_message(self, format, *args):
        now = datetime.now().strftime("%H:%M:%S")
        print(f"[{now}] {format % args}")

        # ── 1. Proxy CSV từ Google Sheets & Finance API ──────────────────────────────
        if self.path.startswith("/api/"):
            path_part = self.path[len("/api/"):]
            
            # Tách query parameters nếu có (ví dụ: ?factory=Brother)
            factory = "Pegatron"
            if "?" in path_part:
                parts = path_part.split("?")
                path_part = parts[0]
                q_params = urllib.parse.parse_qs(parts[1])
                if "factory" in q_params:
                    factory = q_params["factory"][0]

            # ── 1a. Lấy màu nền cột Ngày DK/PV qua Sheets API v4 ──────
            if path_part == "interview-colors":
                self._handle_interview_colors()
                return

            # ── 1b. Proxy Marketing Google Sheets CSV ──────────────────
            if path_part == "marketing":
                spreadsheet_id = "1NgDH3ayQ7nE4_mcT1B5HEW1YrMHaJH8xtf0-u0bFNZQ"
                gid = "1245696062"
                url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/export?format=csv&gid={gid}"
                try:
                    print(f"[Proxy] Đang tải CSV Marketing...")
                    req = urllib.request.Request(
                        url,
                        headers={"User-Agent": "Mozilla/5.0 (compatible; PegatronDashboard/1.0)"}
                    )
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        data = resp.read()
                    self._send_json_or_csv(data, "text/csv; charset=utf-8")
                    print(f"[Proxy] ✅ Marketing ({len(data)} bytes)")
                except Exception as e:
                    print(f"[Proxy] ❌ Lỗi tải Marketing: {e}")
                    self.send_error(502, f"Không thể tải Google Sheets Marketing: {e}")
                return

            # ── 1c. Proxy CSV thông thường (candidates/recruitments) ─────────────────
            if path_part in ["candidates", "recruitments"]:
                spreadsheet_id = "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20" # Pegatron default
                gid = "1671069143"
                
                if path_part == "candidates":
                    if factory == "Brother":
                        spreadsheet_id = "1MQ_M_l_Vugn-_eURR4qmCHylfpiM_pYfPTooJRsAut4";
                        gid = "128053512";
                    elif factory == "LG":
                        spreadsheet_id = "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk";
                        gid = "1326786598";
                    elif factory == "Usi":
                        spreadsheet_id = "1539PRjUCZu98VQAQOrMdlcd6OcQftdony2J4wVQAFEU";
                        gid = "254674118";
                    elif factory == "Fox QN":
                        spreadsheet_id = "1QS41MPzfsv5-_nNqjlTX4YDtze5jtM-UqZTnT-NwoQw";
                        gid = "1975095216";
                elif path_part == "recruitments":
                    gid = "1084935408"; # Pegatron
                    if factory == "Brother":
                        spreadsheet_id = "1MQ_M_l_Vugn-_eURR4qmCHylfpiM_pYfPTooJRsAut4";
                        gid = "2146286375";
                    elif factory == "LG":
                        spreadsheet_id = "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk";
                        gid = "1084935408";
                    elif factory == "Usi":
                        spreadsheet_id = "1539PRjUCZu98VQAQOrMdlcd6OcQftdony2J4wVQAFEU";
                        gid = "481655667";
                    elif factory == "Fox QN":
                        spreadsheet_id = "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20";
                        gid = "1084935408";

                url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/export?format=csv&gid={gid}"
                try:
                    print(f"[Proxy] Đang tải CSV: {path_part} (Nhà máy: {factory})...")
                    req = urllib.request.Request(
                        url,
                        headers={"User-Agent": "Mozilla/5.0 (compatible; PegatronDashboard/1.0)"}
                    )
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        data = resp.read()
                    self._send_json_or_csv(data, "text/csv; charset=utf-8")
                    print(f"[Proxy] ✅ {path_part} (Nhà máy: {factory}) ({len(data)} bytes)")
                except Exception as e:
                    print(f"[Proxy] ❌ Lỗi: {e}")
                    self.send_error(502, f"Lỗi Google Sheets: {e}")
                return

            # ── 1d. Proxy các API Tài chính sang Ruby Backend (port 3001) ─────────────
            target_url = f"http://localhost:3001{self.path}"
            try:
                print(f"[Proxy Finance GET] {self.path} -> port 3001")
                req = urllib.request.Request(target_url, method="GET")
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = resp.read()
                    content_type = resp.headers.get("Content-Type", "application/json")
                self._send_json_or_csv(data, content_type)
            except Exception as e:
                print(f"[Proxy Finance GET] ❌ Lỗi kết nối Ruby Backend: {e}")
                self.send_error(502, f"Không thể kết nối Finance server trên port 3001: {e}")
            return

        # ── 2. Phục vụ file tĩnh (popup.html, popup.css, popup.js ...) ──
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length) if content_length > 0 else b""
            
            target_url = f"http://localhost:3001{self.path}"
            try:
                print(f"[Proxy Finance POST] {self.path} -> port 3001")
                headers = {}
                for key, val in self.headers.items():
                    if key.lower() not in ["host", "content-length"]:
                        headers[key] = val
                
                req = urllib.request.Request(
                    target_url,
                    data=post_data,
                    headers=headers,
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=30) as resp:
                    resp_data = resp.read()
                    content_type = resp.headers.get("Content-Type", "application/json")
                    
                    self.send_response(resp.status)
                    for key, val in resp.headers.items():
                        if key.lower() not in ["content-length", "transfer-encoding"]:
                            self.send_header(key, val)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    self.wfile.write(resp_data)
                    print(f"[Proxy Finance POST] ✅ {self.path} ({len(resp_data)} bytes)")
            except urllib.error.HTTPError as e:
                resp_data = e.read()
                print(f"[Proxy Finance POST] ❌ HTTPError {e.code}: {resp_data[:100]}")
                self.send_response(e.code)
                for key, val in e.headers.items():
                    if key.lower() not in ["content-length", "transfer-encoding"]:
                        self.send_header(key, val)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(resp_data)
            except Exception as e:
                print(f"[Proxy Finance POST] ❌ Lỗi: {e}")
                self.send_error(502, f"Không thể gửi POST đến Finance server trên port 3001: {e}")
            return
            
        self.send_error(404)

    def _send_json_or_csv(self, data, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _handle_interview_colors(self):
        """
        Gọi Google Sheets API v4 để lấy màu nền cột Ngày DK/PV.
        Trả về JSON: { "row_index": true/false, ... }
        true  = ô màu vàng  → Hẹn PV xác nhận
        false = ô không màu → Lịch gọi lại
        """
        api_key = load_api_key()

        if not api_key:
            # Chưa cấu hình API Key — trả về lỗi có hướng dẫn
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            result = {
                "error": "no_api_key",
                "message": "Chưa cấu hình Google API Key. Xem hướng dẫn trong api_config.json."
            }
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
            return

        try:
            # Sheets API v4 endpoint lấy màu nền
            encoded_range = urllib.parse.quote(INTERVIEW_DATE_COL_RANGE)
            api_url = (
                f"https://sheets.googleapis.com/v4/spreadsheets/{SPREADSHEET_ID}"
                f"?includeGridData=true"
                f"&ranges={encoded_range}"
                f"&fields=sheets(data(rowData(values(effectiveFormat/backgroundColor))))"
                f"&key={api_key}"
            )
            print(f"[Colors] Đang lấy màu cột Ngày DK/PV...")
            req = urllib.request.Request(
                api_url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; PegatronDashboard/1.0)"}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read()
                sheets_data = json.loads(raw.decode("utf-8"))

            # Trích xuất màu từng dòng
            # sheets_data["sheets"][0]["data"][0]["rowData"][i]["values"][0]["effectiveCellColor"]
            row_colors = {}  # { row_index (0-based): is_yellow }
            rows = (
                sheets_data
                .get("sheets", [{}])[0]
                .get("data", [{}])[0]
                .get("rowData", [])
            )
            for i, row in enumerate(rows):
                values = row.get("values", [{}])
                effective_format = values[0].get("effectiveFormat", {}) if values else {}
                color = effective_format.get("backgroundColor", {})
                row_colors[i] = is_yellow(color)

            result = {"colors": row_colors, "error": None}
            print(f"[Colors] ✅ Đã lấy màu {len(row_colors)} dòng")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode("utf-8"))

        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8")
            print(f"[Colors] ❌ HTTP {e.code}: {body[:200]}")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"http_{e.code}", "message": body[:300]}).encode("utf-8"))
        except Exception as e:
            print(f"[Colors] ❌ Lỗi: {e}")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))


def main():
    os.chdir(EXTENSION_DIR)
    api_key = load_api_key()

    with socketserver.TCPServer(("", PORT), DashboardHandler) as httpd:
        print("=" * 60)
        print("   🚀 Pegatron HR Dashboard - Máy chủ cục bộ")
        print("=" * 60)
        print(f"\n   ✅ Đang chạy tại: http://localhost:{PORT}")
        print(f"   📂 Thư mục: {EXTENSION_DIR}")
        if api_key:
            print(f"   🔑 Google API Key: {'*' * 8}{api_key[-4:]} (đã cấu hình)")
        else:
            print("   ⚠️  Google API Key: CHƯA CẤU HÌNH")
            print("      → Phân loại màu ô PV sẽ không hoạt động.")
            print("      → Xem hướng dẫn lấy API Key bên dưới.")
        print("\n   Nhấn Ctrl+C để dừng.\n")
        print("-" * 60)
        if not api_key:
            print("\n  📋 HƯỚNG DẪN LẤY GOOGLE API KEY (MIỄN PHÍ):")
            print("  1. Truy cập: https://console.cloud.google.com/")
            print("  2. Tạo project mới (hoặc chọn project có sẵn)")
            print("  3. Vào: APIs & Services → Library")
            print("  4. Tìm 'Google Sheets API' → Bật lên (Enable)")
            print("  5. Vào: APIs & Services → Credentials")
            print("  6. Create Credentials → API key → Copy")
            print("  7. Dán vào file: api_config.json")
            print("      { \"google_api_key\": \"AIza...\" }")
            print("  8. Khởi động lại server này\n")
            print("-" * 60)

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[Server] Đã dừng máy chủ. Tạm biệt!")

if __name__ == "__main__":
    main()
