require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { sendEmail } = require('./src/emailSender');

const surveyLink = process.env.ONBOARDING_SURVEY_LINK;

const surveySection = surveyLink
  ? `<p><a href="${surveyLink}" style="background:#1a73e8;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;display:inline-block;">Complete Onboarding Survey</a></p>`
  : `<p style="color:#e65100;">Survey link not configured.</p>`;

sendEmail({
  to: process.env.GMAIL_USER,
  subject: 'TEST — Onboarding Survey Email',
  html: `
    <p>Dear Test User,</p>
    <p>It's been 23 days since you joined! We'd love to hear about your onboarding experience.</p>
    <p>Please take 5 minutes to complete this survey:</p>
    ${surveySection}
    <p>Your feedback helps us improve the experience for future joiners.</p>
    <p>Regards,<br/>HR Team, Alethea</p>
  `,
}).then(() => console.log('Sent!')).catch(console.error);
