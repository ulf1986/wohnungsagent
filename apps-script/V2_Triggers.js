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
  // New triggers are installed while V2 remains OFF. The V1 triggers are
  // removed only after both have been created without error.
  p.setProperty('WA2_ENABLED','false');
  const existing=ScriptApp.getProjectTriggers();
  for(const trigger of existing)
    if(['wa2Run','wa2Watchdog'].includes(trigger.getHandlerFunction()))
      ScriptApp.deleteTrigger(trigger);
  const created=[];
  try {
    created.push(ScriptApp.newTrigger('wa2Run').timeBased().everyMinutes(WA2_CONFIG.searchIntervalMinutes).create());
    created.push(ScriptApp.newTrigger('wa2Watchdog').timeBased().everyMinutes(15).create());
  }catch(e) {
    for(const trigger of created)try{ScriptApp.deleteTrigger(trigger);}catch(ignored){}
    throw new Error('WA2: Neue Trigger konnten nicht eingerichtet werden: '+e.message);
  }
  try {
    for(const trigger of existing)
      if(['runImageImport','runGmailImagePipeline','runAiQueueWorker'].includes(
        trigger.getHandlerFunction()))ScriptApp.deleteTrigger(trigger);
  }catch(e) {
    for(const trigger of created)try{ScriptApp.deleteTrigger(trigger);}catch(ignored){}
    throw new Error('WA2: Alte Trigger konnten nicht vollständig entfernt werden: '+e.message);
  }
  p.setProperty('WA2_ENABLED','true');
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

/**
 * Manual rollback: stop V2, then restore the existing V1 importer and AI worker
 * from their preserved functions. Re-enable legacy GitHub Telegram workflows
 * separately to restore the original delivery path.
 */
function wa2RollbackToV1() {
  wa2Disable();
  if (typeof setupGmailImageTrigger !== 'function')
    throw new Error('WA2: Alte Trigger-Funktion fehlt. V1-Code erneut deployen.');
  setupGmailImageTrigger();
  return {v2Enabled:wa2IsEnabled(),triggers:wa2ListTriggers(),
    note:'GitHub Telegram-Workflows müssen separat wieder aktiviert werden.'};
}
