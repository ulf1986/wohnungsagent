/**
 * Reuse the original Yaencontre HTML for *recent* previously imported listings.
 * No Gmail search, no old messages, no OpenAI image-review calls.
 * At most one email and six image files per importer tick.
 */
function recoverRecentYaencontreMailImages_(ss) {
  const p=PropertiesService.getScriptProperties(),key='YA_RECENT_PHOTO_CURSOR_V1';
  const queue=ss.getSheetByName('Verarbeitung'),sheet=ss.getSheetByName('Anzeigen');
  if(!queue||!sheet||queue.getLastRow()<2)return {mails:0,photos:0};
  const qh=queue.getRange(1,1,1,queue.getLastColumn()).getValues()[0];
  const at=n=>qh.indexOf(n)+1;
  const mid=at('Queue Gmail-ID'),time=at('Queue Eingang UTC'),links=at('Queue Inseratslinks JSON');
  if(!mid||!time||!links)return {mails:0,photos:0,reason:'queue_columns_missing'};
  const headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const col=n=>headers.indexOf(n);
  const idCol=col('Datensatz-ID'),jsonCol=col('Bildanalyse JSON'),mailCol=col('E-Mail-ID');
  if(Math.min(idCol,jsonCol,mailCol)<0)return {mails:0,photos:0,reason:'listing_columns_missing'};
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues();
  const active=new Map();
  for(let i=0;i<rows.length;i++){
    const id=String(rows[i][idCol]||'');
    if(/^yaencontre:\d+$/.test(id))active.set(id,{row:i+2,values:rows[i]});
  }
  if(!active.size)return {mails:0,photos:0};
  const n=queue.getLastRow()-1;
  const base=Math.min(mid,time,links);
  const q=queue.getRange(2,base,n,Math.max(mid,time,links)-base+1).getValues();
  let cursor=Math.max(0,Math.min(n-1,Number(p.getProperty(key))||0)),checked=0;
  const now=Date.now();
  for(let k=0;k<n;k++){
    const i=(cursor+k)%n,values=q[i];
    const mailId=String(values[mid-base]||'').trim();
    const ts=Date.parse(String(values[time-base]||''));
    if(!mailId||!Number.isFinite(ts)||ts>now||now-ts>48*3600000)continue;
    let targets=[];
    try{
      const listingUrls=JSON.parse(String(values[links-base]||'[]'));
      targets=[...new Set((Array.isArray(listingUrls)?listingUrls:[])
        .map(getMailListingId).filter(id=>active.has(id)))];
    }catch(_){continue;}
    const pending=targets.filter(id=>{
      const v=active.get(id).values;
      try{return !((JSON.parse(String(v[jsonCol]||'{}')).drive_files||[])
        .some(file=>file&&file.file_id));}catch(_){return false;}
    });
    if(!pending.length)continue;
    // Mark attempted mail before Gmail access; malformed messages cannot loop.
    p.setProperty(key,String((i+1)%n));
    let mail;
    try{mail=GmailApp.getMessageById(mailId);}catch(_){
      logImageDiagnostic('ya_recent_images',{mail_id:mailId,status:'mail_unavailable'});return {mails:1,photos:0};
    }
    if(!mail||!mail.getDate||now-mail.getDate().getTime()>48*3600000)
      return {mails:1,photos:0,reason:'outside_48h'};
    const photos=extractYaencontreMailImages(mail.getBody()||'');
    let created=0;
    for(const id of pending) {
      if(created>=6)break;
      if(isListingBlacklisted_(ss,id))continue;
      const own=photos.filter(x=>x.listing_id===id&&
        photos.filter(y=>y.source_url===x.source_url)
          .every(y=>y.listing_id===id)).slice(0,Math.max(0,6-created));
      if(!own.length)continue;
      const result=saveListingImages(getImageFolder(),id,
        own.map(x=>x.source_url),[]);
      if(result.errors.length)logImageDiagnostic('ya_recent_images',{
        mail_id:mailId,listing_id:id,status:'download_failed',count:result.errors.length});
      if(!result.files.length)continue;
      const entry=active.get(id);
      // An item might have changed while the Gmail read was in progress.
      const current=sheet.getRange(entry.row,idCol+1).getValue();
      if(String(current)!==id)continue;
      let data;
      try{data=JSON.parse(String(sheet.getRange(entry.row,jsonCol+1).getValue()||'{}'));}
      catch(_){continue;}
      const existing=(data.drive_files||[]),seen=new Set(existing.map(x=>x.file_id));
      for(const file of result.files)if(file.file_id&&!seen.has(file.file_id)){
        file.listing_id=id;
        file.listing_url=own.find(x=>x.source_url===file.source_url)?.listing_url||'';
        existing.push(file);seen.add(file.file_id);
      }
      data.drive_files=existing;
      sheet.getRange(entry.row,jsonCol+1).setValue(JSON.stringify(data));
      created+=result.created;
    }
    logImageDiagnostic('ya_recent_images',{mail_id:mailId,status:'processed',
      count:created,files:photos.length});
    return {mails:1,photos:created};
  }
  p.setProperty(key,String((cursor+1)%n));
  return {mails:0,photos:0,reason:'no_recent_missing_photos'};
}
