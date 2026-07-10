function parseCSV(text) {
  const lines = [];
  let row = [""];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        row[row.length - 1] += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push("");
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      lines.push(row);
      row = [""];
    } else {
      row[row.length - 1] += char;
    }
  }
  if (row.length > 1 || row[0] !== "") {
    lines.push(row);
  }
  return lines;
}

function parseSheetDate(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!s) return null;
  const parts = s.split('/');
  if (parts.length < 2) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  let year = 2026;
  if (parts.length >= 3) {
    const yr = parts[2].trim();
    if (yr.length === 2) {
      year = 2000 + parseInt(yr, 10);
    } else if (yr.length === 4) {
      year = parseInt(yr, 10);
    }
  }
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function normalizePhone(phone) {
  if (!phone) return "";
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.length === 9) {
    cleaned = "0" + cleaned;
  }
  return cleaned;
}

function normalizeCccd(cccd) {
  if (!cccd) return "";
  let cleaned = String(cccd).replace(/\D/g, '');
  if (cleaned.length > 0 && cleaned.length < 12) {
    cleaned = cleaned.padStart(12, '0');
  }
  return cleaned;
}

const https = require("https");

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error("Too many redirects"));
    }
    https.get(url, (res) => {
      // Tự động chuyển hướng nếu nhận được mã trạng thái 3xx
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location, redirectCount + 1));
      }
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve(data);
      });
    }).on("error", (err) => {
      reject(err);
    });
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", "application/json");

  const url = "https://docs.google.com/spreadsheets/d/1Rx9rDMe1t8A76Sj-4nBsYjbO49dzw-beYMYFF0ffk1E/export?format=csv&gid=0";

  try {
    const csvText = await fetchUrl(url);
    const parsedRows = parseCSV(csvText);

    if (parsedRows.length <= 1) {
      return res.status(200).json([]);
    }

    const headers = parsedRows[0].map(h => h.trim().toLowerCase());
    const factoryIdx = headers.findIndex(h => h.includes("nhà máy") || h.includes("factory"));
    const sourceIdx = headers.findIndex(h => h.includes("nguồn") || h.includes("source"));
    const employeeIdIdx = headers.findIndex(h => h.includes("mã nv") || h.includes("employee_id") || h.includes("mã nhân viên"));
    const fullNameIdx = headers.findIndex(h => h.includes("họ và tên") || h.includes("full_name") || h.includes("tên"));
    const phoneIdx = headers.findIndex(h => h.includes("số đt") || h.includes("sđt") || h.includes("phone"));
    const cccdIdx = headers.findIndex(h => h.includes("cccd") || h.includes("số cccd"));
    const boardingDateIdx = headers.findIndex(h => h.includes("nhận việc") || h.includes("boarding_date") || h.includes("ngày nhận việc"));
    const endDateIdx = headers.findIndex(h => h.includes("kết thúc") || h.includes("end_date") || h.includes("ngày kết thúc"));

    const candidates = [];
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    for (let i = 1; i < parsedRows.length; i++) {
      const row = parsedRows[i];
      if (row.length <= 1) continue;
      
      const full_name = row[fullNameIdx] ? row[fullNameIdx].trim() : "";
      if (!full_name) continue;

      const factory = row[factoryIdx] ? row[factoryIdx].trim() : "";
      const source = row[sourceIdx] ? row[sourceIdx].trim() : "";
      const employee_id = row[employeeIdIdx] ? row[employeeIdIdx].trim() : "";
      const phone = normalizePhone(row[phoneIdx]);
      const cccd = normalizeCccd(row[cccdIdx]);
      const boarding_date = parseSheetDate(row[boardingDateIdx]);
      const end_date_str = row[endDateIdx] ? row[endDateIdx].trim() : "";
      const has_explicit_end_date = end_date_str !== "";

      let end_date = parseSheetDate(end_date_str);
      if (!end_date && boarding_date) {
        const bDate = new Date(boarding_date);
        if (factory === 'Canon' || factory === 'CN') {
          bDate.setMonth(bDate.getMonth() + 6);
        } else {
          bDate.setDate(bDate.getDate() + 90);
        }
        const year = bDate.getFullYear();
        const mm = String(bDate.getMonth() + 1).padStart(2, '0');
        const dd = String(bDate.getDate()).padStart(2, '0');
        end_date = `${year}-${mm}-${dd}`;
      }

      let status = 'Đang làm việc';
      let resignation_date = null;

      if (has_explicit_end_date && end_date && boarding_date) {
        const expectedEnd = new Date(boarding_date);
        if (factory === 'Canon' || factory === 'CN') {
          expectedEnd.setMonth(expectedEnd.getMonth() + 6);
        } else {
          expectedEnd.setDate(expectedEnd.getDate() + 90);
        }
        const toleranceLimit = new Date(expectedEnd.getTime() - 3 * 24 * 60 * 60 * 1000);
        const actualEnd = new Date(end_date);

        if (actualEnd >= toleranceLimit) {
          status = 'Hết hạn';
        } else {
          status = 'Nghỉ việc';
          resignation_date = end_date;
        }
      } else if (end_date && end_date < todayStr) {
        status = 'Hết hạn';
      } else {
        status = 'Đang làm việc';
      }

      candidates.push({
        id: i,
        employee_id,
        full_name,
        phone,
        cccd,
        factory,
        boarding_date,
        end_date,
        resignation_date,
        source,
        status,
        unit: (factory === 'Wistron') ? 'Giờ làm' : 'Ngày'
      });
    }

    res.status(200).json(candidates);
  } catch (error) {
    res.status(502).json({ error: `Error fetching finance candidates CSV: ${error.message}` });
  }
};
