// Google Spreadsheet Export URLs
// Khi chạy trên localhost (qua server.py), dùng proxy cục bộ để tránh lỗi CORS
// Khi chạy trong Chrome Extension, gọi trực tiếp Google Sheets
const IS_CHROME_EXT = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
const URL_CANDIDATES       = IS_CHROME_EXT
  ? "https://docs.google.com/spreadsheets/d/1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20/export?format=csv&gid=1671069143"
  : "/api/candidates";
const URL_RECRUITMENTS     = IS_CHROME_EXT
  ? "https://docs.google.com/spreadsheets/d/1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20/export?format=csv&gid=1084935408"
  : "/api/recruitments";
// Endpoint lấy màu ô Ngày DK/PV
const URL_INTERVIEW_COLORS = IS_CHROME_EXT ? null : "/api/interview-colors";

// Fallback Storage Helper (Works in Chrome Extension & Standard Web Browsers for easy testing)
const storage = {
  get: (keys, callback) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(keys, callback);
    } else {
      const result = {};
      keys.forEach(k => {
        const val = localStorage.getItem(k);
        try {
          result[k] = val ? JSON.parse(val) : null;
        } catch (e) {
          result[k] = val;
        }
      });
      callback(result);
    }
  },
  set: (data, callback) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set(data, callback);
    } else {
      Object.entries(data).forEach(([k, v]) => {
        localStorage.setItem(k, typeof v === 'object' ? JSON.stringify(v) : v);
      });
      if (callback) callback();
    }
  }
};

// State variables
let state = {
  // Raw CSV arrays by factory
  factoryData: {
    Pegatron: { candidates: [], recruitments: [], rowColors: {} },
    Brother: { candidates: [], recruitments: [], rowColors: {} },
    LG: { candidates: [], recruitments: [], rowColors: {} },
    Usi: { candidates: [], recruitments: [], rowColors: {} },
    "Fox QN": { candidates: [], recruitments: [], rowColors: {} }
  },
  selectedFactory: "All", // Filter mode: 'All', 'Pegatron', 'Brother', 'LG', 'Usi', 'Fox QN'
  
  candidates: [],     // Active filtered candidates (merged or single factory)
  recruitments: [],   // Active filtered recruitments
  rowColors: {},      // Active row colors
  hasColorData: true,
  candidateHistory: {},
  dailyStats: {},
  datesList: [],
  lastSync: null,
  refreshTimer: null,
  countdownSeconds: 10,
  lastPopulatedMode: "",
  lastDatesListLength: 0
};

// Robust CSV parser (handles commas and newlines inside quoted values)
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

// Date Normalizer - returns 'YYYY-MM-DD' or null. Default year is 2026.
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  if (dateStr === "" || dateStr === "0" || dateStr.toLowerCase() === "kđl" || dateStr.toLowerCase() === "knm" || dateStr.toLowerCase() === "kdl") return null;
  
  // Replace dots with slashes for dates like "9.6"
  dateStr = dateStr.replace(/\./g, "/");

  // Extract date part from timestamps like "25/02/2026 10:35:10"
  if (dateStr.includes(" ")) {
    dateStr = dateStr.split(" ")[0];
  }
  
  // Try DD/MM/YYYY or D/M/YYYY or D/M
  const parts = dateStr.split("/");
  if (parts.length === 2) {
    let day = parts[0].padStart(2, '0');
    let month = parts[1].padStart(2, '0');
    let year = "2026"; // Default year for the spreadsheet dataset
    if (/^\d+$/.test(day) && /^\d+$/.test(month)) {
      const d = parseInt(day);
      const m = parseInt(month);
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
        return `${year}-${month}-${day}`;
      }
    }
  } else if (parts.length === 3) {
    let day = parts[0].padStart(2, '0');
    let month = parts[1].padStart(2, '0');
    let year = parts[2];
    if (year.length === 2) year = "20" + year; // Convert "26" to "2026"
    if (/^\d+$/.test(day) && /^\d+$/.test(month) && /^\d+$/.test(year)) {
      const d = parseInt(day);
      const m = parseInt(month);
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
        return `${year}-${month}-${day}`;
      }
    }
  }
  
  // Try YYYY-MM-DD
  const partsDash = dateStr.split("-");
  if (partsDash.length === 3) {
    let year = partsDash[0];
    let month = partsDash[1].padStart(2, '0');
    let day = partsDash[2].padStart(2, '0');
    if (year.length === 2) year = "20" + year;
    if (year.length === 4 && /^\d+$/.test(day) && /^\d+$/.test(month) && /^\d+$/.test(year)) {
      const d = parseInt(day);
      const m = parseInt(month);
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
        return `${year}-${month}-${day}`;
      }
    }
  }
  
  return null;
}

// Clean Recruiter name
function cleanRecruiter(rec) {
  if (!rec) return "Chưa rõ";
  rec = rec.trim();
  if (rec === "" || rec === "0") return "Chưa rõ";
  
  const recUpper = rec.toUpperCase();
  if (recUpper === "HÙNG") return "Hùng";
  if (recUpper === "HUY") return "Huy";
  if (rec === "C Ly" || recUpper === "LY") return "Ly";
  if (rec === "Leo Trần" || recUpper === "LEO") return "Leo";
  if (recUpper === "HẢI NGUYÊN" || recUpper === "HẢI NGUYÊN ") return "Hải Nguyên";
  
  return rec.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// Clean Source name
function cleanSource(src) {
  if (!src) return "Chưa rõ";
  src = src.trim();
  if (src === "" || src === "0") return "Chưa rõ";
  return src;
}

// Clean and parse numbers for Marketing calculation
function cleanNumber(str) {
  if (str === undefined || str === null) return 0;
  let s = String(str).trim();
  s = s.replace(/[đĐ\s]/g, ""); // Xóa ký tự đ và khoảng trắng
  s = s.replace(/\./g, "");     // Xóa dấu chấm phân tách phần nghìn
  s = s.replace(/,/g, "");      // Xóa dấu phẩy
  return parseFloat(s) || 0;
}

// Format date for UI: YYYY-MM-DD -> DD/MM/YYYY
function formatUIDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

// Format date for short UI: YYYY-MM-DD -> DD/MM
function formatUIShortDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}`;
  }
  return dateStr;
}

// Process Raw CSV data and build statistics
// rowColors: { "1": true, "5": false, ... } — chỉ số dòng (0-based, cả tiêu đề dòng 0) trên cột Ngày DK/PV
function processData(candidatesRows, recruitmentsRows, rowColors = {}, candidateHistoryArg = {}, hasColorData = false) {
  const dailyStats = {};
  const candidateHistory = {};
  let overdueCareCount = 0;
  
  // Get current local date of the user computer
  const localToday = new Date();
  const todayStr = `${localToday.getFullYear()}-${String(localToday.getMonth() + 1).padStart(2, '0')}-${String(localToday.getDate()).padStart(2, '0')}`;
  const parts = todayStr.split("-");
  const todayObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  
  // Helper to ensure date object exists in stats
  const ensureDateObject = (date) => {
    if (!dailyStats[date]) {
      dailyStats[date] = {
        newCount: 0,
        interviewConfirmed: 0,  // Ô vàng = Hẹn PV xác nhận
        interviewCallback: 0,   // Ô không màu = Lịch gọi lại / Chăm sóc lại
        callbackProcessed: 0,   // Đã chăm sóc lại thành công
        interviewCount: 0,      // Tổng (confirmed + callback)
        hireCount: 0,
        processedCount: 0,
        // Distributions by Registration Date
        sourcesByReg: {},
        recruitersByReg: {},
        // Distributions by Last Care Date
        sourcesByCare: {},
        recruitersByCare: {},
        // Distributions by Interview and Hire (for donut charts)
        sourcesByInterview: {},
        recruitersByInterview: {},
        sourcesByHire: {},
        recruitersByHire: {},
        // Detailed daily stats per recruiter (for daily report table)
        recruitersDaily: {} // { recruiterName: { reg: 0, care: 0, interviewConfirmed: 0, interviewCallback: 0, hire: 0 } }
      };
    }
  };

  // 1. Process candidates sheet (Skip header row 0)
  if (candidatesRows.length > 1) {
    for (let i = 1; i < candidatesRows.length; i++) {
      const row = candidatesRows[i];
      if (row.length < 18) continue;
      
      const regDate      = normalizeDate(row[0]);   // Timestamp (Cột 0)
      const interviewDate = normalizeDate(row[12]);  // Hẹn phỏng vấn (Cột 12)
      const nextCareDate  = normalizeDate(row[14]);  // Ngày CS tiếp theo (Cột 14)
      const hireDate     = normalizeDate(row[16]);  // Nhận Việc (Cột 16)
      const careDate     = normalizeDate(row[17]);  // Ngày CS cuối (Cột 17)
      const source       = cleanSource(row[7]);     // Nguồn data (Cột 7)
      const recruiter    = cleanRecruiter(row[8]);  // Người chăm sóc (Cột 8)
      const status       = row[13] ? row[13].trim().toLowerCase() : "";
      
      // Tính toán chăm sóc bị trễ (nextCareDate nhỏ hơn hôm nay, có bất kỳ trạng thái nào, và chưa có ngày CS cuối tương ứng)
      if (nextCareDate && nextCareDate < todayStr && status) {
        if (!careDate || careDate < nextCareDate) {
          overdueCareCount++;
        }
      }
      
      // Grouping stats by Registration Date
      if (regDate) {
        ensureDateObject(regDate);
        dailyStats[regDate].newCount++;
        dailyStats[regDate].sourcesByReg[source] = (dailyStats[regDate].sourcesByReg[source] || 0) + 1;
        dailyStats[regDate].recruitersByReg[recruiter] = (dailyStats[regDate].recruitersByReg[recruiter] || 0) + 1;
        
        // Detailed recruiter stats
        if (!dailyStats[regDate].recruitersDaily[recruiter]) {
          dailyStats[regDate].recruitersDaily[recruiter] = { reg: 0, care: 0, interviewConfirmed: 0, interviewCallback: 0, hire: 0 };
        }
        dailyStats[regDate].recruitersDaily[recruiter].reg++;
      }
      
      // Grouping stats by Last Care Date (Data Processed)
      if (careDate) {
        ensureDateObject(careDate);
        dailyStats[careDate].processedCount++;
        dailyStats[careDate].sourcesByCare[source] = (dailyStats[careDate].sourcesByCare[source] || 0) + 1;
        dailyStats[careDate].recruitersByCare[recruiter] = (dailyStats[careDate].recruitersByCare[recruiter] || 0) + 1;
        
        // Detailed recruiter stats
        if (!dailyStats[careDate].recruitersDaily[recruiter]) {
          dailyStats[careDate].recruitersDaily[recruiter] = { reg: 0, care: 0, interviewConfirmed: 0, interviewCallback: 0, hire: 0 };
        }
        dailyStats[careDate].recruitersDaily[recruiter].care++;
      }
      
      // Candidate unique key (using Phone or Name)
      const candPhone = row[2] ? row[2].trim() : "";
      const candName  = row[1] ? row[1].trim() : "";
      const candKey   = candPhone || candName || `row_${i}`;

      if (candKey) {
        // If the candidate has an invalid status on the sheet, they should not have an active interview date for today/future
        const isInvalidStatus = ["kđl", "knm", "kdl", "bùng pv", "từ chối", "ko đạt"].includes(status);
        
        if (!candidateHistory[candKey]) {
          const existing = candidateHistoryArg[candKey] || { interviewDates: [], careDates: [] };
          // Preserve historical interview dates from today and past (freeze them <= todayStr)
          const frozenInterviews = (existing.interviewDates || []).filter(d => d <= todayStr);
          
          candidateHistory[candKey] = {
            interviewDates: frozenInterviews,
            careDates: (existing.careDates || []).filter(d => d <= todayStr)
          };
        }
        
        // Save only the current active interviewDate from the sheet row (exclude KĐL, KNM, bùng pv, từ chối, ko đạt)
        const isInterviewStatus = (status === "hẹn phỏng vấn" || status === "đã nhận việc" || status === "chuyển nhà máy khác");
        
        // Vì dữ liệu trên Sheet được sắp xếp giảm dần theo thời gian (dòng mới nhất ở trên cùng),
        // Ta chỉ cho phép dòng đầu tiên duyệt qua (dòng mới nhất của ứng viên) cập nhật trạng thái hoạt động.
        // Các dòng cũ duyệt sau (khi candidateHistory[candKey] đã có dữ liệu từ dòng trước đó) KHÔNG được phép ghi đè làm mất lịch hẹn tương lai.
        const isFirstAppearance = !candidateHistoryArg[candKey] || (candidateHistory[candKey].interviewDates.length === 0 && candidateHistory[candKey].careDates.length === 0);
        
        if (interviewDate && (status === "hẹn phỏng vấn" || isInterviewStatus) && !isInvalidStatus) {
          if (interviewDate > todayStr) {
            candidateHistory[candKey].interviewDates = [
              ...candidateHistory[candKey].interviewDates.filter(d => d <= todayStr),
              interviewDate
            ];
          } else {
            if (!candidateHistory[candKey].interviewDates.includes(interviewDate)) {
              candidateHistory[candKey].interviewDates.push(interviewDate);
            }
          }
        } else {
          // Chỉ cho phép xóa lịch hẹn tương lai nếu đây là dòng trạng thái mới nhất (duyệt lần đầu) và trạng thái đó thực sự bị hủy
          // Nếu đã duyệt qua dòng active trước đó rồi thì bỏ qua không filter để tránh dòng cũ ghi đè.
          const alreadyProcessedInCurrentRun = (candidateHistory[candKey].interviewDates.length > 0 && !isFirstAppearance);
          if (!alreadyProcessedInCurrentRun) {
            candidateHistory[candKey].interviewDates = candidateHistory[candKey].interviewDates.filter(d => d <= todayStr);
          }
        }
        
        const isCareStatus = (status === "chăm sóc tiếp" || status === "đã nhận việc" || status === "hẹn phỏng vấn" || status === "bùng pv" || status === "knm" || status === "từ chối" || status === "ko đạt" || status === "chuyển nhà máy khác" || status === "khác");
        
        // Apply freeze logic for careDates (Lịch chăm sóc lại): Only add or update dynamically if > todayStr. Keep <= todayStr frozen.
        if (nextCareDate && (status === "chăm sóc tiếp" || isCareStatus)) {
          if (nextCareDate > todayStr) {
            candidateHistory[candKey].careDates = [
              ...candidateHistory[candKey].careDates.filter(d => d <= todayStr),
              nextCareDate
            ];
          } else {
            if (!candidateHistory[candKey].careDates.includes(nextCareDate)) {
              candidateHistory[candKey].careDates.push(nextCareDate);
            }
          }
        }
        if (careDate) {
          if (careDate > todayStr) {
            candidateHistory[candKey].careDates = [
              ...candidateHistory[candKey].careDates.filter(d => d <= todayStr),
              careDate
            ];
          } else {
            if (!candidateHistory[candKey].careDates.includes(careDate)) {
              candidateHistory[candKey].careDates.push(careDate);
            }
          }
        }

      }
    }
  }

  // Update global state and persist candidateHistory immediately to storage to prevent loss between filters
  state.candidateHistory = candidateHistory;
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.set({ candidateHistory: candidateHistory });
  } else {
    localStorage.setItem("candidateHistory", JSON.stringify(candidateHistory));
  }

  // 1. Grouping stats by Interview Date (Hẹn phỏng vấn) using history (deduplicated per candidate)
  Object.entries(candidateHistory).forEach(([candKey, hist]) => {
    // Tìm thông tin recruiter và source từ bản ghi gốc khớp với candKey
    let recruiter = "Chưa rõ";
    let source = "Chưa rõ";
    let status = "";
    for (let i = 1; i < candidatesRows.length; i++) {
      const row = candidatesRows[i];
      if (row.length < 18) continue;
      const cp = row[2] ? row[2].trim() : "";
      const cn = row[1] ? row[1].trim() : "";
      const key = cp || cn || `row_${i}`;
      if (key === candKey) {
        recruiter = cleanRecruiter(row[8]);
        source = cleanSource(row[7]);
        status = row[13] ? row[13].trim().toLowerCase() : "";
        // Ưu tiên dòng có trạng thái active
        if (status === "hẹn phỏng vấn" || status === "đã nhận việc") {
          break;
        }
      }
    }

    const isInvalidStatus = ["kđl", "knm", "kdl", "bùng pv", "từ chối", "ko đạt"].includes(status);
    if (!isInvalidStatus) {
      if (hist.interviewDates) {
        // Filter out dates that match invalid status on the sheet
        const validDates = hist.interviewDates.filter(intDate => {
          // If this row has this date but status is now invalid, we filter it out
          return !isInvalidStatus; 
        });
        
        validDates.forEach(intDate => {
          ensureDateObject(intDate);
          
          if (!dailyStats[intDate].recruitersDaily[recruiter]) {
            dailyStats[intDate].recruitersDaily[recruiter] = { reg: 0, care: 0, interviewConfirmed: 0, interviewCallback: 0, hire: 0 };
          }
          
          dailyStats[intDate].interviewConfirmed++;
          dailyStats[intDate].recruitersDaily[recruiter].interviewConfirmed++;
          
          dailyStats[intDate].interviewCount++;
          dailyStats[intDate].sourcesByInterview[source] = (dailyStats[intDate].sourcesByInterview[source] || 0) + 1;
          dailyStats[intDate].recruitersByInterview[recruiter] = (dailyStats[intDate].recruitersByInterview[recruiter] || 0) + 1;
        });
      }
    }

    if (hist.careDates) {
      hist.careDates.forEach(cDate => {
        ensureDateObject(cDate);

        if (!dailyStats[cDate].recruitersDaily[recruiter]) {
          dailyStats[cDate].recruitersDaily[recruiter] = { reg: 0, care: 0, interviewConfirmed: 0, interviewCallback: 0, hire: 0 };
        }

        dailyStats[cDate].interviewCallback++;
        dailyStats[cDate].recruitersDaily[recruiter].interviewCallback++;

        // Kiểm tra xem careDate gần nhất của ứng viên này có trùng cDate
        let candidateCareDate = null;
        for (let i = 1; i < candidatesRows.length; i++) {
          const row = candidatesRows[i];
          if (row.length < 18) continue;
          const cp = row[2] ? row[2].trim() : "";
          const cn = row[1] ? row[1].trim() : "";
          const key = cp || cn || `row_${i}`;
          if (key === candKey && row[17]) {
            candidateCareDate = normalizeDate(row[17]);
            break;
          }
        }
        if (candidateCareDate === cDate) {
          dailyStats[cDate].callbackProcessed = (dailyStats[cDate].callbackProcessed || 0) + 1;
        }
      });
    }
  });

  // 3. Grouping stats by Hire Date (Nhận Việc)
  if (candidatesRows.length > 1) {
    for (let i = 1; i < candidatesRows.length; i++) {
      const row = candidatesRows[i];
      if (row.length < 18) continue;
      
      const hireDate  = normalizeDate(row[16]);
      const status    = row[13] ? row[13].trim().toLowerCase() : "";
      const source    = cleanSource(row[7]);
      const recruiter = cleanRecruiter(row[8]);

      if (hireDate && status === "đã nhận việc") {
        ensureDateObject(hireDate);
        dailyStats[hireDate].hireCount++;
        dailyStats[hireDate].sourcesByHire[source] = (dailyStats[hireDate].sourcesByHire[source] || 0) + 1;
        dailyStats[hireDate].recruitersByHire[recruiter] = (dailyStats[hireDate].recruitersByHire[recruiter] || 0) + 1;

        if (!dailyStats[hireDate].recruitersDaily[recruiter]) {
          dailyStats[hireDate].recruitersDaily[recruiter] = { reg: 0, care: 0, interviewConfirmed: 0, interviewCallback: 0, hire: 0 };
        }
        dailyStats[hireDate].recruitersDaily[recruiter].hire++;
      }
    }
  }

  // Lấy toàn bộ các ngày có dữ liệu từ spreadsheet
  const spreadsheetDates = Object.keys(dailyStats);
  
  // Tạo 180 ngày tiếp theo sau ngày hôm nay
  const futureDates = [];
  for (let i = 1; i <= 180; i++) {
    const d = new Date(todayObj);
    d.setDate(todayObj.getDate() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const fStr = `${y}-${m}-${day}`;
    futureDates.push(fStr);
    
    // Đảm bảo có object thống kê rỗng cho ngày tương lai để tránh crash
    if (!dailyStats[fStr]) {
      dailyStats[fStr] = {
        newCount: 0,
        interviewConfirmed: 0,
        interviewCallback: 0,
        callbackProcessed: 0,
        interviewCount: 0,
        hireCount: 0,
        processedCount: 0,
        sourcesByReg: {},
        recruitersByReg: {},
        sourcesByCare: {},
        recruitersByCare: {},
        sourcesByInterview: {},
        recruitersByHire: {},
        recruitersDaily: {}
      };
    }
  }

  // Kết hợp và sắp xếp giảm dần (ngày tương lai xa nhất ở trên cùng, lùi dần về hôm nay và quá khứ)
  const allDates = [...spreadsheetDates, ...futureDates];
  const datesList = Array.from(new Set(allDates)).sort((a, b) => b.localeCompare(a));
  
  return { dailyStats, datesList, candidateHistory, overdueCareCount };
}

// Fetch and sync data from Google Sheets for all factories
async function syncData() {
  const syncStatus = document.getElementById("sync-status");
  const refreshBtn = document.getElementById("refresh-btn");
  
  syncStatus.textContent = "Đang đồng bộ...";
  syncStatus.className = "sync-status text-cyan";
  refreshBtn.classList.add("spinning");
  
  try {
    const fetchWithTimeout = (url, options = {}, timeout = 15000) => {
      return Promise.race([
        fetch(url, options),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
      ]);
    };
    
    // Gids mapping for factories Candidate lists
    const factoryGids = {
      Pegatron: { candidates: "1671069143", recruitments: "1084935408" },
      Brother: { candidates: "128053512", recruitments: "2146286375" },
      LG: { candidates: "1326786598", recruitments: "1084935408" },
      Usi: { candidates: "254674118", recruitments: "481655667" },
      "Fox QN": { candidates: "1975095216", recruitments: "1084935408" } // Using empty/placeholder for Fox QN recruitments since it is not used or same gid
    };
    
    const factories = ["Pegatron", "Brother", "LG", "Usi", "Fox QN"];
    const fetchPromises = [];
    
    factories.forEach(f => {
      let candUrl = "";
      let recUrl = "";
      if (IS_CHROME_EXT) {
        candUrl = `https://docs.google.com/spreadsheets/d/${f === "Pegatron" ? "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20" : f === "Brother" ? "1MQ_M_l_Vugn-_eURR4qmCHylfpiM_pYfPTooJRsAut4" : f === "LG" ? "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk" : f === "Usi" ? "1539PRjUCZu98VQAQOrMdlcd6OcQftdony2J4wVQAFEU" : "1QS41MPzfsv5-_nNqjlTX4YDtze5jtM-UqZTnT-NwoQw"}/export?format=csv&gid=${factoryGids[f].candidates}`;
        recUrl = `https://docs.google.com/spreadsheets/d/${f === "Pegatron" ? "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20" : f === "Brother" ? "1MQ_M_l_Vugn-_eURR4qmCHylfpiM_pYfPTooJRsAut4" : f === "LG" ? "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk" : f === "Usi" ? "1539PRjUCZu98VQAQOrMdlcd6OcQftdony2J4wVQAFEU" : "1QS41MPzfsv5-_nNqjlTX4YDtze5jtM-UqZTnT-NwoQw"}/export?format=csv&gid=${factoryGids[f].recruitments}`;
      } else {
        candUrl = `/api/candidates?factory=${f}`;
        recUrl = `/api/recruitments?factory=${f}`;
      }
      fetchPromises.push(
        fetchWithTimeout(candUrl).then(r => r.text()).then(t => ({ factory: f, type: 'candidates', text: t })),
        fetchWithTimeout(recUrl).then(r => r.text()).then(t => ({ factory: f, type: 'recruitments', text: t }))
      );
    });
    
    const results = await Promise.all(fetchPromises);
    
    // Parse and store raw data in state.factoryData
    results.forEach(res => {
      const parsed = parseCSV(res.text);
      state.factoryData[res.factory][res.type] = parsed;
    });
    
    // Save to Cache
    const cacheData = {};
    factories.forEach(f => {
      cacheData[`${f}_candidatesCSV`] = results.find(r => r.factory === f && r.type === 'candidates').text;
      cacheData[`${f}_recruitmentsCSV`] = results.find(r => r.factory === f && r.type === 'recruitments').text;
    });
    cacheData['candidateHistory'] = state.candidateHistory;
    cacheData['lastSyncTime'] = new Date().toISOString();
    storage.set(cacheData);
    
    // Apply filter state
    applyFactoryFilter();
    
    state.lastSync = new Date();
    const timeStr = state.lastSync.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    syncStatus.textContent = `Đã đồng bộ lúc ${timeStr}`;
    syncStatus.className = "sync-status text-muted";
    resetCountdown();
  } catch (err) {
    console.error("Sync error:", err);
    syncStatus.textContent = "Lỗi kết nối. Hiển thị dữ liệu cũ.";
    syncStatus.className = "sync-status text-amber";
  } finally {
    refreshBtn.classList.remove("spinning");
  }
}

// Function to apply filter and rebuild metrics
function applyFactoryFilter() {
  const factoryEl = document.getElementById("dashboard-factory-select");
  const selectedFactory = factoryEl ? factoryEl.value : "All";
  state.selectedFactory = selectedFactory;
  
  let mergedCandidates = [];
  let mergedRecruitments = [];
  
  if (selectedFactory === "All") {
    // Merge all candidates sheets (keep only first sheet header, skip others)
    const factories = ["Pegatron", "Brother", "LG", "Usi", "Fox QN"];
    factories.forEach((f, fIdx) => {
      const cand = state.factoryData[f].candidates || [];
      const rec = state.factoryData[f].recruitments || [];
      if (cand.length > 0) {
        if (mergedCandidates.length === 0) {
          const header = [...cand[0]];
          header.push("FactoryName"); // Add factory column index 18
          mergedCandidates.push(header); // Header row
        }
        for (let i = 1; i < cand.length; i++) {
          const row = [...cand[i]];
          row[18] = f; // Map factory name to column index 18
          mergedCandidates.push(row);
        }
      }
      if (rec.length > 0) {
        if (mergedRecruitments.length === 0) {
          const header = [...rec[0]];
          header.push("FactoryName");
          mergedRecruitments.push(header); // Header row
        }
        for (let i = 1; i < rec.length; i++) {
          const row = [...rec[i]];
          row[18] = f;
          mergedRecruitments.push(row);
        }
      }
    });
  } else {
    const cand = state.factoryData[selectedFactory].candidates || [];
    const rec = state.factoryData[selectedFactory].recruitments || [];
    mergedCandidates = cand.map(r => {
      const row = [...r];
      row[18] = selectedFactory;
      return row;
    });
    mergedRecruitments = rec.map(r => {
      const row = [...r];
      row[18] = selectedFactory;
      return row;
    });
  }
  
  // Update state values
  state.candidates = mergedCandidates;
  state.recruitments = mergedRecruitments;
  
  // Re-process metrics
  const processed = processData(state.candidates, state.recruitments, {}, state.candidateHistory, state.hasColorData);
  state.dailyStats = processed.dailyStats;
  state.datesList = processed.datesList;
  state.candidateHistory = processed.candidateHistory;
  state.overdueCareCount = processed.overdueCareCount || 0;
  
  // Re-render charts & UI
  updateUI();
}

// Update DOM elements with states
function getAggregateStats(startDateStr, endDateStr) {
  const agg = {
    newCount: 0,
    interviewConfirmed: 0,
    interviewCallback: 0,
    callbackProcessed: 0,
    hireCount: 0,
    processedCount: 0,
    sourcesByReg: {},
    recruitersByReg: {},
    sourcesByCare: {},
    recruitersByCare: {},
    sourcesByInterview: {},
    recruitersByInterview: {},
    sourcesByHire: {},
    recruitersByHire: {},
    recruitersDaily: {}
  };

  const start = new Date(startDateStr);
  const end = new Date(endDateStr);
  
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dStr = `${y}-${m}-${day}`;
    
    const s = state.dailyStats[dStr];
    if (!s) continue;
    
    agg.newCount += s.newCount || 0;
    agg.interviewCount += s.interviewCount || 0;
    agg.interviewConfirmed += s.interviewConfirmed || 0;
    agg.interviewCallback += s.interviewCallback || 0;
    agg.callbackProcessed += s.callbackProcessed || 0;
    agg.hireCount += s.hireCount || 0;
    agg.processedCount += s.processedCount || 0;
    
    if (s.sourcesByReg) {
      Object.entries(s.sourcesByReg).forEach(([k, v]) => {
        agg.sourcesByReg[k] = (agg.sourcesByReg[k] || 0) + v;
      });
    }
    if (s.sourcesByInterview) {
      Object.entries(s.sourcesByInterview).forEach(([k, v]) => {
        agg.sourcesByInterview[k] = (agg.sourcesByInterview[k] || 0) + v;
      });
    }
    if (s.sourcesByHire) {
      Object.entries(s.sourcesByHire).forEach(([k, v]) => {
        agg.sourcesByHire[k] = (agg.sourcesByHire[k] || 0) + v;
      });
    }
    if (s.sourcesByCare) {
      Object.entries(s.sourcesByCare).forEach(([k, v]) => {
        agg.sourcesByCare[k] = (agg.sourcesByCare[k] || 0) + v;
      });
    }
    
    if (s.recruitersByReg) {
      Object.entries(s.recruitersByReg).forEach(([k, v]) => {
        agg.recruitersByReg[k] = (agg.recruitersByReg[k] || 0) + v;
      });
    }
    if (s.recruitersByInterview) {
      Object.entries(s.recruitersByInterview).forEach(([k, v]) => {
        agg.recruitersByInterview[k] = (agg.recruitersByInterview[k] || 0) + v;
      });
    }
    if (s.recruitersByHire) {
      Object.entries(s.recruitersByHire).forEach(([k, v]) => {
        agg.recruitersByHire[k] = (agg.recruitersByHire[k] || 0) + v;
      });
    }
    if (s.recruitersByCare) {
      Object.entries(s.recruitersByCare).forEach(([k, v]) => {
        agg.recruitersByCare[k] = (agg.recruitersByCare[k] || 0) + v;
      });
    }

    if (s.recruitersDaily) {
      Object.entries(s.recruitersDaily).forEach(([rec, rStat]) => {
        if (!agg.recruitersDaily[rec]) {
          agg.recruitersDaily[rec] = { reg: 0, care: 0, interviewConfirmed: 0, interviewCallback: 0, hire: 0 };
        }
        agg.recruitersDaily[rec].reg += rStat.reg || 0;
        agg.recruitersDaily[rec].care += rStat.care || 0;
        agg.recruitersDaily[rec].interviewConfirmed += rStat.interviewConfirmed || 0;
        agg.recruitersDaily[rec].interviewCallback += rStat.interviewCallback || 0;
        agg.recruitersDaily[rec].hire += rStat.hire || 0;
      });
    }
  }
  return agg;
}

function getTopRecruitersHtml(recruitersObj, icon = "👤") {
  if (!recruitersObj) return `<span class="sub-item-row-empty" style="color:var(--text-muted); opacity: 0.5; padding: 6px 10px; font-size:11px; width:100%; text-align:center;">Không có dữ liệu</span>`;
  const entries = Object.entries(recruitersObj)
    .filter(([_, val]) => val > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  
  if (entries.length === 0) {
    return `<span class="sub-item-row-empty" style="color:var(--text-muted); opacity: 0.5; padding: 6px 10px; font-size:11px; width:100%; text-align:center;">Không có dữ liệu</span>`;
  }
  return entries.map(([rec, count]) => {
    return `<span><span>${icon} ${rec}:</span> <strong>${count}</strong></span>`;
  }).join("");
}

function updateUI() {
  // Populate Dashboard Viewing Date Selector (Header)
  populateDashboardDateSelector();

  const selectedDateEl = document.getElementById("dashboard-date-select");
  const viewModeEl = document.getElementById("dashboard-view-mode");
  const customStartEl = document.getElementById("custom-start-date");
  const customEndEl = document.getElementById("custom-end-date");
  const viewMode = viewModeEl ? viewModeEl.value : "day";

  let targetDateStr = "";
  const todayObj = new Date();
  const formatLocalDate = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const todayStr = formatLocalDate(todayObj);

  if (selectedDateEl && selectedDateEl.value) {
    targetDateStr = selectedDateEl.value;
  } else {
    targetDateStr = todayStr;
  }

  // Calculate start, end, and previous range based on selected mode
  let startDate = "";
  let endDate = "";
  let prevStartDate = "";
  let prevEndDate = "";
  let uiDateLabel = "";
  let uiYesterdayLabel = "";

  if (viewMode === "day") {
    startDate = targetDateStr;
    endDate = targetDateStr;
    
    const parts = targetDateStr.split("-");
    const targetObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    const yesterdayObj = new Date(targetObj);
    yesterdayObj.setDate(targetObj.getDate() - 1);
    
    prevStartDate = formatLocalDate(yesterdayObj);
    prevEndDate = prevStartDate;
    
    uiDateLabel = formatUIDate(targetDateStr);
    uiYesterdayLabel = `Ngày ${formatUIDate(prevStartDate)}`;
  } else if (viewMode === "week") {
    const parts = targetDateStr.split("-");
    const targetObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    const day = targetObj.getDay();
    const distanceToMonday = day === 0 ? -6 : 1 - day;
    
    const monday = new Date(targetObj);
    monday.setDate(targetObj.getDate() + distanceToMonday);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    
    startDate = formatLocalDate(monday);
    endDate = formatLocalDate(sunday);

    const prevMonday = new Date(monday);
    prevMonday.setDate(monday.getDate() - 7);
    const prevSunday = new Date(prevMonday);
    prevSunday.setDate(prevMonday.getDate() + 6);
    
    prevStartDate = formatLocalDate(prevMonday);
    prevEndDate = formatLocalDate(prevSunday);
    
    uiDateLabel = `Tuần ${monday.getDate()}/${monday.getMonth()+1} - ${sunday.getDate()}/${sunday.getMonth()+1}`;
    uiYesterdayLabel = "Tuần trước";
  } else if (viewMode === "month") {
    const parts = targetDateStr.split("-");
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    
    startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    
    let prevYear = year;
    let prevMonth = month - 1;
    if (prevMonth === 0) {
      prevMonth = 12;
      prevYear -= 1;
    }
    prevStartDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
    const prevLastDay = new Date(prevYear, prevMonth, 0).getDate();
    prevEndDate = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${String(prevLastDay).padStart(2, '0')}`;
    
    uiDateLabel = `Tháng ${month}/${year}`;
    uiYesterdayLabel = "Tháng trước";
  } else if (viewMode === "custom") {
    startDate = customStartEl && customStartEl.value ? customStartEl.value : todayStr;
    endDate = customEndEl && customEndEl.value ? customEndEl.value : todayStr;
    
    if (startDate > endDate) {
      // Swap if user picked backward range
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    
    const startObj = new Date(startDate);
    const endObj = new Date(endDate);
    const diffTime = Math.abs(endObj - startObj);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    
    const prevStartObj = new Date(startObj);
    prevStartObj.setDate(startObj.getDate() - diffDays);
    const prevEndObj = new Date(endObj);
    prevEndObj.setDate(endObj.getDate() - diffDays);
    
    prevStartDate = formatLocalDate(prevStartObj);
    prevEndDate = formatLocalDate(prevEndObj);
    
    uiDateLabel = `${formatUIDate(startDate)} - ${formatUIDate(endDate)}`;
    uiYesterdayLabel = "Kỳ trước";
  }

  // Update card titles dynamically to reflect chosen date/range
  document.querySelectorAll(".metric-card").forEach(card => {
    const labelEl = card.querySelector(".metric-label");
    if (!labelEl) return;
    
    if (!labelEl.dataset.baseLabel) {
      labelEl.dataset.baseLabel = labelEl.textContent.replace(/hôm nay|Hôm nay|Hôm Nay/g, "").trim();
    }
    
    const base = labelEl.dataset.baseLabel;
    labelEl.textContent = `${base} ${uiDateLabel}`;
  });

  // Retrieve stats for selected range
  state.startDate = startDate;
  state.endDate = endDate;

  const todayStats = getAggregateStats(startDate, endDate);
  const yesterdayStats = getAggregateStats(prevStartDate, prevEndDate);

  // 1. Metric Value Display
  document.getElementById("metric-new-today").textContent = todayStats.newCount || 0;
  document.getElementById("metric-hire-today").textContent = todayStats.hireCount || 0;
  document.getElementById("metric-processed-today").textContent = todayStats.processedCount || 0;

  // Lịch PV hôm nay phân tách Confirmed/Callback
  const elTodayInterviewVal = document.getElementById("metric-interview-today");
  const elTodayInterviewSub = document.getElementById("metric-interview-today-sub");
  const todayConfirmed = todayStats.interviewConfirmed || 0;
  const todayCallback = todayStats.interviewCallback || 0;
  const todayCallbackProcessed = todayStats.callbackProcessed || 0;
  const todayCallbackUnprocessed = todayCallback - todayCallbackProcessed;

  if (state.hasColorData) {
    elTodayInterviewVal.textContent = todayConfirmed;
    if (elTodayInterviewSub) {
      if (todayCallback > 0 && todayCallbackUnprocessed === 0) {
        elTodayInterviewSub.innerHTML = 
          `<span class="tc-confirmed">🟡 Hẹn PV: <strong>${todayConfirmed}</strong></span>` +
          `<span style="color:#10b981;">✅ Chăm sóc lại: <strong>${todayCallback}</strong> - (Xong)</span>`;
      } else if (todayCallback > 0) {
        elTodayInterviewSub.innerHTML = 
          `<span class="tc-confirmed">🟡 Hẹn PV: <strong>${todayConfirmed}</strong></span>` +
          `<span class="tc-callback">📞 Chăm sóc lại: <strong>${todayCallback}</strong> - <span style="color:var(--amber)">Chưa CS: <strong>${todayCallbackUnprocessed}</strong></span></span>`;
      } else {
        elTodayInterviewSub.innerHTML = 
          `<span class="tc-confirmed">🟡 Hẹn PV: <strong>${todayConfirmed}</strong></span>` +
          `<span class="tc-callback">📞 Chăm sóc lại: <strong>0</strong></span>`;
      }
    }
  } else {
    elTodayInterviewVal.textContent = todayStats.interviewCount || 0;
    if (elTodayInterviewSub) {
      elTodayInterviewSub.innerHTML = `<span style="color:var(--text-muted);font-size:10px">(Cần API Key)</span>`;
    }
  }

  // Thêm hiển thị Trễ CS và Cảnh báo (cùng hàng)
  if (elTodayInterviewSub) {
    const warningCount = state.warningCount || 0;
    const overdueHtml =
      `<div class="tc-overdue-row">` +
        `<span class="tc-overdue" style="cursor:pointer;" title="Xem danh sách trễ chăm sóc">⚠️ Trễ CS: <strong style="color:#ef4444">${state.overdueCareCount || 0}</strong></span>` +
        `<span class="tc-warning" style="cursor:pointer;" title="Xem danh sách cảnh báo">🔔 Cảnh báo: <strong style="color:#f59e0b">${warningCount}</strong></span>` +
      `</div>`;
    elTodayInterviewSub.innerHTML += overdueHtml;
  }

  // Populate sub-items for Card 1, Card 3, and Card 4 with top recruiters stats
  const elNewTodaySub = document.getElementById("metric-new-today-sub");
  if (elNewTodaySub) {
    elNewTodaySub.innerHTML = getTopRecruitersHtml(todayStats.recruitersByReg, "👤");
  }
  const elHireTodaySub = document.getElementById("metric-hire-today-sub");
  if (elHireTodaySub) {
    elHireTodaySub.innerHTML = getTopRecruitersHtml(todayStats.recruitersByHire, "🎉");
  }
  const elProcessedTodaySub = document.getElementById("metric-processed-today-sub");
  if (elProcessedTodaySub) {
    elProcessedTodaySub.innerHTML = getTopRecruitersHtml(todayStats.recruitersByCare, "👤");
  }

  // 2. Metric Comparison Trends
  document.getElementById("metric-new-diff").textContent = `${uiYesterdayLabel}: ${yesterdayStats.newCount || 0}`;
  document.getElementById("metric-interview-diff").textContent = `${uiYesterdayLabel}: ${yesterdayStats.interviewCount || 0}`;
  document.getElementById("metric-hire-diff").textContent = `${uiYesterdayLabel}: ${yesterdayStats.hireCount || 0}`;
  document.getElementById("metric-processed-diff").textContent = `${uiYesterdayLabel}: ${yesterdayStats.processedCount || 0}`;

  // 3. Lịch PV Ngày Mai
  const tomorrowObj = new Date(todayObj);
  tomorrowObj.setDate(todayObj.getDate() + 1);
  const tomorrowStr  = formatLocalDate(tomorrowObj);
  const tomorrowStats = state.dailyStats[tomorrowStr] || { interviewCount: 0, interviewConfirmed: 0, interviewCallback: 0 };
  const tomorrowUIDate = formatUIDate(tomorrowStr);
  document.getElementById("metric-interview-tomorrow-date").textContent = `Ngày ${tomorrowUIDate}`;

  // Hiển thị chi tiết confirmed/callback nếu có dữ liệu màu, ngược lại hiển thị tổng
  const elTomorrowVal  = document.getElementById("metric-interview-tomorrow");
  const elTomorrowSub  = document.getElementById("metric-interview-tomorrow-sub");
  const tomorrowCallback = tomorrowStats.interviewCallback || 0;
  const tomorrowCallbackProcessed = tomorrowStats.callbackProcessed || 0;
  const tomorrowCallbackUnprocessed = tomorrowCallback - tomorrowCallbackProcessed;

  if (state.hasColorData) {
    elTomorrowVal.textContent = tomorrowStats.interviewConfirmed || 0;
    if (elTomorrowSub) {
      if (tomorrowCallback > 0 && tomorrowCallbackUnprocessed === 0) {
        elTomorrowSub.innerHTML =
          `<span class="tc-confirmed">🟡 Hẹn PV: <strong>${tomorrowStats.interviewConfirmed || 0}</strong></span>` +
          `<span style="color:#10b981;">✅ Chăm sóc lại: <strong>${tomorrowCallback}</strong> - (Xong)</span>`;
      } else if (tomorrowCallback > 0) {
        elTomorrowSub.innerHTML =
          `<span class="tc-confirmed">🟡 Hẹn PV: <strong>${tomorrowStats.interviewConfirmed || 0}</strong></span>` +
          `<span class="tc-callback">📞 Chăm sóc lại: <strong>${tomorrowCallback}</strong> - <span style="color:var(--amber)">Chưa CS: <strong>${tomorrowCallbackUnprocessed}</strong></span></span>`;
      } else {
        elTomorrowSub.innerHTML =
          `<span class="tc-confirmed">🟡 Hẹn PV: <strong>${tomorrowStats.interviewConfirmed || 0}</strong></span>` +
          `<span class="tc-callback">📞 Chăm sóc lại: <strong>0</strong></span>`;
      }
    }
  } else {
    elTomorrowVal.textContent = tomorrowStats.interviewCount || 0;
    if (elTomorrowSub) {
      elTomorrowSub.innerHTML = `<span style="color:var(--text-muted);font-size:10px">(Chưa phân loại màu — cần API Key)</span>`;
    }
  }


  // 4. Render 7-day Mini Bar Chart
  renderChart();

  // 5. Render Weekly Summary
  renderWeeklySummary();

  // 5.1. Render Monthly Summary
  renderMonthlySummary();

  // 5.2. Render Daily Summary (Nguồn Data)
  const dailyHeadingEl = document.getElementById("daily-charts-heading");
  if (dailyHeadingEl) {
    dailyHeadingEl.textContent = `Phân tích nguồn data ngày ${uiDateLabel}`;
  }
  const daySourcesNew = todayStats.sourcesByReg || {};
  const daySourcesInt = todayStats.sourcesByInterview || {};
  const daySourcesHire = todayStats.sourcesByHire || {};
  const daySourcesCare = todayStats.sourcesByCare || {};

  renderDonutChart("canvas-day-new", "legend-day-new", daySourcesNew);
  renderDonutChart("canvas-day-interview", "legend-day-interview", daySourcesInt);
  renderDonutChart("canvas-day-hire", "legend-day-hire", daySourcesHire);
  renderDonutChart("canvas-day-processed", "legend-day-processed", daySourcesCare);

  // 5.2a. Render Daily Summary (Nhân Sự)
  const dailyRecruiterHeadingEl = document.getElementById("daily-recruiter-charts-heading");
  if (dailyRecruiterHeadingEl) {
    dailyRecruiterHeadingEl.textContent = `Phân tích nhân sự ngày ${uiDateLabel}`;
  }
  const dayRecruitersNew = todayStats.recruitersByReg || {};
  const dayRecruitersInt = todayStats.recruitersByInterview || {};
  const dayRecruitersHire = todayStats.recruitersByHire || {};
  const dayRecruitersCare = todayStats.recruitersByCare || {};

  renderDonutChart("canvas-day-recruiter-new", "legend-day-recruiter-new", dayRecruitersNew);
  renderDonutChart("canvas-day-recruiter-interview", "legend-day-recruiter-interview", dayRecruitersInt);
  renderDonutChart("canvas-day-recruiter-hire", "legend-day-recruiter-hire", dayRecruitersHire);
  renderDonutChart("canvas-day-recruiter-processed", "legend-day-recruiter-processed", dayRecruitersCare);

  // 5.3. Populate Date Selector for Analysis
  populateDateSelector();

  // 6. Render Distributions (Analysis Tab)
  renderDistributions();

  // 7. Populate Date Selector and Render Recruiter Care (Tab Tổng Quan)
  populateRecruiterCareDateSelector();
  renderRecruiterCare();

  // 8. Populate Date Selector and Render Detailed Recruiter Daily Report (Tab Tổng Quan)
  populateRecruiterReportDateSelector();
  renderRecruiterReport();

  // 9. Render History Table
  renderHistoryTable();
}

// Render Weekly Bar Chart (Từ Thứ 2 đến Chủ nhật của tuần hiện tại)
function renderChart() {
  const chartContainer = document.getElementById("recent-bar-chart");
  chartContainer.innerHTML = "";
  
  const activeDates = [];
  const todayObj = new Date();
  
  // Lấy thứ hiện tại
  const currentDay = todayObj.getDay();
  // Tính khoảng lệch ngày so với thứ Hai
  const distanceToMonday = currentDay === 0 ? -6 : 1 - currentDay;
  
  const mondayObj = new Date(todayObj);
  mondayObj.setDate(todayObj.getDate() + distanceToMonday);
  
  // Tạo danh sách 7 ngày từ thứ Hai (T2) tới Chủ nhật (CN)
  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayObj);
    d.setDate(mondayObj.getDate() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    activeDates.push(`${y}-${m}-${day}`);
  }

  const todayStr = `${todayObj.getFullYear()}-${String(todayObj.getMonth() + 1).padStart(2, '0')}-${String(todayObj.getDate()).padStart(2, '0')}`;
  
  // Cập nhật tiêu đề biểu đồ thành dạng: Xu hướng tuần 15-21/6/2026
  const titleEl = document.getElementById("chart-title");
  if (titleEl) {
    const startParts = activeDates[0].split("-");
    const endParts = activeDates[6].split("-");
    const startDay = parseInt(startParts[2]);
    const endDay = parseInt(endParts[2]);
    const month = parseInt(endParts[1]);
    const year = endParts[0];
    titleEl.textContent = `Xu hướng tuần ${startDay}-${endDay}/${month}/${year}`;
  }
  
  if (activeDates.length === 0) {
    chartContainer.innerHTML = '<div class="chart-empty text-muted">Không có dữ liệu biểu đồ</div>';
    return;
  }
  
  // Find maximum value across all metrics for scaling height (cap at minimum 1 to avoid Division by Zero)
  let maxVal = 1;
  activeDates.forEach(date => {
    const s = state.dailyStats[date] || { newCount: 0, interviewCount: 0, hireCount: 0, processedCount: 0 };
    maxVal = Math.max(maxVal, s.newCount, s.interviewCount, s.hireCount, s.processedCount);
  });
  
  const dayNames = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
  
  activeDates.forEach((date, idx) => {
    const s = state.dailyStats[date] || { newCount: 0, interviewCount: 0, hireCount: 0, processedCount: 0 };
    const shortDate = formatUIShortDate(date);
    const dayName = dayNames[idx];
    
    // Percent heights relative to maxVal
    const hNew = (s.newCount / maxVal) * 100;
    const hInt = (s.interviewCount / maxVal) * 100;
    const hHire = (s.hireCount / maxVal) * 100;
    const hProc = (s.processedCount / maxVal) * 100;
    
    const isToday = (date === todayStr);
    const isFuture = (date > todayStr);
    let highlightClass = "";
    if (isToday) {
      highlightClass = " highlight-today";
    } else if (isFuture) {
      highlightClass = " future-day";
    }
    
    const colDiv = document.createElement("div");
    colDiv.className = `chart-col${highlightClass}`;
    colDiv.innerHTML = `
      <div class="col-bars">
        <div class="col-bar bg-cyan" style="height: ${hNew}%"></div>
        <div class="col-bar bg-amber" style="height: ${hInt}%"></div>
        <div class="col-bar bg-emerald" style="height: ${hHire}%"></div>
        <div class="col-bar bg-purple" style="height: ${hProc}%"></div>
      </div>
      <div class="col-label" style="display: flex; flex-direction: column; gap: 2px; align-items: center; bottom: -38px; ${isToday ? 'color: var(--amber); font-weight: bold;' : ''}">
        <span style="font-size: 12px; font-weight: 600;">${dayName}</span>
        <span style="font-size: 10px; opacity: 0.85;">${shortDate}</span>
      </div>
      <div class="col-tooltip">
        <div class="tooltip-title">${dayName} - ${formatUIDate(date)}${isToday ? ' (Hôm nay)' : (isFuture ? ' (Chưa tới)' : '')}</div>
        <div class="tooltip-row text-cyan"><span>Mới nhập:</span><strong>${s.newCount}</strong></div>
        <div class="tooltip-row text-amber"><span>Hẹn phỏng vấn:</span><strong>${s.interviewCount}</strong></div>
        <div class="tooltip-row text-emerald"><span>Nhận việc:</span><strong>${s.hireCount}</strong></div>
        <div class="tooltip-row text-purple"><span>Đã xử lý:</span><strong>${s.processedCount}</strong></div>
      </div>
    `;
    chartContainer.appendChild(colDiv);
  });
}

// Helper function to render glassmorphism style Donut Chart on a Canvas
function renderDonutChart(canvasId, legendId, dataDistributionMap) {
  const canvas = document.getElementById(canvasId);
  const legendContainer = document.getElementById(legendId);
  if (!canvas || !legendContainer) return;

  const ctx = canvas.getContext("2d");
  legendContainer.innerHTML = "";

  // Enable high-DPI scaling for crisp graphics
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;

  const entries = Object.entries(dataDistributionMap)
    .filter(([_, count]) => count !== undefined && count !== null)
    .sort((a, b) => b[1] - a[1]);

  const total = entries.reduce((sum, item) => sum + item[1], 0);

  const centerX = width / 2;
  const centerY = height / 2;
  const outerRadius = Math.min(width, height) / 2 - 8;
  const innerRadius = outerRadius - 12; // Donut thickness

  // Neon Premium Color Palettes for Glassmorphism
  const neonGradients = [
    { start: "#06b6d4", end: "#0891b2", glow: "rgba(6, 182, 212, 0.35)" }, // Cyan
    { start: "#f59e0b", end: "#d97706", glow: "rgba(245, 158, 11, 0.35)" }, // Amber
    { start: "#10b981", end: "#059669", glow: "rgba(16, 185, 129, 0.35)" }, // Emerald
    { start: "#a855f7", end: "#7e22ce", glow: "rgba(168, 85, 247, 0.35)" }, // Light Purple
    { start: "#3b82f6", end: "#2563eb", glow: "rgba(59, 130, 246, 0.35)" }, // Blue
    { start: "#ec4899", end: "#db2777", glow: "rgba(236, 72, 153, 0.35)" }, // Pink
    { start: "#14b8a6", end: "#0d9488", glow: "rgba(20, 184, 166, 0.35)" }  // Teal
  ];

  if (entries.length === 0 || total === 0) {
    // Draw an empty gray circle
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    ctx.arc(centerX, centerY, (outerRadius + innerRadius) / 2, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = outerRadius - innerRadius;
    ctx.stroke();

    if (entries.length === 0) {
      legendContainer.innerHTML = `<div style="text-align:center;color:var(--text-muted);font-size:9px;margin-top:10px;">Không có data</div>`;
    } else {
      // Show legends with 0% and 0
      entries.forEach(([name, count], index) => {
        const palette = neonGradients[index % neonGradients.length];
        const item = document.createElement("div");
        item.className = "pie-legend-item";
        item.title = `${name}: 0 data`;
        item.innerHTML = `
          <div class="pie-legend-label">
            <span class="pie-legend-dot" style="background: linear-gradient(135deg, ${palette.start}, ${palette.end}); box-shadow: 0 0 6px ${palette.glow}"></span>
            <span>${name}</span>
          </div>
          <span class="pie-legend-pct">0%</span>
          <span class="pie-legend-val">(0)</span>
        `;
        legendContainer.appendChild(item);
      });
    }
    return;
  }

  // Render static legends
  entries.filter(([_, count]) => count > 0).forEach(([name, count], index) => {
    const percentage = count / total;
    const palette = neonGradients[index % neonGradients.length];
    const pctText = Math.round(percentage * 100);
    const item = document.createElement("div");
    item.className = "pie-legend-item";
    item.title = `${name}: ${count} data`;
    item.innerHTML = `
      <div class="pie-legend-label">
        <span class="pie-legend-dot" style="background: linear-gradient(135deg, ${palette.start}, ${palette.end}); box-shadow: 0 0 6px ${palette.glow}"></span>
        <span>${name}</span>
      </div>
      <span class="pie-legend-pct">${pctText}%</span>
      <span class="pie-legend-val">(${count})</span>
    `;
    legendContainer.appendChild(item);
  });

  // Inner drawing logic that can be refreshed on hover
  const draw = (hoveredIndex = -1) => {
    ctx.clearRect(0, 0, width, height);

    // Draw background ring
    ctx.beginPath();
    ctx.arc(centerX, centerY, (outerRadius + innerRadius) / 2, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
    ctx.lineWidth = outerRadius - innerRadius;
    ctx.stroke();

    let startAngle = -Math.PI / 2;

    entries.forEach(([name, count], index) => {
      const percentage = count / total;
      const sliceAngle = percentage * 2 * Math.PI;
      const endAngle = startAngle + sliceAngle;
      const palette = neonGradients[index % neonGradients.length];
      const color = palette.start;

      ctx.save();
      const isHovered = (hoveredIndex === index);
      if (isHovered) {
        ctx.shadowBlur = 15;
        ctx.shadowColor = palette.glow;
        ctx.lineWidth = (outerRadius - innerRadius) + 4; // Make hovered slice thicker
      } else {
        ctx.shadowBlur = 8;
        ctx.shadowColor = palette.glow;
        ctx.lineWidth = outerRadius - innerRadius;
      }

      const sliceGap = (entries.length > 1 && sliceAngle > 0.06) ? 0.05 : 0;
      ctx.beginPath();
      ctx.arc(centerX, centerY, (outerRadius + innerRadius) / 2, startAngle + sliceGap / 2, endAngle - sliceGap / 2);
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();

      startAngle = endAngle;
    });

    // Draw Central Total Text
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    
    ctx.font = "bold 16px 'Outfit', sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
    ctx.shadowBlur = 4;
    ctx.fillText(total, centerX, centerY - 4);

    ctx.shadowBlur = 0;
    ctx.font = "bold 7px 'Outfit', sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.letterSpacing = "1px";
    ctx.fillText("TỔNG CỘNG", centerX, centerY + 8);
    ctx.restore();
  };

  // Re-attach mouse listeners cleanly
  if (canvas._mouseMoveHandler) {
    canvas.removeEventListener("mousemove", canvas._mouseMoveHandler);
  }
  if (canvas._mouseLeaveHandler) {
    canvas.removeEventListener("mouseleave", canvas._mouseLeaveHandler);
  }

  // Find or create global floating tooltip
  let tooltip = document.getElementById("chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "chart-tooltip";
    tooltip.style.position = "fixed";
    tooltip.style.display = "none";
    tooltip.style.pointerEvents = "none";
    tooltip.style.zIndex = "10000";
    tooltip.style.background = "rgba(10, 15, 30, 0.95)";
    tooltip.style.border = "1px solid rgba(255,255,255,0.15)";
    tooltip.style.padding = "8px 12px";
    tooltip.style.borderRadius = "8px";
    tooltip.style.color = "#ffffff";
    tooltip.style.fontSize = "11px";
    tooltip.style.boxShadow = "0 8px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.1)";
    tooltip.style.backdropFilter = "blur(12px)";
    tooltip.style.webkitBackdropFilter = "blur(12px)";
    tooltip.style.fontFamily = "'Outfit', sans-serif";
    document.body.appendChild(tooltip);
  }

  const handleMouseMove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const dx = x - centerX;
    const dy = y - centerY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    let hoveredIndex = -1;

    // Detect if hover is inside the donut ring
    if (dist >= innerRadius - 4 && dist <= outerRadius + 4) {
      let angle = Math.atan2(dy, dx);
      let normalizedAngle = angle + Math.PI / 2;
      if (normalizedAngle < 0) normalizedAngle += 2 * Math.PI;
      if (normalizedAngle >= 2 * Math.PI) normalizedAngle -= 2 * Math.PI;

      let currentAngle = 0;
      for (let i = 0; i < entries.length; i++) {
        const percentage = entries[i][1] / total;
        const sliceAngle = percentage * 2 * Math.PI;
        if (normalizedAngle >= currentAngle && normalizedAngle <= currentAngle + sliceAngle) {
          hoveredIndex = i;
          break;
        }
        currentAngle += sliceAngle;
      }
    }

    if (canvas._lastHoveredIndex !== hoveredIndex) {
      canvas._lastHoveredIndex = hoveredIndex;
      draw(hoveredIndex);
    }

    if (hoveredIndex !== -1) {
      const [name, count] = entries[hoveredIndex];
      const pct = Math.round(count / total * 100);
      tooltip.innerHTML = `
        <div style="font-weight:600;margin-bottom:4px;color:#fff">${name}</div>
        <div style="color:var(--text-secondary);font-size:10px;line-height:1.4;">
          Số lượng: <strong style="color:#fff">${count}</strong><br/>
          Tỷ lệ: <strong style="color:#fff">${pct}%</strong>
        </div>
      `;
      tooltip.style.display = "block";
      tooltip.style.left = (event.clientX + 12) + "px";
      tooltip.style.top = (event.clientY + 12) + "px";
    } else {
      tooltip.style.display = "none";
    }
  };

  const handleMouseLeave = () => {
    canvas._lastHoveredIndex = -1;
    draw(-1);
    tooltip.style.display = "none";
  };

  canvas._mouseMoveHandler = handleMouseMove;
  canvas._mouseLeaveHandler = handleMouseLeave;
  canvas._lastHoveredIndex = -1;

  canvas.addEventListener("mousemove", handleMouseMove);
  canvas.addEventListener("mouseleave", handleMouseLeave);

  // Initial Draw
  draw(-1);
}

// Render Weekly Summary (Từ Thứ 2 đến Chủ nhật của tuần hiện tại)
function renderWeeklySummary() {
  const activeDates = [];
  const todayObj = new Date();
  
  // Lấy thứ hiện tại (0 là Chủ nhật, 1 là Thứ hai, ..., 6 là Thứ bảy)
  const currentDay = todayObj.getDay();
  
  // Tính khoảng lệch ngày so với thứ Hai (thứ 2 là ngày bắt đầu)
  // Nếu là Chủ nhật (0), chúng ta cần lùi 6 ngày để về thứ Hai.
  const distanceToMonday = currentDay === 0 ? -6 : 1 - currentDay;
  
  const mondayObj = new Date(todayObj);
  mondayObj.setDate(todayObj.getDate() + distanceToMonday);
  
  // Tạo danh sách 7 ngày từ thứ Hai (i=0) tới Chủ nhật (i=6)
  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayObj);
    d.setDate(mondayObj.getDate() + i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    activeDates.push(`${y}-${m}-${day}`);
  }
  let totNew = 0, totInt = 0, totIntConfirmed = 0, totHire = 0, totProc = 0;
  
  const weekSourcesNew = {};
  const weekSourcesInt = {};
  const weekSourcesHire = {};
  const weekSourcesCare = {};

  const weekRecruitersNew = {};
  const weekRecruitersInt = {};
  const weekRecruitersHire = {};
  const weekRecruitersCare = {};

  activeDates.forEach(date => {
    const s = state.dailyStats[date] || { 
      newCount: 0, 
      interviewCount: 0, 
      interviewConfirmed: 0,
      hireCount: 0, 
      processedCount: 0,
      sourcesByReg: {},
      sourcesByInterview: {},
      sourcesByHire: {},
      sourcesByCare: {},
      recruitersByReg: {},
      recruitersByInterview: {},
      recruitersByHire: {},
      recruitersByCare: {}
    };
    totNew += s.newCount;
    totInt += s.interviewCount;
    totIntConfirmed += (s.interviewConfirmed || 0);
    totHire += s.hireCount;
    totProc += s.processedCount;

    // Merge sources statistics
    if (s.sourcesByReg) {
      Object.entries(s.sourcesByReg).forEach(([src, count]) => {
        weekSourcesNew[src] = (weekSourcesNew[src] || 0) + count;
      });
    }
    if (s.sourcesByInterview) {
      Object.entries(s.sourcesByInterview).forEach(([src, count]) => {
        weekSourcesInt[src] = (weekSourcesInt[src] || 0) + count;
      });
    }
    if (s.sourcesByHire) {
      Object.entries(s.sourcesByHire).forEach(([src, count]) => {
        weekSourcesHire[src] = (weekSourcesHire[src] || 0) + count;
      });
    }
    if (s.sourcesByCare) {
      Object.entries(s.sourcesByCare).forEach(([src, count]) => {
        weekSourcesCare[src] = (weekSourcesCare[src] || 0) + count;
      });
    }

    // Merge recruiters statistics
    if (s.recruitersByReg) {
      Object.entries(s.recruitersByReg).forEach(([rec, count]) => {
        weekRecruitersNew[rec] = (weekRecruitersNew[rec] || 0) + count;
      });
    }
    if (s.recruitersByInterview) {
      Object.entries(s.recruitersByInterview).forEach(([rec, count]) => {
        weekRecruitersInt[rec] = (weekRecruitersInt[rec] || 0) + count;
      });
    }
    if (s.recruitersByHire) {
      Object.entries(s.recruitersByHire).forEach(([rec, count]) => {
        weekRecruitersHire[rec] = (weekRecruitersHire[rec] || 0) + count;
      });
    }
    if (s.recruitersByCare) {
      Object.entries(s.recruitersByCare).forEach(([rec, count]) => {
        weekRecruitersCare[rec] = (weekRecruitersCare[rec] || 0) + count;
      });
    }
  });
  
  // Cập nhật nhãn khoảng ngày cho người dùng dễ theo dõi
  const formatShortDate = (dateStr) => {
    const p = dateStr.split("-");
    return `${p[2]}/${p[1]}`;
  };
  const labelText = `Tổng số tuần này (${formatShortDate(activeDates[0])} - ${formatShortDate(activeDates[6])})`;
  const headingEl = document.querySelector(".summary-stats .card-header h3");
  if (headingEl) {
    headingEl.textContent = labelText;
  }
  
  document.getElementById("sum-new").textContent = totNew || 0;
  document.getElementById("sum-interview").textContent = (state.hasColorData ? totIntConfirmed : totInt) || 0;
  document.getElementById("sum-hire").textContent = totHire || 0;
  document.getElementById("sum-processed").textContent = totProc || 0;

  // Render weekly Donut Charts (Sources)
  renderDonutChart("canvas-week-new", "legend-week-new", weekSourcesNew);
  renderDonutChart("canvas-week-interview", "legend-week-interview", weekSourcesInt);
  renderDonutChart("canvas-week-hire", "legend-week-hire", weekSourcesHire);
  renderDonutChart("canvas-week-processed", "legend-week-processed", weekSourcesCare);

  // Render weekly Donut Charts (Recruiters)
  renderDonutChart("canvas-week-recruiter-new", "legend-week-recruiter-new", weekRecruitersNew);
  renderDonutChart("canvas-week-recruiter-interview", "legend-week-recruiter-interview", weekRecruitersInt);
  renderDonutChart("canvas-week-recruiter-hire", "legend-week-recruiter-hire", weekRecruitersHire);
  renderDonutChart("canvas-week-recruiter-processed", "legend-week-recruiter-processed", weekRecruitersCare);
}

// Render Monthly Summary (Từ ngày 1 đến ngày hiện tại của tháng)
function renderMonthlySummary() {
  const activeDates = getMonthlyDates();

  let totNew = 0, totInt = 0, totIntConfirmed = 0, totHire = 0, totProc = 0;

  const monthSourcesNew = {};
  const monthSourcesInt = {};
  const monthSourcesHire = {};
  const monthSourcesCare = {};

  const monthRecruitersNew = {};
  const monthRecruitersInt = {};
  const monthRecruitersHire = {};
  const monthRecruitersCare = {};

  activeDates.forEach(date => {
    const s = state.dailyStats[date] || { 
      newCount: 0, 
      interviewCount: 0, 
      interviewConfirmed: 0,
      hireCount: 0, 
      processedCount: 0,
      sourcesByReg: {},
      sourcesByInterview: {},
      sourcesByHire: {},
      sourcesByCare: {},
      recruitersByReg: {},
      recruitersByInterview: {},
      recruitersByHire: {},
      recruitersByCare: {}
    };
    totNew += s.newCount;
    totInt += s.interviewCount;
    totIntConfirmed += (s.interviewConfirmed || 0);
    totHire += s.hireCount;
    totProc += s.processedCount;

    // Merge sources statistics
    if (s.sourcesByReg) {
      Object.entries(s.sourcesByReg).forEach(([src, count]) => {
        monthSourcesNew[src] = (monthSourcesNew[src] || 0) + count;
      });
    }
    if (s.sourcesByInterview) {
      Object.entries(s.sourcesByInterview).forEach(([src, count]) => {
        monthSourcesInt[src] = (monthSourcesInt[src] || 0) + count;
      });
    }
    if (s.sourcesByHire) {
      Object.entries(s.sourcesByHire).forEach(([src, count]) => {
        monthSourcesHire[src] = (monthSourcesHire[src] || 0) + count;
      });
    }
    if (s.sourcesByCare) {
      Object.entries(s.sourcesByCare).forEach(([src, count]) => {
        monthSourcesCare[src] = (monthSourcesCare[src] || 0) + count;
      });
    }

    // Merge recruiters statistics
    if (s.recruitersByReg) {
      Object.entries(s.recruitersByReg).forEach(([rec, count]) => {
        monthRecruitersNew[rec] = (monthRecruitersNew[rec] || 0) + count;
      });
    }
    if (s.recruitersByInterview) {
      Object.entries(s.recruitersByInterview).forEach(([rec, count]) => {
        monthRecruitersInt[rec] = (monthRecruitersInt[rec] || 0) + count;
      });
    }
    if (s.recruitersByHire) {
      Object.entries(s.recruitersByHire).forEach(([rec, count]) => {
        monthRecruitersHire[rec] = (monthRecruitersHire[rec] || 0) + count;
      });
    }
    if (s.recruitersByCare) {
      Object.entries(s.recruitersByCare).forEach(([rec, count]) => {
        monthRecruitersCare[rec] = (monthRecruitersCare[rec] || 0) + count;
      });
    }
  });

  // Cập nhật nhãn khoảng ngày tháng cho người dùng dễ theo dõi
  const formatShortDate = (dateStr) => {
    const p = dateStr.split("-");
    return `${p[2]}/${p[1]}`;
  };
  const labelText = `Tổng số tháng này (${formatShortDate(activeDates[0])} - ${formatShortDate(activeDates[activeDates.length - 1])})`;
  const headingEl = document.getElementById("month-summary-title");
  if (headingEl) {
    headingEl.textContent = labelText;
  }

  document.getElementById("sum-month-new").textContent = totNew || 0;
  document.getElementById("sum-month-interview").textContent = (state.hasColorData ? totIntConfirmed : totInt) || 0;
  document.getElementById("sum-month-hire").textContent = totHire || 0;
  document.getElementById("sum-month-processed").textContent = totProc || 0;

  // Render monthly Donut Charts (Sources)
  renderDonutChart("canvas-month-new", "legend-month-new", monthSourcesNew);
  renderDonutChart("canvas-month-interview", "legend-month-interview", monthSourcesInt);
  renderDonutChart("canvas-month-hire", "legend-month-hire", monthSourcesHire);
  renderDonutChart("canvas-month-processed", "legend-month-processed", monthSourcesCare);

  // Render monthly Donut Charts (Recruiters)
  renderDonutChart("canvas-month-recruiter-new", "legend-month-recruiter-new", monthRecruitersNew);
  renderDonutChart("canvas-month-recruiter-interview", "legend-month-recruiter-interview", monthRecruitersInt);
  renderDonutChart("canvas-month-recruiter-hire", "legend-month-recruiter-hire", monthRecruitersHire);
  renderDonutChart("canvas-month-recruiter-processed", "legend-month-recruiter-processed", monthRecruitersCare);
}

// Populate Date Selector for Analysis Tab
function populateDateSelector() {
  const dateSelect = document.getElementById("analysis-date");
  const previousValue = dateSelect.value;
  
  dateSelect.innerHTML = "";
  
  if (state.datesList.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "Không có dữ liệu";
    opt.value = "";
    dateSelect.appendChild(opt);
    return;
  }
  
  state.datesList.forEach((date, i) => {
    const opt = document.createElement("option");
    opt.value = date;
    
    // Label
    const uiDate = formatUIDate(date);
    const todayObj = new Date();
    const todayStr = `${todayObj.getFullYear()}-${String(todayObj.getMonth() + 1).padStart(2, '0')}-${String(todayObj.getDate()).padStart(2, '0')}`;
    
    if (date === todayStr) {
      opt.textContent = `${uiDate} (Hôm nay)`;
    } else if (i === 0) {
      opt.textContent = `${uiDate} (Mới nhất)`;
    } else {
      opt.textContent = uiDate;
    }
    
    dateSelect.appendChild(opt);
  });
  
  // Mặc định chọn ngày hôm nay nếu có dữ liệu, ngược lại chọn ngày mới nhất (đầu tiên trong danh sách)
  const todayObj = new Date();
  const todayStr = `${todayObj.getFullYear()}-${String(todayObj.getMonth() + 1).padStart(2, '0')}-${String(todayObj.getDate()).padStart(2, '0')}`;
  
  if (previousValue && state.datesList.includes(previousValue)) {
    dateSelect.value = previousValue;
  } else if (state.datesList.includes(todayStr)) {
    dateSelect.value = todayStr;
  } else if (state.datesList.length > 0) {
    dateSelect.value = state.datesList[0];
  }
}

// Render Distributions (Analysis Tab)
function renderDistributions() {
  const dateSelect = document.getElementById("analysis-date");
  const groupBySelect = document.getElementById("analysis-group-by");
  const sourceList = document.getElementById("source-dist-list");
  const recruiterList = document.getElementById("recruiter-dist-list");
  
  const selectedDate = dateSelect.value;
  const groupBy = groupBySelect.value; // 'reg' or 'care'
  
  if (!selectedDate || !state.dailyStats[selectedDate]) {
    sourceList.innerHTML = '<div class="text-muted text-center">Không có dữ liệu</div>';
    recruiterList.innerHTML = '<div class="text-muted text-center">Không có dữ liệu</div>';
    return;
  }
  
  const dayStats = state.dailyStats[selectedDate];
  
  // Pick distribution maps based on selector
  const sourceMap = groupBy === "reg" ? dayStats.sourcesByReg : dayStats.sourcesByCare;
  const recruiterMap = groupBy === "reg" ? dayStats.recruitersByReg : dayStats.recruitersByCare;
  
  const renderList = (container, dataMap, colorClass) => {
    container.innerHTML = "";
    
    const entries = Object.entries(dataMap).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, item) => sum + item[1], 0);
    
    if (entries.length === 0 || total === 0) {
      container.innerHTML = '<div class="text-muted text-center" style="padding: 10px;">Không có dữ liệu cho ngày này</div>';
      return;
    }
    
    entries.forEach(([name, count]) => {
      const percent = total > 0 ? Math.round((count / total) * 100) : 0;
      
      const itemDiv = document.createElement("div");
      itemDiv.className = "dist-item";
      itemDiv.innerHTML = `
        <div class="dist-meta">
          <span class="dist-name">${name}</span>
          <span class="dist-val"><strong>${count}</strong> data (${percent}%)</span>
        </div>
        <div class="dist-bar-bg">
          <div class="dist-bar-fill ${colorClass}" style="width: ${percent}%"></div>
        </div>
      `;
      container.appendChild(itemDiv);
    });
  };
  
  renderList(sourceList, sourceMap, "bg-cyan");
  renderList(recruiterList, recruiterMap, "bg-purple");
}

// Populate Date Selector for Recruiter Care section
function populateRecruiterCareDateSelector() {
  const sel = document.getElementById("recruiter-care-date");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";

  const todayObj = new Date();
  const todayStr = `${todayObj.getFullYear()}-${String(todayObj.getMonth()+1).padStart(2,'0')}-${String(todayObj.getDate()).padStart(2,'0')}`;

  state.datesList.forEach((date, i) => {
    const opt = document.createElement("option");
    opt.value = date;
    const label = formatUIDate(date);
    if (date === todayStr) opt.textContent = `${label} (Hôm nay)`;
    else if (i === 0)     opt.textContent = `${label} (Mới nhất)`;
    else                  opt.textContent = label;
    sel.appendChild(opt);
  });

  // Mặc định chọn ngày hôm nay nếu có dữ liệu, ngược lại chọn ngày mới nhất (đầu tiên trong danh sách)
  if (prev && state.datesList.includes(prev)) {
    sel.value = prev;
  } else if (state.datesList.includes(todayStr)) {
    sel.value = todayStr;
  } else if (state.datesList.length > 0) {
    sel.value = state.datesList[0];
  }
}

// Helper timezone-safe to get week range
function getWeekRangeSafe(dateStr) {
  const p = dateStr.split("-");
  const year = parseInt(p[0]);
  const month = parseInt(p[1]) - 1;
  const day = parseInt(p[2]);
  
  const d = new Date(year, month, day);
  const dayOfWeek = d.getDay(); // 0 is Sunday, 1 is Monday, etc.
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  
  const monday = new Date(year, month, day + diffToMonday);
  const sunday = new Date(year, month, day + diffToMonday + 6);
  
  const format = (dateObj) => {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const dVal = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${dVal}`;
  };
  
  return { monday: format(monday), sunday: format(sunday) };
}

// Populate Dashboard Viewing Date Selector (Header)
function populateDashboardDateSelector() {
  const sel = document.getElementById("dashboard-date-select");
  const viewModeEl = document.getElementById("dashboard-view-mode");
  if (!sel || !viewModeEl) return;

  const mode = viewModeEl.value;
  const datesLength = state.datesList ? state.datesList.length : 0;

  // Only rebuild if mode or dataset changed
  if (state.lastPopulatedMode === mode && state.lastDatesListLength === datesLength && sel.options.length > 0) {
    return;
  }
  
  state.lastPopulatedMode = mode;
  state.lastDatesListLength = datesLength;

  const prev = sel.value;
  sel.innerHTML = "";

  const todayObj = new Date();
  const todayStr = `${todayObj.getFullYear()}-${String(todayObj.getMonth()+1).padStart(2,'0')}-${String(todayObj.getDate()).padStart(2,'0')}`;

  if (mode === "day") {
    // Populate with days
    state.datesList.forEach((date, i) => {
      const opt = document.createElement("option");
      opt.value = date;
      const label = formatUIDate(date);
      if (date === todayStr) opt.textContent = `${label} (Hôm nay)`;
      else if (i === 0)     opt.textContent = `${label} (Mới nhất)`;
      else                  opt.textContent = label;
      sel.appendChild(opt);
    });
  } else if (mode === "week") {
    // Populate with weeks (value is Monday's date)
    const seenWeeks = new Set();
    state.datesList.forEach((date) => {
      const { monday, sunday } = getWeekRangeSafe(date);
      const key = monday;
      if (!seenWeeks.has(key)) {
        seenWeeks.add(key);
        const opt = document.createElement("option");
        opt.value = monday;
        
        const formatShort = (dStr) => {
          const parts = dStr.split("-");
          return `${parts[2]}/${parts[1]}`;
        };
        opt.textContent = `Tuần ${formatShort(monday)} - ${formatShort(sunday)}`;
        sel.appendChild(opt);
      }
    });
  } else if (mode === "month") {
    // Populate with months (value is YYYY-MM-01)
    const seenMonths = new Set();
    state.datesList.forEach((date) => {
      const parts = date.split("-");
      const key = `${parts[0]}-${parts[1]}`;
      if (!seenMonths.has(key)) {
        seenMonths.add(key);
        const opt = document.createElement("option");
        opt.value = `${parts[0]}-${parts[1]}-01`;
        opt.textContent = `Tháng ${parts[1]}/${parts[0]}`;
        sel.appendChild(opt);
      }
    });
  }

  // Prioritize selecting today's period first, otherwise try to restore previous selection, fallback to first item
  let found = false;
  
  // 1. Try to select today's period
  let todayVal = "";
  if (mode === "day") {
    todayVal = todayStr;
  } else if (mode === "week") {
    todayVal = getWeekRangeSafe(todayStr).monday;
  } else if (mode === "month") {
    const parts = todayStr.split("-");
    todayVal = `${parts[0]}-${parts[1]}-01`;
  }
  
  for (let i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value === todayVal) {
      sel.value = todayVal;
      found = true;
      break;
    }
  }
  
  // 2. If today's period not found, try to restore previous selection
  if (!found && prev) {
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === prev) {
        sel.value = prev;
        found = true;
        break;
      }
    }
  }
  
  // 3. Fallback to first item (newest)
  if (!found && sel.options.length > 0) {
    sel.selectedIndex = 0;
  }

  // Sync custom dropdown values
  syncCustomDropdown();
}

function syncCustomDropdown() {
  const select = document.getElementById("dashboard-date-select");
  const label = document.getElementById("custom-dropdown-label");
  const menu = document.getElementById("custom-dropdown-menu");
  if (!select || !menu || !label) return;

  const activeOption = select.options[select.selectedIndex];
  label.textContent = activeOption ? activeOption.textContent : "Chọn thời gian";

  menu.innerHTML = "";
  Array.from(select.options).forEach((opt, idx) => {
    const item = document.createElement("div");
    item.textContent = opt.textContent;
    item.style.padding = "6px 12px";
    item.style.cursor = "pointer";
    item.style.fontSize = "12px";
    item.style.color = "var(--text-primary)";
    item.style.transition = "background 0.2s, color 0.2s";
    item.style.whiteSpace = "nowrap";

    if (select.selectedIndex === idx) {
      item.style.background = "rgba(16, 185, 129, 0.15)";
      item.style.color = "#10b981";
      item.style.fontWeight = "bold";
      item.classList.add("active-dropdown-item");
    }

    item.onmouseover = () => {
      if (select.selectedIndex !== idx) {
        item.style.background = "rgba(255, 255, 255, 0.06)";
      }
    };
    item.onmouseout = () => {
      if (select.selectedIndex !== idx) {
        item.style.background = "transparent";
      }
    };

    item.onclick = (e) => {
      e.stopPropagation();
      select.selectedIndex = idx;
      select.dispatchEvent(new Event("change"));
      menu.style.display = "none";
      const arrow = document.getElementById("custom-dropdown-arrow");
      if (arrow) arrow.style.transform = "rotate(0deg)";
    };

    menu.appendChild(item);
  });
}

// Render Recruiter Care breakdown table (Tab Tổng Quan)
function renderRecruiterCare() {
  const sel = document.getElementById("recruiter-care-date");
  const tbody = document.getElementById("recruiter-care-body");
  const heading = document.getElementById("recruiter-care-heading");
  if (!sel || !tbody) return;

  const selectedDate = sel.value;
  const uiDateLabel = formatUIDate(selectedDate);
  if (heading) heading.textContent = `Data chăm sóc ngày ${uiDateLabel}`;

  const dayStats = state.dailyStats[selectedDate];
  if (!dayStats || !dayStats.recruitersByCare || Object.keys(dayStats.recruitersByCare).length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted" style="padding:12px">Không có data chăm sóc cho ngày này</td></tr>`;
    return;
  }

  const entries = Object.entries(dayStats.recruitersByCare).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  tbody.innerHTML = "";

  entries.forEach(([name, count]) => {
    const pct = total > 0 ? Math.round(count / total * 100) : 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${name}</strong></td>
      <td class="text-center text-purple"><strong>${count}</strong></td>
      <td>
        <div class="dist-bar-bg" style="margin-top:3px">
          <div class="dist-bar-fill bg-purple" style="width:${pct}%"></div>
        </div>
        <span style="font-size:10px;color:var(--text-muted)">${pct}%</span>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Total row
  const trTotal = document.createElement("tr");
  trTotal.style.borderTop = "1px solid rgba(255,255,255,0.12)";
  trTotal.style.innerHTML = "";
  trTotal.innerHTML = `<td style="color:var(--text-secondary)">Tổng cộng</td><td class="text-center text-purple"><strong>${total}</strong></td><td></td>`;
  tbody.appendChild(trTotal);
}

// Populate Date Selector for Daily Report
function populateRecruiterReportDateSelector() {
  const sel = document.getElementById("recruiter-report-date");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = "";

  const todayObj = new Date();
  const todayStr = `${todayObj.getFullYear()}-${String(todayObj.getMonth()+1).padStart(2,'0')}-${String(todayObj.getDate()).padStart(2,'0')}`;

  state.datesList.forEach((date, i) => {
    const opt = document.createElement("option");
    opt.value = date;
    const label = formatUIDate(date);
    if (date === todayStr) opt.textContent = `${label} (Hôm nay)`;
    else if (i === 0)     opt.textContent = `${label} (Mới nhất)`;
    else                  opt.textContent = label;
    sel.appendChild(opt);
  });

  if (prev && state.datesList.includes(prev)) {
    sel.value = prev;
  } else if (state.datesList.includes(todayStr)) {
    sel.value = todayStr;
  } else if (state.datesList.length > 0) {
    sel.value = state.datesList[0];
  }
}

// Render Daily Report table (báo cáo công việc chi tiết)
function renderRecruiterReport() {
  const sel = document.getElementById("recruiter-report-date");
  const tbody = document.getElementById("recruiter-report-body");
  const heading = document.getElementById("recruiter-report-heading");
  if (!sel || !tbody) return;

  const selectedDate = sel.value;
  const uiDateLabel = formatUIDate(selectedDate);
  if (heading) heading.textContent = `Báo cáo công việc ngày ${uiDateLabel}`;

  const dayStats = state.dailyStats[selectedDate];
  if (!dayStats || !dayStats.recruitersDaily || Object.keys(dayStats.recruitersDaily).length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted" style="padding:12px">Không có dữ liệu báo cáo cho ngày này</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  const entries = Object.entries(dayStats.recruitersDaily).sort((a, b) => {
    // Sắp xếp theo tổng công việc thực hiện (reg + care)
    const sumA = a[1].reg + a[1].care;
    const sumB = b[1].reg + b[1].care;
    return sumB - sumA;
  });

  let totReg = 0, totCare = 0, totConf = 0, totCall = 0, totHire = 0;

  entries.forEach(([name, s]) => {
    totReg += s.reg;
    totCare += s.care;
    totConf += s.interviewConfirmed;
    totCall += s.interviewCallback;
    totHire += (s.hire || 0);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${name}</strong></td>
      <td class="text-center text-cyan"><strong>${s.reg}</strong></td>
      <td class="text-center text-purple"><strong>${s.care}</strong></td>
      <td class="text-center text-amber"><strong>${s.interviewConfirmed}</strong></td>
      <td class="text-center text-muted"><strong>${s.interviewCallback}</strong></td>
      <td class="text-center text-emerald"><strong>${s.hire || 0}</strong></td>
    `;
    tbody.appendChild(tr);
  });

  // Dòng Tổng cộng
  const trTotal = document.createElement("tr");
  trTotal.style.borderTop = "2px solid rgba(255,255,255,0.2)";
  trTotal.style.fontWeight = "bold";
  trTotal.innerHTML = `
    <td style="color:var(--text-secondary)">Tổng cộng</td>
    <td class="text-center text-cyan">${totReg}</td>
    <td class="text-center text-purple">${totCare}</td>
    <td class="text-center text-amber">${totConf}</td>
    <td class="text-center text-muted">${totCall}</td>
    <td class="text-center text-emerald">${totHire}</td>
  `;
  tbody.appendChild(trTotal);
}

// Render History Table (Tab 3)
function renderHistoryTable() {
  const tableBody = document.getElementById("history-table-body");
  const searchQuery = document.getElementById("history-search").value.trim().toLowerCase();
  
  tableBody.innerHTML = "";
  
  const filteredDates = state.datesList.filter(date => {
    if (!searchQuery) return true;
    const uiDate = formatUIDate(date);
    return date.includes(searchQuery) || uiDate.includes(searchQuery);
  });
  
  if (filteredDates.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="5" class="text-center text-muted">Không tìm thấy kết quả</td>
      </tr>
    `;
    return;
  }
  
  filteredDates.forEach(date => {
    const s = state.dailyStats[date];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${formatUIDate(date)}</strong></td>
      <td class="text-cyan text-center"><strong>${s.newCount}</strong></td>
      <td class="text-amber text-center"><strong>${s.interviewCount}</strong></td>
      <td class="text-emerald text-center"><strong>${s.hireCount}</strong></td>
      <td class="text-purple text-center"><strong>${s.processedCount}</strong></td>
    `;
    tableBody.appendChild(tr);
  });
}

// Countdown timer for auto-refresh
function resetCountdown() {
  state.countdownSeconds = 10; // Reduced to 10 seconds for near real-time updates
  updateCountdownDisplay();
}

function updateCountdownDisplay() {
  const countdownText = document.getElementById("auto-refresh-countdown");
  const mins = String(Math.floor(state.countdownSeconds / 60)).padStart(2, '0');
  const secs = String(state.countdownSeconds % 60).padStart(2, '0');
  countdownText.textContent = `Tự động làm mới trong ${mins}:${secs}`;
}

function startCountdown() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  
  state.refreshTimer = setInterval(() => {
    state.countdownSeconds--;
    if (state.countdownSeconds <= 0) {
      syncData();
    } else {
      updateCountdownDisplay();
    }
  }, 1000);
}

// Load cached data from storage for all factories
function loadCache() {
  const cacheKeys = [
    'Pegatron_candidatesCSV', 'Pegatron_recruitmentsCSV',
    'Brother_candidatesCSV', 'Brother_recruitmentsCSV',
    'LG_candidatesCSV', 'LG_recruitmentsCSV',
    'Usi_candidatesCSV', 'Usi_recruitmentsCSV',
    'Fox QN_candidatesCSV', 'Fox QN_recruitmentsCSV',
    'lastSyncTime', 'candidateHistory'
  ];
  
  storage.get(cacheKeys, (result) => {
    if (result.candidateHistory) {
      state.candidateHistory = result.candidateHistory;
      
      // Clean up patch: Since history was corrupted before the freeze logic was enforced,
      // we clean out any future dates from the loaded history that are greater than today's date (2026-07-01).
      const localToday = new Date();
      const todayStr = `${localToday.getFullYear()}-${String(localToday.getMonth() + 1).padStart(2, '0')}-${String(localToday.getDate()).padStart(2, '0')}`;
      
      Object.keys(state.candidateHistory).forEach(key => {
        const hist = state.candidateHistory[key];
        if (hist) {
          if (hist.interviewDates) {
            hist.interviewDates = hist.interviewDates.filter(d => d <= todayStr);
          }
          if (hist.careDates) {
            hist.careDates = hist.careDates.filter(d => d <= todayStr);
          }
        }
      });
    } else {
      state.candidateHistory = {};
    }
    
    const factories = ["Pegatron", "Brother", "LG", "Usi", "Fox QN"];
    let hasAllCache = true;
    
    factories.forEach(f => {
      const candCSV = result[`${f}_candidatesCSV`];
      const recCSV = result[`${f}_recruitmentsCSV`];
      if (candCSV && recCSV) {
        state.factoryData[f].candidates = parseCSV(candCSV);
        state.factoryData[f].recruitments = parseCSV(recCSV);
      } else {
        hasAllCache = false;
      }
    });
    
    if (hasAllCache) {
      console.log("Loading all factory data from local cache...");
      applyFactoryFilter();
      
      if (result.lastSyncTime) {
        state.lastSync = new Date(result.lastSyncTime);
        const timeStr = state.lastSync.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        document.getElementById("sync-status").textContent = `Đã đồng bộ lúc ${timeStr} (Offline)`;
      }
    }
    
    // Trigger background update
    syncData();
  });
}

// Initialization and Event Listeners
document.addEventListener("DOMContentLoaded", () => {
  setupMainNavigation();
  // Tab Navigation switching
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const clickedBtn = e.currentTarget;
      const targetTab = clickedBtn.getAttribute("data-tab");
      
      // Toggle tab buttons active status
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      clickedBtn.classList.add("active");
      
      // Toggle panels active status
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      document.getElementById(`tab-${targetTab}`).classList.add("active");
    });
  });
  
  // Date and grouping selector updates in Analysis
  document.getElementById("analysis-date").addEventListener("change", renderDistributions);
  document.getElementById("analysis-group-by").addEventListener("change", renderDistributions);
  
  // Search input in History
  document.getElementById("history-search").addEventListener("input", renderHistoryTable);

  // Recruiter Care date selector
  document.getElementById("recruiter-care-date").addEventListener("change", renderRecruiterCare);

  // Recruiter Report date selector
  document.getElementById("recruiter-report-date").addEventListener("change", renderRecruiterReport);

  // Factory selection change (Dropdown & Navigation Buttons)
  const factorySelect = document.getElementById("dashboard-factory-select");
  
  // Tab buttons click handler
  document.querySelectorAll(".factory-tab-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const selected = e.currentTarget.getAttribute("data-factory");
      
      // Update active styling
      document.querySelectorAll(".factory-tab-btn").forEach(b => {
        b.classList.remove("active");
        b.style.background = "transparent";
        b.style.border = "1px solid transparent";
        b.style.color = "var(--text-muted)";
        b.style.fontWeight = "normal";
      });
      e.currentTarget.classList.add("active");
      e.currentTarget.style.background = "rgba(16, 185, 129, 0.15)";
      e.currentTarget.style.border = "1px solid rgba(16, 185, 129, 0.3)";
      e.currentTarget.style.color = "#10b981";
      e.currentTarget.style.fontWeight = "bold";
      
      // Update dropdown sync if exists
      if (factorySelect) {
        factorySelect.value = selected;
      }
      
      applyFactoryFilter();
    });
  });

  if (factorySelect) {
    // Hide standard dropdown selector since we have premium tab buttons (keeping for backward compatibility)
    factorySelect.style.display = "none";
    factorySelect.addEventListener("change", () => {
      const selected = factorySelect.value;
      // Sync tab buttons
      document.querySelectorAll(".factory-tab-btn").forEach(b => {
        if (b.getAttribute("data-factory") === selected) {
          b.dispatchEvent(new Event("click"));
        }
      });
    });
  }

  // General Dashboard Date Selector (Header)
  const dashboardDateSelect = document.getElementById("dashboard-date-select");
  if (dashboardDateSelect) {
    dashboardDateSelect.addEventListener("change", () => {
      syncCustomDropdown();
      updateUI();
    });
  }

  // Date Spinner/Carousel Prev/Next Navigation
  const elPrev = document.getElementById("date-prev-btn");
  if (elPrev) {
    elPrev.addEventListener("click", () => {
      const select = document.getElementById("dashboard-date-select");
      if (select && select.selectedIndex < select.options.length - 1) {
        select.selectedIndex = select.selectedIndex + 1;
        select.dispatchEvent(new Event("change"));
      }
    });
  }

  const elNext = document.getElementById("date-next-btn");
  if (elNext) {
    elNext.addEventListener("click", () => {
      const select = document.getElementById("dashboard-date-select");
      if (select && select.selectedIndex > 0) {
        select.selectedIndex = select.selectedIndex - 1;
        select.dispatchEvent(new Event("change"));
      }
    });
  }

  // Removed legacy wheel event from spinnerContainer to avoid double-triggering updates

  // Toggle Custom Dropdown Menu Open/Close
  const dropTrigger = document.getElementById("custom-dropdown-trigger");
  const dropMenu = document.getElementById("custom-dropdown-menu");
  const dropArrow = document.getElementById("custom-dropdown-arrow");
  if (dropTrigger && dropMenu) {
    dropTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = dropMenu.style.display === "block";
      dropMenu.style.display = isVisible ? "none" : "block";
      if (dropArrow) {
        dropArrow.style.transform = isVisible ? "rotate(0deg)" : "rotate(180deg)";
      }
      if (!isVisible) {
        // Auto scroll to active item
        setTimeout(() => {
          const selectEl = document.getElementById("dashboard-date-select");
          if (selectEl) {
            visualActiveIdx = selectEl.selectedIndex;
          }
          const activeItem = dropMenu.querySelector(".active-dropdown-item");
          if (activeItem) {
            dropMenu.scrollTop = activeItem.offsetTop - (dropMenu.clientHeight / 2) + (activeItem.clientHeight / 2);
          }
        }, 10);
      }
    });

    // Biến quản lý trạng thái động lực học để cuộn mượt mà có gia tốc
    let currentTargetScrollTop = null;
    let scrollAnimationId = null;
    let currentScrollVelocity = 0; // Vận tốc cuộn hiện tại của menu
    const select = document.getElementById("dashboard-date-select");

    // Hàm cập nhật index của thẻ select dựa trên mục nằm chính giữa màn hình menu hiện tại
    // Hàm cập nhật index của thẻ select dựa trên mục nằm chính giữa màn hình menu hiện tại (Chỉ cập nhật visual, không dispatch event và không thay đổi select.selectedIndex)
    let visualActiveIdx = select.selectedIndex;
    function updateSelectedDateFromScrollVisual() {
      if (!select) return;
      const items = Array.from(dropMenu.children);
      if (items.length === 0) return;

      const menuCenter = dropMenu.scrollTop + (dropMenu.clientHeight / 2);
      let closestItem = null;
      let minDistance = Infinity;
      let closestIdx = visualActiveIdx;

      items.forEach((item, idx) => {
        const itemCenter = item.offsetTop + (item.clientHeight / 2);
        const dist = Math.abs(itemCenter - menuCenter);
        if (dist < minDistance) {
          minDistance = dist;
          closestItem = item;
          closestIdx = idx;
        }
      });

      if (closestIdx !== visualActiveIdx) {
        visualActiveIdx = closestIdx;
        
        // Cập nhật nhãn tiêu đề dropdown visual
        const label = document.getElementById("custom-dropdown-label");
        if (label) {
          label.textContent = select.options[closestIdx] ? select.options[closestIdx].textContent : "";
        }

        // Cập nhật class active visual
        items.forEach((item, idx) => {
          if (idx === closestIdx) {
            item.style.background = "rgba(16, 185, 129, 0.15)";
            item.style.color = "#10b981";
            item.style.fontWeight = "bold";
            item.classList.add("active-dropdown-item");
          } else {
            item.style.background = "transparent";
            item.style.color = "var(--text-primary)";
            item.style.fontWeight = "normal";
            item.classList.remove("active-dropdown-item");
          }
        });
      }
    }

    function animateScroll() {
      // Giảm ma sát nhẹ xuống 0.94 để trượt đi xa hơn tự nhiên, dừng êm ái hơn
      currentScrollVelocity *= 0.94;
      
      // Di chuyển thanh cuộn theo vận tốc hiện tại
      dropMenu.scrollTop += currentScrollVelocity;

      // Cập nhật trạng thái hiển thị visual của ngày đang trỏ qua trong khi lăn
      updateSelectedDateFromScrollVisual();

      // Nếu vận tốc quá nhỏ, dừng hẳn animation và cuộn êm ái về điểm dừng
      if (Math.abs(currentScrollVelocity) < 0.1) {
        currentScrollVelocity = 0;
        scrollAnimationId = null;
        
        // Căn chỉnh chính xác mục đang chọn vào giữa một cách êm ái bằng hiệu ứng smooth
        const items = Array.from(dropMenu.children);
        const activeItem = items[visualActiveIdx];
        if (activeItem) {
          const target = activeItem.offsetTop - (dropMenu.clientHeight / 2) + (activeItem.clientHeight / 2);
          
          dropMenu.scrollTo({
            top: target,
            behavior: "smooth"
          });
        }
        return;
      }
      
      scrollAnimationId = requestAnimationFrame(animateScroll);
    }

    let lastWheelTime = 0;
    // Lăn chuột trực tiếp trên menu dropdown: lăn đến đâu thanh cuộn trượt tới đó có gia tốc thực tế
    dropMenu.addEventListener("wheel", (e) => {
      e.preventDefault();
      
      // Tích lũy vận tốc cuộn dựa trên lực lăn chuột thực tế của người dùng (e.deltaY)
      // Sử dụng hệ số nhạy 0.05
      currentScrollVelocity += e.deltaY * 0.05;

      // Giới hạn vận tốc tối đa thấp hơn để tránh trượt quá nhanh ngoài tầm kiểm soát
      if (currentScrollVelocity > 15) currentScrollVelocity = 15;
      if (currentScrollVelocity < -15) currentScrollVelocity = -15;

      // Khởi chạy vòng lặp hoạt ảnh quán tính nếu chưa chạy
      if (!scrollAnimationId) {
        scrollAnimationId = requestAnimationFrame(animateScroll);
      }
    }, { passive: false });
  }

  // Close Custom Dropdown when clicking outside
  document.addEventListener("click", () => {
    if (dropMenu && dropMenu.style.display === "block") {
      dropMenu.style.display = "none";
      if (dropArrow) dropArrow.style.transform = "rotate(0deg)";
    }
  });

  const viewModeEl = document.getElementById("dashboard-view-mode");
  if (viewModeEl) {
    viewModeEl.addEventListener("change", () => {
      const mode = viewModeEl.value;
      const selectEl = document.getElementById("dashboard-date-select");
      const customContainer = document.getElementById("custom-date-container");
      
      const spinnerContainer = document.querySelector(".date-spinner-container");
      
      if (mode === "custom") {
        if (spinnerContainer) spinnerContainer.style.display = "none";
        else if (selectEl) selectEl.style.display = "none";
        if (customContainer) customContainer.style.display = "flex";
      } else {
        // Rebuild selector options based on new view mode
        populateDashboardDateSelector();
        
        if (spinnerContainer) spinnerContainer.style.display = "flex";
        else if (selectEl) selectEl.style.display = "block";
        if (customContainer) customContainer.style.display = "none";
      }
      updateUI();
    });
  }

  const customStartEl = document.getElementById("custom-start-date");
  if (customStartEl) {
    customStartEl.addEventListener("change", () => {
      updateUI();
      // Auto open end date picker if it doesn't have a value yet
      const customEndEl = document.getElementById("custom-end-date");
      if (customEndEl && !customEndEl.value && typeof customEndEl.showPicker === "function") {
        try {
          customEndEl.showPicker();
        } catch (err) {
          console.warn("Failed to auto-open end date picker:", err);
        }
      }
    });
  }

  const customEndEl = document.getElementById("custom-end-date");
  if (customEndEl) {
    customEndEl.addEventListener("change", () => {
      updateUI();
      // Auto open start date picker if it doesn't have a value yet
      const customStartEl = document.getElementById("custom-start-date");
      if (customStartEl && !customStartEl.value && typeof customStartEl.showPicker === "function") {
        try {
          customStartEl.showPicker();
        } catch (err) {
          console.warn("Failed to auto-open start date picker:", err);
        }
      }
    });
  }


  
  // Refresh Button click
  document.getElementById("refresh-btn").addEventListener("click", () => {
    syncData();
  });
  
  // Modal click triggers (Today)
  const elSub = document.getElementById("metric-interview-today-sub");
  if (elSub) {
    elSub.addEventListener("click", (e) => {
      const confirmedSpan = e.target.closest(".tc-confirmed");
      const callbackSpan = e.target.closest(".tc-callback");
      const overdueSpan = e.target.closest(".tc-overdue");
      
      if (confirmedSpan) {
        openDetailsModal("interviewConfirmed");
      } else if (callbackSpan) {
        openDetailsModal("unprocessedCallback");
      } else if (overdueSpan) {
        openDetailsModal("overdueCare");
      } else if (e.target.closest(".tc-warning")) {
        openDetailsModal("warningAlert");
      }
    });
  }

  // Modal click triggers (Tomorrow)
  const elTomorrowBanner = document.getElementById("tomorrow-banner-card");
  if (elTomorrowBanner) {
    elTomorrowBanner.addEventListener("click", (e) => {
      const tomorrowStr = getTomorrowDateStr();
      if (!tomorrowStr) return;
      
      const confirmedSpan = e.target.closest(".tc-confirmed");
      const callbackSpan = e.target.closest(".tc-callback");
      
      if (confirmedSpan) {
        openDetailsModal("interviewConfirmed", [tomorrowStr]);
      } else if (callbackSpan) {
        openDetailsModal("unprocessedCallback", [tomorrowStr]);
      } else {
        // Default to interviewConfirmed if clicked elsewhere on tomorrow banner
        openDetailsModal("interviewConfirmed", [tomorrowStr]);
      }
    });
  }

  const elMainVal = document.getElementById("metric-interview-today");
  if (elMainVal) {
    elMainVal.addEventListener("click", () => {
      openDetailsModal("interviewConfirmed");
    });
  }

  const elHireVal = document.getElementById("metric-hire-today");
  if (elHireVal) {
    elHireVal.addEventListener("click", () => {
      openDetailsModal("hireConfirmed");
    });
  }

  const elNewVal = document.getElementById("metric-new-today");
  if (elNewVal) {
    elNewVal.addEventListener("click", () => {
      openDetailsModal("newCandidates");
    });
  }

  const elProcVal = document.getElementById("metric-processed-today");
  if (elProcVal) {
    elProcVal.addEventListener("click", () => {
      openDetailsModal("processedCandidates");
    });
  }

  // Monthly summary click listeners
  const elSumNew = document.getElementById("sum-month-new");
  if (elSumNew) {
    elSumNew.addEventListener("click", () => {
      openDetailsModal("newCandidates", getMonthlyDates());
    });
  }

  const elSumInt = document.getElementById("sum-month-interview");
  if (elSumInt) {
    elSumInt.addEventListener("click", () => {
      openDetailsModal("interviewConfirmed", getMonthlyDates());
    });
  }

  const elSumHire = document.getElementById("sum-month-hire");
  if (elSumHire) {
    elSumHire.addEventListener("click", () => {
      openDetailsModal("hireConfirmed", getMonthlyDates());
    });
  }

  const elSumProc = document.getElementById("sum-month-processed");
  if (elSumProc) {
    elSumProc.addEventListener("click", () => {
      openDetailsModal("processedCandidates", getMonthlyDates());
    });
  }

  const elCloseModal = document.getElementById("close-modal-btn");
  if (elCloseModal) {
    elCloseModal.addEventListener("click", closeDetailsModal);
  }

  const elModal = document.getElementById("details-modal");
  if (elModal) {
    elModal.addEventListener("click", (e) => {
      if (e.target === elModal) {
        closeDetailsModal();
      }
    });
  }
  
  // Auto-sync immediately when the page becomes active or user switches tabs
  window.addEventListener("focus", () => {
    console.log("Window focused. Triggering instant sync to avoid data mismatch.");
    syncData();
  });
  
  // Load cache and start timer
  loadCache();
  startCountdown();
});

// Candidate Modal Details Helper Functions
function getCandidatesForType(type, customDates = null) {
  const list = [];
  const dates = [];
  
  if (customDates) {
    dates.push(...customDates);
  } else {
    if (!state.startDate || !state.endDate) {
      console.warn("[getCandidatesForType] No start/end date in state");
      return list;
    }
    
    const start = new Date(state.startDate);
    const end = new Date(state.endDate);
    
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      dates.push(`${y}-${m}-${day}`);
    }
  }
  
  console.log(`[getCandidatesForType] Called with type="${type}", customDates=`, customDates, "resolved dates =", dates);
  
  const todayStr = state.endDate || (state.datesList && state.datesList.length > 0 ? state.datesList[0] : "");

  if (!state.candidates || state.candidates.length <= 1) {
    console.warn("[getCandidatesForType] state.candidates is empty or header-only");
    return list;
  }

  const seenKeys = new Set();
  for (let i = 1; i < state.candidates.length; i++) {
    const row = state.candidates[i];
    if (row.length < 18) continue;

    const name = row[1] ? row[1].trim() : "";
    const phone = row[2] ? row[2].trim() : "";
    const recruiter = row[8] ? row[8].trim() : "Chưa rõ";
    const status = row[13] ? row[13].trim() : "";
    const statusClean = status.toLowerCase();
    const factoryName = row[18] || "Pegatron"; // Default fallback
    
    const cccd = row[3] ? row[3].trim() : "";
    const regDate      = normalizeDate(row[0]);
    const interviewDate = normalizeDate(row[12]);
    const nextCareDate  = normalizeDate(row[14]);
    const hireDate     = normalizeDate(row[16]);
    const careDate     = normalizeDate(row[17]);
    
    const candPhone = row[2] ? row[2].trim() : "";
    const candName  = row[1] ? row[1].trim() : "";
    const candKey   = candPhone || candName || `row_${i}`;
    const rowColor = state.rowColors ? state.rowColors[i] : null;

    if (type === "newCandidates") {
      if (regDate && dates.includes(regDate)) {
        if (!seenKeys.has(candKey)) {
          seenKeys.add(candKey);
          list.push({
            name,
            factory: factoryName,
            phone,
            cccd,
            recruiter,
            status,
            dateInfo: `Đăng ký: ${row[0].split(" ")[0]}`,
            rawDate: regDate
          });
        }
      }
    } else if (type === "processedCandidates") {
      if (careDate && dates.includes(careDate)) {
        if (!seenKeys.has(candKey)) {
          seenKeys.add(candKey);
          list.push({
            name,
            factory: factoryName,
            phone,
            cccd,
            recruiter,
            status,
            dateInfo: `Xử lý: ${row[17]}`,
            rawDate: careDate
          });
        }
      }
    } else if (type === "interviewConfirmed") {
      const isInvalidStatus = ["kđl", "knm", "kdl", "bùng pv", "từ chối", "ko đạt"].includes(statusClean);
      if (!isInvalidStatus) {
        const historyItem = state.candidateHistory[candKey];
        if (historyItem && historyItem.interviewDates) {
          historyItem.interviewDates.forEach(intDate => {
            if (dates.includes(intDate)) {
              const matchColor = true;
              if (matchColor) {
                if (!seenKeys.has(candKey)) {
                  seenKeys.add(candKey);
                  list.push({
                    name,
                    factory: factoryName,
                    phone,
                    cccd,
                    recruiter,
                    status,
                    dateInfo: `Lịch PV: ${row[12]} (Xác nhận)`,
                    rawDate: intDate
                  });
                }
              }
            }
          });
        }
      }
    } else if (type === "hireConfirmed") {
      if (hireDate && dates.includes(hireDate) && statusClean === "đã nhận việc") {
        if (!seenKeys.has(candKey)) {
          seenKeys.add(candKey);
          list.push({
            name,
            factory: factoryName,
            phone,
            cccd,
            recruiter,
            status,
            dateInfo: `Nhận việc: ${row[16]}`,
            rawDate: hireDate
          });
        }
      }
    } else if (type === "overdueCare") {
      if (nextCareDate && nextCareDate < todayStr && statusClean) {
        if (!careDate || careDate < nextCareDate) {
          if (!seenKeys.has(candKey)) {
            seenKeys.add(candKey);
            list.push({
              name,
              factory: factoryName,
              phone,
              cccd,
              recruiter,
              status,
              dateInfo: `Hẹn CS: ${row[14]} (Trễ hạn)`,
              rawDate: nextCareDate
            });
          }
        }
      }
    } else if (type === "warningAlert") {
      // ⚠️ Quy tắc cảnh báo sẽ được bổ sung sau theo yêu cầu của anh
      // Hiện tại trả về danh sách rỗng
    } else if (type === "unprocessedCallback") {
      const historyItem = state.candidateHistory[candKey];
      if (historyItem && historyItem.careDates) {
        historyItem.careDates.forEach(cDate => {
          if (dates.includes(cDate)) {
            if (careDate !== cDate) {
              if (!seenKeys.has(candKey)) {
                seenKeys.add(candKey);
                list.push({
                  name,
                  factory: factoryName,
                  phone,
                  cccd,
                  recruiter,
                  status,
                  dateInfo: `Lịch CS: ${formatUIDate(cDate)} (Chưa CS)`,
                  rawDate: cDate
                });
              }
            }
          }
        });
      }
    }
  }

  // Sắp xếp giảm dần theo ngày (mới nhất ở trên cùng)
  list.sort((a, b) => {
    if (!a.rawDate) return 1;
    if (!b.rawDate) return -1;
    return b.rawDate.localeCompare(a.rawDate);
  });

  console.log(`[getCandidatesForType] Found ${list.length} candidates for type="${type}"`);
  return list;
}

function openDetailsModal(type, customDates = null) {
  const modal = document.getElementById("details-modal");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-table-body");
  
  if (!modal || !modalTitle || !modalBody) return;

  const dates = [];
  if (customDates) {
    dates.push(...customDates);
  } else {
    const start = new Date(state.startDate);
    const end = new Date(state.endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      dates.push(`${y}-${m}-${day}`);
    }
  }
  
  let title = "";
  if (type === "newCandidates") {
    title = "Danh sách ứng viên Mới Đăng Ký";
  } else if (type === "processedCandidates") {
    title = "Danh sách ứng viên Đã Xử Lý";
  } else if (type === "interviewConfirmed") {
    title = "Danh sách ứng viên Hẹn Phỏng Vấn (Xác nhận)";
  } else if (type === "hireConfirmed") {
    title = "Danh sách ứng viên Nhận Việc";
  } else if (type === "overdueCare") {
    title = "Danh sách ứng viên Trễ Chăm Sóc";
  } else if (type === "warningAlert") {
    title = "🔔 Danh sách Cảnh Báo";
  } else if (type === "unprocessedCallback") {
    title = "Danh sách ứng viên Chưa Chăm Sóc Lại";
  }
  
  modalTitle.textContent = title;
  modalBody.innerHTML = `<tr><td colspan="5" class="text-center">Đang tải chi tiết...</td></tr>`;
  modal.classList.add("active");
  
  const candidates = getCandidatesForType(type, customDates);
  
  if (candidates.length === 0) {
    const datesStr = (customDates || []).join(", ") || `${state.startDate} -> ${state.endDate}`;
    modalBody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-muted" style="padding: 20px;">
          Không có ứng viên nào trong khoảng thời gian này.
        </td>
      </tr>
    `;
  } else {
    modalBody.innerHTML = candidates.map(c => {
      let badgeStyle = "background:rgba(255,255,255,0.08);color:var(--text-secondary);border:1px solid rgba(255,255,255,0.1);";
      const f = String(c.factory).trim().toLowerCase();
      if (f === "pegatron") {
        badgeStyle = "background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);"; // Blue theme
      } else if (f === "brother") {
        badgeStyle = "background:rgba(168,85,247,0.15);color:#c084fc;border:1px solid rgba(168,85,247,0.3);"; // Purple theme
      } else if (f === "lg") {
        badgeStyle = "background:rgba(244,63,94,0.15);color:#fb7185;border:1px solid rgba(244,63,94,0.3);"; // Red theme
      } else if (f === "usi") {
        badgeStyle = "background:rgba(6,182,212,0.15);color:#22d3ee;border:1px solid rgba(6,182,212,0.3);"; // Cyan theme
      } else if (f === "fox qn") {
        badgeStyle = "background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3);"; // Gold/Amber theme
      }
      return `
      <tr>
        <td><strong>${c.name}</strong></td>
        <td><span class="status-badge" style="font-weight:bold;font-size:10px;padding:2px 6px;border-radius:4px;${badgeStyle}">${c.factory}</span></td>
        <td class="text-left" style="font-family:monospace; font-size:12px;">${c.phone || '<span class="text-muted">Không có</span>'}</td>
        <td class="text-left" style="font-family:monospace; font-size:12px;">${c.cccd || '<span class="text-muted">Không có</span>'}</td>
        <td>${c.recruiter}</td>
        <td><span class="status-badge status-${getStatusClass(c.status)}">${c.status}</span></td>
        <td>${c.dateInfo}</td>
      </tr>
      `;
    }).join("");
  }
}

function getStatusClass(status) {
  if (!status) return "unknown";
  const s = status.trim().toLowerCase();
  if (s === "chăm sóc tiếp") return "care";
  if (s === "đã nhận việc") return "hire";
  if (s === "hẹn phỏng vấn") return "interview";
  if (s === "bùng pv" || s === "từ chối" || s === "ko đạt") return "fail";
  return "other";
}

function closeDetailsModal() {
  const modal = document.getElementById("details-modal");
  if (modal) modal.classList.remove("active");
}

function getMonthlyDates() {
  const dates = [];
  
  let year = 2026;
  let month = 5; // 0-based (June)
  let day = 25;
  
  if (state.endDate) {
    const parts = state.endDate.split("-");
    if (parts.length === 3) {
      year = parseInt(parts[0]);
      month = parseInt(parts[1]) - 1;
      day = parseInt(parts[2]);
    }
  } else if (state.datesList && state.datesList.length > 0) {
    const parts = state.datesList[0].split("-");
    if (parts.length === 3) {
      year = parseInt(parts[0]);
      month = parseInt(parts[1]) - 1;
      day = parseInt(parts[2]);
    }
  } else {
    const today = new Date();
    year = today.getFullYear();
    month = today.getMonth();
    day = today.getDate();
  }
  
  for (let i = 1; i <= day; i++) {
    const y = year;
    const m = String(month + 1).padStart(2, '0');
    const d = String(i).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
  }
  return dates;
}

function getTomorrowDateStr() {
  const dateEl = document.getElementById("metric-interview-tomorrow-date");
  if (dateEl && dateEl.textContent) {
    const text = dateEl.textContent.replace("Ngày", "").trim(); // "DD/MM/YYYY"
    const parts = text.split("/");
    if (parts.length === 3) {
      const day = parts[0].trim().padStart(2, '0');
      const month = parts[1].trim().padStart(2, '0');
      const year = parts[2].trim();
      return `${year}-${month}-${day}`;
    }
  }
  
  // Fallback to logic calculation
  const baseDateStr = state.endDate || (state.datesList && state.datesList.length > 0 ? state.datesList[0] : "");
  if (!baseDateStr) return "";
  const parts = baseDateStr.split("-");
  const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  return `${y}-${m}-${d}`;
}

// ============================================================================
// INTEGRATED DASHBOARD TABS, MARKETING AND FINANCE MANAGEMENT
// ============================================================================

let unlockedSections = {
  marketing: false,
  finance: false
};

// --- Main Dashboard Tab Switching and Password modal logic ---
function setupMainNavigation() {
  const buttons = document.querySelectorAll(".main-tab-btn");
  const sections = document.querySelectorAll(".main-section");
  const pwdModal = document.getElementById("password-modal");
  const pwdInput = document.getElementById("password-input");
  const pwdError = document.getElementById("password-error");
  const pwdSubmit = document.getElementById("password-submit-btn");
  const pwdCancel = document.getElementById("password-cancel-btn");
  const pwdClose = document.getElementById("close-password-btn");
  
  let targetSection = "sale";
  let pendingButton = null;

  buttons.forEach(btn => {
    btn.addEventListener("click", (e) => {
      const clickedBtn = e.currentTarget;
      const section = clickedBtn.getAttribute("data-section");
      
      if (section === "sale") {
        switchSection("sale", clickedBtn);
      } else if (section === "marketing") {
        if (unlockedSections.marketing) {
          switchSection("marketing", clickedBtn);
        } else {
          showPasswordPrompt("marketing", clickedBtn);
        }
      } else if (section === "finance") {
        if (unlockedSections.finance) {
          switchSection("finance", clickedBtn);
        } else {
          showPasswordPrompt("finance", clickedBtn);
        }
      }
    });
  });

  function switchSection(sectName, btnEl) {
    sections.forEach(s => {
      s.classList.remove("active");
      s.style.display = "none";
    });
    
    buttons.forEach(b => b.classList.remove("active"));
    btnEl.classList.add("active");
    
    const activeSection = document.getElementById(`section-${sectName}`);
    if (activeSection) {
      activeSection.classList.add("active");
      activeSection.style.display = "flex";
    }
    
    if (sectName === "marketing") {
      initMarketingDashboard();
    } else if (sectName === "finance") {
      initFinanceDashboard();
    }
  }

  function showPasswordPrompt(sect, btn) {
    targetSection = sect;
    pendingButton = btn;
    
    document.getElementById("password-modal-title").textContent = `Mở khóa Báo Cáo ${sect === 'marketing' ? 'Marketing' : 'Tài Chính'}`;
    document.getElementById("password-prompt-text").textContent = `Vui lòng nhập mã PIN bảo mật để truy cập Báo cáo ${sect === 'marketing' ? 'Marketing' : 'Tài Chính'}.`;
    
    pwdInput.value = "";
    pwdError.style.display = "none";
    pwdModal.style.display = "flex";
    pwdModal.classList.add("active");
    pwdInput.focus();
  }

  function handleVerifyPassword() {
    const pin = pwdInput.value.trim();
    let isCorrect = false;
    
    if (targetSection === "marketing" && pin === "888888") {
      isCorrect = true;
      unlockedSections.marketing = true;
      pendingButton.textContent = "🔓 Báo cáo Marketing";
    } else if (targetSection === "finance" && pin === "999999") {
      isCorrect = true;
      unlockedSections.finance = true;
      pendingButton.textContent = "🔓 Báo cáo Tài chính";
    }
    
    if (isCorrect) {
      pwdModal.style.display = "none";
      pwdModal.classList.remove("active");
      switchSection(targetSection, pendingButton);
    } else {
      pwdError.style.display = "block";
      pwdInput.value = "";
      pwdInput.focus();
    }
  }

  pwdSubmit.addEventListener("click", handleVerifyPassword);
  pwdInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") handleVerifyPassword();
  });
  
  const hideModal = () => {
    pwdModal.style.display = "none";
    pwdModal.classList.remove("active");
  };
  
  pwdCancel.addEventListener("click", hideModal);
  pwdClose.addEventListener("click", hideModal);
}

// ============================================================================
// MARKETING DASHBOARD LOGIC
// ============================================================================

let mktRawData = [];
let mktChartObj = null;

function initMarketingDashboard() {
  const refreshBtn = document.getElementById("mkt-refresh-btn");
  if (refreshBtn && !refreshBtn.dataset.listenerAdded) {
    refreshBtn.dataset.listenerAdded = "true";
    refreshBtn.addEventListener("click", () => fetchMarketingData());
  }
  
  const monthSelect = document.getElementById("mkt-month-select");
  if (monthSelect && !monthSelect.dataset.listenerAdded) {
    monthSelect.dataset.listenerAdded = "true";
    monthSelect.addEventListener("change", () => fetchMarketingData());
  }
  
  const selectBox = document.getElementById("mkt-campaign-select");
  if (selectBox && !selectBox.dataset.listenerAdded) {
    selectBox.dataset.listenerAdded = "true";
    selectBox.addEventListener("change", () => renderMarketingDashboard());
  }
  fetchMarketingData();
}

async function fetchMarketingData() {
  const tableBody = document.getElementById("mkt-table-body");
  if (tableBody) {
    tableBody.innerHTML = `<tr><td colspan="8" class="text-center text-secondary">Đang tải dữ liệu...</td></tr>`;
  }
  
  const monthSelect = document.getElementById("mkt-month-select");
  const month = monthSelect ? monthSelect.value : "7";
  
  let mktUrl = "";
  if (IS_CHROME_EXT) {
    const gids = { "4": "0", "5": "609412597", "6": "1703521677", "7": "1245696062" };
    const gid = gids[month] || "1245696062";
    mktUrl = `https://docs.google.com/spreadsheets/d/1NgDH3ayQ7nE4_mcT1B5HEW1YrMHaJH8xtf0-u0bFNZQ/export?format=csv&gid=${gid}`;
  } else {
    mktUrl = `/api/marketing?month=${month}`;
  }
  
  try {
    const response = await fetch(mktUrl);
    const text = await response.text();
    mktRawData = parseCSV(text);
    
    // Đổ động các tùy chọn nhà máy dựa trên dòng tiêu đề
    updateCampaignSelector();
    
    renderMarketingDashboard();
  } catch (error) {
    console.error("Lỗi tải dữ liệu marketing:", error);
    if (tableBody) {
      tableBody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">Lỗi tải dữ liệu: ${error.message}</td></tr>`;
    }
  }
}

function updateCampaignSelector() {
  const selectBox = document.getElementById("mkt-campaign-select");
  if (!selectBox || !mktRawData) return;
  
  // Tìm dòng tiêu đề (dòng có phần tử đầu tiên là 'Ngày')
  const headerRow = mktRawData.find(row => row && row[0] && row[0].trim() === "Ngày");
  if (!headerRow) return;
  
  let optionsHTML = "";
  // Cột C (Tổng - index 2) trở đi
  for (let idx = 2; idx < headerRow.length; idx++) {
    const name = headerRow[idx] ? headerRow[idx].trim() : "";
    if (name) {
      optionsHTML += `<option value="${idx}">${name}</option>`;
    }
  }
  selectBox.innerHTML = optionsHTML;
}

function parseMktDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split("/");
  if (parts.length < 2) return null;
  const d = parts[0].padStart(2, '0');
  const m = parts[1].padStart(2, '0');
  const y = "2026"; // Mặc định năm 2026 cho tập dữ liệu hiện tại
  return `${y}-${m}-${d}`;
}

function renderMarketingDashboard() {
  if (!mktRawData || mktRawData.length === 0) return;
  
  const selectBox = document.getElementById("mkt-campaign-select");
  let colIndex = parseInt(selectBox ? selectBox.value : "2"); // Mặc định lấy cột 2 (Tổng)
  if (isNaN(colIndex)) colIndex = 2;
  
  let startIndex = -1;
  for (let i = 0; i < mktRawData.length; i++) {
    const cellA = mktRawData[i][0] ? mktRawData[i][0].trim() : "";
    // Đảm bảo bỏ qua dòng tiêu đề 'Ngày' bằng cách check xem cellA có bắt đầu bằng số (ngày) không
    if (/^\d+\/\d+/.test(cellA) && cellA !== "Ngày") {
      startIndex = i;
      break;
    }
  }
  if (startIndex === -1) startIndex = 9; // Fallback dòng 10 (index 9)
  
  const blocks = [];
  // Cấu trúc mới: Mỗi ngày chiếm đúng 4 dòng khít nhau
  for (let i = startIndex; i < mktRawData.length; i += 4) {
    if (i + 3 >= mktRawData.length) break;
    const block = mktRawData.slice(i, i + 4);
    const dateVal = block[0][0] || "";
    if (!dateVal || !dateVal.includes("/")) continue;
    
    const stdDate = parseMktDate(dateVal);
    if (stdDate) {
      blocks.push({
        date: stdDate,
        displayDate: dateVal,
        data: block
      });
    }
  }

  // Lọc theo khoảng ngày (startDate -> endDate) nếu được chọn trên UI
  let filteredBlocks = blocks;
  if (state.startDate && state.endDate) {
    filteredBlocks = blocks.filter(b => b.date >= state.startDate && b.date <= state.endDate);
  }

  // Sắp xếp tăng dần theo thời gian để vẽ biểu đồ đúng
  filteredBlocks.sort((a, b) => a.date.localeCompare(b.date));
  
  const chartData = {
    labels: [],
    spent: [],
    leads: []
  };
  
  let totalSpent = 0;
  let totalLeads = 0;
  let totalPhones = 0;
  let tableHTML = "";
  
  // Lấy nhãn cột cuối cùng của block (Số điện thoại / Số nhận việc)
  let phoneHeaderLabel = "Số điện thoại / Nhận việc";
  if (filteredBlocks.length > 0) {
    phoneHeaderLabel = filteredBlocks[0].data[3][1] || "Số điện thoại";
  }
  
  // Cập nhật nhãn cột chi tiết trên UI để đồng bộ
  const thead = document.querySelector(".history-table thead tr");
  if (thead) {
    thead.innerHTML = `
      <th>Ngày</th>
      <th style="text-align: right;">Chi Phí (Spent)</th>
      <th style="text-align: right;">Số Lead</th>
      <th style="text-align: right;">CPL</th>
      <th style="text-align: right;">${phoneHeaderLabel}</th>
    `;
    
    // Cập nhật nhãn của metric box thứ 4
    const hiresLabel = document.querySelector(".metrics-grid div:nth-child(4) .metric-label");
    if (hiresLabel) {
      hiresLabel.textContent = `Tổng ${phoneHeaderLabel}`;
    }
  }

  filteredBlocks.forEach(item => {
    const block = item.data;
    const date = item.displayDate;
    const spentStr = block[0][colIndex] || "";
    const leadsStr = block[1][colIndex] || "";
    const cplStr = block[2][colIndex] || "";
    const phonesStr = block[3][colIndex] || "";
    
    const spentVal = cleanNumber(spentStr);
    const leadsVal = cleanNumber(leadsStr);
    const phonesVal = cleanNumber(phonesStr);
    
    totalSpent += spentVal;
    totalLeads += leadsVal;
    totalPhones += phonesVal;
    
    chartData.labels.push(date);
    chartData.spent.push(spentVal);
    chartData.leads.push(leadsVal);
    
    tableHTML += `
      <tr>
        <td><strong>${date}</strong></td>
        <td style="text-align: right;">${spentStr || '0 đ'}</td>
        <td style="text-align: right;">${leadsStr || '0'}</td>
        <td style="text-align: right;">${cplStr || '-'}</td>
        <td style="text-align: right;">${phonesStr || '0'}</td>
      </tr>
    `;
  });
  
  const cpl = totalLeads > 0 ? Math.round(totalSpent / totalLeads) : 0;
  
  document.getElementById("mkt-metric-spent").textContent = formatVND(totalSpent);
  document.getElementById("mkt-metric-leads").textContent = totalLeads;
  document.getElementById("mkt-metric-cpl").textContent = formatVND(cpl);
  
  // Cập nhật giá trị metric box 4
  const hiresValue = document.getElementById("mkt-metric-hires");
  if (hiresValue) {
    hiresValue.textContent = totalPhones;
  }
  
  const tableBody = document.getElementById("mkt-table-body");
  if (tableBody) {
    tableBody.innerHTML = tableHTML || `<tr><td colspan="5" class="text-center text-secondary">Không có dữ liệu trong khoảng thời gian này</td></tr>`;
  }
  
  renderMarketingChart(chartData);
}

function renderMarketingChart(data) {
  const canvas = document.getElementById("mkt-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (mktChartObj) {
    mktChartObj.destroy();
  }
  
  mktChartObj = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.labels,
      datasets: [
        {
          label: 'Chi phí (VND)',
          data: data.spent,
          backgroundColor: 'rgba(6, 182, 212, 0.4)',
          borderColor: '#06b6d4',
          borderWidth: 1.5,
          yAxisID: 'ySpent',
          order: 2
        },
        {
          label: 'Số Lead',
          data: data.leads,
          type: 'line',
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          pointBackgroundColor: '#f59e0b',
          borderWidth: 2.5,
          fill: true,
          yAxisID: 'yLeads',
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#6e8fad', font: { size: 10 } }
        },
        ySpent: {
          type: 'linear',
          position: 'left',
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#6e8fad',
            font: { size: 10 },
            callback: (val) => val.toLocaleString('vi-VN') + ' đ'
          }
        },
        yLeads: {
          type: 'linear',
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: '#6e8fad', font: { size: 10 } }
        }
      },
      plugins: {
        legend: {
          labels: { color: '#eef4ff', font: { size: 11 } }
        }
      }
    }
  });
}

// ============================================================================
// FINANCE DASHBOARD LOGIC
// ============================================================================

let finCandidatesData = [];
let finPnlChartObj = null;
let finSelectedFile = null;
let finStatsData = null;
let finExpensesData = [];

const finFetch = (path, options = {}) => {
  return fetch(path, options);
};

// ===== GOOGLE SHEET TÀI CHÍNH =====
const FIN_SHEET_ID = '1Rx9rDMe1t8A76Sj-4nBsYjbO49dzw-beYMYFF0ffk1E';
const FIN_GID_CANDIDATES = '0';           // Tab: Danh sách nhận việc 2026
const FIN_GID_PRICING    = '702358906';   // Tab: Cấu hình Đơn giá
const FIN_GID_EXPENSES   = '1663228131';  // Tab: Chi phí Vận hành

function finSheetCsvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${FIN_SHEET_ID}/export?format=csv&gid=${gid}`;
}


function initFinanceDashboard() {
  const mainTabContainer = document.querySelector("#section-finance");
  if (!mainTabContainer || mainTabContainer.dataset.initialized) return;
  mainTabContainer.dataset.initialized = "true";

  // Finance Tab Switching
  document.querySelectorAll(".finance-tab-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const clickedBtn = e.currentTarget;
      const targetTab = clickedBtn.getAttribute("data-tab");
      
      document.querySelectorAll(".finance-tab-btn").forEach(b => b.classList.remove("active"));
      clickedBtn.classList.add("active");
      
      document.querySelectorAll(".finance-tab-content").forEach(p => p.style.display = "none");
      document.getElementById(`fin-tab-${targetTab}`).style.display = "block";
    });
  });

  // Reconcile sub-tabs toggling
  document.querySelectorAll(".fin-recon-tab-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const clickedBtn = e.currentTarget;
      const targetTab = clickedBtn.getAttribute("data-tab");
      
      document.querySelectorAll(".fin-recon-tab-btn").forEach(b => b.classList.remove("active"));
      clickedBtn.classList.add("active");
      
      document.querySelectorAll(".fin-recon-table-panel").forEach(p => p.style.display = "none");
      document.getElementById(`fin-recon-tab-${targetTab}`).style.display = "block";
    });
  });

  const searchCandidatesInput = document.getElementById("fin-search-candidates");
  if (searchCandidatesInput) {
    searchCandidatesInput.addEventListener("input", filterFinCandidates);
  }

  document.querySelectorAll(".fin-month-filter-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".fin-month-filter-btn").forEach(b => b.classList.remove("active"));
      e.currentTarget.classList.add("active");
      filterFinCandidates();
    });
  });

  const pricingForm = document.getElementById("fin-pricing-form");
  if (pricingForm) {
    pricingForm.addEventListener("submit", saveFinPricing);
  }
  const pricingResetBtn = document.getElementById("fin-pricing-reset-btn");
  if (pricingResetBtn) {
    pricingResetBtn.addEventListener("click", resetFinPricingForm);
  }

  const expTabManual = document.getElementById("fin-exp-tab-manual");
  const expTabSheet = document.getElementById("fin-exp-tab-sheet");
  if (expTabManual && expTabSheet) {
    expTabManual.addEventListener("click", () => switchFinExpenseTab('manual'));
    expTabSheet.addEventListener("click", () => switchFinExpenseTab('sheet'));
  }

  ['fin-exp-ads','fin-exp-salary','fin-exp-phone','fin-exp-office','fin-exp-other'].forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener("input", () => fmtFinMoney(input));
    }
  });

  const expMonthInput = document.getElementById("fin-exp-month");
  if (expMonthInput) {
    expMonthInput.addEventListener("change", (e) => onFinExpenseMonthChange(e.target.value));
  }

  const expenseSaveBtn = document.getElementById("fin-expense-save-btn");
  if (expenseSaveBtn) {
    expenseSaveBtn.addEventListener("click", saveFinExpense);
  }
  const expenseResetBtn = document.getElementById("fin-expense-reset-btn");
  if (expenseResetBtn) {
    expenseResetBtn.addEventListener("click", resetFinExpenseForm);
  }

  const expSyncSheetBtn = document.getElementById("fin-expense-sync-sheet-btn");
  if (expSyncSheetBtn) {
    expSyncSheetBtn.addEventListener("click", syncFinExpenseSheet);
  }

  setupFinDragAndDrop();
  const executeReconBtn = document.getElementById("fin-execute-recon-btn");
  if (executeReconBtn) {
    executeReconBtn.addEventListener("click", executeFinReconciliation);
  }

  const syncBtn = document.getElementById("fin-sync-btn");
  if (syncBtn) {
    syncBtn.addEventListener("click", () => triggerFinSync(false));
  }

  const enableCustomRange = document.getElementById("fin-enable-custom-range");
  if (enableCustomRange) {
    enableCustomRange.addEventListener("change", toggleFinRangeFilter);
  }
  const statsMonthFilter = document.getElementById("fin-stats-month-filter");
  if (statsMonthFilter) {
    statsMonthFilter.addEventListener("change", updateFinOverviewStats);
  }
  const statsStartFilter = document.getElementById("fin-stats-start-filter");
  const statsEndFilter = document.getElementById("fin-stats-end-filter");
  if (statsStartFilter && statsEndFilter) {
    statsStartFilter.addEventListener("change", updateFinOverviewStats);
    statsEndFilter.addEventListener("change", updateFinOverviewStats);
  }

  const now = new Date();
  const monthStr = now.toISOString().slice(0, 7);
  if (document.getElementById('fin-exp-month')) document.getElementById('fin-exp-month').value = monthStr;
  
  const lastSyncTime = localStorage.getItem('fin_last_sync_time');
  if (lastSyncTime) {
    document.getElementById('fin-sync-status-lbl').innerText = `Đồng bộ lần cuối: ${lastSyncTime}`;
    try {
      const parts = lastSyncTime.split(' ');
      const timePart = parts.find(p => p.includes(':'));
      if (timePart) {
        document.getElementById('fin-sync-time-lbl').innerText = timePart.substring(0, 5);
      }
    } catch(e) {}
  }

  loadFinCandidates();
  // Tải đơn giá và chi phí từ Google Sheet, sau đó load danh sách và thống kê
  Promise.all([loadPricingFromSheet(), loadExpensesFromSheet()]).then(() => {
    loadFinPricingList();
    loadFinExpensesList();
    loadFinStats();
  });
  initFinReconCycleDropdown();
}

function showFinLoading(show) {
  const loader = document.getElementById("fin-loading");
  if (loader) loader.style.display = show ? "flex" : "none";
}



function loadFinCandidates() {
  showFinLoading(true);
  fetch(finSheetCsvUrl(FIN_GID_CANDIDATES))
    .then(r => r.text())
    .then(csvText => {
      const rows = parseCSV(csvText);
      if (rows.length < 2) { showFinLoading(false); return; }
      // Map cột: STT, Nhà máy, Nguồn, Mã NV, Họ và tên, SĐT, CCCD, Ngày nhận việc, Ngày kết thúc
      const data = rows.slice(1).filter(r => r[0] && r[4]).map(r => {
        const hasEndDate = r[8] && r[8].trim() !== '';
        return {
          stt:           r[0]  || '',
          factory:       r[1]  || '',
          source:        r[2]  || '',
          employee_id:   r[3]  || '',
          full_name:     r[4]  || '',
          phone:         r[5]  || '',
          cccd:          r[6]  || '',
          boarding_date: r[7]  || '',
          end_date:      r[8]  || '',
          status:        hasEndDate ? 'Nghỉ việc' : 'Đang làm việc',
          // các cột bổ sung nếu có
          work_hours:    r[9]  || '',
          work_days:     r[10] || '',
          revenue:       r[11] || '',
        };
      });
      finCandidatesData = data;
      renderFinCandidates(data);
      loadFinStats(); // Cập nhật lại thống kê tài chính và các dropdown tháng
      showFinLoading(false);
    })
    .catch(err => {
      console.error('Lỗi tải danh sách nhận việc từ Sheet:', err);
      showFinLoading(false);
    });
}

function renderFinCandidates(list) {
  const body = document.getElementById('fin-candidates-body');
  if (!body) return;
  body.innerHTML = '';
  
  list.forEach(c => {
    const tr = document.createElement('tr');
    
    let badgeStyle = '';
    switch (c.status) {
      case 'Đang làm việc':
        badgeStyle = 'background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);';
        break;
      case 'Nghỉ việc':
      case 'Đã nghỉ việc':
        badgeStyle = 'background:rgba(251,146,60,0.15);color:#fb923c;border:1px solid rgba(251,146,60,0.3);';
        break;
      case 'Hết hạn':
        badgeStyle = 'background:rgba(100,116,139,0.2);color:#94a3b8;border:1px solid rgba(100,116,139,0.3);';
        break;
      default:
        badgeStyle = 'background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);';
    }

    const factoryStyle = getFinFactoryBadgeStyle(c.factory);

    tr.innerHTML = `
      <td style="font-weight: bold;">${c.employee_id || '-'}</td>
      <td>${c.full_name}</td>
      <td><span class="badge" style="${factoryStyle}">${c.factory}</span></td>
      <td>${c.phone || '-'}</td>
      <td>${c.cccd || '-'}</td>
      <td>${c.boarding_date ? formatFinDate(c.boarding_date) : '-'}</td>
      <td>${c.end_date ? formatFinDate(c.end_date) : '-'}</td>
      <td><span class="badge" style="${badgeStyle}">${c.status || 'Đang làm việc'}</span></td>
    `;
    body.appendChild(tr);
  });
}

function getFinFactoryBadgeStyle(factory) {
  const f = (factory || '').toUpperCase().trim();
  if (f.includes('PGT') || f.includes('PEGATRON')) return 'background: rgba(59, 130, 246, 0.15); color: #60a5fa;';
  if (f.includes('WIS') || f.includes('WISTRON')) return 'background: rgba(16, 185, 129, 0.15); color: #34d399;';
  if (f.includes('BROTHER')) return 'background: rgba(245, 158, 11, 0.15); color: #fbbf24;';
  if (f.includes('GOERTEK BN') || f.includes('GT BN')) return 'background: rgba(139, 92, 246, 0.15); color: #a78bfa;';
  if (f.includes('GOERTEK NA') || f.includes('GT NA')) return 'background: rgba(236, 72, 153, 0.15); color: #f472b6;';
  if (f.includes('FOX') || f.includes('FOXCONN')) return 'background: rgba(20, 184, 166, 0.15); color: #2dd4bf;';
  if (f.includes('USI')) return 'background: rgba(99, 102, 241, 0.15); color: #818cf8;';
  if (f.includes('SEV')) return 'background: rgba(244, 63, 94, 0.15); color: #fb7185;';
  if (f.includes('CANON') || f.includes('CN')) return 'background: rgba(249, 115, 22, 0.15); color: #fb923c;';
  return 'background: rgba(107, 114, 128, 0.15); color: #9ca3af;';
}

function formatFinDate(dateStr) {
  if (!dateStr || dateStr.trim() === '') return '-';
  try {
    const cleanStr = dateStr.trim();
    // Hỗ trợ định dạng dạng D/M/YY hoặc DD/MM/YYYY (ví dụ: 02/03/26 hoặc 02/03/2026)
    if (cleanStr.includes('/')) {
      const parts = cleanStr.split('/');
      if (parts.length === 3) {
        let day = parseInt(parts[0], 10);
        let month = parseInt(parts[1], 10);
        let year = parseInt(parts[2], 10);
        if (year < 100) year += 2000; // 26 -> 2026
        return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
      }
    }
    const d = new Date(cleanStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('vi-VN');
  } catch {
    return dateStr;
  }
}

// Định dạng số tiền sang VND (ví dụ: 1.500.000 đ)
function formatVND(value) {
  if (value === null || value === undefined || isNaN(value)) return '0 đ';
  return Number(value).toLocaleString('vi-VN') + ' đ';
}

function filterFinCandidates() {
  const query = document.getElementById('fin-search-candidates').value.toLowerCase().trim();
  const activeMonthBtn = document.querySelector('.fin-month-filter-btn.active');
  const monthFilter = activeMonthBtn ? activeMonthBtn.getAttribute('data-month') : 'all';
  
  let filtered = finCandidatesData;
  
  if (monthFilter !== 'all') {
    const targetMonth = parseInt(monthFilter);
    filtered = filtered.filter(c => {
      if (!c.boarding_date) return false;
      const parts = c.boarding_date.split('-');
      if (parts.length < 2) return false;
      const month = parseInt(parts[1]);
      return month === targetMonth;
    });
  }

  if (query) {
    filtered = filtered.filter(c => {
      return (c.full_name || '').toLowerCase().includes(query) ||
             (c.employee_id || '').toLowerCase().includes(query) ||
             (c.phone || '').includes(query) ||
             (c.cccd || '').includes(query) ||
             (c.factory || '').toLowerCase().includes(query);
    });
  }
  renderFinCandidates(filtered);
}

function triggerFinSync(silent) {
  const icon = document.querySelector("#fin-sync-btn svg") || document.getElementById("fin-sync-btn");
  if (icon) icon.style.animation = 'spin 0.8s linear infinite';

  // Reload tất cả dữ liệu từ Google Sheet
  const now = new Date();
  const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const lastSyncTimeStr = now.toLocaleString('vi-VN');

  Promise.all([
    fetch(finSheetCsvUrl(FIN_GID_CANDIDATES)).then(r => r.text()),
    fetch(finSheetCsvUrl(FIN_GID_PRICING)).then(r => r.text()),
    fetch(finSheetCsvUrl(FIN_GID_EXPENSES)).then(r => r.text()),
  ]).then(([candCsv, priceCsv, expCsv]) => {
    if (icon) icon.style.animation = '';

    // Parse candidates
    const candRows = parseCSV(candCsv);
    if (candRows.length > 1) {
      finCandidatesData = candRows.slice(1).filter(r => r[0] && r[4]).map(r => {
        const hasEndDate = r[8] && r[8].trim() !== '';
        return {
          stt:           r[0]||'',
          factory:       r[1]||'',
          source:        r[2]||'',
          employee_id:   r[3]||'',
          full_name:     r[4]||'',
          phone:         r[5]||'',
          cccd:          r[6]||'',
          boarding_date: r[7]||'',
          end_date:      r[8]||'',
          status:        hasEndDate ? 'Nghỉ việc' : 'Đang làm việc',
          work_hours:    r[9]||'',
          work_days:     r[10]||'',
          revenue:       r[11]||'',
        };
      });
      renderFinCandidates(finCandidatesData);
    }

    // Parse pricing
    const priceRows = parseCSV(priceCsv);
    if (priceRows.length > 1) {
      _cachedPricing = priceRows.slice(1).filter(r => r[0] && r[1]).map((r, i) => ({
        id:         i + 1,
        factory:    r[0] || '',
        price:      parseFloat((r[1]||'0').replace(/,/g,'')) || 0,
        start_date: r[2] || '',
        end_date:   r[3] || '',
        unit:       r[4] || 'Giờ làm',
      }));
      loadFinPricingList();
    }

    // Parse expenses
    const expRows = parseCSV(expCsv);
    if (expRows.length > 1) {
      _cachedExpenses = expRows.slice(1).filter(r => r[0]).map((r, i) => ({
        id:           i + 1,
        month:        r[0] || '',
        ads_cost:     parseFloat((r[1]||'0').replace(/,/g,'')) || 0,
        salary_cost:  parseFloat((r[2]||'0').replace(/,/g,'')) || 0,
        phone_cost:   parseFloat((r[3]||'0').replace(/,/g,'')) || 0,
        office_cost:  parseFloat((r[4]||'0').replace(/,/g,'')) || 0,
        other_cost:   parseFloat((r[5]||'0').replace(/,/g,'')) || 0,
        note:         r[6] || '',
      }));
      loadFinExpensesList();
    }

    // Reload stats
    loadFinStats();

    if (document.getElementById('fin-sync-time-lbl'))
      document.getElementById('fin-sync-time-lbl').innerText = timeStr;
    if (document.getElementById('fin-sync-status-lbl'))
      document.getElementById('fin-sync-status-lbl').innerText = `Đồng bộ lần cuối: ${lastSyncTimeStr}`;

    if (!silent) alert(`✓ Đã đồng bộ ${finCandidatesData.length} ứng viên lúc ${timeStr}`);
  }).catch(err => {
    if (icon) icon.style.animation = '';
    if (!silent) alert('⚠ Lỗi kết nối Google Sheet: ' + err);
  });
}

// Cache pricing trong memory (refresh mỗi lần load)
let _cachedPricing = null;

function getLocalPricing() {
  // Trả về cache nếu đã có
  if (_cachedPricing) return _cachedPricing;
  // Trả default tạm thời, rồi fetch async từ Sheet
  return [];
}

function loadPricingFromSheet() {
  return fetch(finSheetCsvUrl(FIN_GID_PRICING))
    .then(r => r.text())
    .then(csvText => {
      const rows = parseCSV(csvText);
      if (rows.length < 2) return [];
      // Header: Nhà máy, Đơn giá, Từ ngày, Đến ngày, Đơn vị tính
      _cachedPricing = rows.slice(1).filter(r => r[0] && r[1]).map((r, i) => ({
        id:         i + 1,
        factory:    r[0] || '',
        price:      parseFloat((r[1]||'0').replace(/,/g,'')) || 0,
        start_date: r[2] || '',
        end_date:   r[3] || '',
        unit:       r[4] || 'Giờ làm',
      }));
      return _cachedPricing;
    })
    .catch(() => []);
}

function saveLocalPricing(item) {
  const list = getLocalPricing();
  if (item.id) {
    const idx = list.findIndex(p => p.id === parseInt(item.id));
    if (idx !== -1) {
      list[idx] = {
        id: parseInt(item.id),
        factory: item.factory,
        price: parseFloat(item.price) || 0,
        unit: item.unit,
        start_date: item.start_date,
        end_date: item.end_date
      };
    }
  } else {
    const nextId = list.length > 0 ? Math.max(...list.map(p => p.id)) + 1 : 1;
    list.push({
      id: nextId,
      factory: item.factory,
      price: parseFloat(item.price) || 0,
      unit: item.unit,
      start_date: item.start_date,
      end_date: item.end_date
    });
  }
  localStorage.setItem('fin_pricing', JSON.stringify(list));
}

function deleteLocalPricing(id) {
  let list = getLocalPricing();
  list = list.filter(p => p.id !== parseInt(id));
  localStorage.setItem('fin_pricing', JSON.stringify(list));
}

function loadFinPricingList() {
  const prices = getLocalPricing();
  const body = document.getElementById('fin-pricing-body');
  if (!body) return;
  body.innerHTML = '';
  prices.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${p.factory}</strong></td>
      <td>${formatVND(p.price)}</td>
      <td><span class="badge ${p.unit === 'Giờ làm' ? 'badge-info' : p.unit === 'Tháng' ? 'badge-warning' : 'badge-success'}">${p.unit || 'Ngày'}</span></td>
      <td>Từ ${formatFinDate(p.start_date)} đến ${formatFinDate(p.end_date)}</td>
      <td style="text-align: right;">
        <button class="btn btn-secondary" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" onclick="editFinPricing(${JSON.stringify(p).replace(/"/g, '&quot;')})">Sửa</button>
        <button class="btn btn-danger" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;" onclick="deleteFinPricing(${p.id})">Xóa</button>
      </td>
    `;
    body.appendChild(tr);
  });
}

window.editFinPricing = function(p) {
  document.getElementById('fin-price-id').value = p.id;
  document.getElementById('fin-price-factory').value = p.factory;
  document.getElementById('fin-price-value').value = p.price;
  document.getElementById('fin-price-unit').value = p.unit || 'Ngày';
  document.getElementById('fin-price-start').value = p.start_date;
  document.getElementById('fin-price-end').value = p.end_date;
  document.getElementById('fin-pricing-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.deleteFinPricing = function(id) {
  if (confirm("Bạn có chắc chắn muốn xóa đơn giá này?")) {
    deleteLocalPricing(id);
    loadFinPricingList();
    loadFinStats();
  }
};

function saveFinPricing(e) {
  e.preventDefault();
  const id = document.getElementById('fin-price-id').value;
  const factory = document.getElementById('fin-price-factory').value;
  const price = document.getElementById('fin-price-value').value;
  const unit = document.getElementById('fin-price-unit').value;
  const start_date = document.getElementById('fin-price-start').value;
  const end_date = document.getElementById('fin-price-end').value;

  saveLocalPricing({ id: id ? parseInt(id) : null, factory, price, unit, start_date, end_date });
  resetFinPricingForm();
  loadFinPricingList();
  loadFinStats();
}

function resetFinPricingForm() {
  document.getElementById('fin-price-id').value = '';
  document.getElementById('fin-price-value').value = '';
  document.getElementById('fin-price-unit').value = 'Ngày';
  document.getElementById('fin-price-start').value = '';
  document.getElementById('fin-price-end').value = '';
}

function switchFinExpenseTab(mode) {
  const isManual = mode === 'manual';
  document.getElementById('fin-exp-panel-manual').style.display = isManual ? '' : 'none';
  document.getElementById('fin-exp-panel-sheet').style.display = isManual ? 'none' : '';
  
  const manualBtn = document.getElementById('fin-exp-tab-manual');
  const sheetBtn = document.getElementById('fin-exp-tab-sheet');
  
  if (manualBtn && sheetBtn) {
    manualBtn.style.background = isManual ? 'var(--accent-blue, #3b82f6)' : 'transparent';
    manualBtn.style.color = isManual ? '#fff' : 'var(--text-secondary)';
    sheetBtn.style.background = !isManual ? 'var(--accent-blue, #3b82f6)' : 'transparent';
    sheetBtn.style.color = !isManual ? '#fff' : 'var(--text-secondary)';
  }
}

function parseFinMoneyVal(str) {
  if (str === undefined || str === null) return 0;
  let s = String(str).trim();
  s = s.replace(/[đĐ\s]/g, '');
  s = s.replace(/[\.,]/g, '');
  return parseFloat(s) || 0;
}

function fmtFinMoney(input) {
  const raw = parseFinMoneyVal(input.value);
  if (raw === 0) { input.value = '0'; }
  else { input.value = raw.toLocaleString('vi-VN'); }
  calcFinExpenseTotal();
}

function calcFinExpenseTotal() {
  const ids = ['fin-exp-ads','fin-exp-salary','fin-exp-phone','fin-exp-office','fin-exp-other'];
  const total = ids.reduce((s, id) => s + parseFinMoneyVal(document.getElementById(id)?.value), 0);
  const el = document.getElementById('fin-exp-total-preview');
  if (el) el.innerText = formatVND(total);
}

function resetFinExpenseForm() {
  document.getElementById('fin-exp-edit-id').value = '';
  document.getElementById('fin-exp-month').value = '';
  ['fin-exp-ads','fin-exp-salary','fin-exp-phone','fin-exp-office','fin-exp-other'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = 0;
  });
  document.getElementById('fin-exp-note').value = '';
  calcFinExpenseTotal();
}

// Cache expenses trong memory
let _cachedExpenses = null;

function getLocalExpenses() {
  return _cachedExpenses || [];
}

function loadExpensesFromSheet() {
  return fetch(finSheetCsvUrl(FIN_GID_EXPENSES))
    .then(r => r.text())
    .then(csvText => {
      const rows = parseCSV(csvText);
      if (rows.length < 2) return [];
      // Header: Tháng, Chi phí ads, Chi phí lương, Chi phí điện thoại, Chi phí văn phòng, Chi phí khác, Ghi chú
      _cachedExpenses = rows.slice(1).filter(r => r[0]).map((r, i) => ({
        id:           i + 1,
        month:        r[0] || '',
        ads_cost:     parseFloat((r[1]||'0').replace(/,/g,'')) || 0,
        salary_cost:  parseFloat((r[2]||'0').replace(/,/g,'')) || 0,
        phone_cost:   parseFloat((r[3]||'0').replace(/,/g,'')) || 0,
        office_cost:  parseFloat((r[4]||'0').replace(/,/g,'')) || 0,
        other_cost:   parseFloat((r[5]||'0').replace(/,/g,'')) || 0,
        note:         r[6] || '',
      }));
      return _cachedExpenses;
    })
    .catch(() => []);
}

function saveLocalExpense(item) {
  const list = getLocalExpenses();
  const month = item.month;
  const idx = list.findIndex(e => e.month === month);
  
  const expenseRecord = {
    id: idx !== -1 ? list[idx].id : (list.length > 0 ? Math.max(...list.map(e => e.id)) + 1 : 1),
    month: item.month,
    ads_cost: parseFloat(item.ads_cost) || 0,
    salary_cost: parseFloat(item.salary_cost) || 0,
    phone_cost: parseFloat(item.phone_cost) || 0,
    office_cost: parseFloat(item.office_cost) || 0,
    other_cost: parseFloat(item.other_cost) || 0,
    note: item.note || "",
    sheet_url: item.sheet_url || null
  };

  if (idx !== -1) {
    list[idx] = expenseRecord;
  } else {
    list.push(expenseRecord);
  }
  localStorage.setItem('fin_expenses', JSON.stringify(list));
}

function loadFinExpensesList() {
  const data = getLocalExpenses();
  finExpensesData = data;
  const body = document.getElementById('fin-expenses-body');
  if (!body) return;
  body.innerHTML = '';
  if (!data.length) {
    body.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-secondary); padding:1rem;">Chưa có dữ liệu chi phí</td></tr>';
    return;
  }
  data.forEach(e => {
    const total = (e.ads_cost||0) + (e.salary_cost||0) + (e.phone_cost||0) + (e.office_cost||0) + (e.other_cost||0);
    const tr = document.createElement('tr');
    const fv = v => v > 0 ? `<span style="color:#fff">${formatVND(v)}</span>` : '<span style="color:var(--text-muted)">-</span>';
    tr.innerHTML = `
      <td><strong style="color:var(--accent-cyan)">${e.month}</strong></td>
      <td>${fv(e.ads_cost)}</td>
      <td>${fv(e.salary_cost)}</td>
      <td>${fv(e.phone_cost)}</td>
      <td>${fv(e.office_cost)}</td>
      <td>${fv(e.other_cost)}</td>
      <td><strong style="color:var(--accent-rose)">${formatVND(total)}</strong></td>
      <td>
        <button class="btn btn-secondary" onclick="editFinExpense(${JSON.stringify(e).replace(/"/g,'&quot;')})" style="padding:0.2rem 0.5rem; font-size:0.75rem;">✏️</button>
      </td>
    `;
    body.appendChild(tr);
  });
}

window.editFinExpense = function(e) {
  switchFinExpenseTab('manual');
  const fmt = v => (v && v > 0) ? v.toLocaleString('vi-VN') : '0';
  document.getElementById('fin-exp-edit-id').value = e.id || '';
  document.getElementById('fin-exp-month').value   = e.month || '';
  document.getElementById('fin-exp-ads').value     = fmt(e.ads_cost);
  document.getElementById('fin-exp-salary').value  = fmt(e.salary_cost);
  document.getElementById('fin-exp-phone').value   = fmt(e.phone_cost);
  document.getElementById('fin-exp-office').value  = fmt(e.office_cost);
  document.getElementById('fin-exp-other').value   = fmt(e.other_cost);
  document.getElementById('fin-exp-note').value    = e.note || '';
  calcFinExpenseTotal();
  document.getElementById('fin-exp-month').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

function onFinExpenseMonthChange(monthVal) {
  if (!monthVal) return;
  const existing = (finExpensesData || []).find(e => e.month === monthVal);
  if (existing) {
    const fmt = v => (v && v > 0) ? v.toLocaleString('vi-VN') : '0';
    document.getElementById('fin-exp-edit-id').value = existing.id || '';
    document.getElementById('fin-exp-ads').value     = fmt(existing.ads_cost);
    document.getElementById('fin-exp-salary').value  = fmt(existing.salary_cost);
    document.getElementById('fin-exp-phone').value   = fmt(existing.phone_cost);
    document.getElementById('fin-exp-office').value  = fmt(existing.office_cost);
    document.getElementById('fin-exp-other').value   = fmt(existing.other_cost);
    document.getElementById('fin-exp-note').value    = existing.note || '';
  } else {
    document.getElementById('fin-exp-edit-id').value = '';
    document.getElementById('fin-exp-ads').value     = '0';
    document.getElementById('fin-exp-salary').value  = '0';
    document.getElementById('fin-exp-phone').value   = '0';
    document.getElementById('fin-exp-office').value  = '0';
    document.getElementById('fin-exp-other').value   = '0';
    document.getElementById('fin-exp-note').value    = '';
  }
  calcFinExpenseTotal();
}

function saveFinExpense() {
  const month = document.getElementById('fin-exp-month').value;
  if (!month) { alert('⚠ Vui lòng chọn tháng chi phí'); return; }
  const payload = {
    month,
    ads_cost:    parseFinMoneyVal(document.getElementById('fin-exp-ads').value),
    salary_cost: parseFinMoneyVal(document.getElementById('fin-exp-salary').value),
    phone_cost:  parseFinMoneyVal(document.getElementById('fin-exp-phone').value),
    office_cost: parseFinMoneyVal(document.getElementById('fin-exp-office').value),
    other_cost:  parseFinMoneyVal(document.getElementById('fin-exp-other').value),
    note: document.getElementById('fin-exp-note').value,
    sheet_url: null
  };
  saveLocalExpense(payload);
  loadFinExpensesList();
  loadFinStats();
  resetFinExpenseForm();
  alert('✓ Đã lưu chi phí tháng ' + month);
}

function syncFinExpenseSheet() {
  const url  = document.getElementById('fin-exp-sheet-url').value.trim();
  const month = document.getElementById('fin-exp-sheet-month').value;
  if (!url || !month) { alert('⚠ Vui lòng nhập link và chọn tháng'); return; }
  const csvUrl = url.replace(/\/edit.*$/, '/export?format=csv');
  
  showFinLoading(true);
  fetch(csvUrl)
    .then(r => r.text())
    .then(csvText => {
      showFinLoading(false);
      const parsedRows = parseCSV(csvText);
      if (parsedRows.length <= 1) {
        alert("⚠ CSV trống hoặc không hợp lệ");
        return;
      }
      const headers = parsedRows[0].map(h => h.trim().toLowerCase());
      
      let ads = 0, salary = 0, phone = 0, office = 0, other = 0;
      let noteParts = [];

      const catIdx = headers.findIndex(h => h.includes("loại") || h.includes("danh mục") || h.includes("category"));
      const valIdx = headers.findIndex(h => h.includes("số tiền") || h.includes("chi phí") || h.includes("amount") || h.includes("giá trị"));
      const descIdx = headers.findIndex(h => h.includes("nội dung") || h.includes("ghi chú") || h.includes("note") || h.includes("description"));

      for (let i = 1; i < parsedRows.length; i++) {
        const row = parsedRows[i];
        if (row.length <= 1) continue;

        if (catIdx !== -1 && valIdx !== -1) {
          const category = (row[catIdx] || "").toLowerCase();
          const rawValStr = row[valIdx] || "0";
          const val = parseFloat(rawValStr.replace(/[^\d\.]/g, "")) || 0;
          const desc = row[descIdx] || "";

          if (category.includes("ads") || category.includes("quảng cáo") || category.includes("mkt") || category.includes("marketing")) {
            ads += val;
          } else if (category.includes("lương") || category.includes("salary") || category.includes("ctv")) {
            salary += val;
          } else if (category.includes("điện thoại") || category.includes("cước") || category.includes("phone")) {
            phone += val;
          } else if (category.includes("văn phòng") || category.includes("thuê") || category.includes("office")) {
            office += val;
          } else {
            other += val;
          }
          if (desc) {
            noteParts.push(`${category}: ${desc}`);
          }
        }
      }

      const note = noteParts.join("; ").substring(0, 200);
      saveLocalExpense({
        month,
        ads_cost: ads,
        salary_cost: salary,
        phone_cost: phone,
        office_cost: office,
        other_cost: other,
        note,
        sheet_url: csvUrl
      });
      loadFinExpensesList();
      loadFinStats();
      alert('✓ Đồng bộ chi phí từ Sheet thành công!');
    })
    .catch(err => {
      showFinLoading(false);
      alert('⚠ Lỗi kết nối hoặc CORS: ' + err);
    });
}

function initFinReconCycleDropdown() {
  const dropdown = document.getElementById('fin-recon-cycle');
  if (!dropdown) return;

  const startYear = 2026;
  const startMonth = 2; // February
  const today = new Date();
  const targetLimit = new Date(today.getFullYear(), today.getMonth() + 3, 1);
  
  const generatedMonths = [];
  let loopDate = new Date(startYear, startMonth - 1, 1);
  
  while (loopDate <= targetLimit) {
    const yyyy = loopDate.getFullYear();
    const mm = String(loopDate.getMonth() + 1).padStart(2, '0');
    generatedMonths.push(`${yyyy}-${mm}`);
    loopDate.setMonth(loopDate.getMonth() + 1);
  }
  
  generatedMonths.reverse();
  
  dropdown.innerHTML = '';
  generatedMonths.forEach(m => {
    const labelText = `Tháng ${m.split('-')[1]} / ${m.split('-')[0]}`;
    const opt = document.createElement('option');
    opt.value = m;
    opt.innerText = labelText;
    dropdown.appendChild(opt);
  });

  const curMonth = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
  if (generatedMonths.includes(curMonth)) {
    dropdown.value = curMonth;
  } else {
    dropdown.value = generatedMonths[0];
  }
}

function setupFinDragAndDrop() {
  const dropArea = document.getElementById('fin-drop-area');
  if (!dropArea) return;
  const fileInput = document.getElementById('fin-file-input');
  
  dropArea.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) setFinFile(e.target.files[0]);
  });
  
  ['dragenter', 'dragover'].forEach(eventName => {
    dropArea.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropArea.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropArea.classList.remove('dragover');
    }, false);
  });

  dropArea.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      setFinFile(files[0]);
    }
  }, false);
}

function setFinFile(file) {
  finSelectedFile = file;
  const lbl = document.getElementById('fin-selected-file-lbl');
  if (lbl) {
    lbl.innerText = `Đã chọn file: ${file.name} (${(file.size/1024).toFixed(1)} KB)`;
    lbl.style.display = 'block';
  }
}

function executeFinReconciliation() {
  if (!finSelectedFile) {
    alert("Vui lòng kéo thả hoặc chọn file Excel/CSV trước!");
    return;
  }

  const type = document.getElementById('fin-recon-type').value;
  const factory = document.getElementById('fin-recon-factory').value;
  const cycle = document.getElementById('fin-recon-cycle').value;

  showFinLoading(true);

  const formData = new FormData();
  formData.append('file', finSelectedFile);

  finFetch(`/api/reconcile?cycle_month=${cycle}&file_type=${type}&factory=${factory}`, {
    method: 'POST',
    body: formData
  })
  .then(r => r.json())
  .then(res => {
    showFinLoading(false);
    if (res.status === 'success') {
      displayFinReconciliationResults(res);
    } else {
      alert("Lỗi đối soát: " + res.error);
    }
  })
  .catch(err => {
    showFinLoading(false);
    alert("Lỗi kết nối đối soát: " + err);
  });
}

function displayFinReconciliationResults(res) {
  document.getElementById('fin-results-panel').style.display = 'block';
  
  document.getElementById('fin-res-total').innerText = res.summary.total_uploaded;
  document.getElementById('fin-res-matched').innerText = res.summary.matched;
  document.getElementById('fin-res-unmatched').innerText = res.summary.unmatched;
  document.getElementById('fin-res-missing').innerText = Array.isArray(res.missing) ? res.missing.length : 0;
  document.getElementById('fin-res-revenue').innerText = formatVND(res.summary.total_revenue);

  const matchedBody = document.getElementById('fin-res-matched-body');
  matchedBody.innerHTML = '';
  res.matched.forEach(m => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight: bold;">${m.candidate.employee_id || '-'}</td>
      <td>${m.candidate.full_name}</td>
      <td>${m.candidate.phone || '-'} / ${m.candidate.cccd || '-'}</td>
      <td>${formatFinDate(m.candidate.boarding_date)}</td>
      <td>${m.units} (${m.candidate.unit || 'Ngày'})</td>
      <td>${formatVND(m.price)}</td>
      <td><strong style="color:var(--accent-emerald)">${formatVND(m.revenue)}</strong></td>
    `;
    matchedBody.appendChild(tr);
  });

  const unmatchedBody = document.getElementById('fin-res-unmatched-body');
  unmatchedBody.innerHTML = '';
  res.unmatched.forEach(m => {
    const tr = document.createElement('tr');
    const keys = Object.keys(m.row || {});
    const nameKey = keys.find(k => k.toLowerCase().includes('tên') || k.toLowerCase().includes('name')) || keys[1];
    const idKey = keys.find(k => k.toLowerCase().includes('mã') || k.toLowerCase().includes('id')) || keys[0];
    
    tr.innerHTML = `
      <td><strong>${m.row[idKey] || '-'}</strong></td>
      <td>${m.row[nameKey] || '-'}</td>
      <td>${Object.entries(m.row).slice(2, 5).map(([k,v]) => `${k}:${v}`).join(', ')}</td>
      <td style="color:var(--accent-rose)">${m.reason || 'Không khớp'}</td>
    `;
    unmatchedBody.appendChild(tr);
  });

  const missingBody = document.getElementById('fin-res-missing-body');
  missingBody.innerHTML = '';
  const missingArr = Array.isArray(res.missing) ? res.missing : [];
  missingArr.forEach(m => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight: bold;">${m.employee_id || '-'}</td>
      <td>${m.full_name}</td>
      <td>${m.phone || '-'}</td>
      <td>${m.cccd || '-'}</td>
      <td>${formatFinDate(m.boarding_date)}</td>
      <td style="color:var(--accent-rose)">${m.end_date ? formatFinDate(m.end_date) : '-'}</td>
    `;
    missingBody.appendChild(tr);
  });
}

function getCycleRange(paymentMonthStr) {
  const parts = paymentMonthStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  
  let workYear = year;
  let workMonth = month - 2;
  if (workMonth <= 0) {
    workMonth += 12;
    workYear -= 1;
  }
  
  const cycleEnd = new Date(workYear, workMonth - 1, 25);
  
  let startYear = workYear;
  let startMonth = workMonth - 1;
  if (startMonth <= 0) {
    startMonth += 12;
    startYear -= 1;
  }
  const cycleStart = new Date(startYear, startMonth - 1, 26);
  
  return { cycleStart, cycleEnd };
}

function calculateMonthRevenue(paymentMonthStr, candidates) {
  const { cycleStart, cycleEnd } = getCycleRange(paymentMonthStr);
  const prices = getLocalPricing();
  let totalRevenue = 0;
  const details = [];

  candidates.forEach(c => {
    if (!c.boarding_date) return;
    const bDate = new Date(c.boarding_date);
    const endDate = c.end_date ? new Date(c.end_date) : null;
    const resignationDate = c.resignation_date ? new Date(c.resignation_date) : null;

    let endLimit = endDate;
    if (resignationDate) {
      endLimit = endDate ? new Date(Math.min(endDate, resignationDate)) : resignationDate;
    }
    if (!endLimit) return;

    if (endLimit >= cycleStart && bDate <= cycleEnd) {
      const overlapStart = new Date(Math.max(bDate, cycleStart));
      const overlapEnd = new Date(Math.min(endLimit, cycleEnd));
      if (overlapStart > overlapEnd) return;

      const days = Math.round((overlapEnd - overlapStart) / (24 * 60 * 60 * 1000)) + 1;

      const pRule = prices.find(p => {
        if (p.factory.toUpperCase().trim() !== c.factory.toUpperCase().trim()) return false;
        const sd = p.start_date ? new Date(p.start_date) : null;
        const ed = p.end_date ? new Date(p.end_date) : null;
        if (sd && bDate < sd) return false;
        if (ed && bDate > ed) return false;
        return true;
      });

      const price = pRule ? pRule.price : 0;
      const unit = pRule ? (pRule.unit || 'Ngày') : 'Ngày';

      const billingLimitDays = (c.factory === 'Canon' || c.factory === 'CN') ? 180 : 90;
      const tenureStart = Math.round((overlapStart - bDate) / (24 * 60 * 60 * 1000)) + 1;

      let candidateVal = 0;

      if (unit === 'Tháng' && (c.factory === 'Canon' || c.factory === 'CN')) {
        if (days >= 30) {
          candidateVal = price;
        } else if (days >= 14) {
          candidateVal = 0.5 * price;
        }
        if (candidateVal > 0) {
          if (tenureStart <= 30) {
            candidateVal *= 0.75;
          } else if (tenureStart <= 60) {
            candidateVal *= 0.85;
          } else if (tenureStart <= 90) {
            candidateVal *= 0.90;
          }
        }
      } else {
        const projectedUnits = (unit === 'Giờ làm') ? (days * 8.0) : (days * 1.0);
        let isEligible = true;
        if (unit === 'Giờ làm') {
          if (projectedUnits < 40.0) isEligible = false;
        } else {
          if (projectedUnits < 5.0) isEligible = false;
        }

        if (isEligible && tenureStart <= billingLimitDays) {
          let effectiveValue = 0;
          for (let d = 0; d < days; d++) {
            const currentDayTenure = tenureStart + d;
            if (currentDayTenure > billingLimitDays) break;
            const dayUnit = (unit === 'Giờ làm') ? 8.0 : 1.0;
            let dayVal = dayUnit * price;
            if (currentDayTenure <= 30) {
              dayVal *= 0.75;
            } else if (currentDayTenure <= 60) {
              dayVal *= 0.85;
            } else if (currentDayTenure <= 90) {
              dayVal *= 0.90;
            }
            effectiveValue += dayVal;
          }
          candidateVal = effectiveValue;
        }
      }

      if (candidateVal > 0) {
        totalRevenue += candidateVal;
        details.push({
          name: c.full_name,
          factory: c.factory,
          overlap_days: days,
          price: price,
          value: candidateVal
        });
      }
    }
  });

  return { totalRevenue, details };
}

function loadFinStats() {
  const startYear = 2026;
  const startMonth = 2; // February
  const today = new Date();
  const targetLimit = new Date(today.getFullYear(), today.getMonth() + 3, 1);
  
  const generatedMonths = [];
  let loopDate = new Date(startYear, startMonth - 1, 1);
  while (loopDate <= targetLimit) {
    const yyyy = loopDate.getFullYear();
    const mm = String(loopDate.getMonth() + 1).padStart(2, '0');
    generatedMonths.push(`${yyyy}-${mm}`);
    loopDate.setMonth(loopDate.getMonth() + 1);
  }
  generatedMonths.reverse();

  const candidates = finCandidatesData || [];
  const expenses = getLocalExpenses();

  const monthly_stats = [];
  generatedMonths.forEach(m => {
    const { totalRevenue } = calculateMonthRevenue(m, candidates);
    const expRow = expenses.find(e => e.month === m);
    const cost = expRow ? ((expRow.ads_cost||0) + (expRow.salary_cost||0) + (expRow.phone_cost||0) + (expRow.office_cost||0) + (expRow.other_cost||0)) : 0;
    monthly_stats.push({
      month: m,
      revenue: totalRevenue,
      cost: cost,
      pnl: totalRevenue - cost
    });
  });

  finStatsData = {
    monthly_stats: monthly_stats
  };

  const filter = document.getElementById('fin-stats-month-filter');
  const startFilter = document.getElementById('fin-stats-start-filter');
  const endFilter = document.getElementById('fin-stats-end-filter');
  
  if (filter && startFilter && endFilter) {
    const prevVal = filter.value;
    const prevStart = startFilter.value;
    const prevEnd = endFilter.value;

    filter.innerHTML = '';
    startFilter.innerHTML = '';
    endFilter.innerHTML = '';
    
    generatedMonths.forEach(m => {
      const labelText = `Tháng ${m.split('-')[1]} / ${m.split('-')[0]}`;
      
      const opt = document.createElement('option');
      opt.value = m;
      opt.innerText = labelText;
      filter.appendChild(opt);
      
      const optStart = document.createElement('option');
      optStart.value = m;
      optStart.innerText = labelText;
      startFilter.appendChild(optStart);
      
      const optEnd = document.createElement('option');
      optEnd.value = m;
      optEnd.innerText = labelText;
      endFilter.appendChild(optEnd);
    });
    
    const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    
    if (prevVal && [...filter.options].some(o => o.value === prevVal)) {
      filter.value = prevVal;
    } else if (generatedMonths.includes(currentMonth)) {
      filter.value = currentMonth;
    } else if (generatedMonths.length > 0) {
      filter.value = generatedMonths[0]; // Mặc định chọn tháng mới nhất trong danh sách
    }
    
    if (prevStart && [...startFilter.options].some(o => o.value === prevStart)) {
      startFilter.value = prevStart;
    } else if (generatedMonths.length >= 6) {
      startFilter.value = generatedMonths[5];
    } else if (generatedMonths.length > 0) {
      startFilter.value = generatedMonths[generatedMonths.length - 1];
    }
    
    if (prevEnd && [...endFilter.options].some(o => o.value === prevEnd)) {
      endFilter.value = prevEnd;
    } else if (generatedMonths.length > 0) {
      endFilter.value = generatedMonths[0];
    }
  }

  updateFinOverviewStats();
}

function toggleFinRangeFilter() {
  const isRange = document.getElementById('fin-enable-custom-range')?.checked;
  const singleWrapper = document.getElementById('fin-single-filter-wrapper');
  const rangeWrapper = document.getElementById('fin-range-filter-wrapper');
  if (singleWrapper && rangeWrapper) {
    singleWrapper.style.display = isRange ? 'none' : 'flex';
    rangeWrapper.style.display = isRange ? 'flex' : 'none';
  }
  updateFinOverviewStats();
}

function updateFinOverviewStats() {
  if (!finStatsData) return;
  
  const isRange = document.getElementById('fin-enable-custom-range')?.checked;
  const monthFilterVal = document.getElementById('fin-stats-month-filter')?.value;
  const startFilterVal = document.getElementById('fin-stats-start-filter')?.value;
  const endFilterVal = document.getElementById('fin-stats-end-filter')?.value;
  
  let targetStats = [];
  let titleDesc = "";
  let forecastMonth = "";
  let selectedMonthStr = "";
  
  if (isRange) {
    targetStats = finStatsData.monthly_stats.filter(s => {
      return s.month >= startFilterVal && s.month <= endFilterVal;
    });
    titleDesc = `Từ ${startFilterVal} đến ${endFilterVal}`;
    forecastMonth = endFilterVal;
    selectedMonthStr = endFilterVal; // Dùng tháng kết thúc để ghi nhãn
  } else {
    let targetMonth = monthFilterVal;
    if (!targetMonth || targetMonth === 'latest') {
      if (finStatsData.monthly_stats.length > 0) {
        targetMonth = finStatsData.monthly_stats[0].month;
      }
    }
    
    const stat = finStatsData.monthly_stats.find(s => s.month === targetMonth);
    if (stat) targetStats = [stat];
    titleDesc = `${targetMonth?.split('-')[1]}/${targetMonth?.split('-')[0]}`;
    forecastMonth = targetMonth;
    selectedMonthStr = targetMonth;
  }
  
  // Xác định tháng trước để so sánh (MoM)
  let prevMonthStr = "";
  if (selectedMonthStr) {
    const parts = selectedMonthStr.split('-');
    let y = parseInt(parts[0], 10);
    let m = parseInt(parts[1], 10);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
    prevMonthStr = `${y}-${String(m).padStart(2, '0')}`;
  }
  const prevStat = finStatsData.monthly_stats.find(s => s.month === prevMonthStr);
  
  let totalRevenue = targetStats.reduce((sum, s) => sum + s.revenue, 0);
  let totalCost = targetStats.reduce((sum, s) => sum + s.cost, 0);
  let totalPnl = totalRevenue - totalCost;
  
  // Cập nhật giá trị số liệu lớn
  document.getElementById('fin-stat-revenue').innerText = formatVND(totalRevenue);
  document.getElementById('fin-stat-cost').innerText = formatVND(totalCost);
  document.getElementById('fin-stat-pnl').innerText = formatVND(totalPnl);
  
  // Cập nhật tiêu đề động dạng "DOANH THU THÁNG 07/2026 (TẠM TÍNH)"
  const titleFormatted = titleDesc || "--/----";
  document.getElementById('fin-label-revenue').innerText = `DOANH THU THÁNG ${titleFormatted} (TẠM TÍNH)`;
  document.getElementById('fin-label-cost').innerText = `TỔNG CHI PHÍ VẬN HÀNH (THÁNG ${titleFormatted})`;
  document.getElementById('fin-label-pnl').innerText = `LỢI NHUẬN RÒNG P&L (THÁNG ${titleFormatted})`;
  
  // Tính toán Tháng tới cho dự báo
  let nextMonthStr = "";
  if (forecastMonth) {
    const parts = forecastMonth.split('-');
    let y = parseInt(parts[0], 10);
    let m = parseInt(parts[1], 10);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
    nextMonthStr = `${y}-${String(m).padStart(2, '0')}`;
  }
  const nextMonthFormatted = nextMonthStr ? `${nextMonthStr.split('-')[1]}/${nextMonthStr.split('-')[0]}` : "--/----";
  document.getElementById('fin-label-forecast').innerText = `DỰ BÁO DOANH THU (THÁNG ${nextMonthFormatted})`;
  
  // CARD 1: Doanh thu chân card
  document.getElementById('fin-stat-desc-1').innerHTML = `Tỷ lệ chính xác: <span style="color:#fb923c;font-weight:700">100%</span> (dự kiến)`;
  
  // CARD 2: Chi phí chân card (MoM)
  if (prevStat && prevStat.cost > 0) {
    const diffPct = ((totalCost - prevStat.cost) / prevStat.cost) * 100;
    const isDown = diffPct < 0;
    const arrow = isDown ? '▼' : '▲';
    const color = isDown ? '#10b981' : '#f43f5e'; // Giảm chi phí là xanh lá, tăng là đỏ
    document.getElementById('fin-stat-desc-2').innerHTML = `<span style="color:${color};font-weight:700;">${arrow} ${diffPct.toFixed(1)}%</span> so với tháng trước`;
  } else {
    document.getElementById('fin-stat-desc-2').innerText = `-- so với tháng trước`;
  }
  
  // CARD 3: PnL chân card (MoM)
  if (prevStat) {
    const prevPnl = prevStat.revenue - prevStat.cost;
    if (prevPnl !== 0) {
      const diffPct = ((totalPnl - prevPnl) / Math.abs(prevPnl)) * 100;
      const isUp = diffPct >= 0;
      const arrow = isUp ? '▲' : '▼';
      const color = isUp ? '#10b981' : '#f43f5e'; // Tăng PnL là xanh, giảm là đỏ
      document.getElementById('fin-stat-desc-3').innerHTML = `<span style="color:${color};font-weight:700;">${arrow} ${isUp ? '+' : ''}${diffPct.toFixed(1)}%</span> so với tháng trước`;
    } else {
      document.getElementById('fin-stat-desc-3').innerText = `-- so với tháng trước`;
    }
  } else {
    document.getElementById('fin-stat-desc-3').innerText = `-- so với tháng trước`;
  }
  
  // CARD 4: Dự báo doanh thu chân card (Đếm số lao động đang làm việc trong tháng đó)
  const activeWorkersCount = (finCandidatesData || []).filter(c => {
    // Ứng viên đang hoạt động trong tháng được chọn (chưa nghỉ việc hoặc nghỉ việc sau tháng đó)
    if (!c.boarding_date) return false;
    const boardingMonth = c.boarding_date.substring(3, 10); // Format DD/MM/YYYY -> MM/YYYY
    const parts = c.boarding_date.split('/');
    if (parts.length < 3) return false;
    let bYear = parseInt(parts[2], 10);
    if (bYear < 100) bYear += 2000;
    const boardingStr = `${bYear}-${parts[1]}`; // YYYY-MM
    
    // Check xem đã nhận việc trước hoặc trong tháng được chọn hay chưa
    if (boardingStr > selectedMonthStr) return false;
    
    // Check xem ngày nghỉ việc (nếu có) có lớn hơn tháng được chọn hay không
    if (c.end_date) {
      const eParts = c.end_date.split('/');
      if (eParts.length === 3) {
        let eYear = parseInt(eParts[2], 10);
        if (eYear < 100) eYear += 2000;
        const endStr = `${eYear}-${eParts[1]}`;
        if (endStr < selectedMonthStr) return false;
      }
    }
    return true;
  }).length;
  
  const { totalRevenue: forecastRevenue, details: forecastDetails } = calculateMonthRevenue(nextMonthStr, finCandidatesData || []);
  document.getElementById('fin-stat-forecast').innerText = formatVND(forecastRevenue);
  document.getElementById('fin-stat-desc-4').innerHTML = `<span style="font-weight:700;color:var(--text-primary);">${activeWorkersCount} lao động</span> — so với tháng trước`;
  
  const forecastList = document.getElementById('fin-forecast-list');
  if (forecastList) {
    forecastList.innerHTML = '';
    const validDetails = forecastDetails.filter(d => d.value > 0).sort((a,b) => b.value - a.value).slice(0, 10);
    if (validDetails.length > 0) {
      validDetails.forEach(item => {
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';
        div.style.borderBottom = '1px dashed rgba(255,255,255,0.05)';
        div.style.paddingBottom = '4px';
        div.innerHTML = `
          <span style="font-weight:600;">${item.name} (${item.factory})</span>
          <span style="color:var(--cyan);">${formatVND(item.value)}</span>
        `;
        forecastList.appendChild(div);
      });
    } else {
      forecastList.innerHTML = '<p style="color: var(--text-secondary);">Chưa có dữ liệu dự báo</p>';
    }
  }

  renderFinPnlChart(finStatsData.monthly_stats);
}

function renderFinPnlChart(stats) {
  const canvas = document.getElementById('fin-pnl-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (finPnlChartObj) finPnlChartObj.destroy();
  
  const sortedStats = [...stats].sort((a,b) => a.month.localeCompare(b.month));
  
  const labels = sortedStats.map(s => s.month);
  const revenues = sortedStats.map(s => s.revenue);
  const costs = sortedStats.map(s => s.cost);
  const pnls = sortedStats.map(s => s.pnl);
  
  finPnlChartObj = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Doanh thu',
          data: revenues,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          fill: true,
          tension: 0.35,
          borderWidth: 2.5
        },
        {
          label: 'Chi phí',
          data: costs,
          borderColor: '#f43f5e',
          backgroundColor: 'rgba(244, 63, 94, 0.1)',
          fill: true,
          tension: 0.35,
          borderWidth: 2.5
        },
        {
          label: 'Lợi nhuận PnL',
          data: pnls,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          fill: true,
          tension: 0.35,
          borderWidth: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#6e8fad' }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#6e8fad',
            callback: (val) => val.toLocaleString('vi-VN') + ' đ'
          }
        }
      },
      plugins: {
        legend: {
          labels: { color: '#eef4ff' }
        }
      }
    }
  });
}


