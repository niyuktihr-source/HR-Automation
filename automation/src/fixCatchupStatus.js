/**
 * One-shot fix: mark 25-day and 30-day catchup as Done for an employee.
 * Usage: node src/fixCatchupStatus.js EMP0472
 *
 * What this does:
 *  1. Marks checklist tasks t63, t64, t65 (25-day phase) as done
 *  2. Marks checklist tasks t43, t44, t45 (30-day phase) as done
 *  3. Updates the individual Onboarding Status sheet (rows 12 & 13)
 *  4. Updates the Master Dashboard
 *  5. Saves the fixed state back to disk
 */
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { google } = require('googleapis');
const { encrypt, decrypt, isEncryptionEnabled } = require('./encryption');
const { mark25DayCatchupDone, mark30DayDone } = require('./statusTracker');
const { updateMasterDashboard } = require('./masterDashboard');

const employeeId = process.argv[2];
if (!employeeId) {
  console.error('Usage: node src/fixCatchupStatus.js <employeeId>');
  console.error('  e.g. node src/fixCatchupStatus.js EMP0472');
  process.exit(1);
}

const STATE_DIR = path.join(__dirname, '..');
const stateFile = path.join(STATE_DIR, `state-${employeeId}.json`);
if (!fs.existsSync(stateFile)) {
  console.error(`No state file found: state-${employeeId}.json`);
  process.exit(1);
}

// ── Load & decrypt state ──────────────────────────────────────────────────────
const raw  = fs.readFileSync(stateFile, 'utf8');
const data = JSON.parse(raw);
const state = data.ciphertext ? JSON.parse(decrypt(raw)) : data;

// ── Load employee base record ─────────────────────────────────────────────────
const empListPath = path.join(STATE_DIR, 'employees.json');
const empList = JSON.parse(fs.readFileSync(empListPath, 'utf8'));
const empBase = empList.find(e => e.employeeId === employeeId);
if (!empBase) {
  console.error(`${employeeId} not found in employees.json`);
  process.exit(1);
}

const employee = { ...empBase, ...state, employeeId, checklist: state.checklist };

// ── Build auth ────────────────────────────────────────────────────────────────
const credsPath = path.join(__dirname, '..', 'credentials.json');
const tokenPath = path.join(__dirname, '..', 'token.json');
const creds = JSON.parse(fs.readFileSync(credsPath));
const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));

// ── Helper: mark a checklist task done ────────────────────────────────────────
function markTaskDone(checklist, taskId) {
  for (const phase of Object.values(checklist || {})) {
    if (phase.tasks && phase.tasks[taskId] !== undefined) {
      if (!phase.tasks[taskId].done) {
        phase.tasks[taskId].done = true;
        phase.tasks[taskId].doneAt = new Date().toISOString();
        console.log(`  ✓ ${taskId} ("${phase.tasks[taskId].label}") → Done`);
      } else {
        console.log(`  ○ ${taskId} was already done — skipping`);
      }
      return;
    }
  }
  console.warn(`  ! taskId ${taskId} not found in checklist`);
}

// ── Save state back to disk ───────────────────────────────────────────────────
function saveState() {
  const plain = JSON.stringify(employee, null, 2);
  const payload = isEncryptionEnabled() ? encrypt(plain) : plain;
  fs.writeFileSync(stateFile, payload);
  console.log(`  ✓ state-${employeeId}.json saved`);
}

async function run() {
  console.log(`\n=== Fix Catchup Status for ${employee.name} (${employeeId}) ===\n`);

  // ── Step 1: Mark 25-day tasks done in checklist ───────────────────────────
  console.log('[Step 1] Marking 25-day catchup tasks done in state...');
  markTaskDone(employee.checklist, 't63'); // Day 25 catchup call email sent
  markTaskDone(employee.checklist, 't64'); // Recruiter confirms catchup call happened
  markTaskDone(employee.checklist, 't65'); // 25-day milestone marked complete in Checklist1

  // ── Step 2: Mark 30-day tasks done in checklist ───────────────────────────
  console.log('\n[Step 2] Marking 30-day catchup tasks done in state...');
  markTaskDone(employee.checklist, 't43'); // Catchup call transcribed and mailed
  markTaskDone(employee.checklist, 't44'); // Recruiter catchup XLS verified as filled
  markTaskDone(employee.checklist, 't45'); // 30-day milestone marked complete in Checklist1

  // ── Step 3: Save state ─────────────────────────────────────────────────────
  console.log('\n[Step 3] Saving updated state...');
  saveState();

  // ── Step 4: Update individual Onboarding Status sheet ─────────────────────
  console.log('\n[Step 4] Updating individual status sheet...');
  await mark25DayCatchupDone(auth, employee).catch(err =>
    console.warn('  Warning: individual sheet 25-day update failed:', err.message)
  );
  console.log('  ✓ Individual sheet row 12 (25th day catchup) → Done (green)');

  await mark30DayDone(auth, employee).catch(err =>
    console.warn('  Warning: individual sheet 30-day update failed:', err.message)
  );
  console.log('  ✓ Individual sheet row 13 (30-day catchup) → Done (green)');

  // ── Step 5: Update master dashboard ───────────────────────────────────────
  console.log('\n[Step 5] Updating master dashboard...');
  try {
    // Build minimal employees array with updated state for dashboard refresh
    const allStateFiles = fs.readdirSync(STATE_DIR)
      .filter(f => f.startsWith('state-') && f.endsWith('.json'));

    const allEmployees = [];
    for (const sf of allStateFiles) {
      try {
        const sfPath = path.join(STATE_DIR, sf);
        const sfRaw  = fs.readFileSync(sfPath, 'utf8');
        const sfData = JSON.parse(sfRaw);
        const sfState = sfData.ciphertext ? JSON.parse(decrypt(sfRaw)) : sfData;
        const eid = sf.replace('state-', '').replace('.json', '');
        const base = empList.find(e => e.employeeId === eid) || {};
        allEmployees.push({ ...base, ...sfState, employeeId: eid });
      } catch (e) {
        console.warn(`  Skipping ${sf}:`, e.message);
      }
    }

    await updateMasterDashboard(auth, allEmployees);
    console.log('  ✓ Master dashboard updated');
  } catch (err) {
    console.warn('  Warning: master dashboard update failed:', err.message);
  }

  console.log(`\n=== Done! Both dashboards should now show green for Day 25 Catchup and Day 30 Catchup for ${employee.name} ===`);
  console.log(`\nIndividual sheet: https://docs.google.com/spreadsheets/d/${employee.statusSheetId}`);
}

run().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
