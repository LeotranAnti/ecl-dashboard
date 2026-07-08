module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  
  const spreadsheetId = "1NgDH3ayQ7nE4_mcT1B5HEW1YrMHaJH8xtf0-u0bFNZQ";
  const gid = "1245696062";
  
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}&t=${Date.now()}`;
  
  try {
    const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    const data = await response.text();
    res.status(200).send(data);
  } catch (error) {
    res.status(502).send(`Error fetching marketing spreadsheet: ${error.message}`);
  }
};
