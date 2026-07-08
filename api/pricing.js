const { getSheetValues, appendSheetValues, updateSheetValues, deleteSheetRow } = require("./sheets_helper");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", "application/json");

  // Handle pricing delete request: /api/pricing/delete?id=X
  if (req.url.includes("/delete")) {
    const urlObj = new URL(req.url, 'http://localhost');
    const id = parseInt(urlObj.searchParams.get("id"));
    if (isNaN(id)) {
      return res.status(400).json({ error: "Missing or invalid id parameter" });
    }
    try {
      // id represents the 1-based row index in database (excluding header row in gspread, which starts data at row 2)
      // Since row index in sheet = id + 1 (header is row 1, first data is row 2, which has id = 1)
      const rowIndex = id + 1;
      await deleteSheetRow("Cấu hình Đơn giá", rowIndex);
      return res.status(200).json({ status: "success" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Handle save pricing: POST request
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({ error: "Invalid JSON body" });
      }
    }
    const { id, factory, price, start_date, end_date, unit } = body;
    try {
      const values = [[factory, price, start_date, end_date, unit]];
      if (id) {
        // Update existing row
        const rowIndex = parseInt(id) + 1;
        await updateSheetValues(`Cấu hình Đơn giá!A${rowIndex}:E${rowIndex}`, values);
      } else {
        // Append new row
        await appendSheetValues("Cấu hình Đơn giá!A:E", values);
      }
      return res.status(200).json({ status: "success" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Default: GET request (fetch pricing list)
  try {
    const rows = await getSheetValues("Cấu hình Đơn giá!A2:E200");
    const prices = rows.map((r, index) => {
      // ID represents the index row offset: row index = ID + 1
      const id = index + 1;
      return {
        id: id,
        factory: r[0] || "",
        price: parseFloat(r[1]) || 0.0,
        start_date: r[2] || "",
        end_date: r[3] || "",
        unit: r[4] || "Ngày"
      };
    });
    return res.status(200).json(prices);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
