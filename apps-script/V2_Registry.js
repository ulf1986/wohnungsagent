/**
 * Private Drive JSON persistence. Caller owns a ScriptLock for all mutations.
 * Registry and cursor are intentionally independent of Google Sheets.
 */
function wa2StoreFolder() {
  const p=wa2Properties();
  const id=p.getProperty(WA2_CONFIG.folderProperty);
  if(id) return DriveApp.getFolderById(id);
  const folder=DriveApp.createFolder('Wohnungsagent-v2-private');
  p.setProperty(WA2_CONFIG.folderProperty,folder.getId());
  return folder;
}
function wa2StoreFile(key,name,initial) {
  const p=wa2Properties(),folder=wa2StoreFolder();
  let id=p.getProperty(key),file=null;
  if(id) {
    try{file=DriveApp.getFileById(id);}
    catch(e){throw new Error('WA2: Vorhandene Speicherdatei nicht erreichbar: '+name);}
  }
  if(!file){
    const found=folder.getFilesByName(name);
    file=found.hasNext()?found.next():folder.createFile(name,JSON.stringify(initial),'application/json');
    p.setProperty(key,file.getId());
  }
  return file;
}
function wa2LoadJson(key,name,initial) {
  const file=wa2StoreFile(key,name,initial);
  let data;
  try{data=JSON.parse(file.getBlob().getDataAsString('UTF-8'));}
  catch(e){throw new Error('WA2: Speicherdatei beschädigt: '+name);}
  if(!data||typeof data!=='object'||Array.isArray(data)||data.version!==2)
    throw new Error('WA2: Ungültiges JSON-Schema: '+name);
  return {file,data};
}
function wa2LoadRegistry(){
  const x=wa2LoadJson('WA2_REGISTRY_FILE_ID','registry.json',{version:2,records:{}});
  if(!x.data.records||typeof x.data.records!=='object')throw new Error('WA2: Registry unvollständig');
  return x;
}
function wa2LoadState(){
  const x=wa2LoadJson('WA2_STATE_FILE_ID','state.json',{
    version:2,mailQueue:[],indexedMailIds:{},checkpointUtc:'',lastScanUtc:'',
    lastSuccessfulRunUtc:'',lastError:'',lastAlertCode:'',lastAlertUtc:'',
    totals:{mails:0,aiCalls:0,sent:0,excluded:0}
  });
  if(!Array.isArray(x.data.mailQueue)||!x.data.indexedMailIds)
    throw new Error('WA2: State unvollständig');
  if(!x.data.totals)x.data.totals={mails:0,aiCalls:0,sent:0,excluded:0};
  return x;
}
function wa2SaveJson(holder,type) {
  const stamp=new Date().toISOString().slice(0,10);
  const p=wa2Properties();
  if(type==='registry'&&p.getProperty('WA2_BACKUP_DATE')!==stamp){
    const original=holder.file.getBlob().getDataAsString('UTF-8');
    if(original.length>200){
      holder.file.makeCopy('registry-backup-'+stamp+'.json',wa2StoreFolder());
      p.setProperty('WA2_BACKUP_DATE',stamp);
    }
  }
  holder.file.setContent(JSON.stringify(holder.data));
}
function wa2Terminal(status) {
  return status==='sent'||status==='excluded'||status==='manual_review'
    ||status==='unknown_delivery';
}
function wa2AddPending(registry,item,mailId,receivedAt) {
  const previous=registry.records[item.id];
  if(previous) return false;
  registry.records[item.id]={
    id:item.id,provider:item.provider,url:item.url,
    receivedAt,mailId,status:'pending',attempts:0,nextAt:'',
    rent:null,area:null,updatedAt:new Date().toISOString()
  };
  return true;
}
function wa2Due(row,now) {
  return row&&(row.status==='pending'||row.status==='retry'||row.status==='notify_retry')
    &&(!row.nextAt||Date.parse(row.nextAt)<=now);
}
function wa2ScheduleRetry(row,reason,now) {
  row.attempts=(row.attempts||0)+1;
  row.lastError=String(reason||'Technischer Fehler').slice(0,150);
  row.updatedAt=new Date(now).toISOString();
  if(row.attempts>=WA2_CONFIG.maxRetryAttempts){
    row.status='failed_final';row.nextAt='';
    return;
  }
  row.status=row.status==='notify_retry'||row.status==='sending'?'notify_retry':'retry';
  const minutes=Math.min(240,5*Math.pow(2,row.attempts-1));
  row.nextAt=new Date(now+minutes*60000).toISOString();
}
function wa2CompactMailIndex(state,now) {
  const limit=now-7*86400000;
  for(const [id,time] of Object.entries(state.indexedMailIds))
    if(Date.parse(time)<limit)delete state.indexedMailIds[id];
}
