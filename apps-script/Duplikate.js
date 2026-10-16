/**
 * Central cross-portal duplicate registry. Local JPEG dHash only, no OpenAI calls.
 * Registry entries are keyed by portal:listing-id and keep all source links.
 * Compare full and square-cropped hashes to allow different image dimensions/crops.
 * A single photo is only a candidate, never enough to silently remove a listing.
 */
const DUPLICATES = {
  sheetName: 'Duplikate',
  headers: ['Datensatz-ID','Haupteintrag-ID','Ergebnis','Bilder JSON','Quellen JSON','Aktualisiert UTC','Hinweis'],
  imageLimit: 3,
  strongDistance: 4,
  candidateDistance: 7,
  backfillPerRun: 6
};

function ensureDuplicateRegistry_(ss) {
  let sh = ss.getSheetByName(DUPLICATES.sheetName);
  if (!sh) sh = ss.insertSheet(DUPLICATES.sheetName);
  const found = sh.getRange(1,1,1,7).getValues()[0];
  for(let i=0;i<7;i++) if(found[i] && found[i]!==DUPLICATES.headers[i])
    throw new Error('Duplikatregister: unerwartete Spalte '+(i+1));
  if (found.some((v,i)=>v!==DUPLICATES.headers[i])) {
    sh.getRange(1,1,1,7).setValues([DUPLICATES.headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}
function readDuplicateRegistry_(sheet) {
  if (sheet.getLastRow()<2) return [];
  const vals = sheet.getRange(2,1,sheet.getLastRow()-1,7).getValues();
  return vals.map((r,i)=>({
    row:i+2, id:String(r[0]||''), canonical:String(r[1]||''),
    status:String(r[2]||''), photos:dedupJsonArray_(r[3]),
    sources:dedupJsonArray_(r[4]), note:String(r[6]||'')
  })).filter(v=>v.id);
}
function dedupJsonArray_(x) {try{const r=JSON.parse(x||'[]');return Array.isArray(r)?r:[];}catch(_){return [];} }
function saveDuplicateRecord_(sheet,id,canonical,status,photos,sources,note) {
  const existing=readDuplicateRegistry_(sheet).find(r=>r.id===id);
  const row=existing?existing.row:sheet.getLastRow()+1;
  const mergedSources=[...(existing?.sources||[]),...(sources||[])];
  const key=new Set();
  const cleanSources=mergedSources.filter(s=>s&&s.id&&s.url&&(!key.has(s.id+'|'+s.url)&&key.add(s.id+'|'+s.url)));
  sheet.getRange(row,1,1,7).setValues([[
    id,canonical||id,status||'primary',JSON.stringify(photos||existing?.photos||[]),
    JSON.stringify(cleanSources),new Date().toISOString(),note||''
  ]]);
  return row;
}
function dedupHashDistance_(a,b) {
  if(!/^[0-9a-f]{16}$/i.test(a||'')||!/^[0-9a-f]{16}$/i.test(b||''))return 64;
  const pc=[0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4];
  let d=0;
  for(let i=0;i<16;i++)d+=pc[parseInt(a[i],16)^parseInt(b[i],16)];
  return d;
}
function dedupDHash_(decoded,mode) {
  const w=decoded.width,h=decoded.height,raw=decoded.data;
  const size=Math.min(w,h),left=Math.floor((w-size)/2),top=Math.floor((h-size)/2);
  const rect=mode==='square'?[left,top,size,size]:
    mode==='left'?[0,top,size,size]:
    mode==='right'?[w-size,top,size,size]:[0,0,w,h];
  const [x0,y0,cw,ch]=rect;
  const shades=[];
  for(let y=0;y<8;y++){
    const sy=Math.min(h-1,Math.floor(y0+(y+.5)*ch/8));
    for(let x=0;x<9;x++){
      const sx=Math.min(w-1,Math.floor(x0+(x+.5)*cw/9));
      const idx=(sy*w+sx)*4;
      shades.push(0.299*raw[idx]+0.587*raw[idx+1]+0.114*raw[idx+2]);
    }
  }
  let hex='',bits='';
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    bits+=shades[y*9+x]>shades[y*9+x+1]?'1':'0';
    if(bits.length===4){hex+=parseInt(bits,2).toString(16);bits='';}
  }
  return hex;
}
function dedupFileFingerprint_(file) {
  const blob=DriveApp.getFileById(file.file_id).getBlob();
  const mime=String(blob.getContentType()||'').split(';')[0].toLowerCase();
  if(mime!=='image/jpeg' && mime!=='image/jpg')return null; // fail open; never classify unsupported images as duplicates
  // Local, bundled Apache-2.0 jpeg-js decoder. No outbound request.
  const bytes=blob.getBytes();
  if(bytes.length>9*1024*1024) return null; // Apps Script memory safety
  const decoded=decode(new Uint8Array(bytes),{
    useTArray:true,formatAsRGBA:true,maxResolutionInMP:12,maxMemoryUsageInMB:90
  });
  if(!decoded.width||!decoded.height)throw new Error('JPEG konnte nicht gelesen werden');
  return {file_id:file.file_id, hashes:[
    dedupDHash_(decoded,'full'),dedupDHash_(decoded,'square'),
    dedupDHash_(decoded,'left'),dedupDHash_(decoded,'right')
  ]};
}
function fingerprintListingFiles_(files,limit) {
  const fingerprints=[],seen=new Set();
  for(const file of files||[]){
    if(fingerprints.length>=(limit||DUPLICATES.imageLimit))break;
    if(!file||!file.file_id||seen.has(file.file_id))continue;
    seen.add(file.file_id);
    if(/logo|pixel|tracker|banner|badge|app.store/i.test(String(file.name||'')))continue;
    try{const fp=dedupFileFingerprint_(file);if(fp)fingerprints.push(fp);}
    catch(e){
      if(typeof logImageDiagnostic==='function')logImageDiagnostic('fingerprint_warning',{
        level:'WARN',status:'skipped',error:String(e.message||e).slice(0,160)
      });
    }
  }
  return fingerprints;
}
function duplicateSimilarity_(a,b) {
  let matches=0,best=64,candidates=0;
  const used=new Set();
  for(const f of a||[]){
    let hit=null;
    for(let i=0;i<(b||[]).length;i++){
      if(used.has(i))continue;
      const other=b[i];
      let diff=64;
      for(const v of f.hashes||[])for(const v2 of other.hashes||[])
        diff=Math.min(diff,dedupHashDistance_(v,v2));
      if(diff<=DUPLICATES.candidateDistance && (!hit||diff<hit.diff))hit={i,diff};
    }
    if(hit){
      used.add(hit.i);candidates++;
      best=Math.min(best,hit.diff);
      if(hit.diff<=DUPLICATES.strongDistance)matches++;
    }
  }
  return {matches,best,candidates};
}
function matchDuplicateRegistry_(records,id,photos) {
  let winner=null,possible=null;
  for(const entry of records){
    if(entry.id===id||!entry.photos.length||!photos.length)continue;
    const comp=duplicateSimilarity_(photos,entry.photos);
    if(comp.matches>=2){
      if(!winner||comp.matches>winner.score.matches||
        (comp.matches===winner.score.matches&&comp.best<winner.score.best))
        winner={entry,score:comp};
    }else if(comp.matches===1 || comp.candidates>=2){
      if(!possible||comp.best<possible.score.best)possible={entry,score:comp};
    }
  }
  return {winner,possible};
}
/**
 * Run BEFORE any OpenAI call, based on downloaded photos.
 * New listing is only suppressed when two separate images match.
 */
function checkDuplicateBeforeAi_(ss,id,url,files) {
  const registry=ensureDuplicateRegistry_(ss);
  const prior=readDuplicateRegistry_(registry);
  const own=prior.find(r=>r.id===id);
  const photos=own&&own.photos.length?own.photos:fingerprintListingFiles_(files,DUPLICATES.imageLimit);
  const sources=[{id,url}];
  if(own && ['duplicate','blocked'].includes(own.status))
    return {status:own.status,canonical:own.canonical};
  const result=matchDuplicateRegistry_(prior,id,photos);
  if(result.winner){
    const canonical=result.winner.entry.canonical||result.winner.entry.id;
    const listings=ss.getSheetByName('Anzeigen');
    // If winner was removed, never suppress the new listing using stale registry state.
    const headers=listings.getRange(1,1,1,listings.getLastColumn()).getValues()[0];
    const idCol=headers.indexOf('Datensatz-ID')+1;
    const ids=idCol&&listings.getLastRow()>1?listings.getRange(2,idCol,listings.getLastRow()-1,1).getValues().flat():[];
    const present=ids.includes(canonical)||ids.includes(result.winner.entry.id);
    if(present && result.winner.entry.status!=='blocked'){
      saveDuplicateRecord_(registry,id,canonical,'duplicate',photos,sources,'Mindestens zwei ähnliche Fotos; OpenAI übersprungen');
      return {status:'duplicate',canonical};
    }
    if(result.winner.entry.status==='blocked'){
      saveDuplicateRecord_(registry,id,canonical,'blocked',photos,sources,'Gesperrte Wohnung wiedererkannt');
      return {status:'blocked',canonical};
    }
  }
  saveDuplicateRecord_(registry,id,id,result.possible?'candidate':'primary',photos,sources,
    result.possible?'Bildähnlichkeit mit '+result.possible.entry.id+'; keine sichere Zuordnung':'');
  return {status:result.possible?'candidate':'primary',canonical:id};
}
function backfillDuplicateRegistry_(ss,maxNew) {
  const registry=ensureDuplicateRegistry_(ss);
  const known=new Set(readDuplicateRegistry_(registry).filter(x=>x.photos.length||x.status==='unsupported').map(x=>x.id));
  const sheet=ss.getSheetByName('Anzeigen');
  if(!sheet||sheet.getLastRow()<2)return {added:0};
  const header=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const idCol=header.indexOf('Datensatz-ID'),jsonCol=header.indexOf('Bildanalyse JSON'),urlCol=header.indexOf('Anzeigenlink');
  if(Math.min(idCol,jsonCol,urlCol)<0)throw new Error('Dublettenindex: Anzeigenfelder fehlen');
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues();
  let added=0,matched=0;
  for(const row of rows){
    if(added>=(maxNew||DUPLICATES.backfillPerRun))break;
    const id=String(row[idCol]||'').trim();
    if(!id||known.has(id))continue;
    let parsed={};try{parsed=JSON.parse(String(row[jsonCol]||'{}'));}catch(_){}
    const files=parsed.drive_files||[];
    const images=fingerprintListingFiles_(files,DUPLICATES.imageLimit);
    const records=readDuplicateRegistry_(registry);
    const match=matchDuplicateRegistry_(records,id,images);
    const source=[{id,url:String(row[urlCol]||'')}];
    if(match.winner){matched++;saveDuplicateRecord_(registry,id,match.winner.entry.canonical||match.winner.entry.id,'duplicate',images,source,'Bestands-Duplikat anhand zweier Bilder');}
    else saveDuplicateRecord_(registry,id,id,images.length?'primary':'unsupported',images,source,
      match.possible?'Mögliche Dublette: '+match.possible.entry.id:'');
    known.add(id);added++;
  }
  return {added,matched};
}
/** Marked rows: verify persistent blocklist entry before deleting the row. */
function cleanupMarkedListings_(ss) {
  const sheet=ss.getSheetByName('Anzeigen'),blacklist=ss.getSheetByName('Sperrliste');
  if(!sheet||!blacklist)throw new Error('Anzeigen/Sperrliste fehlen');
  if(sheet.getLastRow()<2)return {deleted:0};
  const head=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const del=head.indexOf('Zu löschen'),idcol=head.indexOf('Datensatz-ID'),urlcol=head.indexOf('Anzeigenlink');
  if(Math.min(del,idcol,urlcol)<0)throw new Error('Löschspalten fehlen');
  const values=sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues();
  const existing=readMailImageBlacklist(ss),marked=[];
  for(let i=0;i<values.length;i++){
    const r=values[i],flag=r[del];
    if(flag!==true&&String(flag).toUpperCase()!=='TRUE')continue;
    const id=String(r[idcol]||'').trim(),url=String(r[urlcol]||'').trim();
    if(!id||!url)throw new Error('Markierte Anzeige ohne ID oder URL in Zeile '+(i+2));
    marked.push({row:i+2,id,url});
  }
  for(const item of marked){
    if(!existing.has(item.id.toLowerCase())){
      const next=blacklist.getLastRow()+1;
      blacklist.getRange(next,1,1,3).setValues([[
        item.id,item.url,'Vom Nutzer über Zu löschen gesperrt am '+new Date().toISOString()
      ]]);
      SpreadsheetApp.flush();
      if(String(blacklist.getRange(next,1).getValue())!==item.id)
        throw new Error('Sperrliste nicht bestätigt; Anzeige bleibt erhalten');
      existing.add(item.id.toLowerCase());
    }
  }
  const registry=ensureDuplicateRegistry_(ss);
  const rec=readDuplicateRegistry_(registry);
  for(const item of marked){
    for(const other of rec){
      if(other.id===item.id||other.canonical===item.id){
        saveDuplicateRecord_(registry,other.id,item.id,'blocked',other.photos,other.sources,'Vom Nutzer ausgeschlossen');
      }
    }
  }
  let deleted=0;
  for(const item of marked.sort((a,b)=>b.row-a.row)){
    // No row may be removed if sorting changed the identity unexpectedly.
    const live=String(sheet.getRange(item.row,idcol+1).getValue()||'');
    if(live!==item.id)throw new Error('Zeilenidentität geändert; nicht löschen: '+item.id);
    sheet.deleteRow(item.row);deleted++;
  }
  return {deleted};
}
