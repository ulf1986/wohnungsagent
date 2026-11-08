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
/**
 * Compare only independently verified listing facts. This is a review signal,
 * never grounds for automatic blocking. Do NOT compare portal numeric IDs.
 */
function duplicateTextFacts_(data, row, columns) {
  const p=(data&&data.ai_pipeline)||{},f=(data&&data.extracted_fields)||{};
  const provenance=Array.isArray(p.field_provenance)?p.field_provenance:[];
  const verified=name=>provenance.some(x=>x&&x.field===name&&
    (x.source==='email'||x.source==='listing_page')&&String(x.quote||'').length>=3);
  const address=verified('address')?String(f.address||'').trim().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[.,]/g,'').replace(/\s+/g,' '):'';
  const val=field=>{
    if(!verified(field))return null;
    const value=Number(f[field]);
    return Number.isFinite(value)&&value>0?value:null;
  };
  return {address,area:val('area_m2'),rent:val('rent_eur'),rooms:val('rooms')};
}
function duplicateTextCandidate_(a,b) {
  // Address equality + at least two further facts avoids auto-associating
  // unrelated apartments in the same building by price/area alone.
  if(!a.address||!b.address||a.address!==b.address)return false;
  const checks=[
    [a.area,b.area,2],
    [a.rent,b.rent,5],
    [a.rooms,b.rooms,0]
  ];
  let agreed=0;
  for(const [x,y,tolerance] of checks) {
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<=0||y<=0)continue;
    if(Math.abs(x-y)>tolerance)return false;
    agreed++;
  }
  return agreed>=2;
}
/** Bounded metadata-only review candidates. No new AI calls or row deletion. */
function detectTextDuplicateCandidates_(ss,maxRows) {
  const sheet=ss.getSheetByName('Anzeigen'),registry=ensureDuplicateRegistry_(ss);
  if(!sheet||sheet.getLastRow()<3)return {checked:0,candidates:0};
  const rows=sheet.getRange(1,1,sheet.getLastRow(),sheet.getLastColumn()).getValues();
  const heads=rows.shift(),cols={};
  ['Datensatz-ID','Anzeigenlink','Bildanalyse JSON','Miete','Fläche'].forEach(name=>{
    cols[name]=heads.indexOf(name);if(cols[name]<0)throw new Error('Dubletten-Textprüfung: '+name);
  });
  const relevant=rows.map((r,i)=>{
    const id=String(r[cols['Datensatz-ID']]||'');
    if(!id)return null;
    let parsed={};try{parsed=JSON.parse(String(r[cols['Bildanalyse JSON']]||'{}'));}catch(_){}
    return {id,url:String(r[cols['Anzeigenlink']]||''),facts:duplicateTextFacts_(parsed,r,cols),row:i+2};
  }).filter(Boolean);
  const records=readDuplicateRegistry_(registry),byId=new Map(records.map(r=>[r.id,r]));
  const props=PropertiesService.getScriptProperties();
  const cursorKey='DUPLICATE_TEXT_CURSOR_V1';
  const start=Math.max(0,Math.min(relevant.length-1,Number(props.getProperty(cursorKey))||0));
  const batch=Math.max(1,Math.min(30,Number(maxRows)||10));
  let checked=0,candidates=0;
  for(let offset=0;offset<Math.min(batch,relevant.length);offset++) {
    const entry=relevant[(start+offset)%relevant.length];
    const record=byId.get(entry.id);
    if(record&&['duplicate','blocked'].includes(record.status))continue;
    checked++;
    if(!entry.facts.address)continue;
    const matched=relevant.find(other=>other.id!==entry.id&&
      duplicateTextCandidate_(entry.facts,other.facts));
    if(!matched)continue;
    // Retain photo-based 'primary' judgement; review hint does not override it.
    if(record&&record.status==='primary'&&record.photos.length)continue;
    saveDuplicateRecord_(registry,entry.id,entry.id,'candidate',
      record?.photos||[],[{id:entry.id,url:entry.url}],
      'Textvergleich: mögliche Dublette '+matched.id+' (manuell prüfen)');
    candidates++;
  }
  props.setProperty(cursorKey,String((start+Math.min(batch,relevant.length))%relevant.length));
  return {checked,candidates};
}

function backfillDuplicateRegistry_(ss,maxNew) {
  const registry=ensureDuplicateRegistry_(ss);
  const known=new Set(readDuplicateRegistry_(registry).filter(x=>x.photos.length).map(x=>x.id));
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
    // New images can arrive after an earlier unsupported decision.
    // Reuse only correctly owned files; never mix digest thumbnails.
    const ownedFiles=(parsed.drive_files||[]).filter(file=>
      file&&file.file_id&&(!file.listing_id||file.listing_id===id));
    const files=ownedFiles.length?ownedFiles:
      (Array.isArray(parsed.ai_pipeline?.image_selection)?
        parsed.ai_pipeline.image_selection.filter(file=>
          file&&file.file_id&&(!file.listing_id||file.listing_id===id)) : []);
    if(!files.length)continue;
    const images=fingerprintListingFiles_(files,DUPLICATES.imageLimit);
    if(!images.length)continue;
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
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues();
  const marked=rows.map((r,i)=>({row:i+2,id:String(r[idcol]||'').trim(),
    url:String(r[urlcol]||'').trim(),flag:r[del]}))
    .filter(r=>r.flag===true||String(r.flag).toUpperCase()==='TRUE');
  if(!marked.length)return {deleted:0};
  for(const item of marked)if(!item.id||!item.url)
    throw new Error('Markierte Anzeige ohne ID oder URL in Zeile '+item.row);
  const registry=ensureDuplicateRegistry_(ss),records=readDuplicateRegistry_(registry);
  const linked=new Map(marked.map(x=>[x.id,x]));
  // User blocking one primary blocks all confirmed cross-portal aliases.
  const allBlocked=new Map();
  for(const item of marked){
    const origin=records.find(r=>r.id===item.id);
    const canonical=origin?.canonical||item.id;
    allBlocked.set(item.id,{id:item.id,url:item.url,canonical});
    for(const entry of records.filter(r=>r.id===canonical||r.canonical===canonical)){
      const url=entry.sources.find(s=>s.id===entry.id)?.url||
        rows.find(r=>String(r[idcol]||'')===entry.id)?.[urlcol]||'';
      if(url)allBlocked.set(entry.id,{id:entry.id,url:String(url),canonical});
      const visible=rows.findIndex(r=>String(r[idcol]||'')===entry.id);
      if(visible>=0&&!linked.has(entry.id)){
        const live=rows[visible];
        linked.set(entry.id,{row:visible+2,id:entry.id,url:String(live[urlcol]||'')});
      }
    }
  }
  const existing=readMailImageBlacklist(ss);
  // Write and confirm the entire property group BEFORE removing any visible rows.
  for(const item of allBlocked.values()){
    if(existing.has(item.id.toLowerCase()))continue;
    const next=blacklist.getLastRow()+1;
    blacklist.getRange(next,1,1,3).setValues([[
      item.id,item.url,'Vom Nutzer über Zu löschen ausgeschlossen; Objekt '+item.canonical
    ]]);
    SpreadsheetApp.flush();
    if(String(blacklist.getRange(next,1).getValue())!==item.id)
      throw new Error('Sperrliste nicht bestätigt; Anzeige bleibt erhalten');
    existing.add(item.id.toLowerCase());
  }
  for(const entry of records){
    const blocked=allBlocked.get(entry.id);
    if(blocked)saveDuplicateRecord_(registry,entry.id,blocked.canonical,
      'blocked',entry.photos,entry.sources,'Vom Nutzer ausgeschlossen');
  }
  let deleted=0;
  for(const item of [...linked.values()].sort((a,b)=>b.row-a.row)){
    if(String(sheet.getRange(item.row,idcol+1).getValue()||'')!==item.id)
      throw new Error('Zeilenidentität geändert; nicht löschen: '+item.id);
    sheet.deleteRow(item.row);deleted++;
  }
  return {deleted,blockedIds:allBlocked.size};
}


/**
 * Consolidate already-imported cross-portal duplicate rows without re-running AI.
 * Retain all alternate source URLs/IDs in both the registry and primary row JSON.
 * Prefer the listing with most verified facts and image coverage, not the oldest.
 */
function reconcileExistingDuplicates_(ss) {
  const registry=ensureDuplicateRegistry_(ss),records=readDuplicateRegistry_(registry);
  const sheet=ss.getSheetByName('Anzeigen');
  if(!sheet||sheet.getLastRow()<3)return {groups:0,removed:0};
  const head=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const col=name=>{const i=head.indexOf(name);if(i<0)throw Error('Dublettenbereinigung: Spalte fehlt '+name);return i;};
  const idCol=col('Datensatz-ID'),urlCol=col('Anzeigenlink'),jsonCol=col('Bildanalyse JSON'),mailCol=col('E-Mail-ID');
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues();
  const byId=new Map();
  rows.forEach((values,i)=>{const id=String(values[idCol]||'');if(id)byId.set(id,{row:i+2,values});});
  const groups=new Map();
  for(const record of records){
    const canonical=record.canonical||record.id;
    if(record.status!=='duplicate'||!byId.has(record.id)||!byId.has(canonical))continue;
    if(!groups.has(canonical))groups.set(canonical,new Set([canonical]));
    groups.get(canonical).add(record.id);
  }
  const toDelete=[],priorities={};
  for(const [canonical,ids] of groups){
    const entries=[...ids].map(id=>({id,entry:byId.get(id)})).filter(e=>e.entry);
    if(entries.length<2)continue;
    const quality=e=>{
      const v=e.entry.values;
      let score=0;
      if(v[col('Miete')]!==''&&v[col('Miete')]!==null)score+=6;
      if(v[col('Fläche')]!==''&&v[col('Fläche')]!==null)score+=6;
      if(v[col('Titel')]&&String(v[col('Titel')])!=='Wohnung')score+=2;
      const data=dedupParse_(v[jsonCol]);
      const f=data.extracted_fields||{};
      if(f.address)score+=5;
      if(f.long_term===true)score+=2;
      const num=(data.ai_pipeline?.image_selection||data.drive_files||[]).length;
      score+=Math.min(5,Math.round(Math.log2(1+num)));
      return score;
    };
    entries.sort((a,b)=>quality(b)-quality(a)||a.entry.row-b.entry.row);
    const winner=entries[0],winnerData=dedupParse_(winner.entry.values[jsonCol]);
    const alt=Array.isArray(winnerData.alternate_portals)?winnerData.alternate_portals:[];
    for(const item of entries){
      if(item.id===winner.id)continue;
      alt.push({id:item.id,url:String(item.entry.values[urlCol]||''),
        mail_id:String(item.entry.values[mailCol]||'')});
      toDelete.push({id:item.id,row:item.entry.row});
    }
    winnerData.alternate_portals=[...new Map(alt.filter(a=>a.id&&a.url).map(a=>[a.id,a])).values()];
    sheet.getRange(winner.entry.row,jsonCol+1).setValue(JSON.stringify(winnerData));
    for(const record of records.filter(r=>ids.has(r.id))){
      const nextStatus=record.id===winner.id?'primary':'duplicate';
      saveDuplicateRecord_(registry,record.id,winner.id,nextStatus,record.photos,
        [...record.sources,...winnerData.alternate_portals.map(a=>({id:a.id,url:a.url})),
          {id:winner.id,url:String(winner.entry.values[urlCol]||'')}],'Konsolidiert in '+winner.id);
    }
    priorities[winner.id]=entries.length;
  }
  for(const item of toDelete.sort((a,b)=>b.row-a.row)){
    if(String(sheet.getRange(item.row,idCol+1).getValue()||'')!==item.id)
      throw new Error('Dubletten-Zeile wurde verschoben: '+item.id);
    sheet.deleteRow(item.row);
  }
  return {groups:Object.keys(priorities).length,removed:toDelete.length};
}
function dedupParse_(json) {
  try{const d=JSON.parse(String(json||'{}'));return d&&typeof d==='object'&&!Array.isArray(d)?d:{};}
  catch(_){return {};}
}


/**
 * Idempotent live migration. Deliberately runs only after deploying the
 * matching code, before all other five-minute pipeline stages.
 *
 * Old columns: A=Gesehen, B=Zu löschen, C=Punkte, D=E-Mail-Eingang.
 * New columns: A=Zu löschen, B=Wohnungsbewertung (0–100),
 * C=Preisbewertung (0–100), D=Miete pro m², E=E-Mail-Eingang.
 * All later columns are addressed by header, preserving their contents.
 */
function ensureListingRatingSchema_(ss) {
  const sheet=ss.getSheetByName('Anzeigen');
  if(!sheet)throw new Error('Pflichtblatt Anzeigen fehlt');
  let heads=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const home='Wohnungsbewertung (0–100)',price='Preisbewertung (0–100)';
  if(heads[0]==='Gesehen'){
    if(heads[1]!=='Zu löschen')throw new Error('Nicht erkannte Anzeigenstruktur, Spalte Gesehen bleibt unverändert');
    sheet.deleteColumn(1); // Preserve "Zu löschen" checkbox including validation.
    heads=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  }
  if(heads[0]!=='Zu löschen')throw new Error('Zu löschen muss die erste Spalte sein');
  if(heads[1]==='Punkte'){
    sheet.getRange(1,2).setValue(home);
    heads[1]=home;
  }
  if(heads[1]!==home)throw new Error('Wohnungsbewertung: unerwartete zweite Spalte');
  if(heads[2]!==price){
    if(heads[2]==='E-Mail-Eingang'){
      sheet.insertColumnAfter(2);
      sheet.getRange(1,3).setValue(price);
      // Format second score column consistently with first.
      sheet.getRange(1,2).copyFormatToRange(sheet,3,3,1,1);
      const end=Math.max(2,sheet.getLastRow());
      sheet.getRange(2,2,end-1,1).copyFormatToRange(sheet,3,3,2,end);
      // Old mixed scores must never be presented as the new home rating.
      sheet.getRange(2,2,end-1,2).clearContent();
    }else throw new Error('Preisbewertung: unerwartete dritte Spalte');
  }
  heads=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const unitPrice='Miete pro m²';
  if(heads[3]!==unitPrice){
    if(heads[3]!=='E-Mail-Eingang' || heads.includes(unitPrice))
      throw new Error('Miete pro m²: unerwartete Spaltenposition');
    sheet.insertColumnAfter(3);
    sheet.getRange(1,4).setValue(unitPrice);
    sheet.getRange(1,3).copyFormatToRange(sheet,4,4,1,1);
    sheet.setColumnWidth(4,125);
  }
  // Sanity-check the exact resulting columns before downstream processing.
  heads=sheet.getRange(1,1,1,5).getValues()[0];
  if(heads.join('|')!==['Zu löschen',home,price,unitPrice,'E-Mail-Eingang'].join('|'))
    throw new Error('Bewertungsspaltenmigration nicht abgeschlossen');
  refreshListingRentPerSquareMeter_(sheet);
  return {ready:true};
}

/** Keep existing entries in sync, also after manual rent/area corrections. */
function refreshListingRentPerSquareMeter_(sheet) {
  const last=sheet.getLastRow();
  if(last<2)return;
  const heads=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const target=heads.indexOf('Miete pro m²'),rent=heads.indexOf('Miete'),area=heads.indexOf('Fläche'),id=heads.indexOf('Datensatz-ID');
  if([target,rent,area,id].some(i=>i<0))throw new Error('Miete pro m²: Pflichtspalten fehlen');
  sheet.getRange(2,target+1,last-1,1).setNumberFormat('0.00" €/m²"');
  const rows=sheet.getRange(2,1,last-1,sheet.getLastColumn()).getValues();
  rows.forEach((values,i)=>{
    if(!values[id])return;
    const value=listingRentPerSquareMeter_(values[rent],values[area]);
    if(values[target]!==value)sheet.getRange(i+2,target+1).setValue(value);
  });
  syncListingUnitPriceColors_(sheet);
}

/**
 * Re-evaluate existing listings using saved fields and vision results only.
 * Does not call OpenAI. Version marker prevents repeated Sheet writes.
 */
function recalculateExistingListingScores_(ss,maxRows) {
  const sheet=ss.getSheetByName('Anzeigen');
  if(!sheet||sheet.getLastRow()<2)return {rescored:0};
  const head=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const ci=name=>head.indexOf(name);
  const names=['Datensatz-ID','Bildanalyse JSON','Wohnungsbewertung (0–100)',
    'Preisbewertung (0–100)','Bewertungsabdeckung (%)',
    'Terrasse Punkte','Pool Punkte','Bildbewertung Punkte','Distanz Punkte',
    'Miete','Fläche'];
  if(names.some(n=>ci(n)<0))throw new Error('Zwei Bewertungen: Spalten fehlen');
  const grid=sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues();
  let rescored=0;
  for(let i=0;i<grid.length;i++){
    if(rescored>=(maxRows||10))break;
    const values=grid[i],id=values[ci('Datensatz-ID')];
    if(!id)continue;
    const data=dedupParse_(values[ci('Bildanalyse JSON')]);
    if(data.scoring?.version===3)continue;
    // Existing facts and image reviews are reused; never request OpenAI.
    const facts=Object.assign({},data.extracted_fields||{});
    if((facts.rent_eur===null||facts.rent_eur===undefined||facts.rent_eur==='')&&
      values[ci('Miete')]!=='')facts.rent_eur=values[ci('Miete')];
    if((facts.area_m2===null||facts.area_m2===undefined||facts.area_m2==='')&&
      values[ci('Fläche')]!=='')facts.area_m2=values[ci('Fläche')];
    const score=calculateListingScore_(facts,data.image_review||{});
    const row=i+2;
    sheet.getRange(row,ci('Wohnungsbewertung (0–100)')+1,1,2).setValues([[
      score.homeScore===null?'':score.homeScore,
      score.priceScore===null?'':score.priceScore
    ]]);
    sheet.getRange(row,ci('Bewertungsabdeckung (%)')+1).setValue(score.coverage);
    sheet.getRange(row,ci('Terrasse Punkte')+1).setValue(score.terracePoints===null?'':score.terracePoints);
    sheet.getRange(row,ci('Pool Punkte')+1).setValue(score.poolPoints===null?'':score.poolPoints);
    sheet.getRange(row,ci('Bildbewertung Punkte')+1).setValue(score.imagePoints===null?'':score.imagePoints);
    sheet.getRange(row,ci('Distanz Punkte')+1).clearContent();
    data.scoring=Object.assign({},data.scoring||{},{
      version:3,home_score:score.homeScore,price_score:score.priceScore,
      rent_points:score.priceScore,distance_points:null,
      image_points:score.imagePoints,terrace_points:score.terracePoints,
      pool_points:score.poolPoints,total_points:null,coverage_percent:score.coverage,
      eur_per_m2:(Number(facts.area_m2)>0&&Number(facts.rent_eur)>0)
        ?Number(facts.rent_eur)/Number(facts.area_m2):null,
      provisional:score.coverage<100
    });
    sheet.getRange(row,ci('Bildanalyse JSON')+1).setValue(JSON.stringify(data));
    rescored++;
  }
  if(rescored)syncListingUnitPriceColors_(sheet);
  return {rescored};
}

