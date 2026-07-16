module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  
  const factory = req.query.factory || "Pegatron";
  
  let spreadsheetId = "1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20"; // Pegatron default
  let gid = "1084935408";
  
  if (factory === "Brother") {
    spreadsheetId = "1MQ_M_l_Vugn-_eURR4qmCHylfpiM_pYfPTooJRsAut4";
    gid = "2146286375";
  } else if (factory === "LG") {
    spreadsheetId = "1Q8VEWGF8odmzf_12i-6qBgaGMfOdNmPlDtOkF92qWVk";
    gid = "1084935408"; // Gid for LG 'Danh sách nhận việc' is same as Pegatron's template copy sheet
  } else if (factory === "Usi") {
    spreadsheetId = "1539PRjUCZu98VQAQOrMdlcd6OcQftdony2J4wVQAFEU";
    gid = "481655667"; // Usi 'Danh sách nhận việc' gid
  } else if (factory === "Fox QN") {
    spreadsheetId = "1QS41MPzfsv5-_nNqjlTX4YDtze5jtM-UqZTnT-NwoQw";
    gid = "1084935408";
  } else if (factory === "Wistron") {
    spreadsheetId = "1Z__ek4edK1dRvwL9I-i36hlegslbTCft3zOWD7Mq7Ss";
    gid = "1084935408";
  }
  
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}&t=${Date.now()}`;
  
  try {
    const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    const data = await response.text();
    res.status(200).send(data);
  } catch (error) {
    res.status(502).send(`Error fetching recruitments spreadsheet: ${error.message}`);
  }
};
