const { getSheetValues, appendSheetValues, updateSheetValues } = require("./sheets_helper");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", "application/json");

  // Handle sync sheet action: /api/expenses/sync-sheet
  if (req.url.includes("/sync-sheet") && req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: "Invalid JSON body" }); }
    }
    const { month, sheet_url } = body;
    if (!month || !sheet_url) {
      return res.status(400).json({ error: "Missing month or sheet_url parameter" });
    }
    try {
      // Fetch expense data from public Google Sheet CSV export url
      const response = await fetch(sheet_url);
      const csvText = await response.text();
      
      // Basic CSV parser
      const lines = csvText.split(/\r?\n/);
      if (lines.length <= 1) {
        return res.status(400).json({ message: "Empty CSV data" });
      }

      // Parse headers
      const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
      
      // Parse columns
      let ads = 0, salary = 0, phone = 0, office = 0, other = 0;
      let noteParts = [];

      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = lines[i].split(",").map(c => c.trim().replace(/^"|"$/g, ''));
        
        const catIdx = headers.findIndex(h => h.includes("loại") || h.includes("danh mục") || h.includes("category"));
        const valIdx = headers.findIndex(h => h.includes("số tiền") || h.includes("chi phí") || h.includes("amount") || h.includes("giá trị"));
        const descIdx = headers.findIndex(h => h.includes("nội dung") || h.includes("ghi chú") || h.includes("note") || h.includes("description"));

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
      
      // Read current expenses sheets list to check if month already exists
      const rows = await getSheetValues("Chi phí Vận hành!A2:G200");
      const existIndex = rows.findIndex(r => r[0] === month);
      
      const values = [[month, ads, salary, phone, office, other, note]];
      if (existIndex !== -1) {
        // Update existing row
        const rowIndex = existIndex + 2;
        await updateSheetValues(`Chi phí Vận hành!A${rowIndex}:G${rowIndex}`, values);
      } else {
        // Append new row
        await appendSheetValues("Chi phí Vận hành!A:G", values);
      }
      return res.status(200).json({ status: "success" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Handle save manual expense: POST request
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: "Invalid JSON body" }); }
    }
    const { month, ads_cost, salary_cost, phone_cost, office_cost, other_cost, note } = body;
    try {
      const rows = await getSheetValues("Chi phí Vận hành!A2:G200");
      const existIndex = rows.findIndex(r => r[0] === month);
      
      const values = [[month, ads_cost, salary_cost, phone_cost, office_cost, other_cost, note]];
      if (existIndex !== -1) {
        // Update existing row
        const rowIndex = existIndex + 2;
        await updateSheetValues(`Chi phí Vận hành!A${rowIndex}:G${rowIndex}`, values);
      } else {
        // Append new row
        await appendSheetValues("Chi phí Vận hành!A:G", values);
      }
      return res.status(200).json({ status: "success" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Default: GET request (fetch expenses list)
  try {
    const rows = await getSheetValues("Chi phí Vận hành!A2:G200");
    const expenses = rows.map((r, index) => {
      const id = index + 1;
      return {
        id: id,
        month: r[0] || "",
        ads_cost: parseFloat(r[1]) || 0.0,
        salary_cost: parseFloat(r[2]) || 0.0,
        phone_cost: parseFloat(r[3]) || 0.0,
        office_cost: parseFloat(r[4]) || 0.0,
        other_cost: parseFloat(r[5]) || 0.0,
        note: r[6] || "",
        sheet_url: null
      };
    });
    return res.status(200).json(expenses);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
