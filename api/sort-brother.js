// api/sort-brother.js
// Vercel Serverless Function — Sort Brother sheet tức thì
// Chạy bởi: Vercel Cron Job (mỗi 1 phút, 24/7) + Google Drive Push Notification
const crypto = require('crypto');

const SPREADSHEET_ID = '1MQ_M_l_Vugn-_eURR4qmCHylfpiM_pYfPTooJRsAut4';
const SHEET_NAME     = 'Câu trả lời biểu mẫu 1';
const SECRET_TOKEN   = 'ecl-brother-sort-2026';
const BROTHER_GID    = 128053512;

// Lưu số dòng lần trước (trong memory của serverless instance)
// Với cron job, mỗi lần gọi có thể là instance mới → luôn sort để an toàn
let lastKnownRows = 0;

// ── JWT / OAuth2 (không cần package ngoài) ──────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken() {
  const creds = JSON.parse(process.env.GOOGLE_CREDS_JSON);
  const now   = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive'
    ].join(' '),
    aud:  'https://oauth2.googleapis.com/token',
    iat:  now,
    exp:  now + 3600,
  }));

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(creds.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('OAuth failed: ' + JSON.stringify(d));
  return d.access_token;
}

// ── Parse ngày Việt Nam ─────────────────────────────────────────────────────
function parseDate(val) {
  if (!val) return new Date(0);
  if (val instanceof Date) return val;
  const s = String(val).trim();
  try {
    const p = s.split(/\s+/);
    const d = p[0].replace(/\./g, '/').split('/');
    const day = parseInt(d[0]), mon = parseInt(d[1]);
    let yr = d.length >= 3 ? parseInt(d[2]) : 2026;
    if (yr < 100) yr += 2000;
    let h = 0, m = 0, sc = 0;
    if (p.length > 1) {
      const t = p[1].split(':');
      h = parseInt(t[0]) || 0; m = parseInt(t[1]) || 0; sc = parseInt(t[2]) || 0;
    }
    return new Date(yr, mon - 1, day, h, m, sc);
  } catch (e) { return new Date(0); }
}

// ── Sort Brother Sheet ──────────────────────────────────────────────────────
async function sortBrotherSheet(token) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;
  const hdrs = { Authorization: `Bearer ${token}` };

  // 1. Đọc toàn bộ dữ liệu
  const resp = await fetch(`${base}/values/${encodeURIComponent(SHEET_NAME)}`, { headers: hdrs });
  const data = await resp.json();
  const rows = data.values || [];
  if (rows.length <= 1) return { sorted: 0 };

  const header   = rows[0];
  let dataRows   = rows.slice(1);
  const lastCol  = header.length;

  // 2. Sắp xếp mới nhất lên đầu
  dataRows.sort((a, b) => parseDate(b[0] || '') - parseDate(a[0] || ''));

  // 3. Chuẩn hóa SĐT (cột C, index 2) và CCCD (cột D, index 3) — giữ số 0
  dataRows = dataRows.map(row => {
    const r = [...row];
    // SĐT: thêm 0 nếu đủ 9 chữ số không có số 0 đầu
    if (r[2] && /^\d{9}$/.test(String(r[2]).trim()) && !String(r[2]).startsWith('0'))
      r[2] = '0' + r[2];
    // CCCD: chỉ thêm 0 nếu đúng 11 chữ số
    if (r[3] && /^\d{11}$/.test(String(r[3]).trim()) && !String(r[3]).startsWith('0'))
      r[3] = '0' + r[3];
    return r;
  });

  // 4. Format cột C & D thành TEXT (giữ số 0) + ghi dữ liệu
  const [formatResp, writeResp] = await Promise.all([
    fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          repeatCell: {
            range: {
              sheetId: 128053512, // Brother sheet gid
              startRowIndex: 1, endRowIndex: dataRows.length + 1,
              startColumnIndex: 2, endColumnIndex: 4,
            },
            cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
            fields: 'userEnteredFormat.numberFormat',
          }
        }]
      }),
    }),
    fetch(`${base}/values/${encodeURIComponent(SHEET_NAME + '!A2')}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: dataRows }),
    }),
  ]);

  // 5. Copy dropdown từ dòng template vào toàn bộ dòng dữ liệu
  // Tìm dòng có nhiều dữ liệu nhất trong 20 dòng đầu
  let bestRow = 1, bestCount = 0;
  const checkRows = dataRows.slice(1, 21); // bỏ dòng 1 (mới điền)
  checkRows.forEach((row, i) => {
    const cnt = row.filter(c => String(c).trim()).length;
    if (cnt > bestCount) { bestCount = cnt; bestRow = i + 2; } // 1-indexed row 3+
  });

  if (bestRow > 1 && bestCount > 0) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          copyPaste: {
            source: {
              sheetId: 128053512,
              startRowIndex: bestRow, endRowIndex: bestRow + 1,
              startColumnIndex: 1, endColumnIndex: lastCol,
            },
            destination: {
              sheetId: 128053512,
              startRowIndex: 1, endRowIndex: dataRows.length + 1,
              startColumnIndex: 1, endColumnIndex: lastCol,
            },
            pasteType: 'PASTE_DATA_VALIDATION',
            pasteOrientation: 'NORMAL',
          }
        }]
      }),
    });
  }

  return { sorted: dataRows.length, templateRow: bestRow };
}

// ── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const driveToken = req.headers['x-goog-channel-token'];
  const queryToken = req.query && req.query.token;
  const isCron     = !!req.headers['x-vercel-cron']; // Vercel cron header

  // Xác thực token
  if (driveToken !== SECRET_TOKEN && queryToken !== SECRET_TOKEN) {
    if (req.headers['x-goog-resource-state'] === 'sync') {
      return res.status(200).json({ ok: true, msg: 'sync ack' });
    }
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Với Drive push: skip SYNC và các event không phải thay đổi
  const state = req.headers['x-goog-resource-state'];
  if (state && state !== 'update' && state !== 'change') {
    return res.status(200).json({ ok: true, msg: `skip state=${state}` });
  }

  try {
    const token = await getAccessToken();
    const base  = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;
    const hdrs  = { Authorization: `Bearer ${token}` };

    // Kiểm tra số dòng hiện tại trước (1 API call nhẹ)
    const checkResp = await fetch(
      `${base}/values/${encodeURIComponent(SHEET_NAME + '!A:A')}`,
      { headers: hdrs }
    );
    const checkData  = await checkResp.json();
    const currentRows = (checkData.values || []).length;

    // Với cron job: chỉ sort khi có dòng mới (tránh ghi thừa mỗi phút)
    if (isCron && currentRows <= lastKnownRows && lastKnownRows > 0) {
      lastKnownRows = currentRows;
      return res.status(200).json({ ok: true, msg: 'no new data', rows: currentRows });
    }

    lastKnownRows = currentRows;

    // Sort đầy đủ + copy dropdown
    const result = await sortBrotherSheet(token);
    console.log(`[sort-brother] ✅ Sorted (cron=${isCron}):`, result);
    return res.status(200).json({ ok: true, ...result, ts: new Date().toISOString() });

  } catch (err) {
    console.error('[sort-brother] ❌', err.message);
    return res.status(500).json({ error: err.message });
  }
};
