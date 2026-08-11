// Express webhook server — receives push notifications from:
//   POST /drive-push       ← Google Drive file change notifications
//   POST /gmail-push       ← Gmail inbox change notifications (via Pub/Sub)
//   POST /employee         ← HR adds a new employee (triggers onboarding)
//   POST /recruiter-form   ← Google Apps Script form submit trigger (recruiter form)
//   GET  /health           ← uptime check

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getChangedFiles, loadPushChannels } = require('./driveWatcher');
const { processGmailPush } = require('./gmailWatcher');
const config = require('./config');

// HTML escape for values embedded in server-rendered pages
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Input validation helpers ─────────────────────────────────────────────────
// employeeId: alphanumeric + hyphen/underscore, 1-32 chars
function isValidEmployeeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(id);
}
// taskId: t followed by 1-3 digits
function isValidTaskId(id) {
  return typeof id === 'string' && /^t\d{1,3}$/.test(id);
}
// Basic email sanity check
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]{1,64}@[^\s@]{1,253}$/.test(email);
}
// Timing-safe secret comparison to prevent timing attacks
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  const ba = Buffer.from(a.padEnd(len));
  const bb = Buffer.from(b.padEnd(len));
  return crypto.timingSafeEqual(ba, bb) && a.length === b.length;
}

// ─── Per-endpoint in-memory rate limiter (no extra dep needed) ────────────────
// Tracks request counts per IP in a rolling 60-second window.
function makeRateLimiter(maxPerMinute) {
  const counts = new Map(); // ip → { count, windowStart }
  return function rateLimiter(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = counts.get(ip);
    if (!entry || now - entry.windowStart > 60_000) {
      counts.set(ip, { count: 1, windowStart: now });
      return next();
    }
    entry.count++;
    if (entry.count > maxPerMinute) {
      return res.status(429).json({ error: 'Too many requests — try again in a minute.' });
    }
    next();
  };
}

const employeeCreateLimiter = makeRateLimiter(10);   // 10 new employees/min per IP
const markTaskLimiter       = makeRateLimiter(30);   // 30 mark-task calls/min per IP
const statusLimiter         = makeRateLimiter(60);   // 60 page views/min per IP

const SEEN_FILES_PATH = path.join(__dirname, '..', 'seen-files.json');

// employeeRegistry and handleNewFile are injected by index.js after boot
let _auth = null;
let _employeeRegistry = {};     // { [employeeId]: employee }
let _handleNewFile = null;      // async (auth, employee, file) => void
let _handleReply = null;        // async (classified, rawMessage) => void
let _onNewEmployee = null;      // async (employeeData) => void

let _cancelAllJobs = null; // injected by index.js
let _saveState = null;     // injected by index.js
let _stopEmployeeOnboarding = null; // injected by index.js

function init({ auth, employeeRegistry, handleNewFile, handleReply, onNewEmployee, cancelAllJobs, saveState, stopEmployeeOnboarding }) {
  _auth = auth;
  _employeeRegistry = employeeRegistry;
  _handleNewFile = handleNewFile;
  _handleReply = handleReply;
  _onNewEmployee = onNewEmployee;
  _cancelAllJobs = cancelAllJobs || null;
  _saveState = saveState || null;
  _stopEmployeeOnboarding = stopEmployeeOnboarding || null;
}

// Track last-seen file IDs per employee folder — persisted to seen-files.json
// so restarting the engine doesn't re-process already-handled files.
function loadSeenFiles() {
  if (fs.existsSync(SEEN_FILES_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SEEN_FILES_PATH, 'utf8'));
      // Convert plain arrays back to Sets
      const result = {};
      for (const [empId, ids] of Object.entries(raw)) {
        result[empId] = new Set(ids);
      }
      return result;
    } catch (e) {
      console.warn('[Webhook] Could not load seen-files.json:', e.message);
    }
  }
  return {};
}

function saveSeenFiles(seenFileIds) {
  try {
    const serialisable = {};
    for (const [empId, set] of Object.entries(seenFileIds)) {
      serialisable[empId] = [...set];
    }
    fs.writeFileSync(SEEN_FILES_PATH, JSON.stringify(serialisable, null, 2));
  } catch (e) {
    console.warn('[Webhook] Could not save seen-files.json:', e.message);
  }
}

// Prune seen file IDs that were first observed more than 30 days ago.
// Since we only store IDs (not timestamps), we keep a parallel age map in
// seen-files-meta.json: { [empId]: { [fileId]: isoTimestamp } }
const SEEN_META_PATH = path.join(__dirname, '..', 'seen-files-meta.json');
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function loadSeenMeta() {
  if (fs.existsSync(SEEN_META_PATH)) {
    try { return JSON.parse(fs.readFileSync(SEEN_META_PATH, 'utf8')); } catch { /* ignore */ }
  }
  return {};
}

function pruneSeenFiles(seenFileIds) {
  const meta = loadSeenMeta();
  const now = Date.now();
  let pruned = 0;

  for (const [empId, set] of Object.entries(seenFileIds)) {
    if (!meta[empId]) meta[empId] = {};
    // Stamp any new IDs
    for (const id of set) {
      if (!meta[empId][id]) meta[empId][id] = new Date().toISOString();
    }
    // Remove IDs older than TTL
    for (const [id, ts] of Object.entries(meta[empId])) {
      if (now - new Date(ts).getTime() > TTL_MS) {
        set.delete(id);
        delete meta[empId][id];
        pruned++;
      }
    }
  }

  if (pruned > 0) {
    console.log(`[Webhook] Pruned ${pruned} expired file ID(s) from seen-files cache`);
    saveSeenFiles(seenFileIds);
  }

  try {
    fs.writeFileSync(SEEN_META_PATH, JSON.stringify(meta, null, 2));
  } catch (e) {
    console.warn('[Webhook] Could not save seen-files-meta.json:', e.message);
  }
}

const seenFileIds = loadSeenFiles();
// Prune on load, then every 24 hours
pruneSeenFiles(seenFileIds);
setInterval(() => pruneSeenFiles(seenFileIds), 24 * 60 * 60 * 1000);

const app = express();

// ─── Security headers (no helmet dep — set manually) ──────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Limit request body to 1 MB to prevent memory exhaustion
app.use(express.json({ limit: '1mb' }));
// Gmail Pub/Sub sends raw body — parse it too (same 1 MB cap)
app.use(express.raw({ type: 'application/json', limit: '1mb' }));

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/health', statusLimiter, (_req, res) => {
  const employees = Object.values(_employeeRegistry).map(emp => {
    // Count done tasks
    let totalTasks = 0, doneTasks = 0;
    for (const phase of Object.values(emp.checklist || {})) {
      if (phase.tasks) {
        for (const task of Object.values(phase.tasks)) {
          totalTasks++;
          if (task.done) doneTasks++;
        }
      }
    }
    // Find current phase (first phase with incomplete tasks)
    let currentPhase = 'Complete';
    for (const [key, phase] of Object.entries(emp.checklist || {})) {
      if (phase.tasks && Object.values(phase.tasks).some(t => !t.done)) {
        currentPhase = phase.label;
        break;
      }
    }
    return {
      employeeId: emp.employeeId,
      name: emp.name,
      doj: emp.doj,
      currentPhase,
      progress: `${doneTasks}/${totalTasks} tasks`,
      milestonesScheduled: emp.milestonesScheduled || false,
      activeTimers: Object.keys(emp.replyTimers || {}).length + Object.keys(emp.noResponseTimers || {}).length,
    };
  });

  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()) + 's',
    employees,
  });
});

// ─── Employees list — internal use only, no PII emails exposed ─────────────────
app.get('/employees', statusLimiter, (_req, res) => {
  const list = Object.values(_employeeRegistry).map(emp => ({
    employeeId: emp.employeeId,
    name: emp.name,
    doj: emp.doj,
    milestonesScheduled: emp.milestonesScheduled || false,
  }));
  res.json({ count: list.length, employees: list });
});

// ─── Drive push handler ────────────────────────────────────────────────────────
// Google sends a POST with headers X-Goog-Channel-Token (= employeeId) and
// X-Goog-Resource-State ('sync' on register, 'update'/'add' on change).
app.post('/drive-push', async (req, res) => {
  // Always respond 200 immediately — Google retries on non-2xx
  res.sendStatus(200);

  // Verify channel token matches a known employee — reject spoofed pushes.
  // Subfolder channels use tokens like "EMP001_Aadhaar" — strip the suffix to get the base ID.
  const rawToken = req.headers['x-goog-channel-token'];
  const employeeId = rawToken ? rawToken.split('_')[0] : null;
  if (!employeeId || !isValidEmployeeId(employeeId) || !_employeeRegistry[employeeId]) {
    console.warn(`[Webhook] Drive push rejected — unknown or invalid channel token: ${rawToken}`);
    return;
  }

  const state = req.headers['x-goog-resource-state'];
  // 'sync' is the handshake ping — nothing to do
  if (state === 'sync') {
    console.log(`[Webhook] Drive sync handshake for ${employeeId}`);
    return;
  }

  const employee = _employeeRegistry[employeeId];
  if (!seenFileIds[employeeId]) seenFileIds[employeeId] = new Set();

  try {
    // Fetch files modified within the configured lookback window (push doesn't tell us which file)
    const sinceMs = Date.now() - config.driveChangeLookbackMs;
    const files = await getChangedFiles(_auth, employee.driveFolderId, sinceMs);

    for (const file of files) {
      if (!seenFileIds[employeeId].has(file.id)) {
        seenFileIds[employeeId].add(file.id);
        saveSeenFiles(seenFileIds);
        console.log(`[Webhook] Drive push → new file: ${file.name} for ${employee.name}`);
        const ok = await _handleNewFile(_auth, employee, file).catch(err => {
          console.error(`[Webhook] handleNewFile error:`, err.message);
          return false;
        });
        // On transient error (false return), remove from cache so the file is retried next push
        if (ok === false) {
          seenFileIds[employeeId].delete(file.id);
          saveSeenFiles(seenFileIds);
          console.log(`[Webhook] File ${file.name} removed from seen-cache — will retry on next push`);
        }
      }
    }
  } catch (err) {
    console.error('[Webhook] Drive push processing error:', err.message);
  }
});

// ─── Gmail push handler ────────────────────────────────────────────────────────
// Pub/Sub posts a JSON envelope: { message: { data: <base64>, messageId, ... }, subscription }
app.post('/gmail-push', async (req, res) => {
  res.sendStatus(200);

  let body = req.body;
  // express.raw gives a Buffer if content-type is application/json
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString()); } catch { return; }
  }

  if (!body || !body.message) {
    console.warn('[Webhook] Gmail push missing message body');
    return;
  }

  // Verify the Pub/Sub subscription name matches our configured subscription,
  // preventing spoofed pushes from other projects or unknown subscriptions.
  const expectedSub = process.env.PUBSUB_SUBSCRIPTION_NAME;
  if (expectedSub && body.subscription && body.subscription !== expectedSub) {
    console.warn(`[Webhook] Gmail push rejected — unexpected subscription: ${body.subscription}`);
    return;
  }

  try {
    await processGmailPush(_auth, body, async (classified, rawMsg) => {
      if (_handleReply) await _handleReply(classified, rawMsg);
    });
  } catch (err) {
    console.error('[Webhook] Gmail push processing error:', err.message);
  }
});

// ─── Add new employee endpoint ─────────────────────────────────────────────────
// HR (or a Google Sheet trigger) POSTs employee details here to start onboarding.
// Body: { employeeId, name, personalEmail, doj, driveFolderId,
//         contacts: { recruiterEmail, managerEmail, itEmail } }
app.post('/employee', employeeCreateLimiter, async (req, res) => {
  const required = ['employeeId', 'name', 'personalEmail', 'doj', 'driveFolderId'];
  const missing = required.filter(f => !req.body[f]);
  if (missing.length) {
    return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
  }

  // Strict format validation
  if (!isValidEmployeeId(req.body.employeeId)) {
    return res.status(400).json({ error: 'Invalid employeeId — use only letters, digits, hyphens, underscores (max 32 chars).' });
  }
  if (typeof req.body.name !== 'string' || req.body.name.trim().length < 1 || req.body.name.length > 120) {
    return res.status(400).json({ error: 'Invalid name — must be 1–120 characters.' });
  }
  if (!isValidEmail(req.body.personalEmail)) {
    return res.status(400).json({ error: 'Invalid personalEmail format.' });
  }
  if (!req.body.doj || isNaN(new Date(req.body.doj).getTime())) {
    return res.status(400).json({ error: 'Invalid doj — use YYYY-MM-DD format.' });
  }
  if (typeof req.body.driveFolderId !== 'string' || !/^[A-Za-z0-9_-]{10,60}$/.test(req.body.driveFolderId)) {
    return res.status(400).json({ error: 'Invalid driveFolderId format.' });
  }

  // Validate contacts sub-object — all three are required for escalation emails to reach the right people
  const contacts = req.body.contacts || {};
  const missingContacts = ['recruiterEmail', 'managerEmail', 'itEmail'].filter(f => !contacts[f]);
  if (missingContacts.length) {
    return res.status(400).json({
      error: `Missing contacts fields: ${missingContacts.map(f => `contacts.${f}`).join(', ')}`,
    });
  }
  for (const field of ['recruiterEmail', 'managerEmail', 'itEmail']) {
    if (!isValidEmail(contacts[field])) {
      return res.status(400).json({ error: `Invalid email format for contacts.${field}` });
    }
  }

  const { employeeId } = req.body;
  if (_employeeRegistry[employeeId]) {
    return res.status(409).json({ error: `Employee ${employeeId} already registered` });
  }

  try {
    if (_onNewEmployee) await _onNewEmployee(req.body);
    res.status(201).json({ message: `Onboarding started for ${req.body.name}` });
  } catch (err) {
    console.error('[Webhook] /employee error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Recruiter Google Form webhook ────────────────────────────────────────────
// Google Apps Script POSTs here when a recruiter submits the New Joinee form.
// Maps form fields → /employee payload and triggers onboarding automatically.
// Body fields (from createRecruiterForm.gs onRecruiterFormSubmit):
//   name, employeeId, personalEmail, doj, isFresher, managerName, managerEmail,
//   itEmail, officeLocation, assetRequired, designation, team, driveFolderId,
//   recruiterEmail, notes
app.post('/recruiter-form', employeeCreateLimiter, async (req, res) => {
  const {
    name, employeeId, personalEmail, phoneNumber, doj, isFresher,
    managerName, managerEmail, itEmail, hrEmail,
    officeLocation, assetRequired, designation,
    driveFolderId, recruiterEmail,
  } = req.body || {};

  // Required field validation — driveFolderId is optional; falls back to ONBOARDING_ROOT_FOLDER_ID from .env
  const required = { name, employeeId, personalEmail, doj, managerEmail, itEmail };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
  }
  if (!isValidEmployeeId(employeeId)) {
    return res.status(400).json({ error: 'Invalid employeeId — use only letters, digits, hyphens, underscores (max 32 chars).' });
  }
  if (!isValidEmail(personalEmail))  return res.status(400).json({ error: 'Invalid personalEmail format.' });
  if (!isValidEmail(managerEmail))   return res.status(400).json({ error: 'Invalid managerEmail format.' });
  if (!isValidEmail(itEmail))        return res.status(400).json({ error: 'Invalid itEmail format.' });
  if (hrEmail && !isValidEmail(hrEmail)) {
    return res.status(400).json({ error: 'Invalid hrEmail format.' });
  }
  if (recruiterEmail && !isValidEmail(recruiterEmail)) {
    return res.status(400).json({ error: 'Invalid recruiterEmail format.' });
  }
  if (!doj || isNaN(new Date(doj).getTime())) {
    return res.status(400).json({ error: 'Invalid doj — use YYYY-MM-DD format.' });
  }

  // Resolve Drive folder ID — form value takes priority, falls back to env
  const resolvedFolderId = (driveFolderId && driveFolderId.trim()) || process.env.ONBOARDING_ROOT_FOLDER_ID;
  if (!resolvedFolderId || !/^[A-Za-z0-9_-]{10,60}$/.test(resolvedFolderId)) {
    return res.status(400).json({ error: 'No valid Drive folder ID — provide one in the form or set ONBOARDING_ROOT_FOLDER_ID in .env.' });
  }

  if (_employeeRegistry[employeeId]) {
    return res.status(409).json({ error: `Employee ${employeeId} is already registered.` });
  }

  // Build the employee object the same way /employee does
  const employeeData = {
    employeeId,
    name: name.trim(),
    personalEmail,
    phoneNumber: phoneNumber || '',
    doj,
    driveFolderId: resolvedFolderId,
    designation: designation || '',
    officeLocation: officeLocation || '',
    isFresher: isFresher === true || isFresher === 'true',
    assetRequired: assetRequired || 'Unaware — To be confirmed',
    contacts: {
      recruiterEmail: recruiterEmail || process.env.HR_EMAIL,
      managerName: managerName || '',
      managerEmail,
      itEmail,
      hrEmail: hrEmail || process.env.HR_EMAIL,
    },
  };

  console.log(`[Webhook] /recruiter-form — received submission for ${name} (${employeeId}), DOJ: ${doj}, assetRequired: ${JSON.stringify(assetRequired)} → stored as: ${JSON.stringify(assetRequired || 'Unaware — To be confirmed')}`);

  try {
    if (_onNewEmployee) await _onNewEmployee(employeeData);
    res.status(201).json({ message: `Onboarding started for ${name}` });
  } catch (err) {
    console.error('[Webhook] /recruiter-form error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Pre-onboarding personal details from form submit ────────────────────────
// Google Apps Script POSTs here when the new joinee submits their pre-onboarding form.
// Body: { employeeId, respondentEmail, personalDetails, uploadedFiles? }
// uploadedFiles: array of { fileId, subfolder } — engine moves them and verifies
app.post('/preonboarding-details', async (req, res) => {
  const { employeeId, respondentEmail, personalDetails, uploadedFiles } = req.body || {};
  if (!employeeId || !personalDetails) {
    return res.status(400).json({ error: 'Missing employeeId or personalDetails' });
  }
  const emp = _employeeRegistry[employeeId];
  if (!emp) {
    return res.status(404).json({ error: `Employee ${employeeId} not found in registry` });
  }

  // Validate that the form was submitted by the correct joinee
  if (respondentEmail && emp.personalEmail) {
    if (respondentEmail.toLowerCase() !== emp.personalEmail.toLowerCase()) {
      console.warn(`[Webhook] /preonboarding-details — email mismatch for ${employeeId}: expected ${emp.personalEmail}, got ${respondentEmail}`);
      const { sendEmail } = require('./emailSender');
      const hrEmail = (emp.contacts && emp.contacts.hrEmail) || process.env.HR_EMAIL;
      sendEmail({
        to: hrEmail,
        subject: `ALERT — Unauthorized Pre-Onboarding Form Submission for ${emp.name} (${employeeId})`,
        html: `<p>Hi,</p>
          <p>Someone submitted the pre-onboarding form for <strong>${emp.name}</strong> (${employeeId}) using the wrong email address.</p>
          <p><strong>Expected:</strong> ${emp.personalEmail}</p>
          <p><strong>Submitted by:</strong> ${respondentEmail}</p>
          <p>The submission has been rejected. Please follow up if needed.</p>
          <p>Regards,<br/>${process.env.COMPANY_NAME} HR Automation</p>`,
      }).catch(() => {});
      return res.status(403).json({ error: 'Unauthorized — email does not match registered joinee' });
    }
  }

  emp.personalDetails = Object.assign(emp.personalDetails || {}, personalDetails);
  if (_saveState) _saveState(employeeId, emp);
  console.log(`[Webhook] /preonboarding-details — saved personal details for ${employeeId}`);
  res.status(200).json({ message: 'Personal details saved' });

  // Move uploaded files to correct subfolders and trigger verification
  if (!_handleNewFile || !_auth) return;
  const { google } = require('googleapis');
  const drive = google.drive({ version: 'v3', auth: _auth });

  const processFileList = async (files) => {
    for (const { fileId, subfolder } of files) {
      if (!fileId) continue;
      try {
        const targetFolderRes = await drive.files.list({
          q: `name='${subfolder}' and '${emp.driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id)',
        });
        const targetFolderId = targetFolderRes.data.files && targetFolderRes.data.files[0] && targetFolderRes.data.files[0].id;
        if (!targetFolderId) {
          console.warn(`[Webhook] Subfolder '${subfolder}' not found in ${emp.name}'s Drive folder — skipping ${fileId}`);
          continue;
        }
        const fileMeta = await drive.files.get({ fileId, fields: 'parents,name,mimeType' });
        const oldParents = (fileMeta.data.parents || []).join(',');
        await drive.files.update({ fileId, addParents: targetFolderId, removeParents: oldParents, fields: 'id, parents' });
        console.log(`[Webhook] Moved ${fileMeta.data.name} → ${subfolder} for ${emp.name}`);
        const file = { id: fileId, name: fileMeta.data.name, mimeType: fileMeta.data.mimeType };
        await _handleNewFile(_auth, emp, file, subfolder).catch(err =>
          console.error(`[Webhook] handleNewFile error for ${fileMeta.data.name}: ${err.message}`)
        );
      } catch (err) {
        console.error(`[Webhook] Error processing file ${fileId} for ${emp.name}: ${err.message}`);
      }
    }
  };

  if (Array.isArray(uploadedFiles) && uploadedFiles.length > 0) {
    // GAS sent file IDs — move and verify each one
    await processFileList(uploadedFiles);
  } else {
    // Fallback: GAS didn't send file IDs (old trigger / no trigger set up)
    // Scan the entire employee Drive folder tree for any unprocessed files
    console.log(`[Webhook] No uploadedFiles from GAS for ${emp.name} — scanning Drive folder as fallback`);
    try {
      const res = await drive.files.list({
        q: `'${emp.driveFolderId}' in ancestors and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
        fields: 'files(id, name, mimeType, parents)',
      });
      const allFiles = res.data.files || [];
      const processed = new Set(emp.processedFileIds || []);

      // Build subfolder name→id map for this employee
      const subfolderRes = await drive.files.list({
        q: `'${emp.driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name)',
      });
      const subfolderMap = {};
      for (const sf of (subfolderRes.data.files || [])) subfolderMap[sf.id] = sf.name;

      for (const f of allFiles) {
        if (processed.has(f.id)) continue;
        // Determine subfolder from parent
        const parentId = f.parents && f.parents[0];
        const subfolderName = subfolderMap[parentId] || null;
        await _handleNewFile(_auth, emp, { id: f.id, name: f.name, mimeType: f.mimeType }, subfolderName).catch(err =>
          console.error(`[Webhook] Fallback handleNewFile error for ${f.name}: ${err.message}`)
        );
      }
    } catch (err) {
      console.error(`[Webhook] Fallback Drive scan failed for ${emp.name}: ${err.message}`);
    }
  }
});

// ─── Remove employee from running engine ───────────────────────────────────────
// DELETE /employee/:id — cancels cron jobs + reply timers, removes from registry.
// Complements the remove-employee CLI script (which handles file/Drive cleanup).
app.delete('/employee/:id', (req, res) => {
  const { id } = req.params;
  if (!isValidEmployeeId(id)) return res.status(400).json({ error: 'Invalid employee ID format.' });
  const emp = _employeeRegistry[id];
  if (!emp) {
    return res.status(404).json({ error: `Employee ${id} not found in registry.` });
  }

  // Stop all reply timers
  if (emp.replyTimers) {
    for (const timer of Object.values(emp.replyTimers)) {
      if (timer && typeof timer.stop === 'function') timer.stop();
    }
  }
  // Stop all no-response timers
  if (emp.noResponseTimers) {
    for (const timer of Object.values(emp.noResponseTimers)) {
      if (timer && typeof timer.stop === 'function') timer.stop();
    }
  }
  // Cancel all cron milestone jobs
  if (_cancelAllJobs) _cancelAllJobs(id);

  // Persist final state (timers cleared) before dropping from registry
  try {
    const { encrypt, isEncryptionEnabled } = require('./encryption');
    const fs = require('fs');
    const path = require('path');
    const statePath = path.join(__dirname, '..', `state-${id}.json`);
    if (fs.existsSync(statePath)) {
      const plaintext = JSON.stringify({
        checklist: emp.checklist,
        milestonesScheduled: emp.milestonesScheduled || false,
        statusSheetId: emp.statusSheetId || null,
        verificationResults: emp.verificationResults || {},
        replyTimerExpiry: {},
      }, null, 2);
      const payload = isEncryptionEnabled() ? encrypt(plaintext) : plaintext;
      fs.writeFileSync(statePath, payload);
    }
  } catch (err) {
    console.warn(`[Webhook] Could not persist final state for ${id}: ${err.message}`);
  }

  delete _employeeRegistry[id];
  console.log(`[Webhook] Employee ${id} (${emp.name}) removed from running engine.`);
  res.json({ ok: true, message: `${emp.name} (${id}) removed. Run remove-employee CLI to clean up files.` });
});

// ─── Employee status page ──────────────────────────────────────────────────────
app.get('/status/:employeeId', statusLimiter, (req, res) => {
  if (!isValidEmployeeId(req.params.employeeId)) return res.status(400).send('<h2>Invalid employee ID</h2>');
  const { readLog } = require('./activityLog');
  const emp = _employeeRegistry[req.params.employeeId];
  if (!emp) return res.status(404).send('<h2>Employee not found</h2>');

  const config = require('./config');
  const now = Date.now();
  const STUCK_MS = config.stuckTaskThresholdHours * 60 * 60 * 1000;

  // Build task-level metadata: stuckAt timestamps from activity log
  // Map event "task_started:<taskId>" → timestamp
  const stuckMap = {};
  const allEvents = readLog(emp.employeeId);
  for (const ev of allEvents) {
    if (ev.event && ev.event.startsWith('task_started:')) {
      const tid = ev.event.split(':')[1];
      stuckMap[tid] = new Date(ev.ts).getTime();
    }
  }

  // Check if t16 (official email created) is done
  let t16Done = false;
  for (const phase of Object.values(emp.checklist || {})) {
    if (phase.tasks && phase.tasks['t16'] && phase.tasks['t16'].done) { t16Done = true; break; }
  }

  const verResults = emp.verificationResults || {};

  // Count tasks
  let total = 0, done = 0;
  const phases = [];
  for (const [key, phase] of Object.entries(emp.checklist || {})) {
    const taskEntries = Object.entries(phase.tasks || {});
    const tasks = taskEntries.map(([tid, t]) => ({ ...t, _id: tid }));
    const phaseDone = tasks.filter(t => t.done).length;
    total += tasks.length;
    done += phaseDone;
    phases.push({ label: phase.label, tasks, phaseDone, phaseTotal: tasks.length });
  }
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  // Activity log (last 20 events)
  const events = allEvents.slice(-20).reverse();

  const markTaskEnabled = !!process.env.MARK_TASK_SECRET;

  const phaseRows = phases.map(p => {
    const taskRows = p.tasks.map(t => {
      const isStuck = !t.done && stuckMap[t._id] && (now - stuckMap[t._id]) > STUCK_MS;
      const stuckBadge = isStuck ? ' <span style="background:#fff3cd;color:#856404;font-size:11px;padding:1px 6px;border-radius:3px;border:1px solid #ffc107;">stuck &gt;48h</span>' : '';
      const icon = t.done ? '&#10003;' : (isStuck ? '&#9888;' : '&#9633;');
      const iconColor = t.done ? '#2e7d32' : (isStuck ? '#856404' : '#aaa');

      // Verification result for this task (if any doc is linked to this task)
      let verHtml = '';
      for (const [docKey, vr] of Object.entries(verResults)) {
        if (vr && vr.taskId === t._id) {
          const ok = vr.passed;
          verHtml = `<div style="font-size:12px;margin-top:2px;padding:2px 8px;background:${ok ? '#e8f5e9' : '#fce4ec'};border-radius:3px;color:${ok ? '#2e7d32' : '#c62828'};">
            ${ok ? 'PASS' : 'FAIL'}: ${vr.reason || ''}
          </div>`;
        }
      }

      // Mark-done button for incomplete tasks (only when MARK_TASK_SECRET is configured)
      // Secret is sent as a header by JS, never embedded in page HTML
      const markBtn = (!t.done && markTaskEnabled)
        ? `<button type="button" onclick="markDone('${emp.employeeId}','${t._id}')" style="font-size:11px;padding:2px 8px;background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7;border-radius:3px;cursor:pointer;margin-left:8px;">Mark done</button>`
        : '';

      return `<tr>
        <td style="padding:4px 12px;vertical-align:top;color:${iconColor};font-size:16px;">${icon}</td>
        <td style="padding:4px 8px;color:${t.done ? '#2e7d32' : '#555'}">${t.label}${stuckBadge}${verHtml}${markBtn}</td>
      </tr>`;
    }).join('');

    return `
      <details style="margin-bottom:12px;">
        <summary style="cursor:pointer;font-weight:600;padding:8px;background:#f5f5f5;border-radius:4px;">
          ${p.label} &nbsp;<span style="color:#888;font-weight:400;">(${p.phaseDone}/${p.phaseTotal})</span>
        </summary>
        <table style="width:100%;border-collapse:collapse;margin-top:4px;">${taskRows}</table>
      </details>`;
  }).join('');

  const eventRows = events.length
    ? events.map(e => `<tr><td style="padding:4px 8px;color:#888;white-space:nowrap;">${e.ts.replace('T', ' ').replace('Z', '')}</td><td style="padding:4px 12px;font-family:monospace;">${e.event}</td><td style="padding:4px 8px;color:#555;">${e.detail || ''}</td></tr>`).join('')
    : '<tr><td colspan="3" style="padding:8px;color:#888;">No activity logged yet</td></tr>';

  const officialEmailBadge = t16Done && emp.officialEmail
    ? `&nbsp;|&nbsp; Official email: <strong>${emp.officialEmail}</strong>`
    : '';
  const isStopped = emp.status === 'stopped' || emp.isStopped;
  const stoppedBanner = isStopped
    ? `<div style="background:#ffebee;color:#c62828;border:1px solid #ef9a9a;padding:12px 16px;border-radius:6px;margin-bottom:20px;font-weight:bold;">
        ⛔ ONBOARDING STOPPED (Candidate Didn't Join) — ${esc(emp.statusReason || 'All automated notifications and cron jobs cancelled')}
       </div>`
    : '';

  const stopBtn = !isStopped
    ? `<button type="button" onclick="stopOnboarding('${emp.employeeId}')" style="float:right;background:#d32f2f;color:#fff;border:none;padding:8px 14px;border-radius:4px;cursor:pointer;font-weight:bold;font-size:13px;margin-top:-6px;">⛔ Stop Onboarding (Candidate Didn't Join)</button>`
    : '';

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Onboarding Status — ${emp.name}</title>
  <style>
    body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#333;}
    h1{margin-bottom:4px;}
    .meta{color:#666;margin-bottom:24px;font-size:14px;}
    .progress-bar{background:#e0e0e0;border-radius:8px;height:20px;margin-bottom:8px;}
    .progress-fill{background:${isStopped ? '#9e9e9e' : '#2e7d32'};border-radius:8px;height:100%;transition:width .3s;}
    .pct{font-size:13px;color:#555;margin-bottom:24px;}
    table{width:100%;}
    h2{margin-top:32px;font-size:18px;border-bottom:1px solid #eee;padding-bottom:6px;}
    .back{font-size:13px;margin-bottom:16px;}
  </style>
</head>
<body>
  <div class="back"><a href="/status" style="color:#1a73e8;">&larr; All Employees</a></div>
  ${stoppedBanner}
  ${stopBtn}
  <h1>${esc(emp.name)}</h1>
  <div class="meta">ID: ${esc(emp.employeeId)} &nbsp;|&nbsp; DOJ: ${esc(emp.doj)} &nbsp;|&nbsp; ${esc(emp.personalEmail)}${officialEmailBadge}</div>
  <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
  <div class="pct">${pct}% complete &mdash; ${done} of ${total} tasks done ${isStopped ? '(STOPPED)' : ''}</div>
  <h2>Checklist</h2>
  ${phaseRows}
  <h2>Activity Log</h2>
  <table style="border-collapse:collapse;">
    <thead><tr style="background:#f5f5f5;"><th style="padding:6px 8px;text-align:left;">Time (UTC)</th><th style="padding:6px 12px;text-align:left;">Event</th><th style="padding:6px 8px;text-align:left;">Detail</th></tr></thead>
    <tbody>${eventRows}</tbody>
  </table>
  <script>
    function markDone(empId, taskId) {
      const secret = prompt('Enter admin secret:');
      if (!secret) return;
      fetch('/mark-task/' + empId + '/' + taskId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mark-task-secret': secret },
        body: JSON.stringify({})
      }).then(r => r.json()).then(d => { alert(d.message || d.error); location.reload(); })
        .catch(() => alert('Request failed'));
    }
    function stopOnboarding(empId) {
      const reason = prompt('Reason for stopping onboarding (e.g. Candidate did not join / Stop case requested):', 'Candidate did not join');
      if (reason === null) return;
      if (!confirm('Are you sure you want to stop onboarding and cancel ALL automated emails and notifications for this candidate?')) return;
      fetch('/employee/' + empId + '/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason })
      }).then(r => r.json()).then(d => { alert(d.message || d.error); location.reload(); })
        .catch(e => alert('Error: ' + e.message));
    }
  </script>
</body>
</html>`);
});

// ─── Stop onboarding endpoint ────────────────────────────────────────────────
// POST /employee/:employeeId/stop
app.post('/employee/:employeeId/stop', async (req, res) => {
  const { employeeId } = req.params;
  if (!isValidEmployeeId(employeeId)) {
    return res.status(400).json({ error: 'Invalid employeeId format.' });
  }
  const emp = _employeeRegistry[employeeId];
  if (!emp) return res.status(404).json({ error: `Employee ${employeeId} not found.` });

  const reason = (req.body && req.body.reason) || 'Candidate did not join / Stop case requested';
  try {
    if (_stopEmployeeOnboarding) {
      await _stopEmployeeOnboarding(emp, reason);
    } else {
      emp.status = 'stopped';
      emp.statusReason = reason;
      emp.isStopped = true;
      if (_cancelAllJobs) _cancelAllJobs(employeeId);
      if (_saveState) _saveState(employeeId, emp);
    }
    res.json({ ok: true, message: `Onboarding stopped and all notifications cancelled for ${emp.name}` });
  } catch (err) {
    console.error(`[Webhook] Error stopping onboarding for ${employeeId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── All-employees dashboard ───────────────────────────────────────────────────
app.get('/status', statusLimiter, (_req, res) => {
  const employees = Object.values(_employeeRegistry);
  const now = Date.now();

  // The 16 milestone labels shown on the status sheet
  const MILESTONE_LABELS = [
    'Pre-onboarding initiated',
    'Documents received',
    'Documents not ok — re-upload requested',
    'Documents verified OK',
    'Official email & greythr login confirmed',
    'Manager confirmed seat and work location',
    'IT team confirmed assets',
    'BGV initiated and completed',
    'HR induction scheduled',
    'Project intro meeting scheduled',
    'Day of Joining — onboarding complete',
    '25th day catchup call completed',
    '30-day catchup completed',
    '60-day review completed',
    '90-day review completed',
    'Pre-probation verification completed',
  ];

  // Map milestone label → task IDs that mark it done
  const MILESTONE_TASK_MAP = {
    'Pre-onboarding initiated':               ['t4'],
    'Documents received':                     ['t5'],
    'Documents not ok — re-upload requested': ['t10'],
    'Documents verified OK':                  ['t9'],
    'Official email & greythr login confirmed':['t15'],
    'Manager confirmed seat and work location':['t18'],
    'IT team confirmed assets':               ['t21'],
    'BGV initiated and completed':            ['t25'],
    'HR induction scheduled':                 ['t27'],
    'Project intro meeting scheduled':        ['t29'],
    'Day of Joining — onboarding complete':   ['t42'],
    '25th day catchup call completed':        ['t63'],
    '30-day catchup completed':               ['t43'],
    '60-day review completed':                ['t46'],
    '90-day review completed':                ['t49'],
    'Pre-probation verification completed':   ['t52'],
  };

  function isTaskDoneInChecklist(checklist, taskId) {
    for (const phase of Object.values(checklist || {})) {
      if (phase.tasks && phase.tasks[taskId]) return phase.tasks[taskId].done;
    }
    return false;
  }

  function getPendingActions(emp) {
    const pending = [];
    const cl = emp.checklist || {};
    const vr = emp.verificationResults || {};
    const dojDate = new Date(emp.doj);
    const daysUntilDoj = Math.ceil((dojDate - now) / (1000 * 60 * 60 * 24));
    const daysSinceDoj = Math.floor((now - dojDate) / (1000 * 60 * 60 * 24));

    if (!isTaskDoneInChecklist(cl, 't5'))  pending.push({ label: 'Awaiting document upload', urgency: daysUntilDoj < 3 ? 'high' : 'medium' });
    if (!isTaskDoneInChecklist(cl, 't9') && isTaskDoneInChecklist(cl, 't5'))  pending.push({ label: 'Documents pending verification', urgency: 'medium' });
    if (!isTaskDoneInChecklist(cl, 't15') && isTaskDoneInChecklist(cl, 't9')) pending.push({ label: 'Official email not yet confirmed', urgency: daysUntilDoj < 5 ? 'high' : 'medium' });
    if (!isTaskDoneInChecklist(cl, 't18') && isTaskDoneInChecklist(cl, 't9')) pending.push({ label: 'Manager allocation pending', urgency: daysUntilDoj < 5 ? 'high' : 'medium' });
    if (!isTaskDoneInChecklist(cl, 't21') && isTaskDoneInChecklist(cl, 't18')) pending.push({ label: 'IT assets not confirmed', urgency: daysUntilDoj < 3 ? 'high' : 'low' });
    if (!isTaskDoneInChecklist(cl, 't25') && isTaskDoneInChecklist(cl, 't9')) pending.push({ label: 'BGV not completed', urgency: 'medium' });
    if (!isTaskDoneInChecklist(cl, 't42') && daysSinceDoj >= 0 && daysSinceDoj < 7) pending.push({ label: 'DOJ not marked complete', urgency: 'high' });
    if (!isTaskDoneInChecklist(cl, 't52') && daysSinceDoj > 150) pending.push({ label: 'Pre-probation overdue', urgency: 'high' });

    // Doc rejections
    const failedDocs = Object.entries(vr).filter(([, v]) => v && v.valid === false).map(([k]) => k);
    if (failedDocs.length) pending.push({ label: `Doc re-upload needed: ${failedDocs.join(', ')}`, urgency: 'high' });

    return pending;
  }

  const cards = employees.map(emp => {
    let total = 0, done = 0;
    for (const phase of Object.values(emp.checklist || {})) {
      const tasks = Object.values(phase.tasks || {});
      total += tasks.length;
      done += tasks.filter(t => t.done).length;
    }
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    // Current stage — first incomplete milestone
    let currentStage = 'Complete';
    let stageIndex = MILESTONE_LABELS.length;
    for (let i = 0; i < MILESTONE_LABELS.length; i++) {
      const label = MILESTONE_LABELS[i];
      const taskIds = MILESTONE_TASK_MAP[label] || [];
      const isDone = taskIds.every(tid => isTaskDoneInChecklist(emp.checklist, tid));
      if (!isDone) { currentStage = label; stageIndex = i; break; }
    }

    const dojDate = new Date(emp.doj);
    const daysUntilDoj = Math.ceil((dojDate - now) / (1000 * 60 * 60 * 24));
    const daysSinceDoj = Math.floor((now - dojDate) / (1000 * 60 * 60 * 24));
    const isPreDOJ = daysUntilDoj > 0;
    const dojLabel = isPreDOJ
      ? (daysUntilDoj === 1 ? 'Tomorrow' : `DOJ in ${daysUntilDoj}d`)
      : (daysSinceDoj === 0 ? 'DOJ Today' : `${daysSinceDoj}d since DOJ`);
    const dojUrgent = daysUntilDoj <= 3 && daysUntilDoj > 0;

    // Overall card urgency
    const pending = getPendingActions(emp);
    const hasHigh = pending.some(p => p.urgency === 'high');
    const hasMed  = pending.some(p => p.urgency === 'medium');
    const cardColor = pct === 100 ? '#0D7F7F' : hasHigh ? '#B91C1C' : hasMed ? '#B45309' : '#1D4ED8';
    const cardBg    = pct === 100 ? '#F0FAFA' : hasHigh ? '#FEF2F2' : hasMed ? '#FFFBEB' : '#EFF6FF';
    const urgencyTag = pct === 100
      ? '<span style="background:#0D7F7F;color:#fff;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;letter-spacing:.05em;">COMPLETE</span>'
      : hasHigh
      ? '<span style="background:#B91C1C;color:#fff;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;letter-spacing:.05em;">ACTION NEEDED</span>'
      : hasMed
      ? '<span style="background:#B45309;color:#fff;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;letter-spacing:.05em;">IN PROGRESS</span>'
      : '<span style="background:#1D4ED8;color:#fff;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:700;letter-spacing:.05em;">ON TRACK</span>';

    // Milestone pipeline dots
    const dots = MILESTONE_LABELS.map((label, i) => {
      const taskIds = MILESTONE_TASK_MAP[label] || [];
      const isDone = taskIds.every(tid => isTaskDoneInChecklist(emp.checklist, tid));
      const isCurrent = i === stageIndex;
      const color = isDone ? '#0D7F7F' : isCurrent ? cardColor : '#D1D5DB';
      const title = label.length > 30 ? label.substring(0, 30) + '…' : label;
      return `<span title="${label}" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin:0 2px;${isCurrent ? 'box-shadow:0 0 0 2px #fff,0 0 0 3px ' + color : ''}"></span>`;
    }).join('');

    // Pending action pills
    const pendingPills = pending.slice(0, 3).map(p => {
      const bg = p.urgency === 'high' ? '#FEE2E2' : p.urgency === 'medium' ? '#FEF9C3' : '#F3F4F6';
      const col = p.urgency === 'high' ? '#991B1B' : p.urgency === 'medium' ? '#92400E' : '#4B5563';
      return `<div style="background:${bg};color:${col};font-size:11px;padding:3px 8px;border-radius:4px;margin-bottom:4px;">${p.label}</div>`;
    }).join('');
    const morePending = pending.length > 3 ? `<div style="font-size:11px;color:#6B7280;">+${pending.length - 3} more</div>` : '';

    const fresherBadge = emp.isFresher !== undefined
      ? `<span style="font-size:10px;background:#E0E7FF;color:#3730A3;padding:1px 7px;border-radius:10px;margin-left:6px;">${emp.isFresher ? 'Fresher' : 'Experienced'}</span>`
      : '';

    return `
    <div style="background:${cardBg};border:1px solid ${cardColor}22;border-left:4px solid ${cardColor};border-radius:8px;padding:16px 18px;margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
        <div>
          <a href="/status/${emp.employeeId}" style="font-size:16px;font-weight:700;color:${cardColor};text-decoration:none;">${emp.name}</a>
          ${fresherBadge}
          <div style="font-size:12px;color:#6B7280;margin-top:2px;">${emp.employeeId} &nbsp;·&nbsp; DOJ: ${emp.doj} &nbsp;·&nbsp; <span style="color:${dojUrgent ? '#B91C1C' : '#6B7280'};font-weight:${dojUrgent ? '600' : '400'}">${dojLabel}</span></div>
        </div>
        <div style="text-align:right;">
          ${urgencyTag}
          <div style="font-size:13px;font-weight:700;color:${cardColor};margin-top:4px;">${pct}%</div>
        </div>
      </div>

      <!-- Progress bar -->
      <div style="background:#E5E7EB;border-radius:4px;height:6px;margin-bottom:10px;">
        <div style="background:${cardColor};border-radius:4px;height:100%;width:${pct}%;transition:width .3s;"></div>
      </div>

      <!-- Milestone dots -->
      <div style="margin-bottom:10px;">${dots}</div>

      <!-- Current stage + pending -->
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;">
        <div style="flex:1;min-width:180px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9CA3AF;margin-bottom:4px;">Current Stage</div>
          <div style="font-size:13px;color:#1C1C1E;">${currentStage}</div>
        </div>
        ${pending.length ? `<div style="flex:1;min-width:180px;">
          <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9CA3AF;margin-bottom:4px;">Pending</div>
          ${pendingPills}${morePending}
        </div>` : ''}
      </div>
    </div>`;
  }).join('');

  const emptyState = employees.length === 0
    ? '<div style="text-align:center;padding:48px;color:#9CA3AF;">No employees registered yet.</div>'
    : '';

  // Summary counts
  const total = employees.length;
  const complete = employees.filter(e => {
    let t = 0, d = 0;
    for (const p of Object.values(e.checklist || {})) { const ts = Object.values(p.tasks || {}); t += ts.length; d += ts.filter(x => x.done).length; }
    return t > 0 && d === t;
  }).length;
  const actionNeeded = employees.filter(e => getPendingActions(e).some(p => p.urgency === 'high')).length;
  const onTrack = total - complete - actionNeeded;

  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Alethea HR — Onboarding Dashboard</title>
  <meta http-equiv="refresh" content="30"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F9FAFB;color:#1C1C1E;padding:24px;}
    .header{max-width:900px;margin:0 auto 24px;}
    .title{font-size:22px;font-weight:700;color:#0F1923;}
    .subtitle{font-size:13px;color:#6B7280;margin-top:4px;}
    .stats{display:flex;gap:12px;margin:16px 0;flex-wrap:wrap;}
    .stat{background:#fff;border:1px solid #E5E7EB;border-radius:8px;padding:12px 20px;min-width:120px;}
    .stat-val{font-size:24px;font-weight:700;}
    .stat-label{font-size:11px;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;margin-top:2px;}
    .cards{max-width:900px;margin:0 auto;}
    .refresh{font-size:11px;color:#9CA3AF;margin-top:16px;text-align:right;}
  </style>
</head>
<body>
  <div class="header">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div>
        <div class="title">Onboarding Dashboard</div>
        <div class="subtitle">${esc(process.env.COMPANY_NAME || 'HR')} &nbsp;·&nbsp; Auto-refreshes every 30s</div>
      </div>
      <div style="font-size:12px;color:#9CA3AF;">Uptime: ${Math.floor(process.uptime() / 60)}m</div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-val" style="color:#1C1C1E;">${total}</div><div class="stat-label">Total</div></div>
      <div class="stat"><div class="stat-val" style="color:#B91C1C;">${actionNeeded}</div><div class="stat-label">Action Needed</div></div>
      <div class="stat"><div class="stat-val" style="color:#1D4ED8;">${onTrack}</div><div class="stat-label">On Track</div></div>
      <div class="stat"><div class="stat-val" style="color:#0D7F7F;">${complete}</div><div class="stat-label">Complete</div></div>
    </div>
  </div>
  <div class="cards">${cards}${emptyState}</div>
  <div class="refresh" style="max-width:900px;margin:12px auto 0;">Last updated: ${new Date().toLocaleTimeString('en-IN')}</div>
</body>
</html>`);
});

// ─── Raw state endpoint (debugging) ───────────────────────────────────────────
app.get('/state/:employeeId', statusLimiter, (req, res) => {
  if (!isValidEmployeeId(req.params.employeeId)) return res.status(400).json({ error: 'Invalid employee ID format.' });
  const emp = _employeeRegistry[req.params.employeeId];
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  const stateFile = path.join(__dirname, '..', `state-${emp.employeeId}.json`);
  if (fs.existsSync(stateFile)) {
    try {
      const { decrypt, isEncryptionEnabled } = require('./encryption');
      const raw = fs.readFileSync(stateFile, 'utf8');
      const parsed = (isEncryptionEnabled() && raw.includes('"ciphertext"'))
        ? JSON.parse(decrypt(raw))
        : JSON.parse(raw);
      return res.json(parsed);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse state file', detail: e.message });
    }
  }
  // Fall back to in-memory checklist if no persisted state file yet
  res.json({ checklist: emp.checklist, milestonesScheduled: emp.milestonesScheduled || false });
});

// ─── Manual task mark endpoint ─────────────────────────────────────────────────
// POST /mark-task/:employeeId/:taskId
// Header: x-mark-task-secret: <MARK_TASK_SECRET>
// Allows recruiters to mark manual tasks (t53, t54, etc.) done from a browser or curl.
// Disabled if MARK_TASK_SECRET is not set in .env.
app.post('/mark-task/:employeeId/:taskId', markTaskLimiter, (req, res) => {
  const secret = process.env.MARK_TASK_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Task marking is disabled — set MARK_TASK_SECRET in .env to enable.' });
  }

  const provided = req.headers['x-mark-task-secret'] || (req.body && req.body.secret) || '';
  if (!safeCompare(provided, secret)) {
    return res.status(401).json({ error: 'Invalid or missing secret token.' });
  }

  const { employeeId, taskId } = req.params;
  if (!isValidEmployeeId(employeeId)) {
    return res.status(400).json({ error: 'Invalid employeeId format.' });
  }
  if (!isValidTaskId(taskId)) {
    return res.status(400).json({ error: 'Invalid taskId format.' });
  }

  const emp = _employeeRegistry[employeeId];
  if (!emp) return res.status(404).json({ error: `Employee ${employeeId} not found.` });

  // Find task across all phases
  let found = false;
  let label = '';
  for (const phase of Object.values(emp.checklist || {})) {
    if (phase.tasks && phase.tasks[taskId] !== undefined) {
      if (phase.tasks[taskId].done) {
        return res.json({ ok: true, message: `Task ${taskId} was already marked done.` });
      }
      phase.tasks[taskId].done = true;
      label = phase.tasks[taskId].label;
      found = true;
      break;
    }
  }

  if (!found) {
    return res.status(404).json({ error: `Task ${taskId} not found in checklist for ${employeeId}.` });
  }

  // Persist state
  try {
    const { log } = require('./activityLog');
    log(emp, `task_done:${taskId}`, `${label} (manually marked via /mark-task)`);
  } catch { /* activityLog is best-effort */ }

  try {
    const { encrypt: enc, decrypt: dec, isEncryptionEnabled: encOn } = require('./encryption');
    const stateFile = path.join(__dirname, '..', `state-${employeeId}.json`);
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const state = (encOn() && raw.includes('"ciphertext"')) ? JSON.parse(dec(raw)) : JSON.parse(raw);
      if (state.checklist) {
        for (const phase of Object.values(state.checklist)) {
          if (phase.tasks && phase.tasks[taskId]) {
            phase.tasks[taskId].done = true;
          }
        }
        const plaintext = JSON.stringify(state, null, 2);
        fs.writeFileSync(stateFile, encOn() ? enc(plaintext) : plaintext);
      }
    }
  } catch (e) {
    console.warn(`[Webhook] mark-task: state write failed for ${employeeId}:`, e.message);
  }

  console.log(`[Webhook] Task ${taskId} (${label}) manually marked done for ${employeeId}`);

  // Sync updated checklist back to Drive so the file in the employee's folder stays current
  if (_auth && emp.driveFolderId) {
    const { uploadChecklist } = require('./driveWatcher');
    uploadChecklist(_auth, emp.driveFolderId, emp.checklist).catch(err =>
      console.warn(`[Webhook] mark-task: Drive checklist sync failed for ${employeeId}:`, err.message)
    );
  }

  // If the request came from a browser form, redirect back to the status page
  const accept = req.headers['accept'] || '';
  if (accept.includes('text/html')) {
    return res.redirect(`/status/${employeeId}`);
  }
  res.json({ ok: true, message: `Task ${taskId} marked done for ${emp.name}.`, label });
});

// ─── Start the server ──────────────────────────────────────────────────────────
function start(port) {
  const p = port || parseInt(process.env.WEBHOOK_PORT, 10) || 3000;
  app.listen(p, () => {
    console.log(`[Webhook] Server listening on port ${p}`);
    console.log(`[Webhook] Drive push endpoint: ${process.env.WEBHOOK_BASE_URL || 'http://localhost:' + p}/drive-push`);
    console.log(`[Webhook] Gmail push endpoint: ${process.env.WEBHOOK_BASE_URL || 'http://localhost:' + p}/gmail-push`);
  });
  return app;
}

module.exports = { init, start };
