module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  
  const url = `https://docs.google.com/spreadsheets/d/1_wy9qhm6dnv_pWsk5vrU0wZK60GfBuxtj3ptwt8p3d4/export?format=csv&gid=130238006&t=${Date.now()}`;
  
  try {
    const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.text();
    res.status(200).send(data);
  } catch (error) {
    res.status(502).send(`Error fetching Telesale spreadsheet: ${error.message}`);
  }
};
