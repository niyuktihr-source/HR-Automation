// Manually mark a checklist task as done for an employee.
// Usage: node src/markTask.js <employeeId> <taskId>
//   e.g. node src/markTask.js EMP001 t15
//
// If the engine is running the change is made THROUGH it (POST /mark-task, same secret as the status
// page): the engine keeps every employee in memory and re-saves it, so editing the state file behind
// its back would be silently overwritten. Only when the engine is not running is the state file edited
// directly — and encrypted state files are decrypted and re-encrypted properly.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const http = require('http');
const { encrypt, decrypt, isEncryptionEnabled } = require('./encryption');

const STATE_DIR = path.join(__dirname, '..');
const [,, employeeId, taskId] = process.argv;

if (!employeeId || !taskId) {
  console.error('Usage: node src/markTask.js <employeeId> <taskId>');
  console.error('  e.g. node src/markTask.js EMP001 t15');
  process.exit(1);
}

const stateFile = path.join(STATE_DIR, `state-${employeeId}.json`);

function markInFile() {
  if (!fs.existsSync(stateFile)) {
    console.error(`No state file found for ${employeeId} (expected state-${employeeId}.json).`);
    process.exit(1);
  }
  let state, wasEncrypted = false;
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    wasEncrypted = raw.includes('"ciphertext"');
    state = wasEncrypted ? JSON.parse(decrypt(raw)) : JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to read state file: ${e.message}`);
    process.exit(1);
  }
  if (!state.checklist) {
    console.error(`State file for ${employeeId} has no checklist.`);
    process.exit(1);
  }
  for (const [phaseKey, phase] of Object.entries(state.checklist)) {
    if (phase.tasks && phase.tasks[taskId] !== undefined) {
      if (phase.tasks[taskId].done) {
        console.log(`Task ${taskId} is already marked done in ${phaseKey}.`);
      } else {
        phase.tasks[taskId].done = true;
        const plaintext = JSON.stringify(state, null, 2);
        // keep the file in the format it was found in
        fs.writeFileSync(stateFile, wasEncrypted ? encrypt(plaintext) : plaintext);
        console.log(`Marked ${taskId} as done for ${employeeId} (phase: ${phaseKey}) in the state file.`);
      }
      return;
    }
  }
  console.error(`Task "${taskId}" not found in checklist for ${employeeId}.`);
  console.error('Run "npm run list-employees" to see the employee ID, then check the checklist structure.');
  process.exit(1);
}

const port = process.env.WEBHOOK_PORT || 3000;
const headers = { 'Content-Length': 0 };
if (process.env.MARK_TASK_SECRET) headers['x-mark-task-secret'] = process.env.MARK_TASK_SECRET;

const req = http.request({
  hostname: 'localhost', port, method: 'POST',
  path: `/mark-task/${encodeURIComponent(employeeId)}/${encodeURIComponent(taskId)}`,
  headers,
}, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log(`[Engine] ${body}`);
      process.exit(0);
    }
    // The engine is running but refused — do NOT edit the file behind its back (it would be overwritten).
    console.error(`[Engine] Refused (${res.statusCode}): ${body}`);
    if (res.statusCode === 401 || res.statusCode === 503) console.error('Set MARK_TASK_SECRET in .env (it must match the engine\'s) and try again.');
    process.exit(1);
  });
});
req.on('error', () => {
  console.log(`[Notice] Engine not running on port ${port} — editing the state file directly.`);
  markInFile();
});
req.end();
