const fs = require('fs');
const path = require('path');

function getApiKey() {
  // Try environment variable first (Vercel best practice)
  if (process.env.GOOGLE_API_KEY) {
    return process.env.GOOGLE_API_KEY.trim();
  }
  // Fallback to local config file
  try {
    const configPath = path.join(process.cwd(), 'api_config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return (config.google_api_key || "").trim();
    }
  } catch (e) {
    console.error("Error reading api_config.json:", e);
  }
  return "";
}

function isYellow(colorObj) {
  if (!colorObj) return false;
  const r = colorObj.red || 0;
  const g = colorObj.green || 0;
  const b = colorObj.blue || 0;
  return r > 0.7 && g > 0.7 && b < 0.5;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");

  const apiKey = getApiKey();
  if (!apiKey) {
    return res.status(200).json({
      error: "no_api_key",
      message: "Chưa cấu hình Google API Key. Hãy cấu hình biến môi trường GOOGLE_API_KEY hoặc file api_config.json."
    });
  }

  const SPREADSHEET_ID = "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20";
  const SHEET_NAME_CANDIDATES = "Xử lý data";
  const range = `'${SHEET_NAME_CANDIDATES}'!M1:M5000`;
  const encodedRange = encodeURIComponent(range);
  const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?includeGridData=true&ranges=${encodedRange}&fields=sheets(data(rowData(values(effectiveFormat/backgroundColor))))&key=${apiKey}`;

  try {
    const response = await fetch(apiUrl);
    if (!response.ok) {
      const body = await response.text();
      return res.status(200).json({ error: `http_${response.status}`, message: body });
    }
    const sheetsData = await response.json();
    const rows = sheetsData.sheets?.[0]?.data?.[0]?.rowData || [];
    
    const rowColors = {};
    rows.forEach((row, i) => {
      const values = row.values || [];
      const effectiveFormat = values[0]?.effectiveFormat || {};
      const color = effectiveFormat.backgroundColor || {};
      rowColors[i] = isYellow(color);
    });

    res.status(200).json({ colors: rowColors, error: null });
  } catch (error) {
    res.status(200).json({ error: error.message });
  }
};
