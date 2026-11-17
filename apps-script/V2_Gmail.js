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
  const lastCheckpoint=Date.parse(state.checkpointUtc||'');
  const old=now-48*3600000;
  const start=state.scanWindowStartUtc
    ?Date.parse(state.scanWindowStartUtc)
    :Number.isFinite(lastCheckpoint)
      ?Math.max(old,lastCheckpoint-WA2_CONFIG.searchOverlapMinutes*60000):old;
  if(!state.scanWindowStartUtc)state.scanWindowStartUtc=new Date(start).toISOString();
  if(!state.scanOffsets)state.scanOffsets={label:0,fotocasa:0};
  const after=Math.floor(start/1000);
  const searches=[
    {name:'label',query:'in:anywhere label:"'+WA2_CONFIG.mailLabel+'" after:'+after},
    {name:'fotocasa',query:'in:anywhere from:(fotocasa.es) after:'+after}
  ];
  let staged=0,allComplete=true;
  for(const search of searches){
    const offset=Number(state.scanOffsets[search.name])||0;
    const threads=GmailApp.search(search.query,offset,WA2_CONFIG.maxThreadsPerSearch);
    const unique=new Map();
    for(const thread of threads)for(const mail of thread.getMessages()){
      const t=mail.getDate().getTime(),id=mail.getId();
      if(t<start||t>now||unique.has(id)||state.indexedMailIds[id])continue;
      if(search.name==='fotocasa'&&!/^\s*Nuevo\s*[·-]/i.test(mail.getSubject()))continue;
      unique.set(id,{id,receivedAt:new Date(t).toISOString()});
    }
    const candidates=[...unique.values()].sort((a,b)=>Date.parse(a.receivedAt)-Date.parse(b.receivedAt));
    const slots=Math.max(0,WA2_CONFIG.maxNewMailsPerRun-staged);
    for(const item of candidates.slice(0,slots)){
      state.mailQueue.push(Object.assign({attempts:0,nextAt:''},item));
      state.indexedMailIds[item.id]=item.receivedAt;
      staged++;
    }
    if(candidates.length>slots){
      // Return to the same Gmail page until every candidate is persisted.
      allComplete=false;
    }else if(threads.length===WA2_CONFIG.maxThreadsPerSearch){
      // This page is staged. Continue at the next offset on the next run.
      state.scanOffsets[search.name]=offset+threads.length;
      allComplete=false;
    }else{
      state.scanOffsets[search.name]=0;
    }
  }
  state.lastScanUtc=new Date(now).toISOString();
  if(allComplete){
    state.checkpointUtc=new Date(now).toISOString();
    state.scanWindowStartUtc='';
    state.scanOffsets={label:0,fotocasa:0};
  }else {
    // Next scheduled trigger retries. No fast busy-loop against Gmail quotas.
  }
  wa2CompactMailIndex(state,now);
  return {scanned:true,queued:staged,limited:!allComplete};
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

/**
 * Operator-initiated recovery of an alert mail without a recognized portal ID.
 * Does not rescan the mailbox or bypass the dedup registry.
 */
function wa2RetryUnparsedMail(mailId) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))throw new Error('WA2: Lock besetzt');
  try{
    const holder=wa2LoadState(),state=holder.data;
    const candidate=(state.unparsedMails||[]).find(x=>x.id===String(mailId));
    if(!candidate)throw new Error('WA2: Unbekannte Gmail-ID');
    if(!state.mailQueue.some(x=>x.id===candidate.id))
      state.mailQueue.push({id:candidate.id,receivedAt:candidate.receivedAt,attempts:0,nextAt:''});
    state.unparsedMails=state.unparsedMails.filter(x=>x.id!==candidate.id);
    wa2SaveJson(holder,'state');
    return {queued:candidate.id};
  }finally{lock.releaseLock();}
}
/** Dismiss a manually inspected search alert. */
function wa2AcknowledgeUnparsedMail(mailId) {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))throw new Error('WA2: Lock besetzt');
  try{
    const holder=wa2LoadState();
    const prior=(holder.data.unparsedMails||[]).length;
    holder.data.unparsedMails=(holder.data.unparsedMails||[]).filter(x=>x.id!==String(mailId));
    if(holder.data.unparsedMails.length!==prior)wa2SaveJson(holder,'state');
    return {acknowledged:holder.data.unparsedMails.length!==prior};
  }finally{lock.releaseLock();}
}
