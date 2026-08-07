function createExperiencedPreonboardingForm() {
  const form = FormApp.create('Alethea — New Joinee Pre-Onboarding Form (Experienced)');
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

  // ── Hidden fields — pre-filled by engine when sending the form link ────────
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
    .setHelpText('Where you currently live — Aadhaar card, PG rent slip, wifi bill, electricity bill, or rent agreement. — Change this question type to File Upload')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Permanent Address Proof')
    .setHelpText('Your hometown/permanent address — Aadhaar card only. — Change this question type to File Upload')
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

  // ── Section 4: Previous Employment Details ────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('Section 4 — Previous Employment Details');

  form.addTextItem()
    .setTitle('Previous Company Name')
    .setHelpText('Most recent employer')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Employment Duration')
    .setHelpText('e.g. June 2022 — March 2024')
    .setRequired(true);

  form.addTextItem()
    .setTitle("Previous Manager's Email")
    .setHelpText('Email of your reporting manager at your previous company')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Upload Relieving Letter')
    .setHelpText('Relieving letter or experience letter from your most recent employer (PDF). — Change this question type to File Upload')
    .setRequired(true);

  form.addTextItem()
    .setTitle("Upload Last Month's Payslip")
    .setHelpText('Most recent payslip from your previous employer (PDF or JPG). — Change this question type to File Upload')
    .setRequired(true);

  // ── Log URLs ──────────────────────────────────────────────────────────────
  Logger.log('✅ Experienced Pre-Onboarding Form created!');
  Logger.log('🔗 Published URL: ' + form.getPublishedUrl());
  Logger.log('📋 Form ID:       ' + form.getId());
  Logger.log('→ Add Published URL to .env as PREONBOARDING_FORM_EXPERIENCED_LINK');
}

// ── Form submit trigger setup ─────────────────────────────────────────────────
// Run installExperiencedTrigger() ONCE after creating or recreating the form.
function installExperiencedTrigger() {
  var formId = PropertiesService.getScriptProperties().getProperty('EXPERIENCED_FORM_ID');
  if (!formId) {
    Logger.log('❌ Set EXPERIENCED_FORM_ID in Script Properties first (Extensions → Apps Script → Project Settings → Script Properties)');
    return;
  }
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'onExperiencedFormSubmit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onExperiencedFormSubmit')
    .forForm(formId)
    .onFormSubmit()
    .create();
  Logger.log('✅ Trigger installed for form: ' + formId);
}

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
  'Upload Relieving Letter':       'Relieving_Letter',
  "Upload Last Month's Payslip":   'Payslip',
};

// Root onboarding folder ID — the "Alethea Onboarding" folder in Drive
var ALETHEA_ONBOARDING_ROOT_ID = '1iRrIbE2POIxQVSjbVDlHt1QjVM6LLnob';

var ENGINE_WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty('ENGINE_WEBHOOK_URL') || '';

function onExperiencedFormSubmit(e) {
  var responses = e.response.getItemResponses();
  var employeeId = '';
  var uploadedFiles = [];
  var personalDetails = {};

  for (var i = 0; i < responses.length; i++) {
    var title = responses[i].getItem().getTitle().trim();
    var value = responses[i].getResponse();

    if (title === 'Drive Folder ID' || title === 'Drive Folder ID( Pre-filled by HR — do not edit)') {
      // no longer used — engine uses its own registry
    } else if (title === 'Employee ID' || title === 'Employee ID( Pre-filled by HR — do not edit)') {
      employeeId = value;
    } else if (FOLDER_MAP[title]) {
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

  try {
    var payload = {
      employeeId: employeeId,
      respondentEmail: e.response.getRespondentEmail(),
      personalDetails: personalDetails,
      uploadedFiles: uploadedFiles,
    };
    var resp = UrlFetchApp.fetch(ENGINE_WEBHOOK_URL + '/preonboarding-details', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    Logger.log('✅ Sent to engine — status: ' + resp.getResponseCode() + ' files: ' + uploadedFiles.length);
  } catch (err) {
    Logger.log('⚠️ Could not send to engine: ' + err.message);
  }
}
