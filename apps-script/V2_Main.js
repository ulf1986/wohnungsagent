/**
 * Wohnungsagent 2.0 orchestration: Gmail -> portal identity -> text AI ->
 * durable registry -> Telegram. No Sheets, images or scoring at runtime.
 */
function wa2Run() {
  if(!wa2IsEnabled())return {status:'disabled'};
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))return {status:'busy'};
  const start=Date.now(),summary={status:'ok',scanned:0,mails:0,aiCalls:0,sent:0,excluded:0,errors:[]};
  try{
    const credentials=wa2Credentials();
    const registry=wa2LoadRegistry(),state=wa2LoadState();
    // A previous crash while sending is ambiguous: never send twice blindly.
    let recovered=false;
    for(const row of Object.values(registry.data.records))if(row.status==='sending'){
      row.status='unknown_delivery';row.lastError='Vorheriger Telegram-Sendeversuch unterbrochen';
      recovered=true;
    }
    if(recovered)wa2SaveJson(registry,'registry');
    const now=Date.now();
    if(!state.data.scanPauseUntil||Date.parse(state.data.scanPauseUntil)<=now){
      try{
        const scan=wa2Discover(state.data,now);
        summary.scanned=scan.scanned?1:0;
        state.data.scanPauseUntil='';
        // Persist all discovered Gmail IDs BEFORE advancing their cursor.
        wa2SaveJson(state,'state');
      }catch(e){
        const error=String(e.message||e).slice(0,160);
        const quota=/quota|too many|zu häufig|rate|limit/i.test(error);
        state.data.scanPauseUntil=new Date(now+(quota?60:10)*60000).toISOString();
        state.data.lastError='Gmail: '+error;
        summary.errors.push(state.data.lastError);
        wa2SaveJson(state,'state');
      }
    }
    const queue=state.data.mailQueue.slice().sort((a,b)=>
      Date.parse(b.receivedAt)-Date.parse(a.receivedAt));
    for(const entry of queue) {
      if(summary.mails>=WA2_CONFIG.maxMailsProcessedPerRun ||
        Date.now()-start>WA2_CONFIG.maxRunMilliseconds)break;
      if(entry.nextAt&&Date.parse(entry.nextAt)>Date.now())continue;
      try{
        const mail=wa2ReadMail(entry.id);
        const html=wa2ResolveMilanunciosTrackedLinks(mail.html);
        const listings=wa2ExtractListings(html,mail.plain);
        if(!listings.length){
          if(!state.data.unparsedMails)state.data.unparsedMails=[];
          if(!state.data.unparsedMails.some(x=>x.id===entry.id))
            state.data.unparsedMails.push({id:entry.id,receivedAt:entry.receivedAt});
          state.data.unparsedMails=state.data.unparsedMails.slice(-25);
          summary.errors.push('Keine Portal-ID aus Suchmail '+entry.id);
        }
        const newRows=[];
        for(const listing of listings) {
          if(wa2AddPending(registry.data,listing,entry.id,mail.receivedAt))newRows.push(listing);
          else {
            const existing=registry.data.records[listing.id];
            if(existing&&wa2Due(existing,Date.now())&&
              (existing.status==='retry'||existing.status==='pending'))
              newRows.push(listing);
          }
        }
        if(newRows.length)wa2SaveJson(registry,'registry');
        if(newRows.length) {
          const pageResults={};
          for(const listing of newRows){
            if(Date.now()-start>WA2_CONFIG.maxRunMilliseconds-35000)break;
            if(WA2_CONFIG.allowPageFetch&&!wa2LooksComplete(listing.emailExcerpt))
              pageResults[listing.id]=wa2FetchPage(listing);
          }
          const facts=wa2AnalyzeListings(newRows,credentials,pageResults);
          summary.aiCalls++;state.data.totals.aiCalls++;
          // Some mails appear complete by regex but the model cannot prove
          // a value. Fetch only those pages, then merge missing facts.
          if(WA2_CONFIG.allowPageFetch&&Date.now()-start<WA2_CONFIG.maxRunMilliseconds-55000){
            const missing=newRows.filter(x=>
              (facts[x.id].rent===null||facts[x.id].area===null)&&!pageResults[x.id]);
            const recovered=[];
            for(const item of missing.slice(0,8)){
              if(Date.now()-start>WA2_CONFIG.maxRunMilliseconds-40000)break;
              const page=wa2FetchPage(item);
              if(page.status==='ok'){
                pageResults[item.id]=page;
                recovered.push(item);
              }
            }
            if(recovered.length)try{
              const extra=wa2AnalyzeListings(recovered,credentials,pageResults);
              summary.aiCalls++;state.data.totals.aiCalls++;
              for(const item of recovered)
                for(const key of ['rent','area'])
                  if(facts[item.id][key]===null&&extra[item.id][key]!==null)
                    facts[item.id][key]=extra[item.id][key];
            }catch(e){
              console.warn('WA2 Seiten-Fallback: '+String(e.message||e).slice(0,100));
            }
          }
          for(const listing of newRows) {
            const row=registry.data.records[listing.id],result=facts[listing.id];
            row.rent=result.rent;row.area=result.area;row.attempts=0;row.nextAt='';
            row.updatedAt=new Date().toISOString();
            if(result.area!==null&&result.area<WA2_CONFIG.minAreaM2) {
              row.status='excluded';summary.excluded++;state.data.totals.excluded++;
            } else if(result.area===null&&!WA2_CONFIG.unknownAreaNotify){
              row.status='needs_review';
            } else row.status='ready';
          }
          wa2SaveJson(registry,'registry');
        }
        state.data.mailQueue=state.data.mailQueue.filter(x=>x.id!==entry.id);
        state.data.totals.mails++;
        summary.mails++;
        wa2SaveJson(state,'state');
        // Deliver newly ready listings without waiting for another scheduler tick.
        wa2DeliverDue(registry,state,credentials,WA2_CONFIG.maxListingsPerMail);
      }catch(e){
        const reason=String(e.message||e).slice(0,160);
        entry.attempts=(entry.attempts||0)+1;
        entry.nextAt=new Date(Date.now()+Math.min(240,5*Math.pow(2,entry.attempts-1))*60000).toISOString();
        for(const row of Object.values(registry.data.records))
          if(row.mailId===entry.id&&(row.status==='pending'||row.status==='retry'))
            wa2ScheduleRetry(row,reason,Date.now());
        if(entry.attempts>=WA2_CONFIG.maxRetryAttempts)
          state.data.mailQueue=state.data.mailQueue.filter(x=>x.id!==entry.id);
        wa2SaveJson(registry,'registry');wa2SaveJson(state,'state');
        summary.errors.push('Mail '+entry.id+': '+reason);
      }
    }
    // Retry only telegram delivery; never re-run OpenAI for stored facts.
    wa2DeliverDue(registry,state,credentials,12);
    summary.sent=state.data.totals.sent||0;
    state.data.lastSuccessfulRunUtc=new Date().toISOString();
    if(!summary.errors.length)state.data.lastError='';
    else state.data.lastError=summary.errors.join(' | ').slice(0,400);
    wa2SaveJson(state,'state');
    console.log('WA2 '+JSON.stringify(summary));
    return summary;
  }catch(e){
    console.error('WA2 Pipeline: '+String(e.message||e).slice(0,180));
    throw e; // Visible execution failure; the watchdog can detect a stale pipeline.
  }finally{lock.releaseLock();}
}
function wa2DeliverDue(registry,state,credentials,max) {
  let processed=0;
  for(const row of Object.values(registry.data.records)){
    if(processed>=max)break;
    if(!row||!['ready','notify_retry'].includes(row.status))continue;
    if(row.nextAt&&Date.parse(row.nextAt)>Date.now())continue;
    wa2DeliverOne(registry,row,credentials,state.data);
    processed++;
  }
  if(processed)wa2SaveJson(state,'state');
  return processed;
}
