require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const OpenAI = require('openai');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const IMPL_PASSWORD = process.env.IMPL_PASSWORD;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Token cache per impl
const tokenCache = {};

async function getImplSession(impl) {
  const cached = tokenCache[impl];
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
  const res = await fetch(`https://impl${impl}.taqtics.co/api/v1/internal/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `impl${impl}@taqtics.co`, password: IMPL_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed for impl${impl}: ${res.status}`);
  const data = await res.json();
  const token = data.token;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  const session = {
    token,
    expiresAt: payload.exp * 1000,
    userId: data.userId || data._id,   // root admin ID
    storeId: data.storeId,             // impl's head office store ID
    storeName: data.storeName,
  };
  tokenCache[impl] = session;
  return session;
}
async function getToken(impl) { return (await getImplSession(impl)).token; }

// GET /proxy/roles?impl=N
app.get('/proxy/roles', async (req, res) => {
  const impl = req.query.impl;
  if (!['1', '2', '3', '4'].includes(impl)) return res.status(400).json({ error: 'impl must be 1–4' });
  try {
    const token = await getToken(impl);
    const csvRes = await fetch(`https://impl${impl}.taqtics.co/api/v1/internal/roles/csv/download`, {
      headers: { 'access-token': token },
    });
    if (!csvRes.ok) throw new Error(`Roles fetch failed: ${csvRes.status}`);
    const csv = await csvRes.text();
    const lines = csv.trim().split('\n').slice(1);
    const roles = lines
      .map(line => {
        const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
        return { role: cols[0], reportingRole: cols[1] || '', userRole: cols[2] };
      })
      .filter(r => r.role);
    const seen = new Set();
    const unique = roles.filter(r => {
      const key = `${r.role}||${r.userRole}`;
      return !seen.has(key) && seen.add(key);
    });
    res.json(unique);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /proxy/ai-fill  — natural language → structured setup JSON
// Body: { prompt, impl, designations: [{role, userRole}] }
app.post('/proxy/ai-fill', async (req, res) => {
  const { prompt, impl, designations, context } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const designationList = (designations || []).map(d => `"${d.role}" (${d.userRole})`).join(', ');

  const systemPrompt = `You are a setup assistant for Taqtics, a retail operations SaaS platform used by retail brands.

## How Taqtics hierarchy works
- There is always ONE HQ user (top-level). They can see reports for ALL stores under them.
- Each store can optionally have a Store Manager. If present, the store manager reports to HQ.
- Each store can optionally have a Store Employee. They report to their store manager if one exists, OR directly to HQ if there is no store manager.
- The "5 IDs" or "3 users" the sales team mentions = total count of ALL users including HQ.

## Counting users correctly
- "3 users: 2 stores, 1 manager" = 1 HQ + 2 employees (no store managers), HQ manages both stores directly
- "5 IDs" for 2 stores = typically 1 HQ + 2 managers + 2 employees (standard hierarchy)
- "5 IDs" for 2 stores, "1 manager of both" = 1 HQ + 2 employees, no store managers (HQ is the manager)
- Always count carefully: HQ(1) + managers + employees = total IDs

## Available designations for impl${impl || 'N'}
${designationList || 'Store Manager, Store Employee, Business Head'}

Return ONLY valid JSON (no markdown, no explanation):
{
  "clientName": "string — brand/company name",
  "subdomain": "string — impl number 1-4 if mentioned, else null",
  "city": "string — best city for the location mentioned (infer from country/region if not explicit)",
  "state": "string — state/province for the city",
  "country": "string — country name",
  "stores": [
    {
      "name": "string — store name, or null to auto-generate",
      "area": "string — realistic area/neighbourhood name for the city (e.g. 'Downtown', 'Midtown', 'Connaught Place')"
    }
  ],
  "hqChain": [
    {
      "name": "string or null",
      "designation": "string — must match available designations, prefer areaManager-type for trials",
      "email": "string or null",
      "emailIsReal": false
    }
  ],
  "storeUsers": [
    {
      "storeIndex": 0,
      "manager": null,
      "employees": [
        {
          "name": "string or null",
          "designation": "string — must match available designations",
          "email": "string or null",
          "emailIsReal": false,
          "phone": "string or null"
        }
      ]
    }
  ]
}

Rules:
- hqChain ordered TOP to BOTTOM. First supervisor = root admin. Last manages stores.
- If only one HQ person, hqChain has one entry.
- Set manager to null when no store manager (employees report to HQ directly)
- employees is always an array (even if just one)
- Always create exactly as many storeUsers as stores. storeIndex = 0-based position.
- Pick closest matching designation from available list
- Never use companyAdmin or nonCreatorCompanyAdmin for HQ — prefer areaManager
- IMPORTANT emailIsReal: if the user provided an actual email address (e.g. "john@company.com"), set emailIsReal: true. If no email was given and you are leaving it null, set emailIsReal: false.
- IMPORTANT location: always infer a realistic city + state + area even if only country is mentioned. For USA → pick a major US city. For UK → pick a UK city. Generate plausible area/neighbourhood names per store.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: context
          ? `Current setup:\n${JSON.stringify(context, null, 2)}\n\nRefinement request: ${prompt}`
          : prompt },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    const result = JSON.parse(completion.choices[0].message.content);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /proxy/parse-file  — CSV or Excel upload → extracted setup data
app.post('/proxy/parse-file', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { impl, designations } = req.body;

  try {
    // Parse the uploaded file with xlsx (handles .csv, .xlsx, .xls)
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheets = {};
    workbook.SheetNames.forEach(name => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: '' });
      sheets[name] = rows;
    });

    // Convert sheets to text summary for AI
    let fileText = '';
    workbook.SheetNames.forEach(name => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
      fileText += `\n--- Sheet: ${name} ---\n`;
      rows.slice(0, 50).forEach(row => { fileText += row.join(' | ') + '\n'; });
    });

    const designationList = (JSON.parse(designations || '[]')).map(d => `"${d.role}" (${d.userRole})`).join(', ');

    const systemPrompt = `You are a setup assistant for Taqtics, a retail operations SaaS.
Extract trial setup information from this spreadsheet/CSV data and return a structured JSON object.

Available designations: ${designationList || 'Store Manager, Store Employee, Business Head'}

Return ONLY valid JSON matching this exact structure (no markdown):
{
  "clientName": "string or null",
  "city": "string or null",
  "country": "string or null",
  "stores": [ { "name": "string" } ],
  "hqUser": {
    "name": "string or null",
    "designation": "string — must match available designations",
    "email": "string or null",
    "phone": "string or null"
  },
  "storeUsers": [
    {
      "storeIndex": 0,
      "manager": { "name": "string or null", "designation": "string", "email": "string or null", "phone": "string or null" },
      "employee": { "name": "string or null", "designation": "string", "email": "string or null", "phone": "string or null" }
    }
  ]
}

Extract all store names, user names, emails, phone numbers you can find. Map roles to the closest available designation.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here is the spreadsheet data:\n${fileText}` },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });
    const result = JSON.parse(completion.choices[0].message.content);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /proxy/create-all — create stores + users directly via Taqtics API
// Returns a log array of {type, name, status, id, error}
app.post('/proxy/create-all', async (req, res) => {
  const { impl, clientName, city, state, country, password, stores, hqChain, storeUsers } = req.body;
  if (!impl) return res.status(400).json({ error: 'impl required' });
  const log = [];
  const push = (entry) => { log.push(entry); };

  try {
    const session = await getImplSession(impl);
    const token = session.token;
    const rootAdminId = session.userId;
    const implHQStoreId = session.storeId;   // fallback store for HQ users
    const implHQStoreName = session.storeName;
    const pwd = password || `Impl${impl}@123789`;
    const baseUrl = `https://impl${impl}.taqtics.co/api/v1/internal`;
    const headers = { 'access-token': token, 'Content-Type': 'application/json' };

    const apiFetch = async (path, method = 'GET', body) => {
      const r = await fetch(`${baseUrl}${path}`, {
        method, headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { message: text }; }
      if (!r.ok) throw new Error(json.message || `HTTP ${r.status}`);
      return json;
    };

    // 1. Fetch role IDs
    const rolesJson = await apiFetch('/roles');
    const roleList = rolesJson.data || rolesJson;
    const roleIdMap = {}; // role name (designation) → _id
    roleList.forEach(r => { roleIdMap[r.role] = r._id; });

    // 2. Create stores
    const storeIdMap = {}; // storeName → _id
    const storeCoords = {
      'Mumbai': [19.076, 72.877], 'Delhi': [28.613, 77.209], 'New Delhi': [28.613, 77.209],
      'Bangalore': [12.971, 77.594], 'Chennai': [13.082, 80.270], 'Hyderabad': [17.385, 78.486],
      'New York': [40.712, -74.005], 'London': [51.507, -0.127], 'Dubai': [25.204, 55.270],
    };
    const [baseLat, baseLng] = storeCoords[city] || [28.613, 77.209];

    for (let i = 0; i < stores.length; i++) {
      const s = stores[i];
      const lat = +(baseLat + (Math.random() - 0.5) * 0.06).toFixed(4);
      const lng = +(baseLng + (Math.random() - 0.5) * 0.06).toFixed(4);
      try {
        const r = await apiFetch('/stores', 'POST', {
          storeName: s.name,
          address: `${i + 1} ${s.area || city} Road`,
          area: s.area || `${city} Area ${i + 1}`,
          city: city || 'New Delhi',
          state: state || city || 'Delhi',
          country: country || 'India',
          latitude: lat, longitude: lng,
          storeRadius: 100,
          entityId: String(Math.floor(100000 + Math.random() * 900000)),
          tags: clientName ? { Client_Name: clientName } : {},
        });
        const storeId = r._id || r.data?._id || r.store?._id;
        storeIdMap[s.name] = storeId;
        push({ type: 'store', name: s.name, status: 'created', id: storeId });
      } catch (err) {
        push({ type: 'store', name: s.name, status: 'error', error: err.message });
      }
    }

    // 3. Create HQ chain — each person's supervisor = the one above
    const hqChainData = hqChain || [];
    let prevSupervisorId = rootAdminId;
    let prevSupervisorName = `impl${impl}@taqtics.co`;
    const hqUserIds = [];

    for (let i = 0; i < hqChainData.length; i++) {
      const hq = hqChainData[i];
      const roleId = roleIdMap[hq.designation];
      // Find storeId for this HQ user (by store name they were assigned)
      const assignedStoreId = (hq.storeName && storeIdMap[hq.storeName]) || implHQStoreId;
      const assignedStoreName = hq.storeName || implHQStoreName;
      try {
        const r = await apiFetch('/users', 'POST', {
          name: hq.name || `HQ User ${i + 1}`,
          email: hq.email || `hq${i + 1}@${(clientName || 'trial').toLowerCase().replace(/\s+/g, '')}.com`,
          password: pwd,
          validEmail: !!hq.emailIsReal,
          tenantRole: hq.designation,
          tenantRoleId: roleId,
          storeId: assignedStoreId,
          storeName: assignedStoreName,
          supervisorId: prevSupervisorId,
          supervisorName: prevSupervisorName,
          tags: clientName ? { Client_Name: clientName } : {},
        });
        const userId = r._id || r.data?._id || r.user?._id;
        hqUserIds.push(userId);
        prevSupervisorId = userId;
        prevSupervisorName = hq.name || `HQ User ${i + 1}`;
        push({ type: 'hq', name: hq.name, level: i + 1, status: 'created', id: userId });
      } catch (err) {
        push({ type: 'hq', name: hq.name, level: i + 1, status: 'error', error: err.message });
        hqUserIds.push(null);
      }
    }

    // Bottom HQ user = supervisor of all managers (or employees if no manager)
    const bottomHQId = hqUserIds[hqUserIds.length - 1] || rootAdminId;
    const bottomHQName = (hqChainData[hqChainData.length - 1]?.name) || `impl${impl}@taqtics.co`;

    // 4. Create store managers
    const mgrIdMap = {}; // storeIndex → userId
    for (const su of (storeUsers || [])) {
      if (!su.manager) continue;
      const sName = stores[su.storeIndex]?.name;
      const sId = storeIdMap[sName];
      const roleId = roleIdMap[su.manager.designation];
      try {
        const r = await apiFetch('/users', 'POST', {
          name: su.manager.name || `Manager ${su.storeIndex + 1}`,
          email: su.manager.email || `manager${su.storeIndex + 1}@${(clientName || 'trial').toLowerCase().replace(/\s+/g, '')}.com`,
          password: pwd,
          validEmail: !!su.manager.emailIsReal,
          tenantRole: su.manager.designation,
          tenantRoleId: roleId,
          storeId: sId, storeName: sName,
          supervisorId: bottomHQId, supervisorName: bottomHQName,
          tags: clientName ? { Client_Name: clientName } : {},
        });
        const uid = r._id || r.data?._id || r.user?._id;
        mgrIdMap[su.storeIndex] = uid;
        push({ type: 'manager', name: su.manager.name, store: sName, status: 'created', id: uid });
      } catch (err) {
        push({ type: 'manager', name: su.manager.name, store: sName, status: 'error', error: err.message });
      }
    }

    // 5. Create employees
    for (const su of (storeUsers || [])) {
      const sName = stores[su.storeIndex]?.name;
      const sId = storeIdMap[sName];
      const supId = mgrIdMap[su.storeIndex] || bottomHQId;
      const supName = (storeUsers.find(x => x.storeIndex === su.storeIndex)?.manager?.name) || bottomHQName;
      for (let j = 0; j < (su.employees || []).length; j++) {
        const emp = su.employees[j];
        if (!emp) continue;
        const roleId = roleIdMap[emp.designation];
        try {
          const r = await apiFetch('/users', 'POST', {
            name: emp.name || `Employee ${j + 1}`,
            email: emp.email || `employee${su.storeIndex + 1}_${j + 1}@${(clientName || 'trial').toLowerCase().replace(/\s+/g, '')}.com`,
            password: pwd,
            validEmail: !!emp.emailIsReal,
            tenantRole: emp.designation,
            tenantRoleId: roleId,
            storeId: sId, storeName: sName,
            supervisorId: supId, supervisorName: supName,
            tags: clientName ? { Client_Name: clientName } : {},
          });
          const uid = r._id || r.data?._id || r.user?._id;
          push({ type: 'employee', name: emp.name, store: sName, status: 'created', id: uid });
        } catch (err) {
          push({ type: 'employee', name: emp.name, store: sName, status: 'error', error: err.message });
        }
      }
    }

    res.json({ success: true, log });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message, log });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Taqtics Impl Automation running on port ${PORT}`));
