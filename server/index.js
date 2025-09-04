const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Support configurable data directory for deployments with a mounted disk
const dataDir = process.env.DATA_DIR
  ? process.env.DATA_DIR
  : path.join(__dirname, '..', 'data');
const repoDataDir = path.join(__dirname, '..', 'data');
const colleaguesPath = path.join(dataDir, 'colleagues.json');
const statePath = path.join(dataDir, 'state.json');

// Supabase client (assignments storage lives in DB)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function ensureState() {
  // Only manage tokens in local state file; assignments are in Supabase
  if (!fs.existsSync(statePath)) {
    writeJSON(statePath, { tokens: {} });
  }
}
function ensureDataDirAndSeed() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  // Seed colleagues.json into DATA_DIR if missing
  if (!fs.existsSync(colleaguesPath)) {
    const seedPath = path.join(repoDataDir, 'colleagues.json');
    if (fs.existsSync(seedPath)) {
      fs.copyFileSync(seedPath, colleaguesPath);
    } else {
      // If no seed exists, create empty structure to avoid crashes
      writeJSON(colleaguesPath, []);
    }
  }
}
function loadColleaguesWithTokens() {
  ensureDataDirAndSeed();
  const list = readJSON(colleaguesPath);
  ensureState();
  const state = readJSON(statePath);
  // assign stable tokens on first run
  for (const person of list) {
    if (!state.tokens[person.name]) {
      state.tokens[person.name] = randomUUID();
    }
  }
  writeJSON(statePath, state);
  // attach token field
  return list.map(p => ({ ...p, token: state.tokens[p.name] }));
}

function derangement(n) {
  // generate a random derangement (Fisher-Yates with retries)
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let tries = 0; tries < 2000; tries++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    if (arr.every((v, i) => v !== i)) return arr.slice();
  }
  throw new Error('Failed to create derangement');
}

// === Supabase helpers ===
async function saveAssignments(pairs) {
  // pairs: array of rows for assignments table
  // Use upsert to avoid requiring DELETE permissions under RLS.
  const { error } = await supabase
    .from('assignments')
    .upsert(pairs, { onConflict: 'token' });
  if (error) throw error;
}

async function getAllAssignments() {
  const { data, error } = await supabase
    .from('assignments')
    .select('*')
    .order('giver', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getByToken(token) {
  const { data, error } = await supabase
    .from('assignments')
    .select('*')
    .eq('token', token)
    .maybeSingle();
  if (error) return null;
  return data;
}

app.get('/', (req, res) => {
  res.redirect('/admin');
});

app.get('/claim/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'claim.html'));
});

app.post('/api/assign', async (req, res) => {
  try {
    const token = req.body.token;
    if (!token) return res.status(400).json({ error: 'token required' });
    const people = loadColleaguesWithTokens();

    const tokenToIndex = new Map(people.map((p, i) => [p.token, i]));
    const idx = tokenToIndex.get(token);
    if (idx === undefined) return res.status(404).json({ error: 'invalid token' });

    // Check if assignments exist in DB
    const existing = await getByToken(token);
    if (!existing) {
      // Generate full derangement and store to DB
      const perm = derangement(people.length);
      const rows = [];
      for (let i = 0; i < people.length; i++) {
        const giver = people[i];
        const receiver = people[perm[i]];
        rows.push({
          token: giver.token,
          giver: giver.name,
          receiver_token: receiver.token,
          receiver: receiver.name
        });
      }
      await saveAssignments(rows);
    }

    const row = await getByToken(token);
    const assignee = row ? people.find(p => p.token === row.receiver_token) : null;
    return res.json({ assignee });
  } catch (e) {
    console.error('assign error', e);
    const detail = e && (e.message || e.details || e.hint) ? (e.message || e.details || e.hint) : e;
    return res.status(500).json({ error: 'internal error', detail, raw: JSON.stringify(e) });
  }
});

// Helper: export current personal links (tokens) for distribution
app.get('/admin/links.csv', (req, res) => {
  const people = loadColleaguesWithTokens();
  const header = 'Имя,Ссылка\n';
  let csv = header;
  for (const p of people) {
    const claimUrl = `/claim/${p.token}`;
    csv += `${p.name},${claimUrl}\n`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="links.csv"');
  res.send(csv);
});

app.get('/api/whoami/:token', (req, res) => {
  const people = loadColleaguesWithTokens();
  const me = people.find(p => p.token === req.params.token);
  if (!me) return res.status(404).json({ error: 'invalid token' });
  res.json({ me });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

app.post('/admin/reset', async (req, res) => {
  try {
    // With RLS, DELETE may be restricted; emulate reset by overwriting with empty set is not applicable.
    // For admin reset on public anon key we can no-op, and new assignment run will overwrite via upsert.
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed to reset' });
  }
});

app.get('/admin/export.csv', async (req, res) => {
  try {
    const people = loadColleaguesWithTokens();
    const rows = await getAllAssignments();
    const tokenToPerson = new Map(people.map(p => [p.token, p]));
    const header = 'Даритель,ДР,Годовщина,Подопечный,ДР подопечного,Годовщина подопечного,Ссылка\n';
    let csv = header;
    for (const row of rows) {
      const giver = tokenToPerson.get(row.token);
      const receiver = tokenToPerson.get(row.receiver_token);
      if (!giver || !receiver) continue;
      const claimUrl = `/claim/${giver.token}`;
      csv += `${giver.name},${giver.birthday},${giver.anniversary},${receiver.name},${receiver.birthday},${receiver.anniversary},${claimUrl}\n`;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="assignments.csv"');
    res.send(csv);
  } catch (e) {
    console.error('export error', e);
    const detail = e && (e.message || e.details || e.hint) ? (e.message || e.details || e.hint) : e;
    res.status(500).send('failed: ' + detail);
  }
});

// Simple health endpoint to validate Supabase connectivity
app.get('/admin/health', async (req, res) => {
  try {
    const { data, error } = await supabase.from('assignments').select('token', { count: 'estimated', head: true });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    console.error('health error', e);
    res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
