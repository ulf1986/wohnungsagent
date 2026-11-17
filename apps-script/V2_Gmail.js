/**
 * GmailApp discovery. At most two targeted searches per due scan.
 * Search checkpoint advances only after candidate mail IDs are persisted.
 */
function wa2SearchDue(state,now) {
  const last=Date.parse(state.lastScanUtc||'');
  return !Number.isFinite(last)||now-last>=WA2_CONFIG.searchIntervalMinutes*60000;
}
function wa2Discover(state,now) {
  if(!wa2SearchDue(state,now)) return {scanned:false,queued:0};
  const checkpoint=Date.parse(state.checkpointUtc||'');
  const old=now-48*3600000;
  const recent=Number.isFinite(checkpoint)
    ?Math.max(old,checkpoint-WA2_CONFIG.searchOverlapMinutes*60000):old;
  const after=Math.floor(recent/1000);
  const queries=[
    'in:anywhere label:"'+WA2_CONFIG.mailLabel+'" after:'+after,
    'in:anywhere from:(fotocasa.es) after:'+after
  ];
  const unique=new Map();
  let saturated=false;
  for(const query of queries) {
    const threads=GmailApp.search(query,0,WA2_CONFIG.maxThreadsPerSearch);
    if(threads.length>=WA2_CONFIG.maxThreadsPerSearch)saturated=true;
    for(const thread of threads)for(const mail of thread.getMessages()){
      const t=mail.getDate().getTime(),id=mail.getId();
      if(t<recent||t>now||unique.has(id)||state.indexedMailIds[id])continue;
      if(query.includes('from:(fotocasa.es)')&&!/^\s*Nuevo\s*[·-]/i.test(mail.getSubject()))continue;
      unique.set(id,{id,receivedAt:new Date(t).toISOString()});
    }
  }
  const candidates=[...unique.values()].sort((a,b)=>Date.parse(a.receivedAt)-Date.parse(b.receivedAt));
  for(const item of candidates.slice(0,WA2_CONFIG.maxNewMailsPerRun)) {
    state.mailQueue.push(Object.assign({attempts:0,nextAt:''},item));
    state.indexedMailIds[item.id]=item.receivedAt;
  }
  // Do not advance cursor on truncation; next run must rescan the overlap.
  const complete=!saturated&&candidates.length<=WA2_CONFIG.maxNewMailsPerRun;
  state.lastScanUtc=new Date(now).toISOString();
  if(complete)state.checkpointUtc=new Date(now).toISOString();
  else state.lastScanUtc=new Date(now-9*60000).toISOString(); // retry scan on next tick
  wa2CompactMailIndex(state,now);
  return {scanned:true,queued:Math.min(candidates.length,WA2_CONFIG.maxNewMailsPerRun),
    limited:!complete};
}
function wa2ReadMail(id) {
  const mail=GmailApp.getMessageById(id);
  if(!mail)throw new Error('Gmail-Nachricht nicht verfügbar');
  return {
    id:mail.getId(),receivedAt:mail.getDate().toISOString(),
    subject:String(mail.getSubject()||'').slice(0,300),
    html:String(mail.getBody()||''),
    plain:String(mail.getPlainBody()||'')
  };
}
