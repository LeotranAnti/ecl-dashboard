
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  
  const { month } = req.query;
  
  // Ánh xạ tháng sang GID của Google Sheet
  const gids = {
    "4": "0",          // Tháng 4 MKT
    "5": "609412597",  // Tháng 5 MKT
    "6": "1703521677", // Tháng 6 MKT
    "7": "1245696062"  // Tháng 7 MKT
  };
  
  const spreadsheetId = "1NgDH3ayQ7nE4_mcT1B5HEW1YrMHaJH8xtf0-u0bFNZQ";
  const gid = gids[month] || "1245696062"; // Fallback là tháng 7
  
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}&t=${Date.now()}`;
  
  try {
    const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.text();
    res.status(200).send(data);
  } catch (error) {
    res.status(502).send(`Error fetching marketing spreadsheet: ${error.message}`);
  }
};
