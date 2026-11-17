/**
 * Manual one-time import of historic Telegram delivery IDs.
 * Uses legacy Google Sheet and public GitHub issue #3 ONLY during migration.
 * No Sheets dependency exists in the WA2 production pipeline.
 */
function wa2MigrateHistory() {
  if(wa2IsEnabled())throw new Error('WA2: Migration nur im deaktivierten Zustand');
  const alreadyMigrated=wa2Properties().getProperty('WA2_MIGRATION_COMPLETE')==='true';
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))throw new Error('WA2: Lock besetzt');
  try {
    const registry=wa2LoadRegistry(),state=wa2LoadState();
    const original=Object.keys(registry.data.records).length;
    const add=id=>{
      if(!/^(idealista|fotocasa|yaencontre|pisos|milanuncios):\d+$/.test(id))return;
      if(registry.data.records[id])return;
      registry.data.records[id]={id,provider:id.split(':')[0],status:'sent',
        url:'',rent:null,area:null,sentAt:'legacy',updatedAt:new Date().toISOString()};
    };
    // Existing GitHub issue stores sent IDs from the fallback sender.
    const response=UrlFetchApp.fetch('https://api.github.com/repos/ulf1986/wohnungsagent/issues/3',{
      muteHttpExceptions:true,headers:{Accept:'application/vnd.github+json', 'User-Agent':'Wohnungsagent-2.0'}
    });
    if(response.getResponseCode()!==200)
      throw new Error('WA2: GitHub-Versandhistorie nicht lesbar: HTTP '+response.getResponseCode());
    const issue=JSON.parse(response.getContentText());
    const match=String(issue.body||'').match(new RegExp('```json\\s*([\\s\\S]*?)```','i'));
    if(!match)throw new Error('WA2: GitHub-Historie enthält kein JSON');
    const history=JSON.parse(match[1]);
    if(!Array.isArray(history.sent)||!history.sent.length)
      throw new Error('WA2: GitHub-Historie ohne sent-IDs');
    history.sent.forEach(add);
    // Additionally include IDs sent directly by Apps Script (if any).
    const sheet=SpreadsheetApp.openById(CONFIG.spreadsheetId).getSheetByName('Anzeigen');
    if(!sheet)throw new Error('WA2: Legacy-Anzeigenblatt fehlt');
    const values=sheet.getDataRange().getValues();
    const columns=values[0].map(String),idCol=columns.indexOf('Datensatz-ID');
    const sentCol=columns.indexOf('Telegram Versand UTC');
    if(idCol<0)throw new Error('WA2: Alte Datensatz-ID-Spalte fehlt');
    if(sentCol>=0)for(const row of values.slice(1))
      if(row[sentCol])add(String(row[idCol]).trim());
    wa2SaveJson(registry,'registry');
    // Only the initial migration seeds the 48-hour lookback. Safe resyncs
    // preserve the pending-mail queue and Gmail checkpoint without resetting.
    if(!alreadyMigrated){
      state.data.checkpointUtc=new Date(Date.now()-48*3600000).toISOString();
      state.data.lastScanUtc='';
      wa2SaveJson(state,'state');
    }
    wa2Properties().setProperty('WA2_MIGRATION_COMPLETE','true');
    const result={status:alreadyMigrated?'resynced':'migrated',legacySentImported:Object.keys(registry.data.records).length-original,
      totalStored:Object.keys(registry.data.records).length,
      historyCount:history.sent.length};
    console.log('WA2_MIGRATION '+JSON.stringify(result));
    return result;
  }finally{lock.releaseLock();}
}
