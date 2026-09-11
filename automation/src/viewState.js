// Pretty-print an employee's persisted state file.
// Usage: npm run view-state -- EMP001

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { decrypt } = require('./encryption');

const employeeId = process.argv[2];
if (!employeeId) {
  console.error('Usage: npm run view-state -- <employeeId>');
  console.error('  e.g. npm run view-state -- EMP001');
  process.exit(1);
}

const stateFile = path.join(__dirname, '..', `state-${employeeId}.json`);
if (!fs.existsSync(stateFile)) {
  console.error(`No state file found: state-${employeeId}.json`);
  process.exit(1);
}

try {
  const raw = fs.readFileSync(stateFile, 'utf8');
  const parsed = JSON.parse(raw);
  // Encrypted state files are {iv, ciphertext, tag} — decrypt before reading fields,
  // otherwise every field below silently reads as undefined off the wrong object.
  const state = parsed.ciphertext ? JSON.parse(decrypt(raw)) : parsed;

  // Summary header
  let total = 0, done = 0;
  for (const phase of Object.values(state.checklist || {})) {
    for (const task of Object.values(phase.tasks || {})) {
      total++;
      if (task.done) done++;
    }
  }
  const pct = total > 0 ? Math.round(done / total * 100) : 0;

  console.log(`\n=== State: ${employeeId} ===`);
  console.log(`Progress  : ${done}/${total} tasks (${pct}%)`);
  console.log(`Milestones: ${state.milestonesScheduled ? 'scheduled' : 'not yet scheduled'}`);
  console.log(`Status Sheet ID      : ${state.statusSheetId || '(none)'}`);
  console.log(`Employee Info Sheet ID: ${state.employeeInfoSheetId || '(none)'}`);
  if (state.statusSheetId && state.statusSheetId === state.employeeInfoSheetId) {
    console.log(`  ⚠ statusSheetId and employeeInfoSheetId are THE SAME FILE — this is the bug.`);
  }

  if (state.verificationResults && Object.keys(state.verificationResults).length > 0) {
    console.log('\nVerification Results:');
    for (const [doc, vr] of Object.entries(state.verificationResults)) {
      console.log(`  ${doc}: ${vr.passed ? 'PASS' : 'FAIL'} — ${vr.reason || ''}`);
    }
  }

  if (state.replyTimerExpiry && Object.keys(state.replyTimerExpiry).length > 0) {
    console.log('\nReply Timer Expiry:');
    for (const [key, ts] of Object.entries(state.replyTimerExpiry)) {
      console.log(`  ${key}: ${ts}`);
    }
  }

  console.log('\nFull JSON:');
  console.log(JSON.stringify(state, null, 2));
} catch (e) {
  console.error('Failed to parse state file:', e.message);
  process.exit(1);
}
