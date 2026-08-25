// One-shot: fire 25-day catchup milestone for an employee.
// Usage: node src/fire25Day.js EMP008
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const { google } = require('googleapis');
const { decrypt } = require('./encryption');
const { send25DayCatchupEmail, sendEmail } = require('./emailSender');
const { getOrCreateCatchupSheet, mark25DayCatchupDone } = require('./statusTracker');
const { create25DayCatchupEvent } = require('./calendarService');
const config = require('./config');

const employeeId = process.argv[2];
if (!employeeId) { console.error('Usage: node src/fire25Day.js <employeeId>'); process.exit(1); }

const STATE_DIR = path.join(__dirname, '..');
const stateFile = path.join(STATE_DIR, `state-${employeeId}.json`);
if (!fs.existsSync(stateFile)) { console.error(`No state file for ${employeeId}`); process.exit(1); }

const raw  = fs.readFileSync(stateFile, 'utf8');
const data = JSON.parse(raw);
const state = data.ciphertext ? JSON.parse(decrypt(raw)) : data;

const empList = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'employees.json'), 'utf8'));
const empBase = empList.find(e => e.employeeId === employeeId);
if (!empBase) { console.error(`${employeeId} not found in employees.json`); process.exit(1); }

const employee = { ...empBase, ...state, employeeId };

const credsPath = path.join(__dirname, '..', 'credentials.json');
const tokenPath = path.join(__dirname, '..', 'token.json');
const creds = JSON.parse(fs.readFileSync(credsPath));
const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials(JSON.parse(fs.readFileSync(tokenPath)));
employee._auth = auth;

async function run() {
  console.log(`\nFiring 25-day catchup for ${employee.name} (${employeeId})...`);

  // Ensure personal catchup sheet copy is created from master template in joinee's folder
  const catchupUrl = await getOrCreateCatchupSheet(auth, employee).catch(e => {
    console.warn('  Catchup sheet copy failed:', e.message);
    return null;
  });
  if (catchupUrl) console.log(`  ✓ Catchup sheet created: ${catchupUrl}`);

  // Create calendar event
  let catchupCalendarLink = null;
  let catchupDateStr = null;
  const calResult = await create25DayCatchupEvent(auth, employee).catch(err => {
    console.warn('  Calendar event failed:', err.message);
    return null;
  });
  if (calResult) {
    catchupCalendarLink = calResult.htmlLink;
    const cfg = config.calendarEvents.catchup25day;
    const d = calResult.eventDate;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const hour = cfg.hour > 12 ? cfg.hour - 12 : cfg.hour;
    const ampm = cfg.hour >= 12 ? 'PM' : 'AM';
    catchupDateStr = `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} at ${hour}:${String(cfg.minute).padStart(2,'0')} ${ampm} IST`;
    console.log('  ✓ Calendar event created:', catchupDateStr);
  }

  // Send feedback form + catchup email to new joinee
  const feedbackFormLink = process.env.EMPLOYEE_FEEDBACK_FORM_LINK;
  const formSection = feedbackFormLink
    ? `<p><a href="${feedbackFormLink}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;">Employee Feedback Form</a></p>`
    : `<p style="color:#e65100;">Feedback form link not configured — HR will share it separately.</p>`;
  const catchupSection = catchupDateStr
    ? `<p>You also have a <strong>25-Day Catchup Call</strong> scheduled on <strong>${catchupDateStr}</strong>. Please check your calendar for the invite${catchupCalendarLink ? ` or <a href="${catchupCalendarLink}">view the event here</a>` : ''}.</p>`
    : `<p>Your HR team will be in touch to schedule a 25-day catchup call with you soon.</p>`;

  await sendEmail({
    to: employee.officialEmail || employee.personalEmail,
    subject: `Employee Feedback Form — ${process.env.COMPANY_NAME}`,
    html: `
      <p>Dear ${employee.name},</p>
      <p>You've been with us for 25 days! Please take a moment to fill in the employee feedback form:</p>
      ${formSection}
      ${catchupSection}
      <p>Regards,<br/>HR Team, ${process.env.COMPANY_NAME}</p>
    `,
  }).catch(e => console.warn('  Feedback form email failed:', e.message));
  console.log('  ✓ Feedback form email sent to joinee');

  // Send 25-day catchup email to HR/recruiter
  await send25DayCatchupEmail(employee).catch(e => console.warn('  25-day catchup HR email failed:', e.message));
  console.log('  ✓ 25-day catchup email sent to HR');

  // Mark sheet milestone Done
  await mark25DayCatchupDone(auth, employee);
  console.log('  ✓ Sheet: 25th day catchup call completed → Done');

  console.log('\nDone. Check your email and the status sheet.');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
