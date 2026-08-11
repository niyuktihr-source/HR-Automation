require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { encrypt, decrypt, isEncryptionEnabled } = require('./encryption');

const STATE_DIR = path.join(__dirname, '..');
const employeeId = process.argv[2];
const reason = process.argv.slice(3).join(' ') || 'Candidate did not join / Stop case requested';

if (!employeeId) {
  console.error('Usage: npm run stop-employee -- <EMPLOYEE_ID> [REASON]');
  console.error('Example: npm run stop-employee -- EMP001 "Candidate did not join"');
  process.exit(1);
}

const stateFile = path.join(STATE_DIR, `state-${employeeId}.json`);

function loadStateFile() {
  if (!fs.existsSync(stateFile)) return null;
  const raw = fs.readFileSync(stateFile, 'utf8');
  if (isEncryptionEnabled() && raw.includes('"ciphertext"')) {
    try {
      return JSON.parse(decrypt(raw));
    } catch {
      return null;
    }
  }
  return JSON.parse(raw);
}

function saveStateFile(data) {
  const plaintext = JSON.stringify(data, null, 2);
  const payload = isEncryptionEnabled() ? encrypt(plaintext) : plaintext;
  fs.writeFileSync(stateFile, payload);
}

// 1. Try to trigger via running engine endpoint first
const port = process.env.WEBHOOK_PORT || 3000;
const reqData = JSON.stringify({ reason });

const req = http.request({
  hostname: 'localhost',
  port: port,
  path: `/employee/${encodeURIComponent(employeeId)}/stop`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(reqData),
  },
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log(`[Success] Live engine stopped onboarding for ${employeeId}:`, body);
      process.exit(0);
    } else {
      console.warn(`[Notice] Engine returned ${res.statusCode}: ${body}. Updating local state file directly...`);
      updateStateDirectly();
    }
  });
});

req.on('error', () => {
  console.log(`[Notice] Engine server not running on port ${port}. Updating local state file directly...`);
  updateStateDirectly();
});

req.write(reqData);
req.end();

function updateStateDirectly() {
  const state = loadStateFile();
  if (!state) {
    console.error(`[Error] State file state-${employeeId}.json not found.`);
    process.exit(1);
  }

  state.status = 'stopped';
  state.statusReason = reason;
  state.isStopped = true;

  saveStateFile(state);
  console.log(`[Success] state-${employeeId}.json marked as STOPPED ("${reason}"). Restarts will skip this candidate.`);
  process.exit(0);
}
