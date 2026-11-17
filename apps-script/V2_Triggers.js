/**
 * Manual production switch-over only. A code push does not install triggers.
 * GitHub legacy telegram-listings.yml and watchdog.yml must be disabled first.
 */
function wa2ListTriggers() {
  return ScriptApp.getProjectTriggers().map(t=>({
    name:t.getHandlerFunction(),id:t.getUniqueId()
  }));
}
function wa2InstallTriggers() {
  const p=wa2Properties();
  if(p.getProperty('WA2_MIGRATION_COMPLETE')!=='true')
    throw new Error('WA2: Alt-Historie muss zuerst migriert werden');
  if(p.getProperty('WA2_LEGACY_GITHUB_DISABLED')!=='true')
    throw new Error('WA2: Alte GitHub-Telegram-Workflows zuerst deaktivieren');
  if(wa2CheckConfiguration().missing.length)
    throw new Error('WA2: API-Zugangsdaten unvollständig');
  const old=['runImageImport','runGmailImagePipeline','runAiQueueWorker',
    'wa2Run','wa2Watchdog'];
  for(const trigger of ScriptApp.getProjectTriggers())
    if(old.includes(trigger.getHandlerFunction()))ScriptApp.deleteTrigger(trigger);
  // Old Apps-Script pipeline is stopped before WA2 is enabled.
  p.setProperty('WA2_ENABLED','true');
  ScriptApp.newTrigger('wa2Run').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('wa2Watchdog').timeBased().everyMinutes(15).create();
  return wa2ListTriggers();
}
function wa2Disable() {
  wa2Properties().setProperty('WA2_ENABLED','false');
  for(const t of ScriptApp.getProjectTriggers())
    if(['wa2Run','wa2Watchdog'].includes(t.getHandlerFunction()))
      ScriptApp.deleteTrigger(t);
  return wa2ListTriggers();
}
/** Safe dry-run: no Gmail, AI, Telegram or filesystem mutations. */
function wa2Preflight() {
  return {config:wa2CheckConfiguration(),triggers:wa2ListTriggers(),
    migrationComplete:wa2Properties().getProperty('WA2_MIGRATION_COMPLETE')==='true'};
}
