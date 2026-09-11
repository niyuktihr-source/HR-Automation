function createFresherPreonboardingForm() {
  const form = FormApp.create('Alethea — New Joinee Pre-Onboarding Form (Fresher)');
  form.setDescription(
    'Welcome to Alethea Communications Technologies Pvt Ltd!\n\n' +
    'Please fill this form completely before your Date of Joining. ' +
    'All documents must be uploaded as clear, legible scans or photos (PDF or JPG preferred).\n\n' +
    'If you face any issues, contact HR at hr@aletheatech.com.'
  );
  form.setConfirmationMessage(
    'Thank you for submitting your pre-onboarding details!\n\n' +
    'HR will review your documents and get in touch if anything is missing.\n\n' +
    'Welcome aboard — we look forward to having you on the team!'
  );
  form.setCollectEmail(true);

  // ── Hidden field — pre-filled by engine when sending the form link ─────────
  // Engine generates a pre-filled URL with employeeId and driveFolderId embedded.
  // New joiner never sees or edits this — it is used by the submit trigger to
  // move uploaded files into the correct Drive subfolders automatically.
  form.addTextItem()
    .setTitle('Employee ID')
    .setRequired(false);

  form.addTextItem()
    .setTitle('Drive Folder ID')
    .setHelpText('Pre-filled by HR — do not edit')
    .setRequired(false);

  // ── Section 1: Personal Details ───────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('Section 1 — Personal Details');

  form.addTextItem()
    .setTitle('Full Name')
    .setHelpText('As it appears on your Aadhaar card')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Current Residential Address')
    .setHelpText('Full address including city, state and PIN code')
    .setRequired(true);

  // ── Section 1b: Meeting Preferences ──────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('Section 1b — Meeting Time Preferences')
    .setHelpText('We will try our best to schedule your DOJ meetings at your preferred times. Leave blank to use the default slots.');

  form.addTextItem()
    .setTitle('Preferred Time for HR Induction')
    .setHelpText('Default: 9:30 AM on your Date of Joining. Enter your preferred time e.g. 10:00 AM, 11:30 AM')
    .setRequired(false);

  form.addTextItem()
    .setTitle('Preferred Time for Project Intro Meeting')
    .setHelpText('Default: 2:00 PM on your Date of Joining. Enter your preferred time e.g. 3:00 PM, 4:00 PM')
    .setRequired(false);

  // ── Section 2: Identity Documents ────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('Section 2 — Identity Documents')
    .setHelpText('Upload clear scans or photos. PDF or JPG preferred.');

  form.addTextItem()
    .setTitle('Aadhaar Number')
    .setHelpText('12-digit Aadhaar number')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Upload Aadhaar Card')
    .setHelpText('Front and back scan in a single file. Must be clearly legible. — Change this question type to File Upload')
    .setRequired(true);

  form.addTextItem()
    .setTitle('PAN Number')
    .setHelpText('10-character PAN number e.g. ABCDE1234F')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Upload PAN Card')
    .setHelpText('Clear scan or photo of your PAN card (PDF or JPG). — Change this question type to File Upload')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Current Address Proof')
    .setHelpText('PG rent slip, wifi bill, electricity bill, or rent agreement showing your current address. — Change this question type to File Upload')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Permanent Address Proof')
    .setHelpText('Aadhaar card showing your permanent/hometown address. — Change this question type to File Upload')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Upload Passport Size Photo')
    .setHelpText('Recent photo taken within the last 3 months. Plain white or light background. JPG preferred. — Change this question type to File Upload')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Upload Offer Letter')
    .setHelpText('Signed copy of your Alethea offer letter (PDF). — Change this question type to File Upload')
    .setRequired(true);

  // ── Section 3: Academic Documents ────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('Section 3 — Academic Documents')
    .setHelpText('Upload clear scans. PDF or JPG preferred.');

  form.addTextItem()
    .setTitle('Upload 10th Marksheet')
    .setHelpText('Clear scan of your 10th standard / SSLC / Matriculation marksheet (PDF or JPG). — Change this question type to File Upload')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Upload 12th Marksheet')
    .setHelpText('Clear scan of your 12th standard / HSC / Diploma marksheet (PDF or JPG). — Change this question type to File Upload')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Upload Degree Certificate')
    .setHelpText('Combine ALL semester marksheets (Sem 1 to Sem 8) into a SINGLE PDF in order. Include your final degree/consolidated marksheet at the end. — Change this question type to File Upload')
    .setRequired(true);

  // ── Log URLs ──────────────────────────────────────────────────────────────
  Logger.log('✅ Fresher Pre-Onboarding Form created!');
  Logger.log('🔗 Published URL: ' + form.getPublishedUrl());
  Logger.log('📋 Form ID:       ' + form.getId());
  Logger.log('→ Add Published URL to .env as PREONBOARDING_FORM_FRESHER_LINK');
}

// ── Form submit trigger setup ─────────────────────────────────────────────────
// Run installFresherTrigger() ONCE after creating or recreating the form.
// It deletes any old trigger for this script and installs a fresh one.
function installFresherTrigger() {
  var formId = PropertiesService.getScriptProperties().getProperty('FRESHER_FORM_ID');
  if (!formId) {
    Logger.log('❌ Set FRESHER_FORM_ID in Script Properties first (Extensions → Apps Script → Project Settings → Script Properties)');
    return;
  }
  // Remove any existing onFresherFormSubmit triggers to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'onFresherFormSubmit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onFresherFormSubmit')
    .forForm(formId)
    .onFormSubmit()
    .create();
  Logger.log('✅ Trigger installed for form: ' + formId);
}

// Map of form question title → Drive subfolder name
var FOLDER_MAP = {
  'Upload Aadhaar Card':           'Aadhaar',
  'Upload PAN Card':               'PAN',
  'Current Address Proof':         'Current_Address_Proof',
  'Permanent Address Proof':       'Permanent_Address_Proof',
  'Upload Passport Size Photo':    'Passport_Photo',
  'Upload Offer Letter':           'Offer_Letter',
  'Upload 10th Marksheet':         'Marksheet_10th',
  'Upload 12th Marksheet':         'Marksheet_12th',
  'Upload Degree Certificate':     'Degree_Certificate',
};

// Root onboarding folder ID — the "Alethea Onboarding" folder in Drive
// Update this if the root folder changes
var ALETHEA_ONBOARDING_ROOT_ID = '1iRrIbE2POIxQVSjbVDlHt1QjVM6LLnob';

var ENGINE_WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty('ENGINE_WEBHOOK_URL') || '';
var HR_ALERT_EMAIL = PropertiesService.getScriptProperties().getProperty('HR_ALERT_EMAIL') || 'hr@aletheatech.com';

// POSTs to the engine with a few retries (exponential backoff) before giving up.
// A single failed attempt previously meant the joinee's documents stayed stuck in
// this form's own file-response storage forever, with nothing anywhere noticing —
// most commonly because the engine happened to be mid-restart at that exact moment.
function postToEngineWithRetry(url, payload, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  var lastError = null;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      var resp = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      var code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        return { ok: true, code: code, attempt: attempt };
      }
      lastError = 'HTTP ' + code + ': ' + resp.getContentText();
    } catch (err) {
      lastError = err.message;
    }
    if (attempt < maxAttempts) {
      var delayMs = Math.pow(2, attempt) * 2000; // 4s, 8s, 16s...
      Logger.log('⚠️ Attempt ' + attempt + ' failed (' + lastError + ') — retrying in ' + (delayMs / 1000) + 's');
      Utilities.sleep(delayMs);
    }
  }
  return { ok: false, error: lastError, attempt: maxAttempts };
}

function onFresherFormSubmit(e) {
  var responses = e.response.getItemResponses();
  var employeeId = '';
  var uploadedFiles = [];
  var personalDetails = {};

  for (var i = 0; i < responses.length; i++) {
    var item = responses[i].getItem();
    var title = item.getTitle().trim();
    var value = responses[i].getResponse();

    if (title === 'Drive Folder ID' || title === 'Drive Folder ID( Pre-filled by HR — do not edit)') {
      // no longer used here — engine uses its own registry
    } else if (title === 'Employee ID' || title === 'Employee ID( Pre-filled by HR — do not edit)') {
      employeeId = value;
    } else if (FOLDER_MAP[title]) {
      // File upload question — value is array of file IDs
      var fileIds = Array.isArray(value) ? value : (value ? String(value).split(',') : []);
      var subfolder = FOLDER_MAP[title];
      for (var j = 0; j < fileIds.length; j++) {
        var fid = String(fileIds[j]).trim();
        if (fid) uploadedFiles.push({ fileId: fid, subfolder: subfolder });
      }
    } else {
      personalDetails[title] = value;
    }
  }

  if (!ENGINE_WEBHOOK_URL || !employeeId) {
    Logger.log('⚠️ ENGINE_WEBHOOK_URL or employeeId missing — cannot notify engine');
    return;
  }

  var payload = {
    employeeId: employeeId,
    respondentEmail: e.response.getRespondentEmail(),
    personalDetails: personalDetails,
    uploadedFiles: uploadedFiles,
  };
  var result = postToEngineWithRetry(ENGINE_WEBHOOK_URL + '/preonboarding-details', payload, 3);

  if (result.ok) {
    Logger.log('✅ Sent to engine on attempt ' + result.attempt + ' — status: ' + result.code + ' files: ' + uploadedFiles.length);
    return;
  }

  // All retries failed — the engine may be down or mid-restart. Don't let this
  // fail silently: email HR directly (this doesn't depend on the engine at all).
  Logger.log('⚠️ Could not reach engine after ' + result.attempt + ' attempts: ' + result.error);
  try {
    MailApp.sendEmail({
      to: HR_ALERT_EMAIL,
      subject: 'ALERT — Pre-Onboarding Form Could Not Reach Engine (' + employeeId + ')',
      body: 'The pre-onboarding form (Fresher) was submitted for employee ' + employeeId +
        ' (' + (e.response.getRespondentEmail() || 'unknown email') + '), but the automation engine ' +
        'could not be reached after ' + result.attempt + ' attempts.\n\n' +
        'Error: ' + result.error + '\n\n' +
        uploadedFiles.length + ' document(s) were uploaded in this submission and are currently ' +
        'sitting in this Form\'s own file-response storage — they have NOT been moved into the ' +
        'employee\'s Drive folder yet.\n\n' +
        'The engine will attempt to recover this automatically the next time it restarts. If this ' +
        'keeps happening, check whether the engine is online.',
    });
  } catch (mailErr) {
    Logger.log('⚠️ Could not send HR alert email either: ' + mailErr.message);
  }
}
