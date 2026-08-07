const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

// Lazy — only instantiated when GEMINI_API_KEY is present, so module load never crashes
let _genAI = null;
function getGenAI() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _genAI;
}

// Document type → verification prompt
const VERIFICATION_PROMPTS = {
  aadhaar: `You are verifying an Aadhaar card document. The front side of the Aadhaar card is sufficient — you do NOT need both sides. Check ONLY the following four criteria and respond with a JSON object:
{
  "valid": true/false,
  "docType": "Aadhaar Card",
  "checks": {
    "legible": true/false,
    "nameVisible": true/false,
    "aadhaarNumberVisible": true/false,
    "photoVisible": true/false
  },
  "failureReasons": ["list only which of the four checks above failed"],
  "summary": "one sentence summary"
}
Set valid=true if ALL four checks pass. Do NOT fail for any other reason (e.g. masked digits, missing back side, partial card, format concerns). A masked Aadhaar showing the last 4 digits still counts as aadhaarNumberVisible=true.`,

  pan: `You are verifying a PAN card document. Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "PAN Card",
  "checks": {
    "legible": true/false,
    "nameVisible": true/false,
    "panNumberVisible": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Only set valid=true if ALL three checks pass.`,

  offerLetter: `You are verifying an appointment letter / offer letter from Alethea Communications Technologies. The document may be titled "Appointment Letter" or "Offer Letter". Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "Offer Letter",
  "checks": {
    "signed": true/false,
    "candidateNameVisible": true/false,
    "dateVisible": true/false,
    "aletheaCompanyName": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Check definitions:
- "signed": Both the company and employee signatures should be present. Company signature: look for "Chimbu K Aravind" or "Founder, Director" or any signature block on behalf of Alethea. Employee signature: look for a signature or name filled in the employee acceptance section at the end. Set signed=true only if BOTH are present.
- "candidateNameVisible": The candidate's name appears on the letter (usually top-left or in the salutation "Dear [Name]").
- "dateVisible": A date is present anywhere on the letter.
- "aletheaCompanyName": The name "Alethea" or "Alethea Communications Technologies" is visible anywhere — in the letterhead, logo, body, or footer.
Only set valid=true if ALL four checks pass.`,

  inductionScreenshot: `You are an HR automation assistant verifying a screenshot of an HR Induction meeting to confirm that the new employee attended their HR induction session on their Date of Joining.

Analyse the screenshot and respond ONLY with a JSON object in this exact format:
{
  "valid": true/false,
  "docType": "HR Induction Screenshot",
  "checks": {
    "isMeetingOrVideoCall": true/false,
    "participantsOrNamesVisible": true/false,
    "meetingContextEvident": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}

Check definitions:
- "isMeetingOrVideoCall": The image shows a video call, meeting room, or virtual meeting interface (Google Meet, Zoom, Teams, etc.) OR a physical meeting/induction session photo. Set true if ANY meeting evidence is visible.
- "participantsOrNamesVisible": At least one participant name, tile, or person is visible. Set true even if only one name/face is visible.
- "meetingContextEvident": There is some indication this is a work meeting — meeting platform UI, a presentation, office setting, people gathered, or meeting title visible anywhere.

Be LENIENT: This is just attendance confirmation. If the screenshot reasonably shows someone was in a meeting or video call, set valid=true. Only set valid=false if the image is clearly not a meeting (e.g. a selfie, document scan, random photo).`,

  projectIntroScreenshot: `You are an HR automation assistant verifying a screenshot of a Project Introduction meeting to confirm that the new employee attended their project intro session on their Date of Joining.

Analyse the screenshot and respond ONLY with a JSON object in this exact format:
{
  "valid": true/false,
  "docType": "Project Intro Screenshot",
  "checks": {
    "isMeetingOrVideoCall": true/false,
    "participantsOrNamesVisible": true/false,
    "meetingContextEvident": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}

Check definitions:
- "isMeetingOrVideoCall": The image shows a video call, meeting room, or virtual meeting interface (Google Meet, Zoom, Teams, etc.) OR a physical meeting/induction session photo. Set true if ANY meeting evidence is visible.
- "participantsOrNamesVisible": At least one participant name, tile, or person is visible. Set true even if only one name/face is visible.
- "meetingContextEvident": There is some indication this is a work meeting — meeting platform UI, a presentation, office setting, people gathered, or meeting title visible anywhere.

Be LENIENT: This is just attendance confirmation. If the screenshot reasonably shows someone was in a meeting or video call, set valid=true. Only set valid=false if the image is clearly not a meeting (e.g. a selfie, document scan, random photo).`,

  passportPhoto: `You are verifying a passport-size photograph for HR records. Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "Passport Size Photo",
  "checks": {
    "faceVisible": true/false,
    "plainBackground": true/false,
    "imageNotBlurry": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Only set valid=true if ALL three checks pass.`,

  payslip: `You are verifying a payslip or salary slip document. Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "Payslip",
  "checks": {
    "legible": true/false,
    "employeeNameVisible": true/false,
    "salaryAmountVisible": true/false,
    "monthYearVisible": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Only set valid=true if ALL four checks pass.`,

  relievingLetter: `You are verifying a relieving letter or experience letter from a previous employer. Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "Relieving Letter",
  "checks": {
    "legible": true/false,
    "employeeNameVisible": true/false,
    "companyNameVisible": true/false,
    "signedOrStamped": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Only set valid=true if ALL four checks pass.`,

  marksheet10th: `You are verifying a 10th standard marksheet (SSC/SSLC/Matriculation). Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "10th Marksheet",
  "checks": {
    "legible": true/false,
    "studentNameVisible": true/false,
    "marksOrGradeVisible": true/false,
    "boardOrSchoolVisible": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Only set valid=true if ALL four checks pass.`,

  marksheet12th: `You are verifying a 12th standard marksheet or diploma certificate (HSC/Intermediate/Diploma). Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "12th/Diploma Marksheet",
  "checks": {
    "legible": true/false,
    "studentNameVisible": true/false,
    "marksOrGradeVisible": true/false,
    "boardOrInstituteVisible": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Only set valid=true if ALL four checks pass.`,

  degreeCertificate: `You are verifying a graduation consolidated marksheet and/or degree certificate. Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "Degree Certificate",
  "checks": {
    "legible": true/false,
    "studentNameVisible": true/false,
    "degreeOrCourseNameVisible": true/false,
    "universityOrInstituteVisible": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Only set valid=true if ALL four checks pass.`,

  postgradCertificate: `You are verifying a post-graduation consolidated marksheet and/or degree certificate (Masters/MBA/MTech/PhD). Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "Post Graduation Certificate",
  "checks": {
    "legible": true/false,
    "studentNameVisible": true/false,
    "degreeOrCourseNameVisible": true/false,
    "universityOrInstituteVisible": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Only set valid=true if ALL four checks pass.`,

  currentAddressProof: `You are verifying a current/present address proof document submitted by a new employee. Valid document types are: Aadhaar card, PG rent slip, wifi bill, electricity bill, or rent agreement. Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "Current Address Proof",
  "checks": {
    "legible": true/false,
    "nameVisible": true/false,
    "addressVisible": true/false,
    "isValidDocumentType": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Important: For PG rent slips, the employee's name may not appear on the document — this is normal and acceptable. Set nameVisible=true for PG rent slips as long as the PG address is clearly visible. Only set valid=false if the document is illegible, shows no address at all, or is not one of the valid document types listed above.`,

  permanentAddressProof: `You are verifying a permanent address proof document submitted by a new employee. The only valid document is an Aadhaar card. Check ALL of the following and respond with a JSON object:
{
  "valid": true/false,
  "docType": "Permanent Address Proof",
  "checks": {
    "legible": true/false,
    "nameVisible": true/false,
    "addressVisible": true/false,
    "isAadhaar": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Check definitions:
- "legible": The document is clearly readable — not too blurry, cropped, or dark to read key fields.
- "nameVisible": The name of the tenant, account holder, or lessee is visible anywhere on the document.
- "addressVisible": A residential address (house number, street, city) is visible anywhere on the document.
- "isValidDocumentType": The document is recognisably ONE of the following — set true if ANY one matches:
    1. Electricity bill — shows a utility company name, account number, bill period, and amount due.
    2. Rental agreement — a lease/rental contract between a landlord and tenant, may include an e-Stamp / government stamp paper, with property address and signatures.
    3. Rent receipt — a receipt (printed or handwritten) acknowledging rent payment, showing tenant name, address, amount, and landlord signature.
  Set false if the document is clearly something else (Aadhaar, PAN, marksheet, etc.).
Only set valid=true if ALL four checks pass.`,

  uan: `You are verifying a UAN (Universal Account Number) document submitted by a new employee. This should be a screenshot or PDF from the UMANG app or EPFO portal showing the employee's UAN. Respond with a JSON object:
{
  "valid": true/false,
  "docType": "UAN",
  "checks": {
    "legible": true/false,
    "uanVisible": true/false,
    "nameVisible": true/false,
    "isUANDocument": true/false
  },
  "failureReasons": ["list any failed checks in plain English"],
  "summary": "one sentence summary"
}
Check definitions:
- "legible": The document/screenshot is clearly readable.
- "uanVisible": A 12-digit UAN number is visible on the document.
- "nameVisible": The employee's name is visible anywhere on the document.
- "isUANDocument": The document is recognisably a UAN card, UMANG app screenshot, or EPFO portal page showing UAN details.
Only set valid=true if ALL four checks pass.`,
};

// Extraction prompts — run after successful verification to pull structured data from the doc
const EXTRACTION_PROMPTS = {
  aadhaar: `Extract the following fields from this Aadhaar card image and respond ONLY with a JSON object:
{
  "aadhaarNumber": "12-digit number or null",
  "name": "full name as printed or null",
  "dob": "date of birth in DD/MM/YYYY format or null",
  "address": "full address as printed or null",
  "gender": "Male/Female/Other or null"
}
If a field is not visible or readable, set it to null. Do not guess.`,

  pan: `Extract the following fields from this PAN card image and respond ONLY with a JSON object:
{
  "panNumber": "10-character PAN number or null",
  "name": "full name as printed or null",
  "dob": "date of birth in DD/MM/YYYY format or null",
  "fatherName": "father's name as printed or null"
}
If a field is not visible or readable, set it to null. Do not guess.`,

  relievingLetter: `Extract the following fields from this relieving letter or experience letter and respond ONLY with a JSON object:
{
  "previousEmployer": "company name or null",
  "designation": "last held designation or null",
  "dateOfJoining": "date of joining at previous employer in DD/MM/YYYY or null",
  "dateOfRelieving": "last working day / date of relieving in DD/MM/YYYY or null"
}
If a field is not visible or readable, set it to null. Do not guess.`,

  payslip: `Extract the following fields from this payslip and respond ONLY with a JSON object:
{
  "previousEmployer": "company name or null",
  "grossSalary": "gross salary amount as a string or null",
  "month": "payslip month and year as printed or null"
}
If a field is not visible or readable, set it to null. Do not guess.`,

  marksheet10th: `Extract the following fields from this 10th standard marksheet and respond ONLY with a JSON object:
{
  "board": "board name (e.g. CBSE, ICSE, State board name) or null",
  "yearOfCompletion": "year of passing as a 4-digit string or null",
  "totalMarks": "total marks or percentage as a string or null",
  "schoolName": "name of school or null"
}
If a field is not visible or readable, set it to null. Do not guess.`,

  marksheet12th: `Extract the following fields from this 12th standard marksheet or diploma certificate and respond ONLY with a JSON object:
{
  "board": "board name (e.g. CBSE, State board, University name) or null",
  "yearOfCompletion": "year of passing as a 4-digit string or null",
  "totalMarks": "total marks or percentage as a string or null",
  "schoolName": "name of school or college or null",
  "specialization": "stream or specialization (e.g. Science, Commerce, ECE) or null"
}
If a field is not visible or readable, set it to null. Do not guess.`,

  degreeCertificate: `Extract the following fields from this graduation degree certificate or consolidated marksheet and respond ONLY with a JSON object:
{
  "degree": "degree name (e.g. B.Tech, B.Sc, B.Com) or null",
  "specialization": "branch or specialization (e.g. Computer Science, Mechanical) or null",
  "yearOfCompletion": "year of passing as a 4-digit string or null",
  "totalMarks": "CGPA, percentage, or total marks as a string or null",
  "collegeName": "name of college or university or null"
}
If a field is not visible or readable, set it to null. Do not guess.`,

  postgradCertificate: `Extract the following fields from this post-graduation degree certificate or consolidated marksheet and respond ONLY with a JSON object:
{
  "degree": "degree name (e.g. M.Tech, MBA, M.Sc) or null",
  "specialization": "branch or specialization or null",
  "yearOfCompletion": "year of passing as a 4-digit string or null",
  "totalMarks": "CGPA, percentage, or total marks as a string or null",
  "collegeName": "name of college or university or null"
}
If a field is not visible or readable, set it to null. Do not guess.`,
};

// Extract structured data from a document that has already passed verification.
// Returns an object of extracted fields, or {} if extraction is not configured for this doc type.
async function extractDocumentData(auth, fileId, filename, mimeType, subfolderHint) {
  const docType = await detectDocType(auth, fileId, filename, mimeType, subfolderHint);
  if (!docType || !EXTRACTION_PROMPTS[docType]) return {};

  const genAI = getGenAI();
  if (!genAI) return {};

  let tempPath = null;
  try {
    const { tempPath: tp, downloadMime } = await downloadDriveFile(auth, fileId, mimeType);
    tempPath = tp;
    const { base64, mediaType } = fileToBase64(tp, downloadMime);

    const model = genAI.getGenerativeModel({ model: config.geminiModel });
    const result_raw = await callWithRetry(() => model.generateContent([
      EXTRACTION_PROMPTS[docType],
      { inlineData: { data: base64, mimeType: mediaType } },
    ]));

    const raw = result_raw.response.text().trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[Extract] Non-JSON response for ${filename}`);
      return {};
    }
    const extracted = JSON.parse(jsonMatch[0]);
    console.log(`[Extract] ${filename} → ${JSON.stringify(extracted)}`);
    return { docType, fields: extracted };
  } catch (err) {
    console.warn(`[Extract] Extraction failed for ${filename}: ${err.message}`);
    return {};
  } finally {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

// Map filename keywords to document types — fast path before falling back to Gemini
function detectDocTypeFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes('aadhaar') || lower.includes('aadhar') || lower.includes('uid')) return 'aadhaar';
  if (lower.includes('pan') || lower.includes('pancard') || lower.includes('pan_card')) return 'pan';
  if (lower.includes('offer') || lower.includes('appointment') || lower.includes('offer_letter')) return 'offerLetter';
  if (lower.includes('induction')) return 'inductionScreenshot';
  if (lower.includes('project_intro') || lower.includes('project intro') || lower.includes('intro_screenshot')) return 'projectIntroScreenshot';
  if (lower.includes('meeting') || lower.includes('screenshot')) return 'inductionScreenshot';
  if (lower.includes('passport') || lower.includes('photo') || lower.includes('headshot') || lower.includes('profile')) return 'passportPhoto';
  if (lower.includes('payslip') || lower.includes('pay_slip') || lower.includes('salary') || lower.includes('salary_slip')) return 'payslip';
  if (lower.includes('relieving') || lower.includes('relieve') || lower.includes('experience') || lower.includes('relieving_letter')) return 'relievingLetter';
  if (lower.includes('10th') || lower.includes('10_th') || lower.includes('tenth') || lower.includes('sslc') || lower.includes('matriculation') || lower.includes('marksheet_10')) return 'marksheet10th';
  if (lower.includes('12th') || lower.includes('12_th') || lower.includes('twelfth') || lower.includes('hsc') || lower.includes('puc') || lower.includes('diploma') || lower.includes('intermediate') || lower.includes('marksheet_12')) return 'marksheet12th';
  if (lower.includes('postgrad') || lower.includes('post_grad') || lower.includes('mtech') || lower.includes('msc') || lower.includes('mba') || lower.includes('mca') || lower.includes('phd') || lower.includes('masters') || lower.includes('pg_')) return 'postgradCertificate';
  if (lower.includes('degree') || lower.includes('graduation') || lower.includes('consolidated') || lower.includes('btech') || lower.includes('bsc') || lower.includes('bcom') || lower.includes('bca') || lower.includes('bba')) return 'degreeCertificate';
  if (lower.includes('current_address') || lower.includes('present_address') || lower.includes('current_addr')) return 'currentAddressProof';
  if (lower.includes('permanent_address') || lower.includes('permanent_addr') || lower.includes('hometown')) return 'permanentAddressProof';
  if (lower.includes('uan') || lower.includes('umang') || lower.includes('epfo') || lower.includes('universal_account')) return 'uan';
  if (lower.includes('address') || lower.includes('electricity') || lower.includes('wifi') || lower.includes('rent') || lower.includes('rental') || lower.includes('receipt') || lower.includes('lease') || lower.includes('utility') || lower.includes('pg_rent')) return 'currentAddressProof';
  return null;
}

// Detect document type from content using Gemini — used when filename gives no clue
async function detectDocTypeFromContent(auth, fileId, mimeType) {
  const genAI = getGenAI();
  if (!genAI) return null;

  let tempPath = null;
  try {
    const { tempPath: tp, downloadMime } = await downloadDriveFile(auth, fileId, mimeType);
    tempPath = tp;
    const mediaType = downloadMime || mimeType;
    const base64 = fs.readFileSync(tempPath).toString('base64');

    const model = genAI.getGenerativeModel({ model: config.geminiModel });
    const result_raw = await callWithRetry(() => model.generateContent([
      `Look at this document and identify what type of HR document it is. Respond ONLY with a JSON object in this exact format:
{
  "docType": one of: "aadhaar", "pan", "offerLetter", "inductionScreenshot", "projectIntroScreenshot", "passportPhoto", "payslip", "relievingLetter", "marksheet10th", "marksheet12th", "degreeCertificate", "postgradCertificate", "currentAddressProof", "permanentAddressProof", or null if none match,
  "confidence": "high" / "medium" / "low"
}

Document type descriptions:
- aadhaar: Indian Aadhaar card — has 12-digit UID number, name, photo, address, and "Aadhaar" branding or UIDAI logo
- pan: Indian PAN card — has 10-character alphanumeric PAN number, name, date of birth, and Income Tax Department branding
- offerLetter: Employment offer/appointment letter — has company name, candidate name, role, and signature. May be titled "Appointment Letter" or "Offer Letter"
- inductionScreenshot: Screenshot of an HR Induction meeting — video call or physical meeting showing HR induction session
- projectIntroScreenshot: Screenshot of a Project Introduction meeting — video call or physical meeting for project intro
- passportPhoto: Passport-size portrait photograph — plain background, face clearly visible, no document text
- payslip: Salary slip or payslip — shows employee name, salary components (basic, HRA, deductions), net pay, and month/year
- relievingLetter: Relieving letter or experience letter from a previous employer — confirms last working day and employment period
- marksheet10th: 10th standard marksheet — SSLC / SSC / Matriculation / Board exam result with subject marks and board name
- marksheet12th: 12th standard marksheet or diploma — HSC / PUC / Intermediate / Diploma result with subject marks and board/institution
- degreeCertificate: Graduation degree certificate or consolidated marksheet — BE/BTech/BSc/BBA/BCA/BCom or similar, issued by a university
- postgradCertificate: Post-graduation certificate — MTech/MBA/MSc/MCA/PhD or similar, issued by a university
- currentAddressProof: Current/present address proof — can be an Aadhaar card, PG rent slip, wifi bill, electricity bill, or rent agreement showing the employee's current residential address
- permanentAddressProof: Permanent address proof — Aadhaar card only (shows 12-digit UID, name, address, and UIDAI branding)
- uan: UAN (Universal Account Number) document — a screenshot or PDF from the UMANG app or EPFO portal showing a 12-digit UAN number

Respond with null docType if the document does not match any of the above.`,
      { inlineData: { data: base64, mimeType: mediaType } },
    ]));

    const raw = result_raw.response.text().trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const result = JSON.parse(jsonMatch[0]);
    if (result.docType && result.confidence !== 'low') {
      console.log(`[Verify] Content-based doc type detected: ${result.docType} (confidence: ${result.confidence})`);
      return result.docType;
    }
    return null;
  } catch (err) {
    console.warn(`[Verify] Content-based doc type detection failed: ${err.message}`);
    return null;
  } finally {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

// Subfolder name → guaranteed docType — no filename or content detection needed
const SUBFOLDER_DOCTYPE_MAP = {
  'Address_Proof':        'addressProof',
  'Aadhaar':              'aadhaar',
  'PAN':                  'pan',
  'Offer_Letter':         'offerLetter',
  'Passport_Photo':       'passportPhoto',
  'Payslip':              'payslip',
  'Relieving_Letter':     'relievingLetter',
  'Marksheet_10th':       'marksheet10th',
  'Marksheet_12th':       'marksheet12th',
  'Degree_Certificate':   'degreeCertificate',
  'Postgrad_Certificate': 'postgradCertificate',
  'HR_Induction_Screenshot':   'inductionScreenshot',
  'Project_Intro_Screenshot':  'projectIntroScreenshot',
};

// Detect document type — subfolder is authoritative; content analysis is next; filename is last resort
async function detectDocType(auth, fileId, filename, mimeType, subfolderHint) {
  if (subfolderHint && SUBFOLDER_DOCTYPE_MAP[subfolderHint]) {
    console.log(`[Verify] Doc type resolved from subfolder "${subfolderHint}": ${SUBFOLDER_DOCTYPE_MAP[subfolderHint]}`);
    return SUBFOLDER_DOCTYPE_MAP[subfolderHint];
  }
  const fromContent = await detectDocTypeFromContent(auth, fileId, mimeType);
  if (fromContent) return fromContent;
  // Gemini couldn't confidently classify — try filename as last resort
  const fromFilename = detectDocTypeFromFilename(filename);
  if (fromFilename) console.log(`[Verify] Content detection inconclusive — fell back to filename hint: ${fromFilename}`);
  return fromFilename || null;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB — enough for any ID/offer document

// Download a Drive file to a temp path, return { tempPath, mimeType }
async function downloadDriveFile(auth, fileId, mimeType) {
  const drive = google.drive({ version: 'v3', auth });

  // Check file size before downloading to prevent disk exhaustion
  const meta = await drive.files.get({ fileId, fields: 'size,mimeType' }).catch(() => null);
  if (meta && meta.data.size && parseInt(meta.data.size) > MAX_FILE_BYTES) {
    throw new Error(`File exceeds maximum allowed size (${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB). Please upload a smaller file.`);
  }

  const tmpPath = path.join(os.tmpdir(), `hr_auto_${fileId}_${Date.now()}`);

  // Google Docs/Slides need export; binary files use direct download
  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export(
      { fileId, mimeType: 'application/pdf' },
      { responseType: 'stream' }
    );
    await streamToFile(res.data, tmpPath);
    return { tempPath: tmpPath, downloadMime: 'application/pdf' };
  }

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  await streamToFile(res.data, tmpPath);
  return { tempPath: tmpPath, downloadMime: mimeType };
}

function streamToFile(stream, filePath) {
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(filePath);
    stream.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
    stream.on('error', reject);
  });
}

// Convert downloaded file to base64 and pick the right media type for Gemini
function fileToBase64(filePath, mimeType) {
  const data = fs.readFileSync(filePath);
  if (data.length === 0) throw new Error(`File is empty: ${filePath}`);
  const base64 = data.toString('base64');
  // Gemini vision accepts: image/jpeg, image/png, image/gif, image/webp, application/pdf
  const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
  const mediaType = supported.includes(mimeType) ? mimeType : 'application/pdf';
  return { base64, mediaType };
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
        // Try to parse retryDelay from error message
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

// Core verification function — returns { valid, docType, checks, failureReasons, summary }
async function verifyDocument(auth, fileId, filename, mimeType, subfolderHint) {
  const docType = await detectDocType(auth, fileId, filename, mimeType, subfolderHint);
  if (!docType) {
    return {
      valid: false,
      docType: 'Unknown',
      checks: {},
      failureReasons: [`Could not determine document type for "${filename}" — even after reading the content. Please ensure this is a valid HR document.`],
      summary: 'Unknown document type.',
    };
  }

  const genAI = getGenAI();
  if (!genAI) {
    console.warn(`[Verify] GEMINI_API_KEY not set — skipping verification for ${filename}. Mark manually via /mark-task.`);
    return {
      valid: false,
      docType,
      checks: {},
      failureReasons: ['Gemini API key not configured — document requires manual review.'],
      summary: 'Verification skipped: GEMINI_API_KEY not set.',
    };
  }

  let tempPath = null;
  try {
    const { tempPath: tp, downloadMime } = await downloadDriveFile(auth, fileId, mimeType);
    tempPath = tp;
    const { base64, mediaType } = fileToBase64(tp, downloadMime);

    const model = genAI.getGenerativeModel({ model: config.geminiModel });
    const result_raw = await callWithRetry(() => model.generateContent([
      VERIFICATION_PROMPTS[docType],
      { inlineData: { data: base64, mimeType: mediaType } },
    ]));

    const raw = result_raw.response.text().trim();
    // Extract JSON from the response (model may wrap it in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Gemini returned non-JSON response: ' + raw);
    const result = JSON.parse(jsonMatch[0]);
    console.log(`[Verify] ${filename} → valid=${result.valid} | ${result.summary}`);

    return result;
  } finally {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

// Verify all documents in an employee's folder and return a results map
async function verifyAllDocuments(auth, folderFiles) {
  const results = {};
  for (const file of folderFiles) {
    console.log(`[Verify] Checking ${file.name} (${file.id})`);
    results[file.name] = await verifyDocument(auth, file.id, file.name, file.mimeType);
  }
  return results;
}

// Cross-check extracted data across documents for name/identity mismatches.
// Returns array of mismatch objects: { field, doc1, val1, doc2, val2 }
function crossCheckDocuments(extractedData) {
  const mismatches = [];
  const ex = extractedData || {};

  // Normalise names for fuzzy comparison — lowercase, strip punctuation, collapse spaces
  function norm(s) {
    if (!s) return '';
    return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Check Aadhaar name vs PAN name
  const aadhaarName = norm(ex.aadhaar && ex.aadhaar.name);
  const panName     = norm(ex.pan && ex.pan.name);
  if (aadhaarName && panName && aadhaarName !== panName) {
    mismatches.push({
      field: 'Full Name',
      doc1: 'Aadhaar', val1: (ex.aadhaar && ex.aadhaar.name) || '',
      doc2: 'PAN Card', val2: (ex.pan && ex.pan.name) || '',
    });
  }

  // Check Aadhaar DOB vs PAN DOB
  function normDate(s) {
    if (!s) return '';
    // normalise DD/MM/YYYY, YYYY-MM-DD, etc. → just digits
    return s.replace(/[^0-9]/g, '');
  }
  const aadhaarDob = normDate(ex.aadhaar && ex.aadhaar.dob);
  const panDob     = normDate(ex.pan && ex.pan.dob);
  if (aadhaarDob && panDob && aadhaarDob !== panDob) {
    mismatches.push({
      field: 'Date of Birth',
      doc1: 'Aadhaar', val1: (ex.aadhaar && ex.aadhaar.dob) || '',
      doc2: 'PAN Card', val2: (ex.pan && ex.pan.dob) || '',
    });
  }

  // Check 10th school name vs 12th school name (should match or be related)
  // Only flag if both present and completely different (not substring of each other)
  const school10 = norm(ex.marksheet10th && ex.marksheet10th.schoolName);
  const school12 = norm(ex.marksheet12th && ex.marksheet12th.schoolName);
  if (school10 && school12 && school10 !== school12) {
    // Allow if one contains the other (same school, slightly different name on docs)
    if (!school10.includes(school12) && !school12.includes(school10)) {
      mismatches.push({
        field: 'School Name',
        doc1: '10th Marksheet', val1: (ex.marksheet10th && ex.marksheet10th.schoolName) || '',
        doc2: '12th Marksheet', val2: (ex.marksheet12th && ex.marksheet12th.schoolName) || '',
        note: 'Different schools on 10th and 12th marksheets — verify if student changed schools',
      });
    }
  }

  // Check year of completion — 12th should be after 10th
  const year10 = parseInt(ex.marksheet10th && ex.marksheet10th.yearOfCompletion);
  const year12 = parseInt(ex.marksheet12th && ex.marksheet12th.yearOfCompletion);
  const yearDeg = parseInt(ex.degreeCertificate && ex.degreeCertificate.yearOfCompletion);
  if (year10 && year12 && year12 < year10) {
    mismatches.push({
      field: 'Year of Completion',
      doc1: '10th Marksheet', val1: String(year10),
      doc2: '12th Marksheet', val2: String(year12),
      note: '12th completion year is before 10th — possible data entry error',
    });
  }
  if (year12 && yearDeg && yearDeg < year12) {
    mismatches.push({
      field: 'Year of Completion',
      doc1: '12th Marksheet', val1: String(year12),
      doc2: 'Degree Certificate', val2: String(yearDeg),
      note: 'Degree completion year is before 12th — possible data entry error',
    });
  }

  return mismatches;
}

module.exports = { verifyDocument, verifyAllDocuments, detectDocType, extractDocumentData, crossCheckDocuments };
