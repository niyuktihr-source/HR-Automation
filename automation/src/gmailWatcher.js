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

// Retry helper for Gemini quota / rate-limit errors (429 / RESOURCE_EXHAUSTED)
async function callWithRetry(fn, maxRetries = 4) {
  let delay = 10000; // start at 10s
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.message && (
        err.message.includes('429') ||
        err.message.includes('quota') ||
        err.message.includes('RESOURCE_EXHAUSTED')
      );
      if (is429 && attempt < maxRetries) {
        const retryMatch = err.message.match(/"retryDelay":"(\d+)s"/);
        const waitMs = retryMatch ? parseInt(retryMatch[1]) * 1000 + 2000 : delay;
        console.warn(`[Gemini] Quota hit — waiting ${Math.round(waitMs / 1000)}s before retry ${attempt}/${maxRetries}`);
        await new Promise(r => setTimeout(r, waitMs));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

// ─── Classify reply with Gemini ───────────────────────────────────────────────
// Returns { replyType, employeeId, data } or null if not an automation reply
async function classifyReply(message) {
  // Allow classification even with empty body if any attachment is present
  const hasAttachment = message.attachments && message.attachments.length > 0;
  if (!message.body && !hasAttachment) return null;

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
- "it_allocation": Reply to an "IT Asset" request sent TO the IT TEAM — IT confirms assets are physically ready/handed over. Subject will contain "IT Asset" or "IT Team". This happens AFTER manager_allocation.
- "bgv_report": Reply to a BGV initiation request — HR/recruiter replying with a SmartScreen or Supersoft BGV vendor PDF attached, OR forwarding the vendor report. Subject will contain "BGV" or "Background Verification" or "Initiate BGV". Classify as bgv_report if the subject mentions BGV/Background Verification AND there is a PDF in ATTACHMENTS, even if the body is brief or just "Please find attached". Also classify as bgv_report if the ATTACHMENTS field contains a PDF whose filename looks like a BGV report (e.g. contains "BGV", "background", "smartscreen", "report").
- "induction_confirmed": Reply confirming HR induction meeting attendance or completion
- "admin_allocation": Reply from Admin confirming physical seat or access card allocation
- "meeting_time_preference": New joinee replies to the welcome email with preferred meeting times — subject contains "Pre-Onboarding Form" and body mentions times for induction or project intro
- "catchup25_complete": HR replies "Confirmed" to the 25th day catchup call email — subject contains "25th Day Catchup"
- "catchup_complete": Confirms a 30-day catchup call was completed
- "review_complete": Confirms a 60-day or 90-day performance review was completed
- "pre_probation_result": Confirms probation period outcome
- "doc_reupload": New joinee replies to a document rejection email with corrected document(s) attached — subject contains "Could Not Be Verified" or "Action Required" or "Re-upload" AND there are image or PDF attachments. Extract the document type from the subject into data.docType.
- "doc_manually_approved": Recruiter replies "Confirmed" to a document rejection/verification email to manually approve a document that the joinee sent directly to the recruiter. Subject will contain "Could Not Be Verified" or "Still Pending" and the body contains "confirmed", "approved", "ok", "looks good" or similar positive acknowledgement. Extract the document type from the subject (e.g. Aadhaar, PAN, Offer Letter, etc.) into data.docType.
- "candidate_no_join": Email from HR, recruiter, manager or joinee indicating the candidate did not join, has dropped out, or requesting to stop the onboarding / induction / notifications — subject or body contains phrases like "candidate not join", "did not join", "candidate not joined", "stop case", "induction stop case", "stop onboarding", "cancel case", "stop notification", "no join", "candidate left", "dropped out" or similar request. Extract any reason provided into data.notes.
- "unknown": Related to onboarding but does not clearly match any above type

IMPORTANT: If subject or body indicates candidate did not join, stop case, induction stop case, or candidate left → classify as "candidate_no_join" and set isOnboardingReply=true. If FROM contains "greythr" OR body contains "greythr.com" or "self-service account" or "payslips" and "leaves" → classify as "greythr_welcome" and extract the joinee name from the greeting line into data.notes. If the subject contains "Pre-Onboarding Form" and the body mentions preferred times for meetings → classify as "meeting_time_preference" and extract inductionTime and projectIntroTime into data. If the subject contains "Asset & Seat Allocation" → classify as "manager_allocation". If subject contains "IT Asset" → classify as "it_allocation". If subject contains "BGV" or "Background Verification" or "Initiate BGV" → classify as "bgv_report" (even if body is just "Please find attached"). If subject contains "Confirm Access to Your Official Email" → classify as "official_email_access_confirmed" or "official_email_access_failed" based on whether the body is positive or negative. If subject contains "25th Day Catchup" → classify as "catchup25_complete". If subject contains "Could Not Be Verified" or "Action Required" or "Re-upload" AND there are attachments in ATTACHMENTS → classify as "doc_reupload" (joinee re-sending corrected document). If subject contains "Could Not Be Verified" or "Still Pending" and body is a positive confirmation with NO attachments → classify as "doc_manually_approved". Subject is the strongest signal.
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
        console.error(`[Gmail] Fallback: error processing message ${msg.id}:`, err.message);
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
      const full = await fetchMessageBody(auth, msg.id);

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
        await markAsRead(auth, msg.id).catch(() => {});
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
        processingLocks.delete(msg.id);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      // ─────────────────────────────────────────────────────────────────────────

      const classified = await classifyReply(full);
      if (classified && classified.confidence === 'low') {
        console.warn(`[Gmail] Low-confidence reply dropped — from: ${full.from}, subject: ${full.subject}`);
        // Mark as read first so this message is never re-fetched on next push
        await markAsRead(auth, msg.id).catch(() => {});
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
        await markAsRead(auth, msg.id);
      }
    } catch (err) {
      console.error(`[Gmail] Error processing message ${msg.id}:`, err.message);
      await markAsRead(auth, msg.id).catch(() => {});
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
