const fs = require('fs');
const path = require('path');

// Replicate the pure functions from popup.js for verification
function parseCSV(text) {
  const lines = [];
  let row = [""];
  let insideQuote = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];
    
    if (char === '"') {
      if (insideQuote && nextChar === '"') {
        row[row.length - 1] += '"';
        i++; // skip second quote
      } else {
        insideQuote = !insideQuote;
      }
    } else if (char === ',' && !insideQuote) {
      row.push("");
    } else if ((char === '\r' || char === '\n') && !insideQuote) {
      if (char === '\r' && nextChar === '\n') {
        i++; // skip LF after CR
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

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  if (dateStr === "" || dateStr === "0" || dateStr.toLowerCase() === "kđl" || dateStr.toLowerCase() === "knm" || dateStr.toLowerCase() === "kdl") return null;
  
  if (dateStr.includes(" ")) {
    dateStr = dateStr.split(" ")[0];
  }
  
  const parts = dateStr.split("/");
  if (parts.length === 2) {
    let day = parts[0].padStart(2, '0');
    let month = parts[1].padStart(2, '0');
    let year = "2026";
    if (/^\d+$/.test(day) && /^\d+$/.test(month)) {
      return `${year}-${month}-${day}`;
    }
  } else if (parts.length === 3) {
    let day = parts[0].padStart(2, '0');
    let month = parts[1].padStart(2, '0');
    let year = parts[2];
    if (year.length === 2) year = "20" + year;
    if (/^\d+$/.test(day) && /^\d+$/.test(month) && /^\d+$/.test(year)) {
      return `${year}-${month}-${day}`;
    }
  }
  
  const partsDash = dateStr.split("-");
  if (partsDash.length === 3) {
    let year = partsDash[0];
    let month = partsDash[1].padStart(2, '0');
    let day = partsDash[2].padStart(2, '0');
    if (year.length === 2) year = "20" + year;
    if (year.length === 4 && /^\d+$/.test(day) && /^\d+$/.test(month) && /^\d+$/.test(year)) {
      return `${year}-${month}-${day}`;
    }
  }
  
  return null;
}

function cleanRecruiter(rec) {
  if (!rec) return "Chưa rõ";
  rec = rec.trim();
  if (rec === "" || rec === "0") return "Chưa rõ";
  
  const recUpper = rec.toUpperCase();
  if (recUpper === "HÙNG") return "Hùng";
  if (recUpper === "HUY") return "Huy";
  if (rec === "C Ly" || recUpper === "LY") return "Ly";
  if (rec === "Leo Trần" || recUpper === "LEO") return "Leo";
  
  return rec.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function cleanSource(src) {
  if (!src) return "Chưa rõ";
  src = src.trim();
  if (src === "" || src === "0") return "Chưa rõ";
  return src;
}

// Main Test Execution
try {
  const candidatesPath = path.join(__dirname, '../../Danh_sach_ung_vien_Pegatron.csv');
  console.log(`Đọc file ứng viên từ: ${candidatesPath}`);
  
  const csvContent = fs.readFileSync(candidatesPath, 'utf8');
  console.log("Kích thước file:", csvContent.length, "bytes");
  
  const rows = parseCSV(csvContent);
  console.log(`Số lượng dòng parse được: ${rows.length}`);
  
  // Verify columns for first row
  console.log("\n--- Dòng tiêu đề ---");
  const headers = rows[0].map(h => h.trim().replace(/\n/g, ' '));
  console.log(headers);
  
  // Find indices
  const idxTimestamp = 0;
  const idxDKPV = headers.indexOf("Ngày DK/PV");
  const idxCSCuoi = headers.indexOf("Ngày CS cuối");
  const idxNguon = headers.indexOf("Nguồn data");
  const idxNguoiCS = headers.indexOf("Người chăm sóc");
  
  console.log(`\nChỉ số cột:`);
  console.log(`- Dấu thời gian (Timestamp): ${idxTimestamp}`);
  console.log(`- Ngày DK/PV: ${idxDKPV}`);
  console.log(`- Ngày CS cuối: ${idxCSCuoi}`);
  console.log(`- Nguồn data: ${idxNguon}`);
  console.log(`- Người chăm sóc: ${idxNguoiCS}`);
  
  // Process stats
  const dailyStats = {};
  const ensureDate = (date) => {
    if (!dailyStats[date]) {
      dailyStats[date] = {
        newCount: 0,
        interviewCount: 0,
        processedCount: 0,
        sourcesByReg: {},
        recruitersByReg: {},
        sourcesByCare: {},
        recruitersByCare: {}
      };
    }
  };
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 9) continue;
    
    const regDate = normalizeDate(row[0]);
    const interviewDate = normalizeDate(row[idxDKPV]);
    const careDate = normalizeDate(row[idxCSCuoi]);
    const source = cleanSource(row[idxNguon]);
    const recruiter = cleanRecruiter(row[idxNguoiCS]);
    
    if (regDate) {
      ensureDate(regDate);
      dailyStats[regDate].newCount++;
      dailyStats[regDate].sourcesByReg[source] = (dailyStats[regDate].sourcesByReg[source] || 0) + 1;
      dailyStats[regDate].recruitersByReg[recruiter] = (dailyStats[regDate].recruitersByReg[recruiter] || 0) + 1;
    }
    if (careDate) {
      ensureDate(careDate);
      dailyStats[careDate].processedCount++;
      dailyStats[careDate].sourcesByCare[source] = (dailyStats[careDate].sourcesByCare[source] || 0) + 1;
      dailyStats[careDate].recruitersByCare[recruiter] = (dailyStats[careDate].recruitersByCare[recruiter] || 0) + 1;
    }
    if (interviewDate) {
      ensureDate(interviewDate);
      dailyStats[interviewDate].interviewCount++;
    }
  }
  
  const dates = Object.keys(dailyStats).sort((a, b) => b.localeCompare(a));
  console.log(`\nTổng số ngày có dữ liệu: ${dates.length}`);
  
  console.log("\n--- Top 5 ngày gần nhất ---");
  for (let i = 0; i < Math.min(5, dates.length); i++) {
    const d = dates[i];
    const s = dailyStats[d];
    console.log(`\nNgày: ${d}`);
    console.log(`- Data Mới: ${s.newCount}`);
    console.log(`- Lịch PV: ${s.interviewCount}`);
    console.log(`- Đang xử lý (CS cuối): ${s.processedCount}`);
    
    // Show distribution by care date if there is processed data
    if (s.processedCount > 0) {
      console.log(`  * Phân phối Người Chăm Sóc (Theo Ngày CS):`, s.recruitersByCare);
      console.log(`  * Phân phối Nguồn data (Theo Ngày CS):`, s.sourcesByCare);
    }
    // Show distribution by registration date if there is new data
    if (s.newCount > 0) {
      console.log(`  * Phân phối Người Chăm Sóc (Theo Ngày đăng ký):`, s.recruitersByReg);
      console.log(`  * Phân phối Nguồn data (Theo Ngày đăng ký):`, s.sourcesByReg);
    }
  }
  
  console.log("\n✅ KIỂM TRA TỰ ĐỘNG THÀNH CÔNG!");
} catch (e) {
  console.error("❌ LỖI KHI CHẠY TEST:", e);
}
