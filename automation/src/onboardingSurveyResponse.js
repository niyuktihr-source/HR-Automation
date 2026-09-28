// onboardingSurveyResponse.js — day-23 onboarding survey ("Employee Feedback Form:
// Onboarding Experience").
//
// Each joinee gets their own copy of the template form (ONBOARDING_SURVEY_TEMPLATE_FORM_ID),
// saved in their Drive folder as "Employee Feedback Form: Onboarding Experience (<name>)"
// and shared with their recruiter as an editor. Because the form belongs to one joinee,
// every response in it is theirs — no name/email matching needed. Responses are read
// via the Forms API; once every question is answered, the answers are written to a
// small Sheet in the joinee's folder and exported as .xlsx for the recruiter.
//
// Legacy path: joinees who were sent the old shared form (before per-joinee forms)
// have no `onboardingSurveyForm` on their record — for them the shared response
// spreadsheet (ONBOARDING_SURVEY_RESPONSES_ID) is still searched for their row.

const { google } = require('googleapis');
const { fetchFormResponseRows } = require('./formDocReconciler');
const { findLatestFormRow } = require('./formRowMatcher');

const FORM_TITLE_PREFIX = 'Employee Feedback Form: Onboarding Experience';

// Copies the template form for this joinee, shares it with the recruiter (editor) and
// publishes it. Returns { formId, responderUrl, editUrl }, or the existing record if the
// joinee already has a form — so a retry or restart never creates a duplicate.
async function ensureJoineeSurveyForm(auth, employee) {
  const existing = employee.onboardingSurveyForm;
  if (existing && existing.formId && existing.responderUrl) return existing;

  const drive = google.drive({ version: 'v3', auth });
  const forms = google.forms({ version: 'v1', auth });
  const { name, employeeId } = employee;
  const recruiterEmail = (employee.contacts || {}).recruiterEmail;

  // A previous attempt may have made the copy but failed before finishing setup —
  // reuse that copy and just redo the remaining steps.
  if (!existing || !existing.formId) {
    const templateId = process.env.ONBOARDING_SURVEY_TEMPLATE_FORM_ID;
    if (!templateId) {
      throw new Error('ONBOARDING_SURVEY_TEMPLATE_FORM_ID is not configured');
    }
    const copy = await drive.files.copy({
      fileId: templateId,
      requestBody: {
        name: `${FORM_TITLE_PREFIX} (${name})`,
        parents: employee.driveFolderId ? [employee.driveFolderId] : undefined,
      },
      fields: 'id',
      supportsAllDrives: true,
    });
    const formId = copy.data.id;

    // Save the ID straight away so a failure in the steps below can't lead to a second copy.
    employee.onboardingSurveyForm = {
      formId,
      editUrl: `https://docs.google.com/forms/d/${formId}/edit`,
      responderUrl: null,
    };
    if (employee._saveState) employee._saveState();
    console.log(`[SurveyForm] Created onboarding survey form for ${name} (${employeeId}): ${formId}`);
  }
  const { formId } = employee.onboardingSurveyForm;

  // A copied form may start unpublished — publish it and open it for responses. Older
  // forms that predate Google's publish settings are always live and reject this call.
  await forms.forms.setPublishSettings({
    formId,
    requestBody: {
      publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } },
      updateMask: 'publishState',
    },
  }).catch(err => console.warn(`[SurveyForm] Could not set publish state for ${name}'s form (may already be live): ${err.message}`));

  const meta = await forms.forms.get({ formId });
  employee.onboardingSurveyForm.responderUrl = meta.data.responderUri;

  if (recruiterEmail) {
    await drive.permissions.create({
      fileId: formId,
      requestBody: { type: 'user', role: 'writer', emailAddress: recruiterEmail },
      sendNotificationEmail: false, // the recruiter notice email carries the link
      supportsAllDrives: true,
    }).catch(err => console.warn(`[SurveyForm] Could not give ${recruiterEmail} edit access to ${name}'s form: ${err.message}`));
  }

  if (employee._saveState) employee._saveState();
  return employee.onboardingSurveyForm;
}

// Flattens a form's items into the questions that need an answer, in form order.
// Grid questions contribute one entry per row; text/image/video/section items none.
function listFormQuestions(items) {
  const questions = [];
  for (const item of items || []) {
    if (item.questionItem && item.questionItem.question) {
      questions.push({ id: item.questionItem.question.questionId, title: item.title || '' });
    } else if (item.questionGroupItem && item.questionGroupItem.questions) {
      for (const q of item.questionGroupItem.questions) {
        const rowTitle = (q.rowQuestion && q.rowQuestion.title) || '';
        questions.push({ id: q.questionId, title: `${item.title || ''} [${rowTitle}]` });
      }
    }
  }
  return questions;
}

// Returns the text of one answer ('' when unanswered). File-upload answers are
// rendered as their file names.
function answerText(answer) {
  if (!answer) return '';
  if (answer.textAnswers && answer.textAnswers.answers) {
    return answer.textAnswers.answers.map(a => a.value || '').filter(Boolean).join(', ');
  }
  if (answer.fileUploadAnswers && answer.fileUploadAnswers.answers) {
    return answer.fileUploadAnswers.answers.map(a => a.fileName || a.fileId || '').filter(Boolean).join(', ');
  }
  return '';
}

// Pure: picks the latest response and lines its answers up with the questions.
// Returns null if there is no response yet, else { complete, headers, row }.
function buildSurveyResult(items, responses) {
  if (!responses || responses.length === 0) return null;
  const latest = responses.reduce((a, b) =>
    new Date(b.lastSubmittedTime || 0) > new Date(a.lastSubmittedTime || 0) ? b : a
  );
  const questions = listFormQuestions(items);
  const answers = latest.answers || {};
  const values = questions.map(q => answerText(answers[q.id]));
  const complete = values.every(v => v.trim().length > 0);

  const headers = ['Submitted At', ...questions.map(q => q.title)];
  const row = [latest.lastSubmittedTime || '', ...values];
  if (latest.respondentEmail) {
    headers.splice(1, 0, 'Email Address');
    row.splice(1, 0, latest.respondentEmail);
  }
  return { complete, headers, row };
}

// Returns null if nothing has been submitted yet. Otherwise returns
// { complete, headers, row } — complete is true only once every question has an answer.
async function checkOnboardingSurveyResponse(auth, employee, rowCache = {}) {
  if (employee.onboardingSurveyForm && employee.onboardingSurveyForm.formId) {
    const forms = google.forms({ version: 'v1', auth });
    const { formId } = employee.onboardingSurveyForm;
    const [meta, res] = await Promise.all([
      forms.forms.get({ formId }),
      forms.forms.responses.list({ formId }),
    ]);
    return buildSurveyResult(meta.data.items, res.data.responses);
  }
  return checkSharedSheetResponse(auth, employee, rowCache);
}

// Legacy: find the joinee's row in the shared form's response spreadsheet.
async function checkSharedSheetResponse(auth, employee, rowCache) {
  const spreadsheetId = process.env.ONBOARDING_SURVEY_RESPONSES_ID;
  if (!spreadsheetId) {
    console.warn('[SurveyForm] ONBOARDING_SURVEY_RESPONSES_ID is not configured — cannot auto-detect survey completion.');
    return null;
  }

  const sheets = google.sheets({ version: 'v4', auth });
  if (!rowCache[spreadsheetId]) {
    rowCache[spreadsheetId] = await fetchFormResponseRows(sheets, spreadsheetId);
  }

  const match = findLatestFormRow(rowCache[spreadsheetId], employee);
  if (!match) return null;

  const { row, headers } = match;
  const complete = headers.every((h, i) => {
    const title = (h || '').trim().toLowerCase();
    if (title === 'timestamp') return true; // always populated, not a real answer
    return (row[i] || '').toString().trim().length > 0;
  });

  return { complete, headers, row };
}

// Creates a small Sheet in the joinee's own Drive folder containing just their
// survey answers (Question / Answer columns), shares it with their recruiter as a
// reader, and returns { spreadsheetId, url }.
async function createOnboardingSurveyResponseCopy(auth, employee, headers, row) {
  const drive = google.drive({ version: 'v3', auth });
  const sheets = google.sheets({ version: 'v4', auth });
  const { name, employeeId } = employee;
  const recruiterEmail = (employee.contacts || {}).recruiterEmail;
  const targetFolderId = employee.driveFolderId;

  const file = await drive.files.create({
    requestBody: {
      name: `${FORM_TITLE_PREFIX} (${name}) — Response (${employeeId})`,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: targetFolderId ? [targetFolderId] : undefined,
    },
    fields: 'id',
  });
  const spreadsheetId = file.data.id;

  const values = [['Question', 'Answer'], ...headers.map((h, i) => [h, row[i] || ''])];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'A1',
    valueInputOption: 'RAW',
    requestBody: { values },
  });

  if (recruiterEmail) {
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: { type: 'user', role: 'reader', emailAddress: recruiterEmail },
      sendNotificationEmail: false,
    }).catch(e => console.warn(`[SurveyForm] Could not share survey response with ${recruiterEmail}: ${e.message}`));
  }

  return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
}

// Exports a Google Sheet as .xlsx and returns a nodemailer attachment for it.
async function exportResponseAsXlsx(auth, employee, spreadsheetId) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.export(
    { fileId: spreadsheetId, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { responseType: 'arraybuffer' }
  );
  // Colons are not allowed in Windows file names, so the attachment name drops them.
  const safeName = String(employee.name || '').replace(/[\\/:*?"<>|]/g, '').trim();
  return {
    filename: `Employee Feedback Form - Onboarding Experience (${safeName}) - ${employee.employeeId}.xlsx`,
    content: Buffer.from(res.data),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

module.exports = {
  ensureJoineeSurveyForm,
  checkOnboardingSurveyResponse,
  createOnboardingSurveyResponseCopy,
  exportResponseAsXlsx,
  buildSurveyResult,
};
