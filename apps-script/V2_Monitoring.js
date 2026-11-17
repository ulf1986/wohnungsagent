/**
 * Small watchdog, no Gmail searches, no Sheets or GitHub issues.
 * Alerts are rate-limited to avoid the historical notification storm.
 */
function wa2HealthStatus(state,registry,now) {
  const errors=[];
  const scan=Date.parse(state.lastScanUtc||'');
  if(!Number.isFinite(scan)||now-scan>35*60000)errors.push('GMAIL_STALE');
  if(state.mailQueue.some(x=>now-Date.parse(x.receivedAt)>30*60000))
    errors.push('MAIL_BACKLOG');
  if((state.unparsedMails||[]).length)errors.push('MAIL_UNPARSED');
  const records=Object.values(registry.records);
  if(records.some(x=>x.status==='failed_final'))errors.push('PROCESSING_FAILED');
  if(records.some(x=>x.status==='unknown_delivery'||x.status==='sending'))
    errors.push('TELEGRAM_UNCERTAIN');
  return errors;
}
function wa2MaybeReportHealth(stateHolder,registryHolder,credentials,now) {
  const state=stateHolder.data,errors=wa2HealthStatus(state,registryHolder.data,now);
  const code=errors.join(',')||'OK';
  if(code===state.lastAlertCode)return errors;
  const last=Date.parse(state.lastAlertUtc||'');
  if(code!=='OK'&&Number.isFinite(last)&&now-last<4*3600000)return errors;
  const message=code==='OK'?'Wohnungsagent 2.0: Störung behoben.':
    'Wohnungsagent 2.0: '+errors.join(', ')+' (Details im Apps-Script-Log).';
  try{wa2SendTelegram(credentials,message);}
  catch(e){console.warn('WA2 Health Telegram fehlgeschlagen: '+e.message);return errors;}
  state.lastAlertCode=code;state.lastAlertUtc=new Date(now).toISOString();
  wa2SaveJson(stateHolder,'state');
  return errors;
}
function wa2Watchdog() {
  if(!wa2IsEnabled())return {status:'disabled'};
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))return {status:'busy'};
  try{
    const state=wa2LoadState(),registry=wa2LoadRegistry();
    const errors=wa2MaybeReportHealth(state,registry,wa2Credentials(),Date.now());
    return {status:errors.length?'issues':'ok',errors};
  }finally{lock.releaseLock();}
}
