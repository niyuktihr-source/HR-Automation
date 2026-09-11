// config.js — all tuneable values in one place
// Change values here instead of hunting through source files.

module.exports = {

  // ─── Timezone ──────────────────────────────────────────────────────────────
  timezone: 'Asia/Kolkata',

  // ─── Milestone day offsets (days after DOJ) ────────────────────────────────
  milestones: {
    surveyday:      25,   // onboarding survey sent to employee
    catchup30day:   30,   // 30-day catchup call reminder
    review60day:    60,   // 60-day review reminder
    review90day:    90,   // 90-day review reminder
    probation150day: 150, // pre-probation check
  },

  // ─── Reply deadline windows (hours) ────────────────────────────────────────
  replyDeadlines: {
    noResponseAlertHours: 24, // alert recruiter if employee doesn't upload docs
    stakeholderReplyHours: 48, // escalate if stakeholder (HR/manager/IT) doesn't reply
    reviewNoReplyHours: 48,   // escalate if review confirmation doesn't arrive
  },

  // ─── Calendar event times (24-hour, IST) ───────────────────────────────────
  calendarEvents: {
    hrInduction:    { hour: 10, minute: 30, durationMins: 90 }, // DOJ 10:30–12 PM
    projectIntro:   { hour: 14, minute: 0,  durationMins: 60 }, // DOJ+3 days 2–3 PM
    catchup25day:   { hour: 11, minute: 0,  durationMins: 30 }, // day 25 11–11:30 AM
    catchup30day:   { hour: 11, minute: 0,  durationMins: 30 }, // day 30 11–11:30 AM
    reviewMeeting:  { hour: 15, minute: 0,  durationMins: 60 }, // day 60/90 3–4 PM
    projectIntroDayOffset: 3, // days after DOJ for project intro meeting
  },

  // ─── Drive folder structure ─────────────────────────────────────────────────
  driveSubfolders: ['Aadhaar', 'PAN', 'Current_Address_Proof', 'Permanent_Address_Proof', 'Offer_Letter', 'Passport_Photo', 'Passport', 'UAN', 'Payslip', 'Relieving_Letter', 'Marksheet_10th', 'Marksheet_12th', 'Degree_Certificate', 'Postgrad_Certificate', 'BGV', 'HR_Induction_Screenshot', 'Project_Intro_Screenshot', 'Reports'],

  // ─── Pre-onboarding form file-upload question → Drive subfolder ────────────
  // Must stay in sync with FOLDER_MAP in scripts/createFresherPreonboardingForm.gs
  // and scripts/createExperiencedPreonboardingForm.gs.
  formFileUploadMap: {
    'Upload Aadhaar Card':         'Aadhaar',
    'Upload PAN Card':              'PAN',
    'Current Address Proof':        'Current_Address_Proof',
    'Permanent Address Proof':      'Permanent_Address_Proof',
    'Upload Passport Size Photo':   'Passport_Photo',
    'Upload Offer Letter':          'Offer_Letter',
    'Upload 10th Marksheet':        'Marksheet_10th',
    'Upload 12th Marksheet':        'Marksheet_12th',
    'Upload Degree Certificate':    'Degree_Certificate',
    'Upload Relieving Letter':      'Relieving_Letter',
    "Upload Last Month's Payslip":  'Payslip',
  },

  // ─── Drive push channel TTL ─────────────────────────────────────────────────
  drivePushChannelTtlDays: 6,
  drivePushRenewBeforeExpirySecs: 3600, // renew 1 hour before expiry

  // ─── Document detection keywords (filename matching) ───────────────────────
  docKeywords: {
    aadhaar:           ['aadhaar', 'aadhar', 'uid'],
    pan:               ['pan', 'pancard', 'pan_card'],
    offerLetter:       ['offer', 'offerletter', 'offer_letter'],
    meetingScreenshot: ['meeting', 'screenshot', 'induction', 'intro'],
    passportPhoto:     ['passport', 'photo', 'headshot', 'profile'],
    payslip:           ['payslip', 'pay_slip', 'salary', 'salary_slip'],
    relievingLetter:   ['relieving', 'relieve', 'experience', 'relieving_letter'],
    marksheet10th:     ['10th', '10_th', 'tenth', 'sslc', 'matriculation', 'marksheet_10'],
    marksheet12th:     ['12th', '12_th', 'twelfth', 'hsc', 'diploma', 'intermediate', 'marksheet_12'],
    degreeCertificate: ['degree', 'graduation', 'consolidated', 'btech', 'be_', 'bsc', 'bcom', 'ba_', 'bca', 'bba'],
    postgradCertificate: ['postgrad', 'post_grad', 'mtech', 'msc', 'mba', 'mca', 'phd', 'masters', 'pg_'],
    currentAddressProof:   ['current_address', 'current_address_proof', 'present_address', 'electricity', 'wifi', 'rent', 'rental', 'receipt', 'lease', 'pg_rent'],
    permanentAddressProof: ['permanent_address', 'permanent_address_proof', 'hometown', 'native'],
    uan:                   ['uan', 'umang', 'epfo', 'universal_account', 'pf_account'],
  },

  // ─── Optional documents — auto-marked N/A if not uploaded within this many days ──
  optionalDocGraceDays: 3,

  // ─── Webhook file-change window (ms) ───────────────────────────────────────
  // How far back to look for changed Drive files on each push notification
  driveChangeLookbackMs: 5 * 60 * 1000, // 5 minutes

  // ─── Status sheet display ──────────────────────────────────────────────────
  statusSymbols: {
    pending:    '⏳ Pending',
    inProgress: '🔄 In Progress',
    done:       '✅ Done',
    actionReq:  '⚠️ Action Required',
    notOk:      '❌ Not OK',
  },

  // ─── Daily health check cron (runs on weekdays) ────────────────────────────
  healthCheckCron: '0 9 * * 1-5', // 9 AM Mon–Fri

  // ─── Drive folder polling interval (ms) ────────────────────────────────────
  drivePollIntervalMs: 60 * 1000, // 60 seconds

  // ─── Stuck-task detection threshold (hours) ────────────────────────────────
  stuckTaskThresholdHours: 48,

  // ─── Gemini model ──────────────────────────────────────────────────────────
  // Used by documentVerifier.js and gmailWatcher.js
  geminiModel: 'gemini-3.1-flash-lite',
};
