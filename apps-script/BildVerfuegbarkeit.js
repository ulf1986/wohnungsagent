/**
 * Verfügbarkeit ausschließlich anhand der ORIGINALEN Bild-URLs.
 * Die vorhandenen Drive-Kopien werden niemals verkleinert oder gelöscht.
 * 0 Bytes im Prüfstatus bedeutet: alle geprüften Quellbilder lieferten
 * verifiziert HTTP 404/410; nicht etwa eine zerstörte Drive-Datei.
 */
function checkListingImageAvailabilityInternal() {
  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const sheet = ss.getSheetByName(CONFIG.sheetName);
  const settings = ss.getSheetByName('Einstellungen');
  if (!sheet || !settings) throw new Error('Anzeigen/Einstellungen fehlen');
  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const c = name => {
    const i = headers.indexOf(name);
    if (i < 0) throw new Error('Spalte fehlt: ' + name);
    return i + 1;
  };
  const idCol=c('Datensatz-ID'), linkCol=c('Anzeigenlink');
  const jsonCol=c('Bildanalyse JSON');
  const rowCount=sheet.getLastRow()-1;
  if (rowCount<1) return;
  const data=sheet.getRange(2,1,rowCount,headers.length).getValues();
  const blacklist=settings.getRange(1,4,Math.max(1,settings.getLastRow()),3).getValues();
  const blocked=new Set(blacklist.slice(1).map(x=>String(x[0]||'').trim()));
  const deletion=[];
  let checked=0, unavailable=0, uncertain=0;
  for(let i=0;i<data.length;i++){
    const row=data[i], id=String(row[idCol-1]||'').trim();
    if(!id || blocked.has(id)) continue;
    let payload;
    try { payload=JSON.parse(String(row[jsonCol-1]||'{}')); }
    catch(e) { uncertain++; continue; }
    if(!payload || typeof payload!=='object' || Array.isArray(payload)) continue;
    const sourceUrls=[...(Array.isArray(payload.bild_urls)?payload.bild_urls:[]),
      ...(Array.isArray(payload.drive_files)?payload.drive_files.map(x=>x.source_url):[])]
      .map(u=>String(u||'')).filter(u=>/^https:\/\//i.test(u));
    const urls=[...new Set(sourceUrls)].slice(0,15);
    if(urls.length===0) continue;
    checked++;
    const details=[];
    for(const url of urls){
      try {
        const response=UrlFetchApp.fetch(url,{method:'get',muteHttpExceptions:true,
          followRedirects:true,headers:{Accept:'image/jpeg,image/png,image/webp,*/*'}});
        const status=response.getResponseCode();
        const bytes=response.getBlob().getBytes().length;
        details.push({url,status,bytes:status===404||status===410?0:bytes});
      } catch(e) {
        details.push({url,status:'network_error',bytes:null});
      }
    }
    const allMissing=details.every(x=>(x.status===404||x.status===410) && x.bytes===0);
    const previous=payload.availability_check||{};
    const previousMissing=previous.state==='all_images_missing' &&
      previous.checked_count===urls.length;
    const attempts=allMissing?(previousMissing?(Number(previous.confirmations)||1)+1:1):0;
    payload.availability_check={
      method:'original_image_http',state:allMissing?'all_images_missing':
        details.some(x=>x.status===200&&x.bytes>0)?'images_accessible':'not_verifiable',
      confirmations:attempts,checked_count:urls.length,
      checked_at:new Date().toISOString(),images:details
    };
    sheet.getRange(i+2,jsonCol).setValue(JSON.stringify(payload));
    if(allMissing && attempts>=2){
      unavailable++;
      deletion.push({row:i+2,id,url:String(row[linkCol-1]||''),
        reason:'Alle '+urls.length+' Original-Bild-URLs wiederholt HTTP 404/410 (0 Bytes im Prüfergebnis)'});
    } else if (!details.some(x=>x.status===200&&x.bytes>0)) uncertain++;
  }
  // Liste vor jeder Löschung dauerhaft ergänzen und durch Kontrolllesen bestätigen.
  for(const item of deletion){
    const next=settings.getLastRow()+1;
    settings.getRange(next,4,1,3).setValues([[item.id,item.url,item.reason]]);
    SpreadsheetApp.flush();
    const saved=settings.getRange(next,4,1,3).getValues()[0];
    if(saved[0]!==item.id||saved[1]!==item.url)
      throw new Error('Sperrliste nicht bestätigt: '+item.id);
  }
  deletion.sort((a,b)=>b.row-a.row);
  for(const item of deletion) sheet.deleteRow(item.row);
  console.log('Bild-Verfügbarkeit: '+JSON.stringify({
    checked,unavailable,uncertain,removed:deletion.length
  }));
}
