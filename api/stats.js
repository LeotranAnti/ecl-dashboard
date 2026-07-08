module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");
  const backendUrl = process.env.FINANCE_BACKEND_URL || "http://localhost:3001";
  
  const urlObj = new URL(req.url, 'http://localhost');
  const targetUrl = `${backendUrl}/api/stats${urlObj.search}`;
  
  try {
    const response = await fetch(targetUrl);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(502).json({ error: `Error proxying to finance backend: ${error.message}` });
  }
};
