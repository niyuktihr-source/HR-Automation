const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const config = require('./config');
require('dotenv').config();

const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');
const TOKEN_PATH = path.join(__dirname, '..', 'token.json');

// OAuth scopes are declared in auth.js and baked into token.json at first-run.
// Scopes required by this engine (for reference — change auth.js, then re-run npm run auth):
//   https://www.googleapis.com/auth/drive
//   https://www.googleapis.com/auth/gmail.send
//   https://www.googleapis.com/auth/gmail.modify   (needed for users.watch)
//   https://www.googleapis.com/auth/calendar
//   https://www.googleapis.com/auth/spreadsheets

// Retry an async API call up to maxAttempts times with exponential backoff.
// Retries on network errors and Google 429/500/503 responses.
async function apiWithRetry(fn, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.code || (err.response && err.response.status);
      const retryable = !status || status === 429 || status >= 500;
      if (attempt === maxAttempts || !retryable) throw err;
      const delay = attempt * 3000;
      console.warn(`[Drive] "${label}" attempt ${attempt} failed (${err.message}) — retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Build and return an authorised OAuth2 client
function getAuthClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      'credentials.json not found.\n' +
      'Download it from Google Cloud Console (OAuth 2.0 → Desktop app) and place it in automation/.'
    );
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      'token.json not found. Run the one-time auth script first:\n  npm run auth'
    );
  }

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);

  // Auto-refresh tokens and persist the updated token.json on refresh
  oAuth2Client.on('tokens', (newTokens) => {
    try {
      const current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      const merged = { ...current, ...newTokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
      console.log('[Auth] Token refreshed and saved to token.json');
    } catch (err) {
      console.error('[Auth] Failed to persist refreshed token — next API call may fail:', err.message);
    }
  });

  return oAuth2Client;
}

// Validate a Drive resource ID — Google IDs are alphanumeric + underscores/hyphens, 10–60 chars
function assertDriveId(id, label) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{10,60}$/.test(id)) {
    throw new Error(`Invalid Drive ID for ${label}: "${id}"`);
  }
}

// List all files inside a Drive folder
async function listFolderFiles(auth, folderId) {
  assertDriveId(folderId, 'listFolderFiles');
  const drive = google.drive({ version: 'v3', auth });
  const res = await apiWithRetry(() => drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime, createdTime)',
    orderBy: 'createdTime desc',
  }), 'listFolderFiles');
  return res.data.files || [];
}

// Create a sub-folder inside a parent Drive folder
async function createSubFolder(auth, parentFolderId, folderName) {
  const drive = google.drive({ version: 'v3', auth });
  const safeName = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const existing = await apiWithRetry(() => drive.files.list({
    q: `name='${safeName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
  }), `createSubFolder:list:${folderName}`);
  if (existing.data.files.length > 0) return existing.data.files[0].id;

  const res = await apiWithRetry(() => drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id',
  }), `createSubFolder:create:${folderName}`);
  console.log(`[Drive] Created sub-folder "${folderName}" → ${res.data.id}`);
  return res.data.id;
}

// Move a file into a destination folder
async function moveFileTo(auth, fileId, destinationFolderId) {
  const drive = google.drive({ version: 'v3', auth });
  const file = await apiWithRetry(() => drive.files.get({ fileId, fields: 'parents' }), `moveFileTo:get:${fileId}`);
  const previousParents = file.data.parents.join(',');
  await apiWithRetry(() => drive.files.update({
    fileId,
    addParents: destinationFolderId,
    removeParents: previousParents,
    fields: 'id, parents',
  }), `moveFileTo:update:${fileId}`);
}

// Upload a plain-text upload instructions file into the employee's root Drive folder.
// Employees see this file when they open their folder and know exactly what to upload.
async function uploadInstructions(auth, folderId, employeeName) {
  const drive = google.drive({ version: 'v3', auth });
  const filename = 'UPLOAD_INSTRUCTIONS.txt';
  const content = [
    `Hello ${employeeName},`,
    ``,
    `Welcome to Alethea! Please upload your documents into the dedicated subfolders`,
    `in this Drive folder. The HR automation system will verify each document`,
    `automatically and notify you if anything needs to be re-uploaded.`,
    ``,
    `REQUIRED DOCUMENTS (upload before your joining date):`,
    `──────────────────────────────────────────────────────`,
    `1. Aadhaar Card (front and back)`,
    `   → Upload into the "Aadhaar" folder`,
    `   → Name the file with "aadhaar"  e.g. aadhaar_john.pdf`,
    ``,
    `2. PAN Card`,
    `   → Upload into the "PAN" folder`,
    `   → Name the file with "pan"  e.g. pan_john.jpg`,
    ``,
    `3. Signed Offer Letter`,
    `   → Upload into the "Offer_Letter" folder`,
    `   → Name the file with "offer"  e.g. offer_john.pdf`,
    ``,
    `4. Passport Size Photo`,
    `   → Upload into the "Passport_Photo" folder`,
    `   → Name the file with "photo"  e.g. photo_john.jpg`,
    ``,
    `5. 10th Standard Marksheet (SSC / SSLC / Matriculation)`,
    `   → Upload into the "Marksheet_10th" folder`,
    `   → Name the file with "10th"  e.g. 10th_marksheet_john.pdf`,
    ``,
    `6. 12th Standard Marksheet or Diploma Certificate`,
    `   → Upload into the "Marksheet_12th" folder`,
    `   → Name the file with "12th" or "diploma"  e.g. 12th_john.pdf`,
    ``,
    `7. Graduation Consolidated Marksheet and Degree Certificate`,
    `   → Upload into the "Degree_Certificate" folder`,
    `   → Name the file with "degree" or "graduation"  e.g. degree_john.pdf`,
    ``,
    `8. Current Address Proof (where you currently live)`,
    `   → Accepted: Aadhaar card, PG rent slip, wifi bill, electricity bill, rent agreement`,
    `   → Upload into the "Current_Address_Proof" folder`,
    `   → Name the file with "current_address"  e.g. current_address_john.pdf`,
    ``,
    `9. Permanent Address Proof (your hometown address)`,
    `   → Accepted: Aadhaar card only`,
    `   → Upload into the "Permanent_Address_Proof" folder`,
    `   → Name the file with "permanent_address"  e.g. permanent_address_john.pdf`,
    ``,
    `10. UAN (Universal Account Number) — generate on your Date of Joining via UMANG app`,
    `   → Open UMANG app → EPFO → UAN → take a screenshot or export PDF`,
    `   → Upload into the "UAN" folder`,
    `   → Name the file with "uan"  e.g. uan_john.pdf`,
    `   → Must be uploaded within 3 days of your Date of Joining`,
    ``,
    ``,
    `PREVIOUS EMPLOYMENT DOCUMENTS (read conditions below — upload only if applicable):`,
    `─────────────────────────────────────────────────────────────────────────────────`,
    `If you have worked with previous employers, you must submit ONE of the following`,
    `for EACH employer, depending on how many employers you have worked with:`,
    ``,
    `  • Relieving-cum-Experience Letter  OR  Relieving Letter + Experience Letter (separate)`,
    `  • Full & Final Settlement Letter  OR  Last Month's Payslip`,
    ``,
    `  Employer 1 — Most Recent Employer`,
    `    → MANDATORY if you have prior employment (submit within 30–60 days of joining)`,
    `    → Upload your document into the "Relieving_Letter" folder (relieving/experience letter)`,
    `      OR into the "Payslip" folder (if submitting last month's payslip)`,
    `    → Name the file clearly  e.g. relieving_employer1_john.pdf / payslip_employer1_john.pdf`,
    ``,
    `  Employer 2 — Previous Employer`,
    `    → Required if you have worked with 2 or more employers`,
    `    → Upload into the same "Relieving_Letter" or "Payslip" folder`,
    `    → Name clearly  e.g. relieving_employer2_john.pdf / payslip_employer2_john.pdf`,
    ``,
    `  Employer 3 — Previous Employer`,
    `    → Required if you have worked with 3 or more employers`,
    `    → Upload into the same "Relieving_Letter" or "Payslip" folder`,
    `    → Name clearly  e.g. relieving_employer3_john.pdf / payslip_employer3_john.pdf`,
    ``,
    `  If you are a FRESHER (no prior employment): skip this section entirely.`,
    ``,
    `OPTIONAL DOCUMENTS (upload only if applicable):`,
    `────────────────────────────────────────────────`,
    `11. Post Graduation Consolidated Marksheet and Degree Certificate (Masters / MBA / MTech / PhD)`,
    `   → Upload into the "Postgrad_Certificate" folder`,
    `   → Name the file with "postgrad" or "masters"  e.g. postgrad_john.pdf`,
    `   → Will be automatically marked as N/A after 3 days if not applicable`,
    ``,
    `12. Passport (if available)`,
    `   → Upload into the "Passport" folder`,
    `   → Name the file with "passport"  e.g. passport_john.pdf`,
    `   → Not mandatory — upload only if you have one`,
    ``,
    `TIPS:`,
    `──────`,
    `• Documents must be clearly legible — not blurry or cropped.`,
    `• Aadhaar: upload both front and back in a single image or PDF.`,
    `• Photo: plain background, face clearly visible, recent photo.`,
    `• If a document fails verification you will receive an email with the reason.`,
    `• Always include the keyword in your filename so the system can identify it`,
    `  (see examples above). Wrong filename = unrecognised document.`,
    ``,
    process.env.HR_EMAIL ? `If you have any questions contact HR at ${process.env.HR_EMAIL}.` : `If you have any questions, please contact HR.`,
    ``,
    `— ${process.env.COMPANY_NAME || 'Alethea'} HR Automation`,
  ].join('\n');

  const media = { mimeType: 'text/plain', body: content };

  const existing = await apiWithRetry(() => drive.files.list({
    q: `name='${filename}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
  }), 'uploadInstructions:list');

  if (existing.data.files.length > 0) {
    const fileId = existing.data.files[0].id;
    await apiWithRetry(() => drive.files.update({ fileId, media, fields: 'id' }), 'uploadInstructions:update');
    console.log(`[Drive] Upload instructions updated for ${employeeName}`);
    return fileId;
  }

  const res = await apiWithRetry(() => drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media,
    fields: 'id',
  }), 'uploadInstructions:create');
  console.log(`[Drive] Upload instructions created for ${employeeName} (${res.data.id})`);
  return res.data.id;
}

// Checklist is no longer uploaded to Drive — state is persisted locally via
// encrypted state-EMPID.json files. This stub keeps all call sites working.
async function uploadChecklist() {
  return null;
}

// Build the expected sub-folder structure inside an employee's Drive folder
async function scaffoldEmployeeFolder(auth, rootFolderId, employeeName, employeeId, isFresher) {
  const folderName = `${employeeName}_${employeeId}`;
  const employeeFolderId = await createSubFolder(auth, rootFolderId, folderName);

  // Freshers have no prior employment — skip work-history document folders
  const fresherExclude = isFresher ? ['Relieving_Letter', 'Payslip'] : [];
  const subFolders = config.driveSubfolders.filter(sf => !fresherExclude.includes(sf));

  const folderMap = { root: employeeFolderId };
  for (const sf of subFolders) {
    folderMap[sf] = await createSubFolder(auth, employeeFolderId, sf);
  }
  console.log(`[Drive] Folder structure ready for ${employeeName} (${employeeId})`);
  return folderMap;
}

// Grant a single user writer access to the employee Drive folder.
// Used to give the joinee access when the pre-onboarding form is sent.
async function grantFolderAccess(auth, folderId, email, employeeName) {
  const drive = google.drive({ version: 'v3', auth });
  try {
    await drive.permissions.create({
      fileId: folderId,
      requestBody: { type: 'user', role: 'writer', emailAddress: email },
      sendNotificationEmail: false,
      supportsAllDrives: true,
    });
    console.log(`[Drive] Granted folder access to ${email} for ${employeeName}`);
  } catch (err) {
    console.warn(`[Drive] Could not grant folder access to ${email} for ${employeeName}: ${err.message}`);
  }
}

// Lock the employee Drive folder so only the recruiter and joinee can access it.
// All other inherited permissions from the root onboarding folder are revoked.
async function lockEmployeeFolder(auth, folderId, recruiterEmail, employeeName) {
  const drive = google.drive({ version: 'v3', auth });

  // Fetch all current permissions on the folder
  let existingPerms = [];
  try {
    const res = await apiWithRetry(() => drive.permissions.list({
      fileId: folderId,
      fields: 'permissions(id, emailAddress, role)',
      supportsAllDrives: true,
    }), `lockEmployeeFolder:list:${folderId}`);
    existingPerms = res.data.permissions || [];
  } catch (err) {
    console.warn(`[Drive] Could not list permissions for ${employeeName} folder: ${err.message}`);
  }

  // Only the recruiter is allowed — remove everyone else (except the engine account owner)
  const allowSet = new Set([recruiterEmail].filter(Boolean).map(e => e.toLowerCase()));

  for (const perm of existingPerms) {
    if (!perm.emailAddress) continue; // skip 'anyone' or domain-wide perms
    if (perm.role === 'owner') continue; // never remove owner
    if (allowSet.has(perm.emailAddress.toLowerCase())) continue; // keep recruiter
    try {
      await drive.permissions.delete({ fileId: folderId, permissionId: perm.id, supportsAllDrives: true });
      console.log(`[Drive] Removed folder access for ${perm.emailAddress} on ${employeeName} folder`);
    } catch (err) {
      console.warn(`[Drive] Could not remove permission ${perm.id} (${perm.emailAddress}) on ${employeeName} folder: ${err.message}`);
    }
  }

  // Grant recruiter write access
  if (recruiterEmail) {
    try {
      await drive.permissions.create({
        fileId: folderId,
        requestBody: { type: 'user', role: 'writer', emailAddress: recruiterEmail },
        sendNotificationEmail: false,
        supportsAllDrives: true,
      });
      console.log(`[Drive] Folder locked — only recruiter has access: ${recruiterEmail}`);
    } catch (err) {
      console.warn(`[Drive] Could not grant folder access to recruiter ${recruiterEmail}: ${err.message}`);
    }
  }
}

// ─── Drive Push Notifications ─────────────────────────────────────────────────
// Drive push channels expire after at most 1 week (604800s). We renew 1h before
// expiry. Each channel targets one folder and posts to WEBHOOK_BASE_URL/drive-push.
//
// Channel state is persisted to push-channels.json so restarts don't lose track.

const PUSH_CHANNELS_PATH = path.join(__dirname, '..', 'push-channels.json');
const PUSH_TTL_MS      = config.drivePushChannelTtlDays * 24 * 60 * 60 * 1000;
const RENEW_BEFORE_MS  = config.drivePushRenewBeforeExpirySecs * 1000;

function loadPushChannels() {
  if (fs.existsSync(PUSH_CHANNELS_PATH)) {
    return JSON.parse(fs.readFileSync(PUSH_CHANNELS_PATH, 'utf8'));
  }
  return {};
}

function savePushChannels(channels) {
  fs.writeFileSync(PUSH_CHANNELS_PATH, JSON.stringify(channels, null, 2));
}

// Register a Drive push channel for a folder. Returns channel metadata.
// Stops any existing live channel first to avoid duplicate notifications on restart.
async function registerDrivePushChannel(auth, folderId, employeeId) {
  const drive = google.drive({ version: 'v3', auth });
  const webhookUrl = `${process.env.WEBHOOK_BASE_URL}/drive-push`;

  // Stop existing channel for this employee (if still live) to avoid duplicates
  const existingChannels = loadPushChannels();
  const existing = existingChannels[employeeId];
  if (existing && existing.channelId && existing.resourceId) {
    try {
      await drive.channels.stop({ requestBody: { id: existing.channelId, resourceId: existing.resourceId } });
      console.log(`[Drive] Stopped existing push channel for ${employeeId} before re-registering`);
    } catch (err) {
      // May already be expired — non-fatal
      console.warn(`[Drive] Could not stop existing channel for ${employeeId}: ${err.message}`);
    }
  }

  const channelId = `hr-auto-${employeeId}-${Date.now()}`;
  const expiration = Date.now() + PUSH_TTL_MS;

  const res = await apiWithRetry(
    () => drive.files.watch({
      fileId: folderId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: webhookUrl,
        expiration: String(expiration),
        token: employeeId,
      },
    }),
    `registerDrivePushChannel(${employeeId})`
  );

  const channel = {
    channelId,
    resourceId: res.data.resourceId,
    folderId,
    employeeId,
    expiration,
  };

  const channels = loadPushChannels();
  channels[employeeId] = channel;
  savePushChannels(channels);

  console.log(`[Drive] Push channel registered for ${employeeId} → expires ${new Date(expiration).toISOString()}`);

  // Schedule automatic renewal
  const renewIn = PUSH_TTL_MS - RENEW_BEFORE_MS;
  setTimeout(() => renewDrivePushChannel(auth, employeeId), renewIn);

  return channel;
}

// Stop an existing push channel and register a fresh one
async function renewDrivePushChannel(auth, employeeId) {
  const channels = loadPushChannels();
  const old = channels[employeeId];
  if (old) {
    try {
      const drive = google.drive({ version: 'v3', auth });
      await drive.channels.stop({ requestBody: { id: old.channelId, resourceId: old.resourceId } });
      console.log(`[Drive] Old push channel stopped for ${employeeId}`);
    } catch (err) {
      console.warn(`[Drive] Could not stop old channel for ${employeeId}:`, err.message);
    }
  }
  if (old) await registerDrivePushChannel(auth, old.folderId, employeeId);
}

// Fetch only files added/modified since `sinceMs` (used when a push notification arrives)
async function getChangedFiles(auth, folderId, sinceMs) {
  const drive = google.drive({ version: 'v3', auth });
  const sinceISO = new Date(sinceMs).toISOString();
  // Use 'in ancestors' so files inside subfolders are included (not just direct children)
  const res = await apiWithRetry(() => drive.files.list({
    q: `'${folderId}' in parents and trashed = false and modifiedTime > '${sinceISO}' and mimeType != 'application/vnd.google-apps.folder'`,
    fields: 'files(id, name, mimeType, modifiedTime, createdTime, parents)',
    orderBy: 'createdTime desc',
  }), 'getChangedFiles');
  return res.data.files || [];
}

// Fallback polling — kept as a safety net when WEBHOOK_BASE_URL is not set
function watchFolderPolling(auth, folderId, onNewFile, intervalMs = config.drivePollIntervalMs) {
  const seenFileIds = new Set();

  async function poll() {
    try {
      const files = await listFolderFiles(auth, folderId);
      for (const file of files) {
        if (!seenFileIds.has(file.id)) {
          seenFileIds.add(file.id);
          console.log(`[Drive] New file detected (poll): ${file.name} (${file.id})`);
          const ok = await onNewFile(file).catch(err => {
            console.error(`[Drive] Error handling file ${file.name}:`, err.message);
            return false;
          });
          // On transient error, remove from cache so the file is retried next poll
          if (ok === false) {
            seenFileIds.delete(file.id);
            console.log(`[Drive] File ${file.name} removed from poll-cache — will retry next poll`);
          }
        }
      }
    } catch (err) {
      const status = err.code || (err.response && err.response.status);
      if (status === 404) {
        console.error(`[Drive] Folder ${folderId} not found (404) — polling stopped. Folder may have been deleted.`);
        clearInterval(timer);
      } else {
        console.error('[Drive] Poll error:', err.message);
      }
    }
  }

  poll();
  const timer = setInterval(poll, intervalMs);
  console.log(`[Drive] Polling folder ${folderId} every ${intervalMs / 1000}s (fallback mode)`);
  return timer;
}

// Primary watch function — always polls, and also registers push channel if
// WEBHOOK_BASE_URL is a real URL (not the placeholder).
async function watchFolder(auth, folderId, employeeId, onNewFile, intervalMs = config.drivePollIntervalMs) {
  const webhookUrl = process.env.WEBHOOK_BASE_URL || '';
  const isRealWebhook = webhookUrl && !webhookUrl.includes('your-ngrok-url');

  if (isRealWebhook) {
    // Register push for instant notifications — fall back to polling only if quota hit
    try {
      await registerDrivePushChannel(auth, folderId, employeeId);
    } catch (err) {
      console.warn(`[Drive] Push channel registration failed for ${employeeId} — falling back to polling: ${err.message}`);
    }
  }

  // Always run polling regardless — catches files when push isn't set up
  return watchFolderPolling(auth, folderId, onNewFile, intervalMs);
}

module.exports = {
  getAuthClient,
  listFolderFiles,
  getChangedFiles,
  createSubFolder,
  moveFileTo,
  uploadChecklist,
  uploadInstructions,
  scaffoldEmployeeFolder,
  lockEmployeeFolder,
  watchFolder,
  watchFolderPolling,
  registerDrivePushChannel,
  renewDrivePushChannel,
  loadPushChannels,
};
