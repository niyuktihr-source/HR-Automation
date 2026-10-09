// Gmail Watch API — listens for incoming reply emails from HR / manager / IT
// and uses Claude to extract structured data from each reply.
//
// Flow:
//   1. registerGmailWatch() tells Gmail to POST to /gmail-push when inbox changes
//   2. webhookServer.js receives the push, calls processGmailPush()
//   3. processGmailPush() fetches new messages, runs them through Claude
//   4. Claude extracts reply type + data (official email ID, asset details, etc.)
//   5. index.js callback receives structured data and advances the checklist

const { google } = require('googleapis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { retryTransient } = require('./transientError');

const escHtml = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// Lazy — only instantiated when GEMINI_API_KEY is present, so module load never crashes
let _genAI = null;
function getGenAI() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _genAI;
}
const GMAIL_STATE_PATH = path.join(__dirname, '..', 'gmail-state.json');

// ─── State helpers ────────────────────────────────────────────────────────────
function loadGmailState() {
  if (fs.existsSync(GMAIL_STATE_PATH)) {
    return JSON.parse(fs.readFileSync(GMAIL_STATE_PATH, 'utf8'));
  }
  return { historyId: null, watchExpiry: null };
}

function saveGmailState(state) {
  fs.writeFileSync(GMAIL_STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Register Gmail push watch ────────────────────────────────────────────────
// Gmail watch tokens expire after 7 days — renew via renewGmailWatch().
async function registerGmailWatch(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const webhookUrl = `${process.env.WEBHOOK_BASE_URL}/gmail-push`;

  // Gmail push requires a Google Cloud Pub/Sub topic — the topic must have
  // gmail-api-push@system.gserviceaccount.com as a Publisher.
  // Set GMAIL_PUBSUB_TOPIC=projects/YOUR_PROJECT/topics/YOUR_TOPIC in .env
  const topicName = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topicName) {
    throw new Error('GMAIL_PUBSUB_TOPIC not set in .env — see setup guide');
  }

  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      labelIds: ['INBOX'],
      topicName,
    },
  });

  const state = loadGmailState();
  // Preserve existing historyId so getNewMessages catches up on messages
  // that arrived during the restart gap. Only set if none saved yet.
  if (!state.historyId) {
    state.historyId = res.data.historyId;
  }
  state.watchExpiry = Date.now() + 6 * 24 * 60 * 60 * 1000; // renew after 6 days
  saveGmailState(state);

  console.log(`[Gmail] Watch registered — historyId: ${res.data.historyId} (processing from: ${state.historyId})`);

  // Auto-renew before expiry
  setTimeout(() => renewGmailWatch(auth), 6 * 24 * 60 * 60 * 1000);
  return res.data;
}

async function renewGmailWatch(auth) {
  console.log('[Gmail] Renewing Gmail watch...');
  try {
    const gmail = google.gmail({ version: 'v1', auth });
    await gmail.users.stop({ userId: 'me' });
  } catch (err) {
    console.warn('[Gmail] Could not stop existing watch:', err.message);
  }
  await registerGmailWatch(auth);
}

// ─── Fetch messages added since last known historyId ─────────────────────────
async function getNewMessages(auth, newHistoryId) {
  const gmail = google.gmail({ version: 'v1', auth });
  const state = loadGmailState();
  const startHistoryId = state.historyId;

  if (!startHistoryId) {
    console.warn('[Gmail] No stored historyId — skipping history fetch');
    state.historyId = newHistoryId;
    saveGmailState(state);
    return [];
  }

  let messages = [];
  try {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
    });

    const history = res.data.history || [];
    for (const entry of history) {
      for (const added of entry.messagesAdded || []) {
        messages.push(added.message);
      }
    }
  } catch (err) {
    // historyId too old — fall back to listing recent unread messages
    if (err.code === 404) {
      console.warn('[Gmail] historyId expired, fetching recent unread messages');
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread in:inbox',
        maxResults: 20,
      });
      messages = res.data.messages || [];
    } else {
      throw err;
    }
  }

  state.historyId = newHistoryId;
  saveGmailState(state);
  return messages;
}

// ─── Fetch full message content ───────────────────────────────────────────────
async function fetchMessageBody(auth, messageId) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const msg = res.data;
  if (!msg || !msg.payload) {
    throw new Error(`Gmail returned malformed message for id ${messageId} — missing payload`);
  }
  const headers = {};
  for (const h of msg.payload.headers || []) {
    headers[h.name.toLowerCase()] = h.value;
  }

  // Extract plain text body
  let body = '';
  function extractBody(part) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      body += Buffer.from(part.body.data, 'base64').toString('utf8');
    }
    for (const sub of part.parts || []) extractBody(sub);
  }
  extractBody(msg.payload);

  // Extract attachments — PDFs (BGV reports) and images (document re-uploads)
  const ATTACHMENT_EXTS = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.webp'];
  const attachments = [];
  function extractAttachments(part) {
    const fname = (part.filename || '').toLowerCase();
    if (part.filename && ATTACHMENT_EXTS.some(ext => fname.endsWith(ext)) && part.body) {
      attachments.push({
        filename: part.filename,
        attachmentId: part.body.attachmentId || null,
        data: part.body.data || null,
        mimeType: part.mimeType || 'application/octet-stream',
      });
    }
    for (const sub of part.parts || []) extractAttachments(sub);
  }
  extractAttachments(msg.payload);

  return {
    id: messageId,
    from: headers['from'] || '',
    subject: headers['subject'] || '',
    body: body.trim(),
    threadId: msg.threadId,
    attachments,
  };
}

// Retry helper for temporary Gemini trouble (429 / quota and 503 / 5xx outages / network errors)
function callWithRetry(fn, maxRetries = 4) {
  return retryTransient(fn, { maxRetries, label: 'Gemini' });
}

// ─── Classify reply with Gemini ───────────────────────────────────────────────
// Returns { replyType, employeeId, data } or null if not an automation reply
async function classifyReply(message) {
  // Allow classification even with empty body if any attachment is present
  const hasAttachment = message.attachments && message.attachments.length > 0;
  if (!message.body && !hasAttachment) return null;

  // ── Deterministic BGV shortcut — bypass Gemini entirely ──────────────────
  // If a PDF attachment has a BGV-vendor filename, it IS a bgv_report.
  // This prevents Gemini from being confused by forwarding body text like
  // "Kindly upload the BGV report" even when the PDF is right there attached.
  const BGV_FILENAME_PATTERNS = /smartscreen|bgv|background.?verif|supersoft/i;
  if (hasAttachment) {
    const bgvPdf = message.attachments.find(a =>
      a.filename && a.filename.toLowerCase().endsWith('.pdf') &&
      BGV_FILENAME_PATTERNS.test(a.filename)
    );
    if (bgvPdf) {
      // Extract employee ID from subject (format: EMP followed by alphanumerics)
      const empIdMatch = (message.subject || '').match(/\bEMP[A-Z0-9]+\b/i);
      const employeeId = empIdMatch ? empIdMatch[0].toUpperCase() : null;
      console.log(`[Gmail] ✅ Deterministic BGV PDF detected (${bgvPdf.filename}) — bypassing Gemini, classifying as bgv_report (employee: ${employeeId || 'unknown'})`);
      return {
        isOnboardingReply: true,
        replyType: 'bgv_report',
        employeeId,
        data: { bgvStatus: null, notes: `Auto-detected from attachment: ${bgvPdf.filename}` },
        confidence: 'high',
      };
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Informational emails — replies never advance a step ─────────────────
  // e.g. "Booked the room manually" in reply to the no-room alert was read by Gemini as
  // admin_allocation, which would mark seat allocation (t36) done.
  const INFO_ONLY_SUBJECTS = /No Meeting Room Booked|Onboarding Survey Sent|Onboarding Survey Response|Heads-up — Your \d+-Day/i;
  if (INFO_ONLY_SUBJECTS.test(message.subject || '')) {
    console.log(`[Gmail] Reply to an informational email ("${message.subject}") — not a workflow step, skipping`);
    return null;
  }
  // ─────────────────────────────────────────────────────────────────────────

  const genAI = getGenAI();
  if (!genAI) {
    console.warn('[Gmail] GEMINI_API_KEY not set — reply classification skipped. Replies must be processed manually.');
    return null;
  }

  const attachmentInfo = (message.attachments && message.attachments.length > 0)
    ? `ATTACHMENTS: ${message.attachments.map(a => a.filename).join(', ')}`
    : 'ATTACHMENTS: none';

  const prompt = `You are an HR automation assistant. Analyse this email and determine if it is a substantive reply to an automated HR onboarding email.

FROM: ${message.from}
SUBJECT: ${message.subject}
${attachmentInfo}
BODY:
${message.body}

Reply type definitions — use the email SUBJECT as the primary signal, then body for confirmation:
- "greythr_welcome": Automated welcome email sent directly by Greythr HRMS to the new joinee — FROM address contains "greythr" or subject contains "Welcome to" and body contains "greythr" or "self-service account". Extract the joinee's name from the greeting (e.g. "Hi Ezhava Pooja Prakash"). This is NOT a reply from HR — it is sent automatically by the Greythr system.
- "official_email_created": Reply to a "Create Official Email" request — must include an actual @company email address in the body
- "official_email_access_confirmed": Reply from the employee confirming their official email works — subject contains "Confirm Access" or "Official Email" and body contains "confirmed", "working", "yes" or similar positive acknowledgement
- "official_email_access_failed": Reply from the employee saying their official email is NOT working — body contains "not working", "issue", "can't login", "problem", "error" or similar negative response
- "manager_allocation": Reply to an "Asset & Seat Allocation" request sent TO a MANAGER — contains supervisor name, office location, asset type. This is the MANAGER confirming allocation plans BEFORE joining. Subject will contain "Asset & Seat Allocation".
- "it_allocation": Reply to an "IT Asset" request sent TO the IT TEAM — IT confirms assets are physically ready/handed over. Subject will contain "IT Asset" or "IT Team" or "IT Asset Setup Required". This happens AFTER manager_allocation. Also classify as it_allocation if IT sends a fresh email (not a reply) confirming assets are ready for the employee — look for phrases like "asset assigned", "asset ready", "laptop ready", "system ready" addressed to HR.
- "bgv_report": Reply to a BGV initiation request — HR/recruiter replying with a SmartScreen or Supersoft BGV vendor PDF attached, OR forwarding the vendor report. REQUIRES a PDF in ATTACHMENTS — do NOT classify as bgv_report if ATTACHMENTS is "none" or empty. Subject will contain "BGV" or "Background Verification" or "Initiate BGV". THE ATTACHMENT IS THE PRIMARY SIGNAL: if ATTACHMENTS contains a PDF whose filename contains "bgv", "background", "smartscreen", or "report", classify as bgv_report even if the body text sounds like a reminder or forwarding message (e.g. "Hi, kindly upload the BGV report", "Please find attached", "FYI"). Many HR people forward the vendor report with a brief note — the PDF presence confirms this is the actual submission. A text-only reply with NO attachment is NOT a bgv_report — classify those as "unknown".
- "induction_confirmed": Reply confirming HR induction meeting attendance or completion
- "admin_allocation": Reply from Admin confirming physical seat or access card allocation
- "meeting_time_preference": New joinee replies to the welcome email with preferred meeting times — subject contains "Pre-Onboarding Form" and body mentions times for induction or project intro
- "catchup25_complete": HR replies "Confirmed" to the 25th day catchup call email — subject contains "25th Day Catchup"
- "catchup_complete": Manager (cc recruiter) replies "Confirmed" to a 30-day review sheet confirmation email — subject contains "Confirm 30-Day Review"
- "review_complete": Manager replies "Confirmed" to a 60-day or 90-day review sheet confirmation email — subject contains "Confirm 60-Day Review" or "Confirm 90-Day Review"
- "review_summary_shared": Recruiter replies "Confirmed" with a screenshot attached, confirming they shared the review summary with the joinee — subject contains "Review Summary" and does NOT contain "Did You Receive". REQUIRES an image attachment — if ATTACHMENTS is none or empty, classify as "unknown" instead (recruiter forgot to attach the screenshot).
- "review_summary_received_confirmed": The new joinee replies "Confirmed" (or similar positive acknowledgement) to an email asking whether they received their review summary — subject contains "Review Summary" and "Did You Receive".
- "review_summary_not_received": The new joinee replies "Not Received" (or similar) to an email asking whether they received their review summary — subject contains "Review Summary" and "Did You Receive", and the body is negative (says they have not gotten it).
- "pre_probation_result": Confirms probation period outcome
- "doc_reupload": New joinee replies to a document rejection email with corrected document(s) attached — subject contains "Could Not Be Verified" or "Action Required" or "Re-upload" AND there are image or PDF attachments. Extract the document type from the subject into data.docType.
- "exit_mail_approval": HR replies to an "Exit Mail Approval Required" email, saying whether the joinee's exit email from the previous employer is sufficient to proceed. Subject contains "Exit Mail Approval Required". Set data.decision to "yes" if the reply approves/accepts it ("yes", "ok", "approved", "sufficient", "fine", "confirmed", "done", "proceed") or "no" if it rejects it ("no", "not sufficient", "reject", "not acceptable", "ask for relieving letter"). If it is unclear, set data.decision to null.
- "doc_manually_approved": Recruiter replies "Confirmed" to a document rejection/verification email to manually approve a document that the joinee sent directly to the recruiter. Subject will contain "Could Not Be Verified" or "Still Pending" and the body contains "confirmed", "approved", "ok", "looks good" or similar positive acknowledgement. Extract the document type from the subject (e.g. Aadhaar, PAN, Offer Letter, etc.) into data.docType.
- "candidate_no_join": Email from HR, recruiter, manager or joinee indicating the candidate did not join, has dropped out, or requesting to stop the onboarding / induction / notifications — subject or body contains phrases like "candidate not join", "did not join", "candidate not joined", "stop case", "induction stop case", "stop onboarding", "cancel case", "stop notification", "no join", "candidate left", "dropped out" or similar request. Extract any reason provided into data.notes.
- "unknown": Related to onboarding but does not clearly match any above type

IMPORTANT: If subject or body indicates candidate did not join, stop case, induction stop case, or candidate left → classify as "candidate_no_join" and set isOnboardingReply=true. If FROM contains "greythr" OR body contains "greythr.com" or "self-service account" or "payslips" and "leaves" → classify as "greythr_welcome" and extract the joinee name from the greeting line into data.notes. If the subject contains "Pre-Onboarding Form" and the body mentions preferred times for meetings → classify as "meeting_time_preference" and extract inductionTime and projectIntroTime into data. If the subject contains "Asset & Seat Allocation" → classify as "manager_allocation". If subject contains "IT Asset" or "IT Asset Setup Required" or "IT Team" → classify as "it_allocation"; also classify as it_allocation if the body contains "Asset Assigned: Y" or confirms assets are physically ready/handed over. For BGV: ATTACHMENT OVERRIDES BODY TEXT — if ATTACHMENTS contains a PDF with "smartscreen", "bgv", "background", or "report" in the filename → always classify as "bgv_report" regardless of what the body says; if subject mentions BGV but ATTACHMENTS is none or empty → classify as "unknown" (sender forgot to attach the PDF). If subject contains "Confirm Access to Your Official Email" → classify as "official_email_access_confirmed" or "official_email_access_failed" based on whether the body is positive or negative. If subject contains "25th Day Catchup" → classify as "catchup25_complete". If subject contains "Confirm 30-Day Review" → classify as "catchup_complete". If subject contains "Confirm 60-Day Review" or "Confirm 90-Day Review" → classify as "review_complete". If subject contains "Review Summary" and does NOT contain "Did You Receive" → classify as "review_summary_shared" ONLY if ATTACHMENTS contains an image (jpg/jpeg/png/heic/webp) — otherwise classify as "unknown". If subject contains "Review Summary" AND "Did You Receive" → classify as "review_summary_received_confirmed" if the body is a positive acknowledgement (e.g. "confirmed", "yes", "received"), or "review_summary_not_received" if the body says they have not received it (e.g. "not received", "no", "haven't got it"). If subject contains "Could Not Be Verified" or "Action Required" or "Re-upload" AND there are attachments in ATTACHMENTS → classify as "doc_reupload" (joinee re-sending corrected document). If subject contains "Exit Mail Approval Required" → classify as "exit_mail_approval" and set data.decision to "yes", "no" or null. If subject contains "Could Not Be Verified" or "Still Pending" and body is a positive confirmation with NO attachments → classify as "doc_manually_approved". Subject is the strongest signal; but for BGV the ATTACHMENT FILENAME is the strongest signal.
EXIT MAIL APPROVAL: a reply whose subject contains "Exit Mail Approval Required" is ALWAYS "exit_mail_approval" (never candidate_no_join or an acknowledgement) — even a one-word reply such as "ok", "yes", "fine", "no" is HR's decision, not a simple acknowledgement.
"DONE" MEANS "CONFIRMED": wherever a type above says the sender replies "Confirmed", a reply of "Done" (or "done", "Done.", "Done - attached", "Confirmed / Done") means exactly the same thing — classify it as that same type, with the same attachment rules (e.g. review_summary_shared and catchup25_complete still need an image attached). "Confirmed" and "Done" are workflow confirmations, NOT simple acknowledgements.
Simple acknowledgements ("ok", "noted", "will do", "thanks") should be classified with isOnboardingReply=false unless they contain substantive information.

Respond ONLY with a JSON object in this exact format:
{
  "isOnboardingReply": true/false,
  "replyType": one of the types above or null,
  "employeeId": "extracted employee ID (e.g. EMP007) from subject/body — prefer the ID code over the name; look for patterns like EMP followed by digits in the subject line",
  "data": {
    "officialEmail": "extracted official email address or null",
    "assetType": "extracted asset type or null",
    "officeLocation": "extracted office location or null",
    "supervisorName": "extracted supervisor/buddy name or null",
    "bgvStatus": "extracted BGV status or null",
    "inductionTime": "preferred HR Induction time if mentioned e.g. '10:00 AM' or null",
    "projectIntroTime": "preferred Project Intro Meeting time if mentioned e.g. '3:00 PM' or null",
    "docType": "document type extracted from subject if this is a doc_manually_approved reply — e.g. 'Aadhaar', 'PAN', 'Offer Letter', 'Payslip', 'Relieving Letter', '10th Marksheet', '12th Marksheet', 'Degree Certificate', 'Post Graduation Certificate', 'Passport Size Photo' — or null",
    "decision": "yes or no if this is an exit_mail_approval reply, otherwise null",
    "notes": "any other relevant details"
  },
  "confidence": "high/medium/low"
}

If this is not related to onboarding or is just a simple acknowledgement, set isOnboardingReply=false and use null for all other fields.`;

  const model = genAI.getGenerativeModel({ model: config.geminiModel });
  const response = await callWithRetry(() => model.generateContent(prompt));
  const raw = response.response.text().trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const result = JSON.parse(jsonMatch[0]);
  if (!result.isOnboardingReply) return null;

  // Keep employee matching reliable when Gemini omits an ID or truncates one
  // containing underscores/hyphens. The official-email request subject carries
  // the ID, so use it as a deterministic fallback.
  if (!result.employeeId) {
    const idMatch = `${message.subject} ${message.body || ''}`.match(/\bEMP[A-Z0-9_-]+\b/i);
    if (idMatch) result.employeeId = idMatch[0].toUpperCase();
  }
  if (result.replyType === 'official_email_created' && !result.data?.officialEmail) {
    const emailMatch = (message.body || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (emailMatch) {
      result.data = result.data || {};
      result.data.officialEmail = emailMatch[0];
    }
  }

  console.log(`[Gmail] Reply classified as "${result.replyType}" for employee ${result.employeeId} (confidence: ${result.confidence})`);
  return result;
}

// Download a Gmail attachment by attachmentId and return as a Buffer
async function downloadAttachment(auth, messageId, attachmentId) {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  return Buffer.from(res.data.data, 'base64');
}

// Mark a message as read after processing
async function markAsRead(auth, messageId) {
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

// In-memory dedup sets — prevents the same message from being processed twice
// even if Pub/Sub delivers the same push multiple times concurrently.
const processedMessageIds = new Set();
const processingLocks = new Set(); // IDs currently being processed (in-flight)

// Handles ONE incoming message end to end (STOP command, or Gemini classification + dispatch).
// Throws on failure; a Gemini outage that outlasts the in-call retries is flagged err.serviceUnavailable.
async function processOneMessage(auth, messageId, onReplyClassified) {
  const full = await fetchMessageBody(auth, messageId);

  // ── STOP automation command — deterministic, no Gemini needed ────────────
  // Authorized sender: hr@alethea.in
  // Subject can be in any natural form — all of the following work:
  //   "EMP0475 STOP ONBOARDING"
  //   "STOP ONBOARDING EMP0475"
  //   "EMP0475 no join"
  //   "stop case EMP0475"
  //   "cancel onboarding EMP0475"
  //   "EMP0475 candidate did not join"
  // This fires BEFORE Gemini so it is instant, reliable, and costs no quota.
  const STOP_AUTHORIZED_SENDER = 'hr@alethea.in';
  const STOP_KEYWORDS = /\b(stop|cancel|no.?join|did.?not.?join|not.?joining|drop(?:ped)?(?:.?out)?|withdraw|left|induction.?stop|stop.?case|stop.?onboarding|onboarding.?stop)\b/i;
  // Extract employee ID (EMP followed by alphanumerics) from subject or body
  const subjectAndBody = full.subject + ' ' + (full.body || '');
  const empIdMatch = subjectAndBody.match(/\bEMP[A-Z0-9]+\b/i);
  const fromRaw = full.from || '';
  const fromEmail = fromRaw.toLowerCase().replace(/.*<([^>]+)>.*/, '$1').trim()
                    || fromRaw.toLowerCase().trim();

  const isStopEmail = fromEmail === STOP_AUTHORIZED_SENDER
                      && STOP_KEYWORDS.test(full.subject)
                      && empIdMatch;

  if (isStopEmail) {
    const empId = empIdMatch[0].toUpperCase();
    console.log(`[Gmail] ⛔ Stop onboarding email detected — Employee: ${empId}, Sender: ${fromEmail}, Subject: "${full.subject}"`);
    await markAsRead(auth, messageId).catch(() => {});
    await onReplyClassified(
      {
        isOnboardingReply: true,
        replyType: 'candidate_no_join',
        employeeId: empId,
        data: {
          notes: `STOP automation command received via email from ${fromEmail} — Subject: "${full.subject}"`,
        },
        confidence: 'high',
      },
      full
    );
    // Skip Gemini classification for this message — already handled above
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  const classified = await classifyReply(full);
  if (classified && classified.confidence === 'low') {
    console.warn(`[Gmail] Low-confidence reply dropped — from: ${full.from}, subject: ${full.subject}`);
    // Mark as read first so this message is never re-fetched on next push
    await markAsRead(auth, messageId).catch(() => {});
    // Alert HR so the reply isn't silently lost
    const { sendEmail } = require('./emailSender');
    await sendEmail({
      to: process.env.HR_EMAIL,
      subject: `HR Automation — Unclassified Reply Received`,
      html: `
        <p>Hi HR Team,</p>
        <p>An email reply was received that the automation could not confidently classify. Please review it manually:</p>
        <ul>
          <li><strong>From:</strong> ${full.from}</li>
          <li><strong>Subject:</strong> ${full.subject}</li>
        </ul>
        <blockquote style="border-left:4px solid #ffa000;padding:8px 16px;background:#fffde7;color:#555;">${escHtml((full.body || '').slice(0, 500))}</blockquote>
        <p>If this is an onboarding reply, you can manually mark the relevant task via the status dashboard.</p>
        <p>Regards,<br/>${process.env.COMPANY_NAME} HR Automation</p>
      `,
    }).catch(err => console.warn('[Gmail] Could not send low-confidence alert to HR:', err.message));
  } else if (classified) {
    await onReplyClassified(classified, full);
    await markAsRead(auth, messageId);
  }
}

// ─── Gemini-outage retries ────────────────────────────────────────────────────
// If Gemini is down when a reply arrives, the message is NOT marked read and not dropped: it is
// re-processed every RETRY_DELAY_MS, up to MAX_RETRIES times (~25 min). Only then is it marked read
// and HR alerted, so it can never vanish silently. (In-memory — a restart forgets pending retries,
// but the message stays unread in the inbox.)
const RETRY_DELAY_MS = 3 * 60 * 1000;
const MAX_RETRIES = 8;
const retryAttempts = new Map(); // messageId -> attempts so far

async function alertHrGaveUp(auth, messageId) {
  let from = 'unknown', subject = 'unknown';
  try { const full = await fetchMessageBody(auth, messageId); from = full.from; subject = full.subject; } catch (_) {}
  try {
    const { sendEmail } = require('./emailSender');
    await sendEmail({
      to: process.env.HR_EMAIL,
      subject: `HR Automation — Reply Not Processed (Gemini unavailable)`,
      html: `
        <p>Hi HR Team,</p>
        <p>An email reply could not be read by the automation because Gemini stayed unavailable after ${MAX_RETRIES} retries. Please handle it manually:</p>
        <ul>
          <li><strong>From:</strong> ${escHtml(from)}</li>
          <li><strong>Subject:</strong> ${escHtml(subject)}</li>
        </ul>
        <p>If it is an onboarding reply, you can manually mark the relevant task via the status dashboard.</p>
        <p>Regards,<br/>${process.env.COMPANY_NAME} HR Automation</p>
      `,
    });
  } catch (err) {
    console.warn('[Gmail] Could not send gave-up alert to HR:', err.message);
  }
}

// Called when processing a message failed. Schedules a retry for a temporary Gemini outage;
// any other error keeps the old behaviour (log + mark read).
async function handleProcessingError(auth, messageId, err, onReplyClassified) {
  if (!err.serviceUnavailable) {
    console.error(`[Gmail] Error processing message ${messageId}:`, err.message);
    await markAsRead(auth, messageId).catch(() => {});
    return;
  }
  const attempts = retryAttempts.get(messageId) || 0;
  if (attempts >= MAX_RETRIES) {
    retryAttempts.delete(messageId);
    console.error(`[Gmail] Giving up on message ${messageId} after ${attempts} retries — Gemini still unavailable`);
    await markAsRead(auth, messageId).catch(() => {});
    await alertHrGaveUp(auth, messageId);
    return;
  }
  retryAttempts.set(messageId, attempts + 1);
  console.warn(`[Gmail] Gemini unavailable — message ${messageId} left unread, retry ${attempts + 1}/${MAX_RETRIES} in ${Math.round(RETRY_DELAY_MS / 60000)} min`);
  const timer = setTimeout(async () => {
    if (processingLocks.has(messageId)) return;
    processingLocks.add(messageId);
    try {
      await processOneMessage(auth, messageId, onReplyClassified);
      retryAttempts.delete(messageId);
    } catch (e) {
      await handleProcessingError(auth, messageId, e, onReplyClassified);
    } finally {
      processingLocks.delete(messageId);
    }
  }, RETRY_DELAY_MS);
  if (timer && timer.unref) timer.unref();
}

// ─── Main entry point called by webhookServer when a Gmail push arrives ───────
// `onReplyClassified` is a callback: (classified) => void
async function processGmailPush(auth, pushData, onReplyClassified) {
  // pushData is base64-encoded JSON: { emailAddress, historyId }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(pushData.message.data, 'base64').toString());
  } catch {
    console.warn('[Gmail] Could not decode push payload');
    return;
  }

  const { historyId } = decoded;
  if (!historyId) {
    // historyId can be absent in some Pub/Sub delivery edge cases.
    // Fall back to scanning recent unread messages so replies are never silently dropped.
    console.warn('[Gmail] Push payload missing historyId — falling back to recent unread scan');
    const gmail = google.gmail({ version: 'v1', auth });
    let fallbackMessages = [];
    try {
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread in:inbox',
        maxResults: 20,
      });
      fallbackMessages = res.data.messages || [];
    } catch (err) {
      console.error('[Gmail] Fallback unread scan failed:', err.message);
      return;
    }
    console.log(`[Gmail] Fallback scan found ${fallbackMessages.length} unread message(s)`);

    for (const msg of fallbackMessages) {
      if (processedMessageIds.has(msg.id) || processingLocks.has(msg.id)) {
        console.log(`[Gmail] Skipping already-processed message ${msg.id}`);
        continue;
      }
      processedMessageIds.add(msg.id);
      processingLocks.add(msg.id);
      try {
        const full = await fetchMessageBody(auth, msg.id);
        const classified = await classifyReply(full);
        if (classified && classified.confidence !== 'low') {
          await onReplyClassified(classified, full);
          await markAsRead(auth, msg.id);
        } else if (classified && classified.confidence === 'low') {
          await markAsRead(auth, msg.id).catch(() => {});
        }
      } catch (err) {
        if (err.serviceUnavailable) {
          await handleProcessingError(auth, msg.id, err, onReplyClassified);
        } else {
          console.error(`[Gmail] Fallback: error processing message ${msg.id}:`, err.message);
        }
      } finally {
        processingLocks.delete(msg.id);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return;
  }
  console.log(`[Gmail] Push received — historyId: ${historyId}`);

  const messages = await getNewMessages(auth, historyId);
  console.log(`[Gmail] ${messages.length} new message(s) to process`);

  for (const msg of messages) {
    if (processedMessageIds.has(msg.id) || processingLocks.has(msg.id)) {
      console.log(`[Gmail] Skipping already-processed message ${msg.id}`);
      continue;
    }
    processedMessageIds.add(msg.id);
    processingLocks.add(msg.id);
    try {
      await processOneMessage(auth, msg.id, onReplyClassified);
    } catch (err) {
      await handleProcessingError(auth, msg.id, err, onReplyClassified);
    } finally {
      processingLocks.delete(msg.id);
    }
    // Brief pause between messages to avoid Gmail API quota bursts
    await new Promise(r => setTimeout(r, 500));
  }
}

module.exports = {
  registerGmailWatch,
  renewGmailWatch,
  processGmailPush,
  downloadAttachment,
};
