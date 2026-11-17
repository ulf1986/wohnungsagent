/**
 * Wohnungsagent 2.0: isolated configuration.
 * Production remains OFF until a separately approved switch-over.
 */
const WA2_CONFIG = Object.freeze({
  enabledProperty: 'WA2_ENABLED',
  folderProperty: 'WA2_STATE_FOLDER_ID',
  searchIntervalMinutes: 15,
  // Conservative initial interval; only shorten after measuring actual usage.
  searchOverlapMinutes: 30,
  reconciliationHours: 12,
  maxThreadsPerSearch: 50,
  maxNewMailsPerRun: 20,
  maxMailsProcessedPerRun: 8,
  maxListingsPerMail: 40,
  maxRunMilliseconds: 210000,
  maxRetryAttempts: 5,
  minAreaM2: 60,
  mailLabel: 'Wohnungssuche/Suchaufträge',
  unknownAreaNotify: true,
  allowPageFetch: true
});
function wa2Properties() { return PropertiesService.getScriptProperties(); }
function wa2IsEnabled() {
  return wa2Properties().getProperty(WA2_CONFIG.enabledProperty) === 'true';
}
function wa2Credentials() {
  const p = wa2Properties();
  const values = {
    openAiKey: p.getProperty('OPENAI_API_KEY'),
    model: p.getProperty('OPENAI_MODEL'),
    botToken: p.getProperty('TELEGRAM_BOT_TOKEN'),
    chatId: p.getProperty('TELEGRAM_CHAT_ID')
  };
  if (!values.openAiKey || !values.model || !values.botToken || !values.chatId)
    throw new Error('WA2: OPENAI_API_KEY, OPENAI_MODEL oder Telegram Script Properties fehlen.');
  return values;
}
/** Read-only configuration check; no credentials are returned. */
function wa2CheckConfiguration() {
  const p = wa2Properties();
  const required = ['OPENAI_API_KEY','OPENAI_MODEL','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'];
  return {
    enabled: wa2IsEnabled(),
    missing: required.filter(k => !p.getProperty(k)),
    folderConfigured: !!p.getProperty(WA2_CONFIG.folderProperty),
    desiredGmailSearchMinutes: WA2_CONFIG.searchIntervalMinutes
  };
}
