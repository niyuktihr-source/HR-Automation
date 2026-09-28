function createEmployeeFeedbackForm() {
  const form = FormApp.create('Employee Feedback Form: Onboarding Experience');
  form.setCollectEmail(true);

  form.addTextItem()
    .setTitle('Name')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Designation')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Date of Joining')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Department')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How would you rate your overall onboarding experience?')
    .setChoiceValues(['Excellent', 'Good', 'Average'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Were the expectations and objectives of your role made clear during onboarding?')
    .setChoiceValues(['Yes', 'No', 'Somewhat'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Did you feel welcomed by your team?')
    .setChoiceValues(['Yes, very welcomed', 'Somewhat welcomed', 'Neutral', 'Not welcomed'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Was the training provided sufficient to understand your responsibilities?')
    .setChoiceValues(['Yes, completely', 'Mostly', 'Partially', 'No, not at all'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Do you have the resources you need to perform your job effectively?')
    .setChoiceValues(['Yes', 'Somewhat', 'No'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How effective was the communication from HR and your manager?')
    .setChoiceValues(['Effective', 'Neutral', 'Ineffective'])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Were there any specific challenges you faced during onboarding?')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How would you describe the overall company culture?')
    .setChoiceValues(['Positive', 'Neutral', 'Negative'])
    .setRequired(true);

  Logger.log('✅ Employee Feedback Form created successfully!');
  Logger.log('🔗 Published URL: ' + form.getPublishedUrl());
  Logger.log('📝 Edit URL:      ' + form.getEditUrl());
  Logger.log('📋 Form ID:       ' + form.getId());
  Logger.log('');
  Logger.log('→ Copy the Form ID into your .env as ONBOARDING_SURVEY_TEMPLATE_FORM_ID (each joinee gets their own copy on day 23)');
}
