/**
 * Small watchdog, no Gmail searches, no Sheets or GitHub issues.
 * Alerts are rate-limited to avoid the historical notification storm.
 */

/**
 * Mail age alone does not mean the pipeline is stuck: the initial 48h lookback
 * naturally starts with older messages. Start a fresh observation period
 * whenever a waiting mail is processed successfully.
 * Returns true only when state needs to be saved.
 */
function wa2TrackBacklog(state,now) {
  const oldMail=(state.mailQueue||[]).some(x=>
    Number.isFinite(Date.parse(x.receivedAt||''))&&
    now-Date.parse(x.receivedAt)>30*60000);
  if(!oldMail){
    if(!state.backlogObservationUtc)return false;
    state.backlogObservationUtc='';
    return true;
  }
  const observed=Date.parse(state.backlogObservationUtc||'');
  const processed=Date.parse(state.lastMailProcessedAtUtc||'');
  if(!Number.isFinite(observed)||
      (Number.isFinite(processed)&&processed>=observed)){
    state.backlogObservationUtc=new Date(now).toISOString();
    return true;
  }
  return false;
}

function wa2HealthStatus(state,registry,now) {
  const errors=[];
  const scan=Date.parse(state.lastScanUtc||'');
  if(!Number.isFinite(scan)||now-scan>35*60000)errors.push('GMAIL_STALE');
  const staleQueued=(state.mailQueue||[]).some(x=>
    Number.isFinite(Date.parse(x.receivedAt||''))&&
    now-Date.parse(x.receivedAt)>30*60000);
  const observed=Date.parse(state.backlogObservationUtc||'');
  if(staleQueued&&Number.isFinite(observed)&&now-observed>60*60000)
    errors.push('MAIL_BACKLOG');
  if((state.unparsedMails||[]).length)errors.push('MAIL_UNPARSED');
  const records=Object.values(registry.records);
  if(records.some(x=>x.status==='failed_final'))errors.push('PROCESSING_FAILED');
  if(records.some(x=>x.status==='unknown_delivery'||x.status==='sending'))
    errors.push('TELEGRAM_UNCERTAIN');
  return errors;
}
function wa2MaybeReportHealth(stateHolder,registryHolder,credentials,now) {
  const state=stateHolder.data;
  if(wa2TrackBacklog(state,now))wa2SaveJson(stateHolder,'state');
  const errors=wa2HealthStatus(state,registryHolder.data,now);
  const code=errors.join(',')||'OK';
  const last=Date.parse(state.lastAlertUtc||'');
  const recent=Number.isFinite(last)&&now-last<4*3600000;
  // A healthy first run is not a recovery event.
  if(code==='OK'&&!state.lastAlertCode)return errors;
  // Repeat only continuing problems after four hours. New failures alert now.
  if(code===state.lastAlertCode&&(code==='OK'||recent))return errors;
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
