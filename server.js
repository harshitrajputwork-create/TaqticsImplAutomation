const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const IMPL_PASSWORD = 'ThisIsMasterTaqtics12789';

// Token cache: { impl1: { token, expiresAt }, ... }
const tokenCache = {};

async function getToken(impl) {
  const cached = tokenCache[impl];
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(`https://impl${impl}.taqtics.co/api/v1/internal/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `impl${impl}@taqtics.co`, password: IMPL_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed for impl${impl}: ${res.status}`);
  const data = await res.json();
  const token = data.token;

  // Decode exp from JWT payload (no library needed)
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  tokenCache[impl] = { token, expiresAt: payload.exp * 1000 };
  return token;
}

// GET /proxy/roles?impl=3  → returns JSON array of { role, userRole, reportingRole }
app.get('/proxy/roles', async (req, res) => {
  const impl = req.query.impl;
  if (!['1', '2', '3', '4'].includes(impl)) {
    return res.status(400).json({ error: 'impl must be 1–4' });
  }
  try {
    const token = await getToken(impl);
    const csvRes = await fetch(
      `https://impl${impl}.taqtics.co/api/v1/internal/roles/csv/download`,
      { headers: { 'access-token': token } }
    );
    if (!csvRes.ok) throw new Error(`Roles fetch failed: ${csvRes.status}`);
    const csv = await csvRes.text();

    // Parse CSV → JSON (skip header row, handle quoted fields)
    const lines = csv.trim().split('\n').slice(1);
    const roles = lines
      .map(line => {
        // Split on comma, strip surrounding quotes, trim whitespace
        const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
        return { role: cols[0], reportingRole: cols[1] || '', userRole: cols[2] };
      })
      .filter(r => r.role); // drop empty rows

    // Deduplicate by role name (keep first occurrence)
    const seen = new Set();
    const unique = roles.filter(r => !seen.has(r.role) && seen.add(r.role));

    res.json(unique);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Taqtics Impl Automation running on port ${PORT}`));
