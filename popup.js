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
      
      // Tính toán chăm sóc bị trễ (nextCareDate nhỏ hơn hôm nay, status là chăm sóc tiếp, và chưa có ngày CS cuối tương ứng)
      if (nextCareDate && nextCareDate < todayStr && status === "chăm sóc tiếp") {
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
        // Save only the current active interviewDate from the sheet row (exclude KĐL, KNM, bùng pv, từ chối, ko đạt)
        const isInterviewStatus = (status === "hẹn phỏng vấn" || status === "đã nhận việc" || status === "chuyển nhà máy khác");
        if (interviewDate && (status === "hẹn phỏng vấn" || isInterviewStatus) && !isInvalidStatus) {
          // If the interview date is in the future, we update it dynamically
          if (interviewDate > todayStr) {
            // Keep past frozen dates (< todayStr) and today's frozen date, and replace future dates with the new active date
            candidateHistory[candKey].interviewDates = [
              ...candidateHistory[candKey].interviewDates.filter(d => d <= todayStr),
              interviewDate
            ];
          } else {
            // If it is today or a past date, it is frozen. Only append if not present in the cached list to prevent loss, but do NOT overwrite or remove existing ones.
            if (!candidateHistory[candKey].interviewDates.includes(interviewDate)) {
              candidateHistory[candKey].interviewDates.push(interviewDate);
            }
          }
        } else {
          // If status is invalid, remove future dates from history, but keep today's and past frozen ones (<= todayStr)
          candidateHistory[candKey].interviewDates = candidateHistory[candKey].interviewDates.filter(d => d <= todayStr);
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
  const processed = processData(state.candidates, state.recruitments, {}, state.candidateHistory, false);
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

  // Thêm hiển thị Trễ CS (từ hôm qua trở về trước chưa chăm sóc)
  if (elTodayInterviewSub) {
    const overdueHtml = `<span class="tc-overdue" style="color:#ef4444;"><span>⚠️ Trễ CS:</span> <strong style="color:#ef4444">${state.overdueCareCount || 0}</strong></span>`;
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
      if (nextCareDate && nextCareDate < todayStr && statusClean === "chăm sóc tiếp") {
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
  dateObj.setDate(dateObj.getDate() + 1);
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
