const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

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

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
function ensureState() {
  if (!fs.existsSync(statePath)) {
    writeJSON(statePath, { tokens: {}, assignments: {} });
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

app.get('/', (req, res) => {
  res.redirect('/admin');
});

app.get('/claim/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'claim.html'));
});

app.post('/api/assign', (req, res) => {
  const token = req.body.token;
  if (!token) return res.status(400).json({ error: 'token required' });
  const people = loadColleaguesWithTokens();
  const state = readJSON(statePath);

  const tokenToIndex = new Map(people.map((p, i) => [p.token, i]));
  const idx = tokenToIndex.get(token);
  if (idx === undefined) return res.status(404).json({ error: 'invalid token' });

  // If no assignments yet, compute global once
  if (!state.assignments || Object.keys(state.assignments).length === 0) {
    const perm = derangement(people.length);
    state.assignments = {};
    for (let i = 0; i < people.length; i++) {
      state.assignments[people[i].token] = people[perm[i]].token;
    }
    writeJSON(statePath, state);
  }

  const assigneeToken = state.assignments[token];
  const assignee = people.find(p => p.token === assigneeToken);
  return res.json({ assignee });
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

app.post('/admin/reset', (req, res) => {
  ensureState();
  writeJSON(statePath, { tokens: readJSON(statePath).tokens || {}, assignments: {} });
  res.json({ ok: true });
});

app.get('/admin/export.csv', (req, res) => {
  const people = loadColleaguesWithTokens();
  const state = readJSON(statePath);
  const header = 'Даритель,ДР,Годовщина,Подопечный,ДР подопечного,Годовщина подопечного,Ссылка\n';
  let csv = header;
  for (const giver of people) {
    const receiver = people.find(p => p.token === state.assignments[giver.token]);
    if (!receiver) continue;
    const claimUrl = `/claim/${giver.token}`;
    csv += `${giver.name},${giver.birthday},${giver.anniversary},${receiver.name},${receiver.birthday},${receiver.anniversary},${claimUrl}\n`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="assignments.csv"');
  res.send(csv);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
