function createRecruiterForm() {
  const form = FormApp.create('New Joinee Onboarding — Recruiter Submission Form');
  form.setDescription(
    'Fill this form to register a new joinee and trigger the onboarding automation. ' +
    'All fields are mandatory unless marked optional. ' +
    'Once submitted, the engine will automatically send the pre-onboarding form to the new joinee ' +
    'and begin the onboarding process.'
  );
  form.setConfirmationMessage(
    'Thank you! The onboarding automation has been triggered for the new joinee.\n\n' +
    'The system will send the pre-onboarding form to the employee within a few minutes.\n\n' +
    'You will receive a confirmation email once the process begins.'
  );
  form.setCollectEmail(true);

  // ── Section 1: Employee Details ───────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('Section 1 — New Joinee Details');

  form.addTextItem()
    .setTitle('Employee Full Name')
    .setHelpText('As per Aadhaar card')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Employee ID')
    .setHelpText('e.g. EMP001')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Personal Email ID')
    .setHelpText('The email the employee uses personally — pre-onboarding form will be sent here')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Phone Number')
    .setHelpText('Employee\'s personal mobile number')
    .setRequired(true);

  form.addDateItem()
    .setTitle('Date of Joining (DOJ)')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Is this a Fresher?')
    .setChoiceValues(['Yes — No prior employment', 'No — Has prior employment experience'])
    .setRequired(true);

  // ── Section 2: Manager & IT Details ──────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('Section 2 — Manager & IT Contact');

  form.addTextItem()
    .setTitle('Reporting Manager\'s Full Name')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Reporting Manager\'s Email ID')
    .setRequired(true);

  form.addTextItem()
    .setTitle('IT Team Email ID')
    .setHelpText('Email of the IT person who will set up assets')
    .setRequired(true);

  form.addTextItem()
    .setTitle('HR Email ID')
    .setHelpText('Email of the HR person handling this joinee\'s onboarding')
    .setRequired(true);

  // ── Section 3: Location & Assets ─────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('Section 3 — Location & Asset Details');

  form.addMultipleChoiceItem()
    .setTitle('Work Location')
    .setChoiceValues(['Client Location', 'L1', 'L2', 'L4', 'T1'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Asset Required?')
    .setChoiceValues(['Yes — Asset required', 'No — Asset not required', 'Unaware — To be confirmed'])
    .setRequired(true);

  form.addTextItem()
    .setTitle('Designation / Role')
    .setHelpText('e.g. Software Engineer, Business Analyst')
    .setRequired(true);

  // ── Section 4: Additional Info ────────────────────────────────────────────
  form.addSectionHeaderItem()
    .setTitle('Section 4 — Additional Information');

  form.addTextItem()
    .setTitle('Google Drive Root Folder ID')
    .setHelpText('The ID of the Alethea Onboarding root folder in Drive (from the URL). Engine will create the employee subfolder inside this.')
    .setRequired(true);

  // ── Log URLs ──────────────────────────────────────────────────────────────
  Logger.log('✅ Recruiter Onboarding Form created successfully!');
  Logger.log('🔗 Published URL: ' + form.getPublishedUrl());
  Logger.log('📝 Edit URL:      ' + form.getEditUrl());
  Logger.log('📋 Form ID:       ' + form.getId());
  Logger.log('');
  Logger.log('→ Copy the Form ID and set up a Google Apps Script trigger on form submit');
  Logger.log('→ The trigger should POST the response to your engine webhook: POST /recruiter-form');
  Logger.log('→ Add the Published URL to .env as RECRUITER_FORM_LINK');
}

// ── Webhook trigger — runs on every form submission ───────────────────────
// Set this up as an installable trigger: Extensions → Apps Script → Triggers
// Event type: From form → On form submit
function onRecruiterFormSubmit(e) {
  const responses = e.response.getItemResponses();
  const data = {};

  for (const r of responses) {
    const title = r.getItem().getTitle().trim();
    const t = title.toLowerCase();
    const value = r.getResponse();

    if (t === 'employee full name')                    data.name = value;
    else if (t === 'employee id')                      data.employeeId = value;
    else if (t === 'personal email id')                data.personalEmail = value;
    else if (t === 'phone number')                     data.phoneNumber = value;
    else if (t === 'date of joining (doj)')            data.doj = value;
    else if (t === 'is this a fresher?')               data.isFresher = value.startsWith('Yes') || value.startsWith('yes');
    else if (t === "reporting manager's full name")    data.managerName = value;
    else if (t === "reporting manager's email id")     data.managerEmail = value;
    else if (t === 'it team email id')                 data.itEmail = value;
    else if (t === 'hr email id')                      data.hrEmail = value;
    else if (t === 'work location')                    data.officeLocation = value;
    else if (t === 'asset required?' || t === 'asset required') data.assetRequired = value;
    else if (t === 'designation / role')               data.designation = value;
    else if (t === 'google drive root folder id')      data.driveFolderId = value;
    else Logger.log('Unmatched form question: "' + title + '" = "' + value + '"');
  }

  Logger.log('Mapped data: ' + JSON.stringify(data));

  // Build the recruiter email from the form submission (for the record)
  const recruiterEmail = e.response.getRespondentEmail();
  data.recruiterEmail = recruiterEmail;

  // POST to engine webhook
  const engineUrl = 'YOUR_ENGINE_WEBHOOK_URL/recruiter-form'; // replace with your ngrok/production URL
  const payload = JSON.stringify(data);

  try {
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: payload,
      muteHttpExceptions: true,
    };
    const response = UrlFetchApp.fetch(engineUrl, options);
    Logger.log('Engine response: ' + response.getContentText());

    if (response.getResponseCode() === 200) {
      Logger.log('✅ Onboarding triggered successfully for ' + data.name);
    } else {
      Logger.log('❌ Engine returned error: ' + response.getResponseCode());
      // Send alert email to recruiter
      GmailApp.sendEmail(
        recruiterEmail,
        'Onboarding Trigger Failed — ' + (data.name || 'Unknown'),
        'Hi,\n\nThe onboarding automation could not be triggered for ' + (data.name || 'the new joinee') +
        '.\n\nPlease contact the HR automation team to resolve this.\n\nEngine response: ' +
        response.getContentText() + '\n\nAlethea HR Automation'
      );
    }
  } catch (err) {
    Logger.log('❌ Error posting to engine: ' + err.message);
    GmailApp.sendEmail(
      recruiterEmail,
      'Onboarding Trigger Failed — ' + (data.name || 'Unknown'),
      'Hi,\n\nThe onboarding automation could not be triggered for ' + (data.name || 'the new joinee') +
      ' due to a network error.\n\nError: ' + err.message + '\n\nPlease contact the HR automation team.\n\nAlethea HR Automation'
    );
  }
}
