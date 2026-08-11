require('dotenv').config();
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

// Resolve HR email for a specific employee — uses per-employee hrEmail from recruiter form,
// falling back to the global HR_EMAIL env var.
function resolveHrEmail(employee) {
  return (employee && employee.contacts && employee.contacts.hrEmail) || process.env.HR_EMAIL;
}

// Escape user-controlled strings before embedding in HTML email bodies
function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Nodemailer transporter using Gmail App Password (SMTP)
function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

// Send via nodemailer + Gmail App Password
async function sendEmail({ to, subject, html }, retries = 3) {
  const sender = process.env.GMAIL_USER;
  const fromName = process.env.COMPANY_NAME ? `${process.env.COMPANY_NAME} HR` : 'HR Team';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const transporter = getTransporter();
      const info = await transporter.sendMail({
        from: `"${fromName}" <${sender}>`,
        to,
        subject,
        html,
      });
      console.log(`[Email] Sent to ${to} — ${subject} (${info.messageId})`);
      return info;
    } catch (err) {
      if (attempt === retries) {
        console.error(`[Email] Failed after ${retries} attempts — ${subject} to ${to}: ${err.message}`);
        throw err;
      }
      const delay = attempt * 5000;
      console.warn(`[Email] Attempt ${attempt} failed, retrying in ${delay / 1000}s — ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Template 1: Pre-onboarding form sent to new joinee
// Sends fresher form or experienced form based on employee.isFresher flag
// Generates a pre-filled URL so Employee ID and Drive Folder ID are embedded silently
async function sendPreOnboardingForm(employee) {
  const { name, personalEmail, doj, employeeId, driveFolderId } = employee;

  const baseLink = employee.isFresher
    ? (process.env.PREONBOARDING_FORM_FRESHER_LINK || process.env.PREONBOARDING_FORM_LINK || '')
    : (process.env.PREONBOARDING_FORM_EXPERIENCED_LINK || process.env.PREONBOARDING_FORM_LINK || '');

  // Entry IDs for "Employee ID" and "Drive Folder ID" hidden fields in each form
  const FRESHER_EMPLOYEE_ID_ENTRY  = 'entry.2053877771';
  const FRESHER_FOLDER_ID_ENTRY    = 'entry.744388872';
  const EXPERIENCED_EMPLOYEE_ID_ENTRY = 'entry.2039881686';
  const EXPERIENCED_FOLDER_ID_ENTRY   = 'entry.1556025136';

  const empEntry    = employee.isFresher ? FRESHER_EMPLOYEE_ID_ENTRY  : EXPERIENCED_EMPLOYEE_ID_ENTRY;
  const folderEntry = employee.isFresher ? FRESHER_FOLDER_ID_ENTRY    : EXPERIENCED_FOLDER_ID_ENTRY;

  let formLink = '#';
  if (baseLink) {
    const base = baseLink.replace(/[?#].*$/, '');
    const parts = ['usp=pp_url'];
    if (employeeId)    parts.push(`${empEntry}=${encodeURIComponent(employeeId)}`);
    if (driveFolderId) parts.push(`${folderEntry}=${encodeURIComponent(driveFolderId)}`);
    formLink = `${base}?${parts.join('&')}`;
  }

  const formSection = formLink === '#'
    ? `<p style="color:#c62828;">⚠️ The pre-onboarding form link has not been configured. Please contact HR directly.</p>`
    : `<p><a href="${esc(formLink)}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;">Complete Pre-Onboarding Form</a></p>`;
  return sendEmail({
    to: personalEmail,
    subject: `Welcome to ${process.env.COMPANY_NAME}! Action Required — Pre-Onboarding Form (${esc(employeeId)})`,
    html: `
      <p>Dear ${esc(name)},</p>
      <p>We are delighted to welcome you to <strong>${esc(process.env.COMPANY_NAME)}</strong>!</p>
      <p>Your Date of Joining is <strong>${esc(doj)}</strong>. To ensure a smooth onboarding, please complete the pre-onboarding form and upload all your documents.</p>
      <p>Your <strong>Employee ID</strong> is: <strong style="font-size:16px;">${esc(employeeId)}</strong> — you will need to enter this in the form.</p>
      ${formSection}
      <p>Please submit within <strong>24 hours</strong> of receiving this email.</p>
      <p>Looking forward to having you on board!<br/>HR Team, ${esc(process.env.COMPANY_NAME)}</p>
    `,
  });
}

// Template 2: Document verification failed — ask employee to send document to recruiter
async function sendDocumentRejection(employee, docType, reason) {
  const { name, personalEmail, contacts } = employee;
  const recruiterEmail = (contacts && contacts.recruiterEmail) || process.env.HR_EMAIL;
  const co = esc(process.env.COMPANY_NAME || '');

  // Email to joinee
  await sendEmail({
    to: personalEmail,
    subject: `Action Required — ${esc(docType)} Could Not Be Verified`,
    html: `
      <p>Dear ${esc(name)},</p>
      <p>Thank you for submitting your documents. Unfortunately we could not verify your <strong>${esc(docType)}</strong>:</p>
      <blockquote style="border-left:4px solid #e53935;padding:8px 16px;color:#555;">${esc(reason)}</blockquote>
      <p>Please <strong>reply to this email</strong> with a clear, legible copy of your <strong>${esc(docType)}</strong> attached. Our system will verify it automatically.</p>
      <p>Please ensure:</p>
      <ul>
        <li>The document is clearly legible — not blurry or cropped</li>
        <li>All required fields are fully visible</li>
        <li>Accepted formats: PDF, JPG, PNG</li>
      </ul>
      <p>Please reply within <strong>24 hours</strong>.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });

  // Notify recruiter — FYI only, no action needed
  if (recruiterEmail) {
    await sendEmail({
      to: recruiterEmail,
      subject: `Document Verification Failed — ${esc(docType)} for ${esc(name)} (${esc(employee.employeeId)})`,
      html: `
        <p>Hi,</p>
        <p>The <strong>${esc(docType)}</strong> submitted by <strong>${esc(name)}</strong> (${esc(employee.employeeId)}) could not be verified:</p>
        <blockquote style="border-left:4px solid #e53935;padding:8px 16px;color:#555;">${esc(reason)}</blockquote>
        <p>The employee has been notified and asked to resubmit. You will be updated once the document is verified.</p>
        <p>Regards,<br/>${co} HR Automation</p>
      `,
    }).catch(() => {});
  }
}

// Template 2b: Follow-up reminder to employee (sent at 24h / 48h after rejection)
async function sendDocumentReminder(employee, docType, attemptNumber, reason) {
  const { name, personalEmail, contacts, doj } = employee;
  const recruiterEmail = (contacts && contacts.recruiterEmail) || process.env.HR_EMAIL;
  const co = esc(process.env.COMPANY_NAME || '');
  const urgency = attemptNumber >= 3 ? 'Final Reminder' : `Reminder ${attemptNumber}`;
  const dojFormatted = doj ? new Date(doj).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
  const extra = attemptNumber >= 3
    ? `<p style="color:#c62828;font-weight:bold;">This is your final reminder. If the document is not received within 24 hours, your recruiter will be notified and your onboarding may be delayed.</p>`
    : '';
  return sendEmail({
    to: personalEmail,
    subject: `${urgency} — ${esc(docType)} still pending for your onboarding (DOJ: ${dojFormatted})`,
    html: `
      <p>Dear ${esc(name)},</p>
      <div style="margin:16px 0;padding:12px 16px;background:#fff8e1;border-left:4px solid #ffa000;border-radius:2px;">
        <p style="margin:0 0 4px;font-weight:bold;color:#333;">Why are you receiving this?</p>
        <p style="margin:0;color:#555;">Your <strong>${esc(docType)}</strong> was either not submitted or did not pass verification. This document is required to complete your pre-onboarding and proceed with your joining on <strong>${dojFormatted}</strong>.</p>
        ${reason ? `<p style="margin:8px 0 0;color:#c62828;font-size:13px;"><strong>Reason flagged:</strong> ${esc(reason)}</p>` : ''}
      </div>
      <p><strong>What to do:</strong> Reply to this email with a clear, legible copy of your <strong>${esc(docType)}</strong> attached.</p>
      <ul>
        <li>Document must be clearly legible — not blurry or cropped</li>
        <li>All required fields must be fully visible</li>
        <li>Accepted formats: PDF, JPG, PNG</li>
      </ul>
      ${extra}
      <p>If you have any trouble, contact your recruiter: <a href="mailto:${esc(recruiterEmail)}">${esc(recruiterEmail)}</a></p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 2c: Pre-onboarding form reminder to joinee (24h / 48h / 72h)
async function sendPreOnboardingReminder(employee, attemptNumber) {
  const { name, personalEmail, contacts, doj } = employee;
  const recruiterEmail = (contacts && contacts.recruiterEmail) || process.env.HR_EMAIL;
  const co = esc(process.env.COMPANY_NAME || '');
  const formLink = employee.isFresher
    ? (process.env.PREONBOARDING_FORM_FRESHER_LINK || process.env.PREONBOARDING_FORM_LINK || '#')
    : (process.env.PREONBOARDING_FORM_EXPERIENCED_LINK || process.env.PREONBOARDING_FORM_LINK || '#');
  const urgency = attemptNumber >= 3 ? 'Final Reminder' : `Reminder ${attemptNumber}`;
  const dojFormatted = doj ? new Date(doj).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
  const finalWarning = attemptNumber >= 3
    ? `<p style="color:#c62828;font-weight:bold;">This is your final reminder. If the form is not filled, your recruiter will be notified and your onboarding preparation may be delayed.</p>`
    : '';
  return sendEmail({
    to: personalEmail,
    subject: `${urgency} — Pre-Onboarding Form not filled | Your joining is on ${dojFormatted}`,
    html: `
      <p>Dear ${esc(name)},</p>
      <div style="margin:16px 0;padding:12px 16px;background:#fff8e1;border-left:4px solid #ffa000;border-radius:2px;">
        <p style="margin:0 0 4px;font-weight:bold;color:#333;">Why are you receiving this?</p>
        <p style="margin:0;color:#555;">You have been selected to join <strong>${co}</strong> on <strong>${dojFormatted}</strong>. Before your joining, you need to fill a pre-onboarding form so HR can prepare your documents, credentials, and workspace. This form has not been filled yet.</p>
      </div>
      <p><strong>What to do:</strong> Click the button below and complete the form. It takes less than 5 minutes.</p>
      <p style="margin:16px 0;">
        <a href="${formLink}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">Fill Pre-Onboarding Form</a>
      </p>
      ${finalWarning}
      <p>If you face any issues, contact your recruiter: <a href="mailto:${esc(recruiterEmail)}">${esc(recruiterEmail)}</a></p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 3: No-response priority notice to recruiter when joinee hasn't filled pre-onboarding form
async function sendNoResponseAlert(employee, recruiterEmail) {
  const { name, employeeId, personalEmail, doj } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const dojFormatted = doj ? new Date(doj).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
  return sendEmail({
    to: recruiterEmail,
    subject: `Respond on Priority — ${esc(name)} (${esc(employeeId)}) has not filled the pre-onboarding form`,
    html: `
      <p>Hi,</p>
      <p><strong>Respond on Priority.</strong></p>
      <p><strong>${esc(name)}</strong> (ID: ${esc(employeeId)}, DOJ: ${dojFormatted}) has not filled the pre-onboarding form even after multiple reminders. It has been more than <strong>24 hours</strong> since the last reminder was sent to <strong>${esc(personalEmail)}</strong>.</p>
      <p><strong>What needs to happen:</strong> Please contact ${esc(name)} directly and ask them to complete the pre-onboarding form immediately. The form must be submitted before the Date of Joining so the onboarding checklist can proceed.</p>
      <p>If the candidate has already submitted the form or if there is an issue with their email, please let the HR team know so the system can be updated.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 4: Request to HR to create official email ID + greythr login
async function sendOfficialEmailCreationRequest(employee) {
  const { name, employeeId, doj, personalEmail } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  return sendEmail({
    to: resolveHrEmail(employee),
    subject: `Action Required — Create Official Email & Greythr Login for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi HR Team,</p>
      <p>Pre-onboarding documents for <strong>${esc(name)}</strong> have been verified. Please create the following before DOJ on <strong>${esc(doj)}</strong>:</p>
      <ol>
        <li>Official ${co} email ID</li>
        <li>Greythr login credentials</li>
      </ol>
      <ul>
        <li>Name: ${esc(name)}</li>
        <li>Employee ID: ${esc(employeeId)}</li>
        <li>Personal Email: ${esc(personalEmail)}</li>
        <li>Date of Joining: ${esc(doj)}</li>
      </ul>
      <p>Please reply with the official email ID and Greythr confirmation so we can proceed.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 4b: Test email to new official address — employee replies to confirm access
async function sendOfficialEmailAccessTest(employee) {
  const { name, employeeId, officialEmail } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  return sendEmail({
    to: officialEmail,
    subject: `Welcome to ${co} — Please Confirm Access to Your Official Email (${esc(employeeId)})`,
    html: `
      <p>Hi ${esc(name)},</p>
      <p>Welcome to <strong>${co}</strong>! Your official email ID has been created.</p>
      <p>To confirm that you can access this inbox, simply <strong>reply to this email</strong> with the word <strong>"Confirmed"</strong>.</p>
      <p>Once we receive your confirmation, your onboarding checklist will be updated automatically.</p>
      <p>If you face any issues logging in, please contact HR immediately.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 5: Asset allocation request to reporting manager
async function sendAssetAllocationRequest(employee, managerEmail) {
  const { name, employeeId, doj } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  return sendEmail({
    to: managerEmail,
    subject: `Action Required — Asset & Seat Allocation for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi,</p>
      <p>New team member <strong>${esc(name)}</strong> (ID: ${esc(employeeId)}) is joining on <strong>${esc(doj)}</strong>. Please advise on:</p>
      <ol>
        <li>Asset allocation (laptop, peripherals, etc.)</li>
        <li>Office location / work site</li>
        <li>Supervisor / buddy allocation</li>
      </ol>
      <p>Please reply with the above details so we can coordinate with IT and Admin.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 6: IT asset request — includes manager's confirmed allocation details
async function sendITAssetRequest(employee, itEmail, assetDetails) {
  const { name, employeeId, doj } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const ad = assetDetails || {};
  const designation = esc(employee.role || employee.designation || 'New Joinee');
  const department  = esc(employee.department || ad.department || '');
  const location    = esc(ad.officeLocation || employee.officeLocation || 'Office');
  const assetType   = esc(ad.assetType || '');
  const supervisor  = esc(ad.supervisorName || '');
  const reportingRow = supervisor ? `<li><strong>Reporting To:</strong> ${supervisor}</li>` : '';
  const assetRow     = assetType  ? `<li><strong>Asset Required:</strong> ${assetType}</li>` : '';

  return sendEmail({
    to: itEmail,
    subject: `IT Asset Setup Required — ${esc(name)} (DOJ: ${esc(doj)})`,
    html: `
      <p>Hi IT Team,</p>
      <p>A new team member is joining us and requires IT setup before their Day of Joining. Please arrange the necessary assets and access as per the details below:</p>
      <ul>
        <li><strong>Name:</strong> ${esc(name)} (${esc(employeeId)})</li>
        <li><strong>Designation:</strong> ${designation}${department ? ` — ${department}` : ''}</li>
        <li><strong>Date of Joining:</strong> ${esc(doj)}</li>
        <li><strong>Office Location:</strong> ${location}</li>
        ${assetRow}
        ${reportingRow}
      </ul>
      <p>Please ensure the laptop, system access, email credentials, and any required peripherals are ready before the DOJ. If any requested asset is unavailable, kindly reply with an alternative or the expected availability date so HR can coordinate accordingly.</p>
      <p><strong>Kindly fill in the details below and reply to this email:</strong></p>
      <blockquote style="border-left:4px solid #1a73e8;padding:8px 16px;color:#333;margin:8px 0;font-family:monospace;font-size:13px;line-height:1.8;">
        Asset Assigned: Y/N<br/>
        Reason for not assigning: Already Assigned earlier / Client location Deployment / Asset not available to assign
      </blockquote>
      <p style="font-size:13px;color:#555;">Your reply will automatically update the onboarding checklist.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 7a: BGV initiation email — fires on DOJ, recruiter only
async function sendBGVInitiateRequest(employee, recruiterEmail) {
  const { name, employeeId, doj } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  return sendEmail({
    to: recruiterEmail,
    subject: `Initiate BGV for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi,</p>
      <p><strong>${esc(name)}</strong> (Employee ID: <strong>${esc(employeeId)}</strong>) has joined today (<strong>${esc(doj)}</strong>).</p>
      <p>Please initiate the Background Verification (BGV) process with SmartScreen for this employee at the earliest.</p>
      <p>Once you receive the BGV report from SmartScreen, you will receive a separate email asking you to upload it.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 7b: BGV upload request — fires 7 working days after DOJ, recruiter + HR
async function sendBGVUploadRequest(employee, recruiterEmail) {
  const { name, employeeId } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const engineEmail = esc(process.env.ENGINE_EMAIL || process.env.GMAIL_USER || '');
  const hrEmail = (employee.contacts && employee.contacts.hrEmail) || process.env.HR_EMAIL || '';
  const toEmails = [recruiterEmail, hrEmail].filter(Boolean).join(', ');
  return sendEmail({
    to: toEmails,
    subject: `Action Required — Upload BGV Report for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi,</p>
      <p>Please upload the BGV report for <strong>${esc(name)}</strong> (Employee ID: <strong>${esc(employeeId)}</strong>) received from SmartScreen.</p>
      <ol>
        <li><strong>Reply to this email</strong> with the BGV report PDF attached.</li>
        <li>Make sure the Employee ID <strong>${esc(employeeId)}</strong> is visible in the subject or body.</li>
      </ol>
      <p>The automation system will read the PDF, classify the result as BGV Passed or Failed, move the report to the employee's Drive folder, and notify you — no manual entry needed.</p>
      <p style="color:#555;font-size:13px;">(The engine monitors replies to this email at ${engineEmail})</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Alias kept for any legacy callers — routes to upload request
async function sendBGVRequest(employee, recruiterEmail) {
  return sendBGVUploadRequest(employee, recruiterEmail);
}

// Template 8: HR induction attendance confirmation
async function sendHRInductionConfirmation(employee, recruiterEmail) {
  const { name, employeeId, doj } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const dojFormatted = doj ? new Date(doj).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
  const driveFolderId = employee.driveFolderId;
  const folderLink = driveFolderId ? `https://drive.google.com/drive/folders/${driveFolderId}` : null;
  return sendEmail({
    to: recruiterEmail,
    subject: `Action Required — HR Induction confirmation for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi,</p>
      <div style="margin:16px 0;padding:12px 16px;background:#fff8e1;border-left:4px solid #ffa000;border-radius:2px;">
        <p style="margin:0 0 4px;font-weight:bold;color:#333;">What this email is about</p>
        <p style="margin:0;color:#555;"><strong>${esc(name)}</strong> (ID: ${esc(employeeId)}, DOJ: ${dojFormatted}) has joined. The HR Induction session needs to be conducted. Once the session is done, you must upload a screenshot of the meeting to the <strong>HR_Induction_Screenshot</strong> subfolder in ${esc(name)}'s Drive folder. The onboarding checklist will only turn green after the screenshot is uploaded — not just after this reply.</p>
      </div>
      <p><strong>Step 1:</strong> Reply to this email with <strong>"Confirmed"</strong> once the HR induction is done.</p>
      <p><strong>Step 2:</strong> Upload a screenshot of the induction meeting to the <strong>HR_Induction_Screenshot</strong> folder in Drive.</p>
      ${folderLink ? `<p style="margin:16px 0;"><a href="${folderLink}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">Open ${esc(name)}'s Drive Folder</a></p>` : ''}
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 10: 60/90-day review reminder
async function sendPeriodicReviewReminder(employee, recruiterEmail, managerEmail, dayMark) {
  const { name, employeeId } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const joineeEmail = employee.officialEmail || employee.personalEmail;

  // Month tab: 30→Month -1, 60→Month -2, 90→Month -3
  const monthTab = dayMark === 30 ? 'Tracking - Month -1' : dayMark === 60 ? 'Tracking - Month -2' : 'Tracking - Month -3';

  // Get tracking sheet URL from projectIntroSheetId (New Joinee & Task Tracker)
  let sheetUrl = employee.projectIntroSheetId
    ? `https://docs.google.com/spreadsheets/d/${employee.projectIntroSheetId}`
    : null;

  if (!sheetUrl && employee._auth && employee.driveFolderId) {
    try {
      const drive = google.drive({ version: 'v3', auth: employee._auth });
      const res = await drive.files.list({
        q: `'${employee.driveFolderId}' in parents and name contains 'New Joinee' and trashed=false`,
        fields: 'files(id)',
        pageSize: 5,
      });
      if (res.data.files.length > 0) {
        sheetUrl = `https://docs.google.com/spreadsheets/d/${res.data.files[0].id}`;
      }
    } catch (err) {
      console.warn(`[Email] Could not look up tracking sheet for ${name}: ${err.message}`);
    }
  }

  const sheetSection = sheetUrl
    ? `<p style="margin:16px 0;"><a href="${sheetUrl}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">Open Tracking Sheet — ${esc(monthTab)}</a></p>`
    : '';

  // Email to manager only — tracking sheet link + instructions
  if (managerEmail) {
    await sendEmail({
      to: managerEmail,
      subject: `Action Required — ${dayMark}-Day Project Review for ${esc(name)} (${esc(employeeId)})`,
      html: `
        <p>Hi,</p>
        <div style="margin:16px 0;padding:12px 16px;background:#fff8e1;border-left:4px solid #ffa000;border-radius:2px;">
          <p style="margin:0 0 4px;font-weight:bold;color:#333;">What this email is about</p>
          <p style="margin:0;color:#555;">It has been <strong>${dayMark} days</strong> since <strong>${esc(name)}</strong> (ID: ${esc(employeeId)}) joined ${co}. The <strong>${dayMark}-day project review</strong> is now due. This is a structured check-in to assess progress, discuss any challenges, and set expectations for the next phase. Two steps are required after the call:</p>
          <ol style="margin:8px 0 0;color:#555;">
            <li>The recruiter fills their section in the <strong>${esc(monthTab)}</strong> tab of the tracking sheet</li>
            <li>You (the manager) confirm the review call was completed by replying "Done" to a follow-up email — that is what closes this milestone</li>
          </ol>
        </div>
        <p>Please schedule and conduct the review call at the earliest. The tracking sheet is linked below for reference:</p>
        ${sheetSection}
        <p>Regards,<br/>${co} HR</p>
      `,
    });
  }

  // Separate simple email to new joinee
  if (joineeEmail) {
    await sendEmail({
      to: joineeEmail,
      subject: `${dayMark}-Day Review — ${esc(name)}, your manager will be scheduling a call`,
      html: `
        <p>Hi ${esc(name)},</p>
        <div style="margin:16px 0;padding:12px 16px;background:#fff8e1;border-left:4px solid #ffa000;border-radius:2px;">
          <p style="margin:0 0 4px;font-weight:bold;color:#333;">What this email is about</p>
          <p style="margin:0;color:#555;">It has been <strong>${dayMark} days</strong> since you joined ${co}. As part of your onboarding, your manager will schedule a <strong>${dayMark}-day project review call</strong> with you. This is a check-in to discuss your progress, any challenges you are facing, and goals for the next phase.</p>
        </div>
        <p>Please check your calendar for the meeting invite from your manager and come prepared to discuss your progress and any questions you have.</p>
        <p>Regards,<br/>${co} HR</p>
      `,
    });
  }
}

// Template 11: Pre-probation reminder (5 months)
async function sendPreProbationReminder(employee, managerEmail) {
  const { name, employeeId } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  return sendEmail({
    to: `${resolveHrEmail(employee)}, ${managerEmail}`,
    subject: `Action Required — Pre-Probation Verification for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi,</p>
      <p><strong>${esc(name)}</strong> (ID: ${esc(employeeId)}) is approaching the end of their probation period.</p>
      <p>Please complete the pre-probation verification:</p>
      <ul>
        <li>Performance review during probation</li>
        <li>Feedback from reporting manager</li>
        <li>Decision: confirm or extend probation</li>
        <li>Communicate decision to employee</li>
      </ul>
      <p>Reply to this email with <strong>"Pre-probation verification complete for [Employee ID]"</strong> once done. The system will automatically close this milestone.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 12: Phase completion summary to HR
async function sendPhaseCompletionSummary(employee, phase, completedTasks) {
  const { name, employeeId } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const taskList = completedTasks.map(t => `<li>${esc(String(t))}</li>`).join('');
  return sendEmail({
    to: resolveHrEmail(employee),
    subject: `Onboarding Update — ${esc(phase)} Completed for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi HR Team,</p>
      <p>The following onboarding phase has been completed for <strong>${esc(name)}</strong> (ID: ${esc(employeeId)}):</p>
      <p><strong>Phase: ${esc(phase)}</strong></p>
      <ul>${taskList}</ul>
      <p>The system will now automatically proceed to the next phase.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 13: Document verification report to recruiter (t9)
async function sendVerificationReport(employee, verificationResults) {
  const { name, employeeId, contacts } = employee;
  const recruiterEmail = contacts && contacts.recruiterEmail;

  if (!verificationResults || Object.keys(verificationResults).length === 0) {
    console.warn(`[Email] sendVerificationReport skipped for ${name} — no verification results yet`);
    return;
  }

  if (!recruiterEmail) {
    console.warn(`[Email] sendVerificationReport skipped for ${name} — recruiterEmail is not set`);
    return;
  }

  const rows = Object.entries(verificationResults).map(([docType, res]) => {
    const statusIcon = res.valid ? '&#10003;' : '&#10007;';
    const statusColor = res.valid ? '#2e7d32' : '#c62828';
    const statusLabel = res.valid ? 'PASSED' : 'FAILED';
    const summary = res.summary || (res.valid ? 'Verification successful' : 'Verification failed');
    return `
      <tr>
        <td style="padding:8px 12px;border:1px solid #ddd;">${esc(docType)}</td>
        <td style="padding:8px 12px;border:1px solid #ddd;color:${statusColor};font-weight:bold;">${statusIcon} ${esc(statusLabel)}</td>
        <td style="padding:8px 12px;border:1px solid #ddd;color:#555;">${esc(summary)}</td>
      </tr>`;
  }).join('');

  return sendEmail({
    to: recruiterEmail,
    subject: `Document Verification Report — ${esc(name)}`,
    html: `
      <p>Hi,</p>
      <p>Here is the automated document verification report for <strong>${esc(name)}</strong> (ID: ${esc(employeeId)}):</p>
      <table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;">
        <thead>
          <tr style="background:#1a73e8;color:#fff;">
            <th style="padding:10px 12px;border:1px solid #1a73e8;text-align:left;">Document</th>
            <th style="padding:10px 12px;border:1px solid #1a73e8;text-align:left;">Status</th>
            <th style="padding:10px 12px;border:1px solid #1a73e8;text-align:left;">Summary</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      <p style="margin-top:16px;">If any document has <strong>FAILED</strong>, the system has already sent a re-upload request to the candidate. Please follow up if no response is received within 24 hours.</p>
      <p>Regards,<br/>${process.env.COMPANY_NAME} HR</p>
    `,
  });
}

// Template 14: HR induction calendar invite — email to employee + recruiter + manager (t27)
async function sendInductionCalendarInvite(employee) {
  const { name, employeeId, doj, officialEmail, personalEmail, contacts } = employee;
  const recruiterEmail = contacts && contacts.recruiterEmail;
  const managerEmail = contacts && contacts.managerEmail;
  const joineeEmail = officialEmail || personalEmail;
  const displayDoj = doj || 'Your Date of Joining';

  const inductionTable = `
    <table style="border-collapse:collapse;width:480px;font-family:Arial,sans-serif;font-size:14px;margin:16px 0;">
      <tr style="background:#f5f5f5;">
        <td style="padding:8px 14px;border:1px solid #ddd;font-weight:bold;">Date</td>
        <td style="padding:8px 14px;border:1px solid #ddd;">${displayDoj} (Date of Joining)</td>
      </tr>
      <tr>
        <td style="padding:8px 14px;border:1px solid #ddd;font-weight:bold;">Time</td>
        <td style="padding:8px 14px;border:1px solid #ddd;">10:30 AM onwards</td>
      </tr>
      <tr style="background:#f5f5f5;">
        <td style="padding:8px 14px;border:1px solid #ddd;font-weight:bold;">Location</td>
        <td style="padding:8px 14px;border:1px solid #ddd;">Office / As communicated by your recruiter</td>
      </tr>
      <tr>
        <td style="padding:8px 14px;border:1px solid #ddd;font-weight:bold;">Conducted by</td>
        <td style="padding:8px 14px;border:1px solid #ddd;">Recruiter / HR Team</td>
      </tr>
      <tr style="background:#f5f5f5;">
        <td style="padding:8px 14px;border:1px solid #ddd;font-weight:bold;">Topics covered</td>
        <td style="padding:8px 14px;border:1px solid #ddd;">Company policies, tools, culture, team introductions</td>
      </tr>
    </table>`;

  // Joinee email — no recruiter instructions
  if (joineeEmail) {
    await sendEmail({
      to: joineeEmail,
      subject: `HR Induction Details — ${name} — DOJ ${displayDoj}`,
      html: `
        <p>Dear ${esc(name)},</p>
        <p>Your HR induction has been scheduled for your Date of Joining. Please find the details below:</p>
        ${inductionTable}
        <p>Please be present at the office by <strong>10:30 AM</strong> on your Date of Joining.</p>
        <p>A calendar invite has been sent to you.</p>
        <p>Regards,<br/>${process.env.COMPANY_NAME} HR</p>
      `,
    });
  }

  // Recruiter + manager email — includes confirmation request
  const internalTo = [recruiterEmail, managerEmail].filter(Boolean).join(', ');
  if (internalTo) {
    await sendEmail({
      to: internalTo,
      subject: `HR Induction Details — ${esc(name)} (${esc(employeeId)}) — DOJ ${displayDoj}`,
      html: `
        <p>Hi,</p>
        <p>HR induction has been scheduled for <strong>${esc(name)}</strong> (${esc(employeeId)}). Details below:</p>
        ${inductionTable}
        <p>Please confirm attendance by replying to this email once the induction is complete.</p>
        <p>Regards,<br/>${process.env.COMPANY_NAME} HR</p>
      `,
    });
  }
}

// Template 15: Project intro meeting invite
// - Joinee gets a simple notification email (no sheet link, no sheet access)
// - Sheet link goes to recruiter only
async function sendProjectIntroInvite(employee, sheetUrl) {
  const { name, employeeId, doj, officialEmail, personalEmail, contacts } = employee;
  const recruiterEmail = contacts && contacts.recruiterEmail;
  const managerEmail = contacts && contacts.managerEmail;
  const joineeEmail = officialEmail || personalEmail;
  const displayDoj = doj ? new Date(doj).toDateString() : 'your Date of Joining';

  // Notify joinee — no sheet link
  if (joineeEmail) {
    await sendEmail({
      to: joineeEmail,
      subject: `Project Intro Meeting — ${esc(name)}`,
      html: `
        <p>Hi ${esc(name)},</p>
        <p>A project introduction meeting has been scheduled for you on <strong>${displayDoj}</strong> (post-lunch).</p>
        <p>The meeting will cover your initial project context, goals, team introductions, and buddy/mentor assignment.</p>
        <p>Your manager will be present. Please be available after lunch on your Date of Joining.</p>
        <p>Regards,<br/>${process.env.COMPANY_NAME} HR</p>
      `,
    });
  }

  // Sheet link to recruiter and manager only
  const sheetSection = sheetUrl
    ? `<p style="margin:16px 0;">
        <a href="${sheetUrl}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">
          Open Project Intro Sheet
        </a>
      </p>
      <p style="color:#555;font-size:13px;">
        <strong>Manager:</strong> Please fill in Key Projects, Initial Goals, Buddy/Mentor, and Team Name before the meeting.
      </p>`
    : '';

  const internalTo = [recruiterEmail, managerEmail].filter(Boolean).join(', ');
  if (internalTo) {
    await sendEmail({
      to: internalTo,
      subject: `Project Intro Meeting Scheduled — ${esc(name)} (${esc(employeeId)})`,
      html: `
        <p>Hi,</p>
        <p>A project introduction meeting has been scheduled for <strong>${esc(name)}</strong> (${esc(employeeId)}) on <strong>${displayDoj}</strong> (post-lunch).</p>
        ${sheetSection}
        <p>Regards,<br/>${process.env.COMPANY_NAME} HR</p>
      `,
    });
  }
}

// Template 16: 30-day catchup tracker — creates a Google Sheet in Drive + emails link to recruiter + manager (t40)
async function sendCatchupXLSEmail(employee) {
  const { name, employeeId, contacts, driveFolderId } = employee;
  const recruiterEmail = contacts && contacts.recruiterEmail;
  const managerEmail = contacts && contacts.managerEmail;
  const toEmail = [recruiterEmail, managerEmail].filter(Boolean).join(', ');

  // Reuse the project intro sheet (AL_DI_HR_019) that was created at joining time.
  // It already contains the Tracking - Month -1/2/3 tabs the manager needs to fill.
  let sheetUrl = employee.projectIntroSheetId
    ? `https://docs.google.com/spreadsheets/d/${employee.projectIntroSheetId}`
    : null;

  // Fallback: look it up by name in Drive if not stored on employee object
  if (!sheetUrl && employee._auth && driveFolderId) {
    try {
      const { google } = require('googleapis');
      const drive = google.drive({ version: 'v3', auth: employee._auth });
      const res = await drive.files.list({
        q: `name contains 'AL_DI_HR_019' and name contains '${employeeId}' and trashed=false`,
        fields: 'files(id)',
      });
      if (res.data.files.length > 0) {
        sheetUrl = `https://docs.google.com/spreadsheets/d/${res.data.files[0].id}`;
      }
    } catch (err) {
      console.warn(`[Email] Could not look up project intro sheet for ${name}: ${err.message}`);
    }
  }

  if (!sheetUrl && employee._auth && driveFolderId) {
    try {
      const { google } = require('googleapis');
      const sheets = google.sheets({ version: 'v4', auth: employee._auth });
      const drive = google.drive({ version: 'v3', auth: employee._auth });

      // Create workbook with all 4 tabs up front
      const spreadsheet = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title: `New Joinee & Task Tracker — ${name} (${employeeId})` },
          sheets: [
            { properties: { title: 'Document Version history',    index: 0 } },
            { properties: { title: 'Details of New Joinee & Task', index: 1 } },
            { properties: { title: 'Tracking - Month -1',          index: 2 } },
            { properties: { title: 'Tracking - Month -2',          index: 3 } },
            { properties: { title: 'Tracking - Month -3',          index: 4 } },
          ],
        },
      });
      const spreadsheetId = spreadsheet.data.spreadsheetId;
      const tabIds = {};
      for (const s of spreadsheet.data.sheets) {
        tabIds[s.properties.title] = s.properties.sheetId;
      }

      // ── Tab: Details of New Joinee & Task ──────────────────────────────────
      const dojStr = employee.doj || '';
      const teamJoined = employee.team || employee.department || '';
      const reportingManager = (contacts && contacts.managerName) || managerEmail || '';
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: "'Details of New Joinee & Task'!A1",
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [
            ['Details of New Joinee & Task'],
            [`Name: ${name}\nDOJ: ${dojStr}\nTeam Joined: ${teamJoined}\nReporting Manager: ${reportingManager}\nProject Buddy:`],
            ['Key Areas of Responsibilities:\n1.\n2.\n3.'],
            ['Objectives:\n1.\n2.\n3.'],
            ['Task/ Training Schedule:'],
            [],
          ],
        },
      });

      // ── Tab: Tracking rows (same structure for Month -1, -2, -3) ──────────
      const trackingRows = [
        // Row 1: header (merged A1:C1 — just set in A1)
        // Row 2-4: Tasks Assigned block + completion % header
        // Row 5: Lead's Observations | Suggestions headers
        // Rows 6-10: Performance dimensions
        // Rows 11-12: blank spacers
        // Row 13: Filled by Recruiter headers
        // Rows 14-15: Concern questions
        // Row 16: Summary
      ];

      // Month -1: 2 recruiter questions. Month -2 and -3: adds probation question.
      const buildTrackingData = (monthLabel) => {
        const hasProbationQ = monthLabel !== 'Tracking - Month -1';
        const rows = [
          [monthLabel, '', ''],
          ['Tasks Assigned', 'Task/ Training 1: Completion Percentage: Mention percentage only (For example 100% )Proficiency achieved on the tasks completed: Task/ Training 2:', ''],
          ['', '', ''],
          ['', '', ''],
          ['', "Lead's Observations on the tasks assigned", 'Suggestions for improvements from the lead'],
          ['PERSONAL QUALITY\n1.Timely and accurate completion of activities with desired standards\n2.Takes initiative and is innovative\n3.Flexible and effective in taking up new challenges\n4.Response time', '', ''],
          ['TEAMWORK\nCo-operation with other team members', '', ''],
          ['LEADERSHIP\nAbility to plan\nOrganize\nDelegate\nControl', '', ''],
          ['COMMUNICATIONClarity  and Conciseness in one-to-one and group discussions', '', ''],
          ['Ownership & Accountability', '', ''],
          ['', '', ''],
          ['', '', ''],
          ['Filled by Recruiter', 'Filled by Recruiter', ''],
          ['Do you have any other concerns apart from technical output which is impacting the work currently ?', '', ''],
          ['Do you have any concerns on the time taken to complete the assigned tasks/training and/or the quality of the output?', '', ''],
        ];
        if (hasProbationQ) {
          rows.push(['Do you feel the probation will be confirmed or will it be extended ?', '', '']);
        }
        rows.push(['', '', '']);
        rows.push(['Summary', '', '']);
        rows.push(['', '', '']);
        return rows;
      };

      for (const tab of ['Tracking - Month -1', 'Tracking - Month -2', 'Tracking - Month -3']) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${tab}'!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: buildTrackingData(tab) },
        });
      }

      // ── Formatting ─────────────────────────────────────────────────────────
      const formatRequests = [];

      // Details tab — title row bold centered
      const detailsId = tabIds['Details of New Joinee & Task'];
      formatRequests.push({
        repeatCell: {
          range: { sheetId: detailsId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: {
            textFormat: { bold: true, fontSize: 12 },
            horizontalAlignment: 'CENTER',
          }},
          fields: 'userEnteredFormat(textFormat,horizontalAlignment)',
        },
      });
      // Details tab — wrap all cells
      formatRequests.push({
        repeatCell: {
          range: { sheetId: detailsId, startRowIndex: 0, endRowIndex: 10 },
          cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
          fields: 'userEnteredFormat(wrapStrategy)',
        },
      });

      // Tracking tabs — header row + performance dimension rows light grey background
      for (const tab of ['Tracking - Month -1', 'Tracking - Month -2', 'Tracking - Month -3']) {
        const sid = tabIds[tab];
        // Tab title row bold centered
        formatRequests.push({
          repeatCell: {
            range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: {
              textFormat: { bold: true, fontSize: 11 },
              horizontalAlignment: 'CENTER',
            }},
            fields: 'userEnteredFormat(textFormat,horizontalAlignment)',
          },
        });
        // Performance dimension rows (rows 6-10, 0-indexed: 5-9) light grey + bold label
        formatRequests.push({
          repeatCell: {
            range: { sheetId: sid, startRowIndex: 5, endRowIndex: 10 },
            cell: { userEnteredFormat: {
              backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 },
              textFormat: { bold: true },
              wrapStrategy: 'WRAP',
            }},
            fields: 'userEnteredFormat(backgroundColor,textFormat,wrapStrategy)',
          },
        });
        // "Filled by Recruiter" row bold
        formatRequests.push({
          repeatCell: {
            range: { sheetId: sid, startRowIndex: 12, endRowIndex: 13 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat(textFormat)',
          },
        });
        // Wrap all content rows
        formatRequests.push({
          repeatCell: {
            range: { sheetId: sid, startRowIndex: 0, endRowIndex: 18 },
            cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
            fields: 'userEnteredFormat(wrapStrategy)',
          },
        });
        // Auto-resize columns A-C
        formatRequests.push({
          autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: 3 } },
        });
      }

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: formatRequests },
      });

      // Move into employee's Drive folder
      const fileMeta = await drive.files.get({ fileId: spreadsheetId, fields: 'parents' });
      const currentParents = (fileMeta.data.parents || []).join(',');
      await drive.files.update({
        fileId: spreadsheetId,
        addParents: driveFolderId,
        removeParents: currentParents,
        fields: 'id, parents',
      });

      // Share with recruiter and manager only — joinee has no access
      const shareWithEdit = [recruiterEmail, managerEmail].filter(Boolean);
      for (const email of [...new Set(shareWithEdit)]) {
        await drive.permissions.create({
          fileId: spreadsheetId,
          requestBody: { type: 'user', role: 'writer', emailAddress: email },
          sendNotificationEmail: false,
        }).catch(() => {});
      }

      sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
      console.log(`[Email] Catchup tracker sheet created for ${name}: ${sheetUrl}`);
    } catch (err) {
      console.warn(`[Email] Could not create catchup XLS sheet for ${name}: ${err.message}`);
    }
  } // end fallback sheet creation

  const sheetSection = sheetUrl
    ? `<p style="margin:16px 0;"><a href="${sheetUrl}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">Open New Joinee & Task Tracker</a></p>
       <p style="color:#555;font-size:13px;">The tracker has been saved in ${esc(name)}'s onboarding folder. Please fill in the monthly tracking tabs after each review call.</p>`
    : `<p style="color:#e65100;">The tracker sheet could not be created automatically — please create it manually.</p>`;

  // Send to recruiter + manager
  await sendEmail({
    to: toEmail,
    subject: `New Joinee & Task Tracker — ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi,</p>
      <p>Please find the New Joinee & Task Tracker for <strong>${esc(name)}</strong> (ID: ${esc(employeeId)}) below.</p>
      <p>The tracker contains:</p>
      <ul>
        <li><strong>Details of New Joinee & Task</strong> — Employee info, Key Areas of Responsibilities, Objectives, Task/Training Schedule (to be filled by manager)</li>
        <li><strong>Tracking - Month -1/2/3</strong> — Monthly performance tracking with tasks, lead observations, and recruiter feedback sections</li>
      </ul>
      ${sheetSection}
      <p>Please fill in the relevant month tab after each catchup call (30-day, 60-day, and 90-day reviews).</p>
      <p>Regards,<br/>${process.env.COMPANY_NAME} HR</p>
    `,
  });

}

// Template 17: 30/60/90-day review email — single email with tracking sheet link
async function sendReviewSummaryRequest(employee, dayMark) {
  const { name, employeeId, contacts } = employee;
  const recruiterEmail = contacts && contacts.recruiterEmail;
  const managerEmail = contacts && contacts.managerEmail;
  const toEmail = [recruiterEmail, managerEmail].filter(Boolean).join(', ');
  const co = esc(process.env.COMPANY_NAME || '');

  // Month tab mapping: 30-day → Month -1, 60-day → Month -2, 90-day → Month -3
  const monthTab = dayMark === 30 ? 'Tracking - Month -1' : dayMark === 60 ? 'Tracking - Month -2' : 'Tracking - Month -3';
  const monthLabel = dayMark === 30 ? 'Month 1' : dayMark === 60 ? 'Month 2' : 'Month 3';

  // Get the tracking sheet URL (AL_DI_HR_019 project intro sheet)
  let sheetUrl = employee.projectIntroSheetId
    ? `https://docs.google.com/spreadsheets/d/${employee.projectIntroSheetId}`
    : null;

  if (!sheetUrl && employee._auth && employee.driveFolderId) {
    try {
      const drive = google.drive({ version: 'v3', auth: employee._auth });
      const res = await drive.files.list({
        q: `'${employee.driveFolderId}' in parents and name contains 'New Joinee' and trashed=false`,
        fields: 'files(id,name)',
        pageSize: 5,
      });
      if (res.data.files.length > 0) {
        sheetUrl = `https://docs.google.com/spreadsheets/d/${res.data.files[0].id}`;
      }
    } catch (err) {
      console.warn(`[Email] Could not look up tracking sheet for ${name}: ${err.message}`);
    }
  }

  const sheetSection = sheetUrl
    ? `<p style="margin:16px 0;">
        <a href="${sheetUrl}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">
          Open Tracking Sheet — ${monthLabel}
        </a>
       </p>
       <p style="color:#555;font-size:13px;">Please fill in the <strong>${esc(monthTab)}</strong> tab after the review call.</p>`
    : `<p style="color:#e65100;font-size:13px;">Tracking sheet not found — please fill it in manually from the employee's Drive folder.</p>`;

  return sendEmail({
    to: toEmail,
    subject: `${dayMark}-Day Project Review — ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi,</p>
      <p>The <strong>${dayMark}-day project review</strong> for <strong>${esc(name)}</strong> (ID: ${esc(employeeId)}) is due. Please check your calendar for the meeting invite.</p>
      <p>After the review, please fill in the tracking sheet for <strong>${monthLabel}</strong>:</p>
      ${sheetSection}
      <p style="color:#555;border-left:4px solid #ffa000;padding:8px 16px;background:#fffde7;">
        Once the review is done, reply to this email with <strong>"Confirmed"</strong> to update the onboarding checklist.
      </p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 18c2: Day 30 technical review
async function send30DayTechnicalReview(employee) {
  const { name, employeeId, contacts } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const joineeEmail = employee.officialEmail || employee.personalEmail;
  const managerEmail = contacts && contacts.managerEmail;
  const monthTab = 'Tracking - Month -1';

  // Find tracking sheet URL
  let sheetUrl = employee.projectIntroSheetId
    ? `https://docs.google.com/spreadsheets/d/${employee.projectIntroSheetId}`
    : null;
  if (!sheetUrl && employee._auth && employee.driveFolderId) {
    try {
      const drive = google.drive({ version: 'v3', auth: employee._auth });
      const res = await drive.files.list({
        q: `'${employee.driveFolderId}' in parents and name contains 'New Joinee' and trashed=false`,
        fields: 'files(id)',
        pageSize: 5,
      });
      if (res.data.files.length > 0) {
        sheetUrl = `https://docs.google.com/spreadsheets/d/${res.data.files[0].id}`;
      }
    } catch (err) {
      console.warn(`[Email] Could not look up tracking sheet for ${name}: ${err.message}`);
    }
  }
  const sheetSection = sheetUrl
    ? `<p style="margin:16px 0;"><a href="${sheetUrl}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">Open Tracking Sheet — ${esc(monthTab)}</a></p>`
    : '';

  // Manager email — with tracking sheet
  if (managerEmail) {
    await sendEmail({
      to: managerEmail,
      subject: `Reminder — 30-Day Project Review for ${esc(name)} (${esc(employeeId)})`,
      html: `
        <p>Hi,</p>
        <p>The <strong>30-day project review</strong> for <strong>${esc(name)}</strong> (ID: ${esc(employeeId)}) is due.</p>
        <p>Please schedule and conduct the review. After the call:</p>
        <ol>
          <li>Fill in the <strong>${esc(monthTab)}</strong> tab in the tracking sheet below</li>
          <li>Reply to this email confirming the review was completed</li>
        </ol>
        ${sheetSection}
        <p>If the call cannot happen soon, reply with the new proposed date.</p>
        <p>Regards,<br/>${co} HR</p>
      `,
    });
  }

  // Joinee email — simple notification
  if (joineeEmail) {
    await sendEmail({
      to: joineeEmail,
      subject: `30-Day Project Review — ${esc(name)} (${esc(employeeId)})`,
      html: `
        <p>Hi,</p>
        <p>It has been 30 days since you joined ${co}. Time for your <strong>30-day project review!</strong></p>
        <p>Please check your calendar for the review meeting invite and come prepared to discuss progress, challenges, and next steps.</p>
        <p>Regards,<br/>${co} HR</p>
      `,
    });
  }
}

// Template 18c: Day 25 catchup call notification — sent to HR + new joiner on day 25
async function send25DayCatchupEmail(employee) {
  const { name, employeeId, doj, isFresher } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const hrEmailAddr = resolveHrEmail(employee);
  const recruiterEmail = (employee.contacts || {}).recruiterEmail || '';
  const toEmail = [hrEmailAddr, recruiterEmail].filter(Boolean).join(', ');
  const sheetLink = process.env.CATCHUP_TRACKING_SHEET_LINK || '#';
  const contacts = employee.contacts || {};
  const managerEmail = contacts.managerEmail || '';
  const managerName  = contacts.managerName  || managerEmail;
  const location     = employee.officeLocation || '';
  const assetRequired = employee.assetRequired || '';
  const fresherLabel  = isFresher ? 'Yes (Fresher)' : 'No (Experienced)';

  return sendEmail({
    to: toEmail,
    subject: `25th Day Catchup Call — ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi,</p>
      <p>This is a reminder that the <strong>25th day catchup call</strong> for <strong>${esc(name)}</strong> is due today. Please schedule or confirm the call.</p>
      <table style="border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:4px 12px 4px 0;color:#555;"><strong>Employee Name</strong></td><td>${esc(name)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555;"><strong>Employee ID</strong></td><td>${esc(employeeId)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555;"><strong>Date of Joining</strong></td><td>${esc(doj || '')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555;"><strong>Official Email</strong></td><td>${esc(employee.officialEmail || employee.personalEmail || '')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555;"><strong>Reporting Manager</strong></td><td>${esc(managerName)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555;"><strong>Manager Email</strong></td><td>${esc(managerEmail)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555;"><strong>Location</strong></td><td>${esc(location)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555;"><strong>Asset Required</strong></td><td>${esc(assetRequired)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555;"><strong>Fresher</strong></td><td>${esc(fresherLabel)}</td></tr>
      </table>
      <br/>
      <p>Recruiter — please fill in the <a href="${sheetLink}">catchup tracking sheet</a> after the call.</p>
      <p>HR — once the call is done, reply to this email with <strong>"Confirmed"</strong> to update the checklist.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 18b: Admin seat allocation request — sent on DOJ to Admin/HR asking for seat confirmation
async function sendAdminSeatAllocationRequest(employee) {
  const { name, employeeId, doj } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  return sendEmail({
    to: resolveHrEmail(employee),
    subject: `Action Required — Seat Allocation Confirmation for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi Admin Team,</p>
      <p><strong>${esc(name)}</strong> (ID: ${esc(employeeId)}) is joining on <strong>${esc(doj)}</strong>. Please confirm that a workstation / seat has been allocated and is ready.</p>
      <ul>
        <li>Name: ${esc(name)}</li>
        <li>Employee ID: ${esc(employeeId)}</li>
        <li>Date of Joining: ${esc(doj)}</li>
      </ul>
      <p>Please reply to this email confirming the seat allocation so the onboarding checklist can be updated.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 18: No-reply priority notice — sent to HR when a stakeholder hasn't replied
// context: plain-text description of what the original email asked for (shown in the email body)
async function sendNoReplyEscalation(employee, recipientType, originalRecipient, context) {
  const { name, employeeId, doj } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const dojFormatted = doj ? new Date(doj).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
  const contextBlock = context
    ? `<div style="margin:16px 0;padding:12px 16px;background:#fff8e1;border-left:4px solid #ffa000;border-radius:2px;">
        <p style="margin:0 0 4px;font-weight:bold;color:#333;">What was the original email about?</p>
        <p style="margin:0;color:#555;">${esc(context)}</p>
       </div>`
    : '';
  return sendEmail({
    to: resolveHrEmail(employee),
    subject: `Respond on Priority — ${esc(recipientType)} has not replied for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi HR Team,</p>
      <p><strong>Respond on Priority.</strong></p>
      <p>The onboarding system sent an automated request to <strong>${esc(recipientType)}</strong> (<code>${esc(originalRecipient)}</code>) for <strong>${esc(name)}</strong> (ID: ${esc(employeeId)}, DOJ: ${dojFormatted}). There has been no response.</p>
      ${contextBlock}
      <p><strong>Action needed:</strong> Please contact <strong>${esc(originalRecipient)}</strong> directly, share the context above, and ensure the step is completed. If it was already done, confirm so the checklist can be updated.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Template 19: Onboarding completion report — sent to HR + recruiter when probation is cleared
async function sendOnboardingCompletionReport(employee) {
  const { name, employeeId, doj, designation, contacts } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const recruiterEmail = contacts && contacts.recruiterEmail;
  const hrEmailAddr = resolveHrEmail(employee);
  const toList = [hrEmailAddr, recruiterEmail].filter(Boolean);
  if (!toList.length) return;

  const ex = employee.extractedData || {};
  const vr = employee.verificationResults || {};

  // ── Document verification summary ────────────────────────────────────────
  const docLabels = {
    aadhaar:              'Aadhaar Card',
    pan:                  'PAN Card',
    offerLetter:          'Signed Offer Letter',
    passportPhoto:        'Passport Size Photo',
    marksheet10th:        '10th Marksheet',
    marksheet12th:        '12th / Diploma Marksheet',
    degreeCertificate:    'Degree Certificate',
    postgradCertificate:  'Post Graduation Certificate',
    relievingLetter:      'Relieving Letter',
    payslip:              'Last Payslip',
  };

  const docRows = Object.entries(docLabels).map(([key, label]) => {
    const result = vr[key];
    if (!result) return null;
    const passed = result.valid === true;
    const color  = passed ? '#2D7D46' : '#C0392B';
    const status = passed ? 'Verified' : 'Failed';
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #E5E5E0;">${label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #E5E5E0;color:${color};font-weight:600;">${status}</td>
    </tr>`;
  }).filter(Boolean).join('');

  // ── BGV result ────────────────────────────────────────────────────────────
  const bgvLog = (employee.activityEvents || []).find(e => e.event === 'bgv_report_received');
  let bgvResult = '—';
  if (bgvLog) {
    bgvResult = bgvLog.detail || '—';
  } else {
    // Fall back to scanning the activity log file
    try {
      const { readLog } = require('./activityLog');
      const logs = readLog(employeeId);
      const entry = logs.find(e => e.event === 'bgv_report_received');
      if (entry) bgvResult = entry.detail || '—';
    } catch { /* non-fatal */ }
  }
  const bgvColor = bgvResult.toLowerCase().includes('passed') ? '#2D7D46' : bgvResult === '—' ? '#6B7280' : '#C0392B';

  // ── Milestone completion summary ──────────────────────────────────────────
  const milestones = [
    { label: 'Documents Verified',       taskId: 't14' },
    { label: 'BGV Complete',             taskId: 't25' },
    { label: 'Day of Joining',           taskId: 't42' },
    { label: '25-Day Catchup',           taskId: 't64' },
    { label: '30-Day Review',            taskId: 't44' },
    { label: '60-Day Review',            taskId: 't46' },
    { label: '90-Day Review',            taskId: 't49' },
    { label: 'Pre-Probation Verified',   taskId: 't52' },
  ];

  function isTaskDoneInChecklist(checklist, taskId) {
    if (!checklist) return false;
    for (const phase of Object.values(checklist)) {
      if (phase.tasks && phase.tasks[taskId]) return phase.tasks[taskId].done;
    }
    return false;
  }

  const milestoneRows = milestones.map(m => {
    const done = isTaskDoneInChecklist(employee.checklist, m.taskId);
    const color  = done ? '#2D7D46' : '#C0392B';
    const status = done ? 'Complete' : 'Pending';
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #E5E5E0;">${m.label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #E5E5E0;color:${color};font-weight:600;">${status}</td>
    </tr>`;
  }).join('');

  // ── Priority follow-up count from activity log ───────────────────────────
  let escalationCount = 0;
  try {
    const { readLog } = require('./activityLog');
    const logs = readLog(employeeId);
    escalationCount = logs.filter(e => e.event && e.event.includes('escalat')).length;
  } catch { /* non-fatal */ }

  const escalationNote = escalationCount > 0
    ? `<p style="margin:0 0 8px;color:#6B7280;font-size:13px;">${escalationCount} priority follow-up(s) were raised during onboarding. Review the activity log for details.</p>`
    : `<p style="margin:0 0 8px;color:#2D7D46;font-size:13px;">No priority follow-ups were raised during onboarding.</p>`;

  const dojFormatted = doj ? new Date(doj).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';

  await sendEmail({
    to: toList.join(', '),
    subject: `Onboarding Complete — ${esc(name)} (${esc(employeeId)})`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:620px;color:#1C1C1E;">
        <div style="background:#0F1923;padding:24px 28px;border-radius:6px 6px 0 0;">
          <p style="margin:0;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#3A7CA5;">Onboarding Complete</p>
          <p style="margin:8px 0 0;font-size:22px;font-weight:700;color:#fff;">${esc(name)}</p>
          <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.55);">${esc(employeeId)} &nbsp;·&nbsp; ${esc(designation || '—')} &nbsp;·&nbsp; DOJ: ${dojFormatted}</p>
        </div>

        <div style="background:#fff;border:1px solid #E5E5E0;border-top:none;padding:24px 28px;border-radius:0 0 6px 6px;">

          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4A5A6A;">
            The onboarding process for <strong>${esc(name)}</strong> has been completed successfully.
            Pre-probation has been verified and all milestones are closed.
            This is the final automated summary for your records.
          </p>

          <!-- BGV -->
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6B7280;">Background Verification</p>
          <p style="margin:0 0 20px;font-size:15px;font-weight:700;color:${bgvColor};">${esc(bgvResult)}</p>

          <!-- Priority Follow-ups -->
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6B7280;">Priority Follow-ups</p>
          ${escalationNote}

          <!-- Milestones -->
          <p style="margin:20px 0 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6B7280;">Milestone Summary</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
            <thead>
              <tr style="background:#F2F5F8;">
                <th style="padding:8px 12px;text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;">Milestone</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;">Status</th>
              </tr>
            </thead>
            <tbody>${milestoneRows}</tbody>
          </table>

          <!-- Documents -->
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#6B7280;">Document Verification</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
            <thead>
              <tr style="background:#F2F5F8;">
                <th style="padding:8px 12px;text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;">Document</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;">Result</th>
              </tr>
            </thead>
            <tbody>${docRows || '<tr><td colspan="2" style="padding:8px 12px;color:#6B7280;">No document results recorded.</td></tr>'}</tbody>
          </table>

          <p style="margin:0;font-size:13px;color:#6B7280;">Regards,<br/>${co} HR</p>
        </div>
      </div>
    `,
  });
}

// Simple review/catchup notification to the new joinee (day 25/30/60/90)
async function sendJoineeReviewNotification(employee, dayMark) {
  const { name, officialEmail, personalEmail } = employee;
  const co = esc(process.env.COMPANY_NAME || 'Alethea');
  const to = officialEmail || personalEmail;
  if (!to) return;

  const labels = {
    25: { subject: `Your 25-Day Catchup Call — ${esc(name)}`, body: `This is a reminder that your <strong>25-day catchup call</strong> is scheduled. Your recruiter will reach out to connect with you. Please be available and share any feedback or concerns you have so far.` },
    30: { subject: `Your 30-Day Review — ${esc(name)}`, body: `You have completed <strong>30 days</strong> at ${co}! Your 30-day project review call is coming up. Your manager and recruiter will connect with you to discuss your progress, challenges, and goals for the next month.` },
    60: { subject: `Your 60-Day Review — ${esc(name)}`, body: `You have completed <strong>60 days</strong> at ${co}! Your 60-day review call is scheduled. Your manager and recruiter will discuss your project progress and set goals for the next phase.` },
    90: { subject: `Your 90-Day Review — ${esc(name)}`, body: `You have completed <strong>90 days</strong> at ${co}! Your 90-day review call is coming up. This is your final probation review — your manager and recruiter will assess your progress and confirm probation clearance.` },
  };

  const { subject, body } = labels[dayMark] || { subject: `Review Call — ${esc(name)}`, body: `Your ${dayMark}-day review is scheduled.` };

  return sendEmail({
    to,
    subject,
    html: `
      <p>Hi ${esc(name)},</p>
      <p>${body}</p>
      <p>If you have any questions or concerns before the call, feel free to reach out to HR.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Day-before reminder — sent to joinee + HR/recruiter the day before a milestone
async function sendDayBeforeReminder(employee, dayMark) {
  const { name, officialEmail, personalEmail } = employee;
  const co = esc(process.env.COMPANY_NAME || 'Alethea');
  const joineeEmail = officialEmail || personalEmail;
  const recruiterEmail = (employee.contacts || {}).recruiterEmail || '';
  const hrEmailAddr = resolveHrEmail(employee);

  const labels = {
    25: {
      joineeSubject: `Heads-up — Your 25-Day Catchup Call is Tomorrow`,
      joineeBody: `Your <strong>25-day catchup call</strong> is scheduled for tomorrow. Your recruiter will reach out to connect with you. Please be available and come prepared with any feedback, questions, or concerns you'd like to share about your first 25 days.`,
      internalSubject: `Tomorrow — 25-Day Catchup Call for ${esc(name)} (${esc(employee.employeeId)})`,
      internalBody: `The <strong>25-day catchup call</strong> for <strong>${esc(name)}</strong> (${esc(employee.employeeId)}) is tomorrow.<br/><br/><strong>What needs to happen:</strong> The recruiter should connect with the employee, collect their feedback on the first 25 days, and note any concerns. After the call, the employee will receive an onboarding feedback form email (this is automated). No manual action is needed after the call unless there are concerns to flag.`,
    },
    30: {
      joineeSubject: `Heads-up — Your 30-Day Review is Tomorrow`,
      joineeBody: `Your <strong>30-day project review</strong> is scheduled for tomorrow. Your manager will connect with you to discuss how the first month has gone — your progress, any challenges, and goals going forward. Please check your calendar for the invite and come prepared.`,
      internalSubject: `Tomorrow — 30-Day Review for ${esc(name)} (${esc(employee.employeeId)})`,
      internalBody: `The <strong>30-day project review</strong> for <strong>${esc(name)}</strong> (${esc(employee.employeeId)}) is tomorrow.<br/><br/><strong>What needs to happen after the call:</strong><ol><li>Recruiter fills the <strong>Tracking - Month -1</strong> tab in the tracking sheet (the "Filled by Recruiter" section)</li><li>Once filled, the system will automatically email the manager to confirm — manager replies "Done" to close the milestone</li></ol>Please ensure the review call is scheduled and the tracking sheet is ready.`,
    },
    60: {
      joineeSubject: `Heads-up — Your 60-Day Review is Tomorrow`,
      joineeBody: `Your <strong>60-day project review</strong> is scheduled for tomorrow. Your manager will connect with you to discuss your progress over the last two months and set goals for the next phase. Please check your calendar and come prepared.`,
      internalSubject: `Tomorrow — 60-Day Review for ${esc(name)} (${esc(employee.employeeId)})`,
      internalBody: `The <strong>60-day project review</strong> for <strong>${esc(name)}</strong> (${esc(employee.employeeId)}) is tomorrow.<br/><br/><strong>What needs to happen after the call:</strong><ol><li>Recruiter fills the <strong>Tracking - Month -2</strong> tab in the tracking sheet (the "Filled by Recruiter" section)</li><li>Once filled, the system will automatically email the manager to confirm — manager replies "Done" to close the milestone</li></ol>Please ensure the review call is arranged and the tracking sheet is ready.`,
    },
    90: {
      joineeSubject: `Heads-up — Your 90-Day Probation Review is Tomorrow`,
      joineeBody: `Your <strong>90-day probation review</strong> is scheduled for tomorrow. This is your final probation review — your manager will assess your overall progress and confirm probation clearance. Please check your calendar and come well prepared.`,
      internalSubject: `Tomorrow — 90-Day Probation Review for ${esc(name)} (${esc(employee.employeeId)})`,
      internalBody: `The <strong>90-day probation review</strong> for <strong>${esc(name)}</strong> (${esc(employee.employeeId)}) is tomorrow. This is the final review before probation confirmation.<br/><br/><strong>What needs to happen after the call:</strong><ol><li>Recruiter fills the <strong>Tracking - Month -3</strong> tab in the tracking sheet (the "Filled by Recruiter" section)</li><li>Once filled, the system will automatically email the manager to confirm — manager replies "Done" to close the milestone</li><li>After the 90-day milestone is closed, the 5-month pre-probation verification will be triggered automatically</li></ol>Please ensure the review call is arranged and the tracking sheet is ready.`,
    },
  };

  const l = labels[dayMark];
  if (!l) return;

  const promises = [];

  if (joineeEmail) {
    promises.push(sendEmail({
      to: joineeEmail,
      subject: l.joineeSubject,
      html: `<p>Hi ${esc(name)},</p><p>${l.joineeBody}</p><p>If you have any questions before the call, feel free to reach out to HR.</p><p>Regards,<br/>${co} HR</p>`,
    }));
  }

  const internalTo = [recruiterEmail, hrEmailAddr].filter(Boolean).join(', ');
  if (internalTo) {
    promises.push(sendEmail({
      to: internalTo,
      subject: l.internalSubject,
      html: `<p>Hi,</p>${l.internalBody}<p>Regards,<br/>${co} HR Automation</p>`,
    }));
  }

  await Promise.all(promises);
}

// Simple onboarding complete email to the new joinee
async function sendJoineeOnboardingComplete(employee) {
  const { name, officialEmail, personalEmail } = employee;
  const co = esc(process.env.COMPANY_NAME || 'Alethea');
  const to = officialEmail || personalEmail;
  if (!to) return;

  return sendEmail({
    to,
    subject: `Welcome Aboard — Your Onboarding is Complete!`,
    html: `
      <p>Hi ${esc(name)},</p>
      <p>Congratulations! Your onboarding at <strong>${co}</strong> is now complete.</p>
      <p>All your documents have been verified, your pre-probation has been cleared, and you are now a confirmed member of the team.</p>
      <p>We are excited to have you with us. If you have any questions, feel free to reach out to HR at any time.</p>
      <p>Welcome to the ${co} family!</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

async function sendDocumentCrossCheckAlert(employee, mismatches) {
  const { name, employeeId, contacts } = employee;
  const co = esc(process.env.COMPANY_NAME || 'Alethea');
  const hrEmailAddr = resolveHrEmail(employee);
  const recruiterEmail = contacts && contacts.recruiterEmail;
  const toList = [hrEmailAddr, recruiterEmail].filter(Boolean);
  if (!toList.length || !mismatches.length) return;

  const rows = mismatches.map(m => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #E5E5E0;font-weight:600;color:#1C1C1E;">${esc(m.field)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #E5E5E0;color:#C0392B;">${esc(m.doc1)}: <strong>${esc(m.val1)}</strong></td>
      <td style="padding:10px 12px;border-bottom:1px solid #E5E5E0;color:#C0392B;">${esc(m.doc2)}: <strong>${esc(m.val2)}</strong></td>
    </tr>
    ${m.note ? `<tr><td colspan="3" style="padding:4px 12px 10px;border-bottom:1px solid #E5E5E0;font-size:12px;color:#6B7280;font-style:italic;">${esc(m.note)}</td></tr>` : ''}
  `).join('');

  await sendEmail({
    to: toList.join(', '),
    subject: `Document Mismatch Detected — ${esc(name)} (${esc(employeeId)})`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:620px;color:#1C1C1E;">
        <div style="background:#7B1C1C;padding:22px 26px;border-radius:6px 6px 0 0;">
          <p style="margin:0;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#F5A0A0;">Document Cross-Check Alert</p>
          <p style="margin:8px 0 0;font-size:20px;font-weight:700;color:#fff;">${esc(name)}</p>
          <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.6);">${esc(employeeId)}</p>
        </div>
        <div style="background:#fff;border:1px solid #E5E5E0;border-top:none;padding:24px 26px;border-radius:0 0 6px 6px;">
          <p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#1C1C1E;">
            The following <strong>${mismatches.length} mismatch${mismatches.length > 1 ? 'es were' : ' was'} detected</strong> when cross-checking
            <strong>${esc(name)}'s</strong> submitted documents. Please review before proceeding with onboarding.
          </p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #E5E5E0;border-radius:4px;overflow:hidden;">
            <thead>
              <tr style="background:#F5F5F5;">
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;">Field</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;">Document 1</th>
                <th style="padding:10px 12px;text-align:left;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;">Document 2</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin:20px 0 0;font-size:13px;color:#4A5A6A;line-height:1.6;">
            These discrepancies may indicate a data entry error, a name change, or a document belonging to a different person.
            Please verify with the employee and request corrected documents if needed.
          </p>
          <hr style="border:none;border-top:1px solid #E5E5E0;margin:20px 0;">
          <p style="margin:0;font-size:13px;color:#6B7280;">Regards,<br/>${co} HR</p>
        </div>
      </div>
    `,
  });
}

async function sendDOJScreenshotRequest(employee) {
  const { name, employeeId, doj, driveFolderId, contacts } = employee;
  const co  = esc(process.env.COMPANY_NAME || 'Alethea');
  const recruiterEmail = (contacts && contacts.recruiterEmail) || process.env.HR_EMAIL;
  if (!recruiterEmail) return;

  const dojFormatted = doj
    ? new Date(doj).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : '—';
  const folderUrl = driveFolderId
    ? `https://drive.google.com/drive/folders/${driveFolderId}`
    : null;

  await sendEmail({
    to: recruiterEmail,
    subject: `Action Required — Upload Meeting Screenshot for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;color:#1C1C1E;">
        <div style="background:#0F1923;padding:22px 26px;border-radius:6px 6px 0 0;">
          <p style="margin:0;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#3A7CA5;">Day of Joining — ${dojFormatted}</p>
          <p style="margin:8px 0 0;font-size:20px;font-weight:700;color:#fff;">${esc(name)}</p>
          <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.55);">${esc(employeeId)}</p>
        </div>
        <div style="background:#fff;border:1px solid #E5E5E0;border-top:none;padding:24px 26px;border-radius:0 0 6px 6px;">
          <p style="margin:0 0 16px;font-size:14px;line-height:1.7;color:#1C1C1E;">
            Today is <strong>${esc(name)}'s</strong> Date of Joining. Once each meeting is done, please upload a screenshot to the respective subfolder in their Drive folder.
          </p>
          <table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:13px;">
            <tr style="background:#F5F5F5;">
              <td style="padding:10px 14px;border:1px solid #E5E5E0;font-weight:600;color:#1C1C1E;">Meeting</td>
              <td style="padding:10px 14px;border:1px solid #E5E5E0;font-weight:600;color:#1C1C1E;">Upload to subfolder</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;border:1px solid #E5E5E0;color:#1C1C1E;">HR Induction</td>
              <td style="padding:10px 14px;border:1px solid #E5E5E0;font-family:monospace;color:#0D7F7F;">HR_Induction_Screenshot</td>
            </tr>
            <tr style="background:#F5F5F5;">
              <td style="padding:10px 14px;border:1px solid #E5E5E0;color:#1C1C1E;">Project Intro Meeting</td>
              <td style="padding:10px 14px;border:1px solid #E5E5E0;font-family:monospace;color:#0D7F7F;">Project_Intro_Screenshot</td>
            </tr>
          </table>
          <p style="margin:0 0 16px;font-size:13px;color:#4A5A6A;">The screenshot can be from Google Meet, Zoom, Teams, or a photo of a physical meeting. Any image that shows the meeting took place is accepted. Both screenshots are required to complete the Day of Joining milestone.</p>
          ${folderUrl ? `
          <a href="${folderUrl}" style="display:inline-block;background:#0D7F7F;color:#fff;text-decoration:none;padding:11px 22px;border-radius:4px;font-size:14px;font-weight:600;">
            Open ${esc(name)}'s Drive Folder
          </a>
          ` : ''}
          <p style="margin:20px 0 0;font-size:12px;color:#9CA3AF;line-height:1.6;">
            Upload each screenshot into its respective subfolder — not the root folder.<br>
            The system will automatically confirm attendance once both screenshots are uploaded.
          </p>
          <hr style="border:none;border-top:1px solid #E5E5E0;margin:20px 0;">
          <p style="margin:0;font-size:13px;color:#6B7280;">Regards,<br/>${co} HR</p>
        </div>
      </div>
    `,
  });
}

// Recruiter sheet reminder — sent daily until recruiter fills the review tab (Part 1)
async function sendRecruiterSheetReminder(employee, recruiterEmail, dayMark, sheetUrl) {
  const { name, employeeId } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const monthTab = dayMark === 30 ? 'Tracking - Month -1' : dayMark === 60 ? 'Tracking - Month -2' : 'Tracking - Month -3';
  const sheetSection = sheetUrl
    ? `<p style="margin:16px 0;"><a href="${sheetUrl}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">Open Tracking Sheet — ${esc(monthTab)}</a></p>`
    : '';
  return sendEmail({
    to: recruiterEmail,
    subject: `Reminder — Fill the ${dayMark}-Day Review Sheet for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi,</p>
      <div style="margin:16px 0;padding:12px 16px;background:#fff8e1;border-left:4px solid #ffa000;border-radius:2px;">
        <p style="margin:0 0 4px;font-weight:bold;color:#333;">What this reminder is about</p>
        <p style="margin:0;color:#555;">The <strong>${dayMark}-day project review</strong> for <strong>${esc(name)}</strong> (ID: ${esc(employeeId)}) was triggered ${dayMark} days after their joining. The review tracking sheet has a section <strong>"Filled by Recruiter"</strong> in the <strong>${esc(monthTab)}</strong> tab that you need to fill. The onboarding checklist cannot move forward until this is done. Once you fill it, the system will automatically email the manager to confirm the review.</p>
      </div>
      <p><strong>What to do:</strong> Open the tracking sheet, go to the <strong>${esc(monthTab)}</strong> tab, and fill in the "Filled by Recruiter" section.</p>
      ${sheetSection}
      <p style="font-size:13px;color:#888;">You will continue to receive this reminder every day until the sheet is updated.</p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

// Manager confirmation request — sent after recruiter fills the sheet (Part 2)
// Manager must reply "Done" to mark the milestone fully complete.
async function sendManagerConfirmationRequest(employee, managerEmail, dayMark) {
  const { name, employeeId } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const monthTab = dayMark === 30 ? 'Tracking - Month -1' : dayMark === 60 ? 'Tracking - Month -2' : 'Tracking - Month -3';
  const sheetUrl = employee.projectIntroSheetId
    ? `https://docs.google.com/spreadsheets/d/${employee.projectIntroSheetId}`
    : null;
  const sheetSection = sheetUrl
    ? `<p style="margin:16px 0;"><a href="${sheetUrl}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">Open Tracking Sheet — ${esc(monthTab)}</a></p>`
    : '';
  return sendEmail({
    to: managerEmail,
    subject: `Action Required — Confirm ${dayMark}-Day Review for ${esc(name)} (${esc(employeeId)})`,
    html: `
      <p>Hi,</p>
      <div style="margin:16px 0;padding:12px 16px;background:#fff8e1;border-left:4px solid #ffa000;border-radius:2px;">
        <p style="margin:0 0 4px;font-weight:bold;color:#333;">What this email is about</p>
        <p style="margin:0;color:#555;">The recruiter has filled in their section of the <strong>${dayMark}-day review tracking sheet</strong> (tab: <strong>${esc(monthTab)}</strong>) for <strong>${esc(name)}</strong> (ID: ${esc(employeeId)}). The final step is for you (the reporting manager) to confirm that the ${dayMark}-day review call was actually conducted. Your reply is what closes this milestone in the onboarding checklist.</p>
      </div>
      <p>You can review what the recruiter filled in the tracking sheet:</p>
      ${sheetSection}
      <p style="padding:10px 16px;background:#fffde7;border-left:4px solid #ffa000;">
        <strong>Reply to this email with "Done"</strong> once you have confirmed the ${dayMark}-day review call was completed.
      </p>
      <p>Regards,<br/>${co} HR</p>
    `,
  });
}

async function sendNoJoinNotification(employee) {
  const { name, employeeId, doj, contacts } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const recruiterEmail = (contacts && contacts.recruiterEmail) || process.env.HR_EMAIL;
  const hrEmailAddr = (contacts && contacts.hrEmail) || process.env.HR_EMAIL;
  const recipients = [...new Set([recruiterEmail, hrEmailAddr].filter(Boolean))].join(', ');

  await sendEmail({
    to: recipients,
    subject: `[Auto-Removed] ${esc(name)} (${esc(employeeId)}) — Pre-Onboarding Form Not Submitted`,
    html: `
      <p>Hi,</p>
      <p><strong>${esc(name)} (${esc(employeeId)})</strong> was scheduled to join on <strong>${esc(doj ? doj.split('T')[0] : '')}</strong>.</p>
      <p>Despite the welcome email and 3 follow-up reminders, the pre-onboarding form was not submitted within <strong>7 days</strong>. The candidate has been <strong>automatically removed</strong> from the onboarding system.</p>
      <p>If the candidate still intends to join, please contact HR to re-initiate the onboarding process.</p>
      <p>Regards,<br/>${co} HR Automation</p>
    `,
  });
}

async function sendOnboardingStoppedNotification(employee, reason) {
  const { name, employeeId, doj, contacts } = employee;
  const co = esc(process.env.COMPANY_NAME || '');
  const recruiterEmail = (contacts && contacts.recruiterEmail) || process.env.HR_EMAIL;
  const hrEmailAddr = (contacts && contacts.hrEmail) || process.env.HR_EMAIL;
  const managerEmail = (contacts && contacts.managerEmail);
  const itEmail = (contacts && contacts.itEmail);
  const recipients = [...new Set([recruiterEmail, hrEmailAddr, managerEmail, itEmail].filter(Boolean))].join(', ');
  const stopReason = esc(reason || 'Candidate did not join / Stop case requested');

  await sendEmail({
    to: recipients,
    subject: `[STOPPED] ${esc(name)} (${esc(employeeId)}) — Onboarding & Notifications Cancelled`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px;padding:24px;background:#ffffff;">
        <div style="background:#d32f2f;color:#ffffff;padding:12px 16px;border-radius:6px;font-size:16px;font-weight:bold;margin-bottom:20px;">
          ⛔ Onboarding Stopped — ${esc(name)} (${esc(employeeId)})
        </div>
        <p>Dear Team,</p>
        <p>Please note that the onboarding process for <strong>${esc(name)}</strong> (ID: <strong>${esc(employeeId)}</strong>) has been <strong>STOPPED</strong>.</p>
        <div style="background:#fff3e0;border-left:4px solid #ff9800;padding:12px 16px;margin:16px 0;border-radius:4px;">
          <strong>Reason / Trigger:</strong> ${stopReason}
        </div>
        <p><strong>Actions automatically executed by system:</strong></p>
        <ul>
          <li>All scheduled daily notifications (including project intro tracking sheet reminders) have been cancelled.</li>
          <li>All upcoming milestone reminder emails (25-day, 30-day, 60-day, 90-day, 5-month probation) have been stopped.</li>
          <li>All pending document reminder chains and stakeholder reply timers have been terminated.</li>
          <li>Employee status updated to <strong>STOPPED</strong> on the status sheet and master dashboard.</li>
        </ul>
        <p>No further action or email replies are required for this candidate.</p>
        <hr style="border:none;border-top:1px solid #eeeeee;margin:20px 0;" />
        <p style="color:#777777;font-size:12px;">Regards,<br/>${co} HR Automation Engine</p>
      </div>
    `,
  });
}

module.exports = {
  sendEmail,
  sendPreOnboardingForm,
  sendDocumentRejection,
  sendDocumentReminder,
  sendPreOnboardingReminder,
  sendNoResponseAlert,
  sendNoJoinNotification,
  sendOnboardingStoppedNotification,
  sendOfficialEmailCreationRequest,
  sendOfficialEmailAccessTest,
  sendAssetAllocationRequest,
  sendITAssetRequest,
  sendAdminSeatAllocationRequest,
  send25DayCatchupEmail,
  send30DayTechnicalReview,
  sendBGVRequest,
  sendBGVInitiateRequest,
  sendBGVUploadRequest,
  sendHRInductionConfirmation,
  sendPeriodicReviewReminder,
  sendPreProbationReminder,
  sendPhaseCompletionSummary,
  sendVerificationReport,
  sendInductionCalendarInvite,
  sendProjectIntroInvite,
  sendCatchupXLSEmail,
  sendReviewSummaryRequest,
  sendNoReplyEscalation,
  sendOnboardingCompletionReport,
  sendJoineeOnboardingComplete,
  sendJoineeReviewNotification,
  sendDOJScreenshotRequest,
  sendDocumentCrossCheckAlert,
  sendDayBeforeReminder,
  sendRecruiterSheetReminder,
  sendManagerConfirmationRequest,
};
