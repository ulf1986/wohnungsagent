const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

class Sheet {
  constructor(rows) { this.rows = rows; this.max = rows[0].length; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.max; }
  getMaxColumns() { return this.max; }
  insertColumnsAfter(_, n) { this.max += n; }
  getRange(r,c,n=1,m=1) {
    const get = () => Array.from({length:n}, (_,i) => Array.from({length:m}, (_,j) => this.rows[r+i-1]?.[c+j-1] ?? ''));
    const set = values => { values.forEach((row,i) => { this.rows[r+i-1] ||= []; row.forEach((v,j) => this.rows[r+i-1][c+j-1] = v); }); };
    return { getValues:get, getValue:()=>get()[0][0], setValues:set, setValue:v=>set([[v]]), clearContent:()=>set(Array.from({length:n},()=>Array(m).fill(''))) };
  }
}
const headers = ['Zu löschen','Wohnungsbewertung (0–100)','Preisbewertung (0–100)','E-Mail-Eingang','Vorschaubild','Titel','Fläche','Miete','Zusammenfassung',
  'Lage zu 29001','Entfernung zu 29001 km','Richtung von 29001','Bewertungsabdeckung (%)','Merkmale','Status','Portal','Anzeigenlink',
  'Anzeigendatum (Quelle)','Eingang (UTC)','Mietart / Laufzeit','Mietprüfung','Einschränkungen','Offene Angaben',
  'Terrasse Punkte','Pool Punkte','Bildbewertung Punkte','Distanz Punkte','Fläche Punkte','Gmail-Link','Datensatz-ID','Anzeigen-ID',
  'E-Mail-ID','KI-Bewertung','Bildanalyse JSON','Duplikatprüfung JSON','Suchfilter','Chat Nachricht','E-Mail Kontakt','WhatsApp Kontakt','Telefon Anruf'];

function setup({ blocked = false, images = true, fileCount = 1 } = {}) {
  const calls = [], logs = [], props = new Map([['OPENAI_API_KEY','test-key'],['OPENAI_MODEL','test-model']]);
  const listing = new Sheet([headers, [false], [false]]);
  const blacklist = new Sheet([['Sperrliste Datensatz-ID'], ...(blocked ? [['idealista:123']] : [])]);
  let queue;
  const ss = { getSheetByName: name => ({ Anzeigen:listing, Verarbeitung:queue, Sperrliste:blacklist }[name]) };
  const ctx = vm.createContext({ console:{ log(){}, error(){}, warn(){} },
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)})},
    SpreadsheetApp:{openById:()=>ss,flush(){}},
    DriveApp:{getFileById:id=>({getSize:()=>5000,getBlob:()=>({getBytes:()=>new Array(5000).fill(Number(id.split('-').pop()) || 1),getContentType:()=> 'image/jpeg'})})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,bytes)=>Array.from(require('node:crypto').createHash('sha256').update(Buffer.from(bytes)).digest())}
  });
  for(const name of ['Drive','Pisos','ImmoScout','Milanuncios','Diagnostics','GmailImport','Fotocasa','Idealista','Yaencontre','Main','AiInput','AIProcessing'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script',name+'.js'),'utf8'),ctx);
  const qHeaders = vm.runInContext("['E-Mail-ID','Eingang','Verarbeitet','Status','Anzahl','IDs','Fehler',...MAIL_IMPORT.headers,...AI_PIPELINE.queueHeaders]",ctx);
  const row = qHeaders.map(()=>''), at = n=>qHeaders.indexOf(n);
  row[at('Queue Gmail-ID')]='mail-1'; row[at('Queue Eingang UTC')]=new Date().toISOString();
  row[at('Queue Betreff')]='Wohnung'; row[at('Queue Originaltext')]='Fakten aus der Mail';
  row[at('Queue Inseratslinks JSON')]=JSON.stringify(['https://www.idealista.com/inmueble/123/?tracking=a','https://www.idealista.com/inmueble/123/']);
  row[at('Queue Drive-Dateien JSON')]=JSON.stringify(images ? Array.from({length:fileCount},(_,i)=>({file_id:'photo-'+(i+1),listing_id:'idealista:123',source_url:'https://img4.idealista.com/photo'+(i+1)+'.jpg'})) : []);
  row[at('Queue Bildstatus')]='ready_for_ai';
  queue = new Sheet([qHeaders,row]);
  ctx.logImageDiagnostic=(stage,detail)=>logs.push({stage,...detail});
  ctx.checkDuplicateBeforeAi_=()=>({status:'primary'}); // separate duplicate regression tests cover real implementation
  ctx.callListingExtraction_=()=>{calls.push('email'); return {provenance_version:1,fields:{title:'Wohnung aus E-Mail',rent_eur:null,area_m2:70,rooms:null,
    long_term:null,student_only:null,seasonal_or_short_term:null,terrace:null,pool:null,amenities:[],restrictions:[]}, missing_fields:['rent_eur']};};
  const providerPageFetcher=ctx.fetchListingPageForProvider_;
  ctx.fetchListingPageForProvider_=()=>{calls.push('page');return {status:'http_error',httpStatus:404,error:'HTTP 404'};};
  ctx.findDriveListingFiles_=()=>[];
  ctx.callImageReview_=(_,batch)=>{calls.push('images');return {images:batch.map((_,i)=>({index:i+1,brightness:4,space:4,furniture_condition:4,care_renovation:4})),summary:'Helle Räume'};};
  const value = (sheet,col,row=1)=>sheet.rows[row]?.[sheet.rows[0].indexOf(col)];
  const setQueue = (col,v)=>queue.rows[1][at(col)]=v;
  return {ctx,listing,queue,blacklist,props,calls,logs,value,setQueue,ss,providerPageFetcher};
}

test('Yaencontre digest keeps the title, price, size and rooms after repeated listing links',()=>{
  const x=setup();
  const url=id=>'https://www.yaencontre.com/alquiler/piso/inmueble-53076-'+id;
  const body=[
    '<'+url(112880475)+'?utm_content=cont-principal-link-media-1>',
    '<'+url(112880475)+'?utm_content=thumbnail-1>',
    'Piso en alquiler en La Goleta',
    '<'+url(112880475)+'?utm_content=cont-principal-link-inmueble-1>',
    '950 €/mes',
    '2 hab. | 1 baños | 83 m²',
    '<'+url(112880475)+'?utm_content=cont-principal-cta-principal-1>',
    '<'+url(112877530)+'?utm_content=cont-principal-link-media-2>',
    'Apartamento en otra zona',
    '<'+url(112877530)+'?utm_content=cont-principal-link-inmueble-2>',
    '1.150 €/mes',
    '3 hab. | 91 m²'
  ].join('\n\n');
  const first=x.ctx.extractListingMailExcerpt_(body,'yaencontre:112880475');
  assert.match(first,/950 €\/mes/);
  assert.match(first,/83 m²/);
  assert.match(first,/2 hab/);
  assert.match(first,/La Goleta/);
  assert.doesNotMatch(first,/1.150|91 m²|otra zona/);
  const second=x.ctx.extractListingMailExcerpt_(body,'yaencontre:112877530');
  assert.match(second,/1.150/);
  assert.doesNotMatch(second,/950/);
});

test('ready mail becomes a row, survives offline page, completes photos and never creates duplicates',()=>{
  const x=setup();
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(x.value(x.listing,'Titel'),'Wohnung aus E-Mail');
  assert.equal(x.value(x.listing,'Eingang (UTC)'),x.value(x.queue,'Queue Eingang UTC'));
  assert.equal(x.value(x.listing,'Datensatz-ID'),'idealista:123');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(x.value(x.listing,'KI-Bewertung'),'Abgeschlossen');
  assert.equal(x.value(x.listing,'Status'),'Verfügbarkeit ungeklärt');
  assert.ok(!x.value(x.listing,'Merkmale').includes('null Zimmer'));
  assert.equal(x.value(x.listing,'Bewertungsabdeckung (%)'),85);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_ready_jobs');
  x.setQueue('KI Verarbeitungsstatus','pending'); x.setQueue('KI Abgeschlossene Anzeigen JSON','[]');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(x.listing.rows.filter(r=>r[headers.indexOf('Datensatz-ID')]==='idealista:123').length,1);
  assert.deepEqual(x.calls,['page','email','images']);
});

test('worker preflight preserves queue and makes no portal or AI request',()=>{
  const x=setup();const before=JSON.stringify(x.queue.rows);
  assert.equal(x.ctx.processNextAiListing(x.ss, x.queue, {peek:true}).status,'ready');
  assert.deepEqual(x.calls,[]);
  assert.equal(JSON.stringify(x.queue.rows),before);
  assert.equal(x.value(x.listing,'Datensatz-ID'),undefined);
});

test('worker drains real text and ten-image checkpoints with no repeated API calls',()=>{
  const x=setup({fileCount:10});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/AiWorker.js'),'utf8'),x.ctx);
  x.ctx.waMonitorAi_=()=>{};x.ctx.imageDiagnosticRun=null;
  const result=x.ctx.drainAiQueue_(x.ss,x.queue);
  assert.equal(result.steps,3);
  assert.equal(x.value(x.queue,'KI Verarbeitungsstatus'),'completed');
  assert.deepEqual(x.calls,['page','email','images','images']);
  assert.equal(x.ctx.drainAiQueue_(x.ss,x.queue).steps,0);
  assert.deepEqual(x.calls,['page','email','images','images']);
});

test('worker does not immediately repeat a definite rate-limited extraction',()=>{
  const x=setup();
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/AiWorker.js'),'utf8'),x.ctx);
  x.ctx.waMonitorAi_=()=>{};x.ctx.imageDiagnosticRun=null;
  let requests=0;
  x.ctx.callListingExtraction_=()=>{requests++;throw Error('OpenAI HTTP 429');};
  x.ctx.drainAiQueue_(x.ss,x.queue);
  assert.equal(requests,1);
  assert.equal(x.value(x.queue,'KI Verarbeitungsstatus'),'retry');
  assert.ok(Date.parse(x.value(x.queue,'KI Wiederholung ab UTC'))>Date.now());
});
test('no images can finalize facts without a missing image_review crash',()=>{
  const x=setup({images:false});
  x.ctx.processNextAiListing(x.ss);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_images');
  assert.equal(x.value(x.listing,'KI-Bewertung'),'Keine Fotos');
  assert.equal(x.value(x.listing,'Status'),'Verfügbarkeit ungeklärt');
});
test('blacklist prevents row creation and all AI calls',()=>{
  const x=setup({blocked:true});
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'blocked');
  assert.equal(x.value(x.listing,'Datensatz-ID'),undefined);
  assert.deepEqual(x.calls,[]);
});

test('new listing defers delivery to Telegram even with verified rent and area',()=>{
  const x=setup(), mails=[];
  x.ctx.callListingExtraction_=()=>{x.calls.push('email');return {provenance_version:1,fields:{
    title:'Wohnung',rent_eur:1000,area_m2:70,rooms:2,long_term:null,
    seasonal_or_short_term:null,student_only:null,terrace:null,pool:null,amenities:[],restrictions:[]
  },missing_fields:[]};};
  x.ctx.MailApp={sendEmail:mail=>mails.push(mail)};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(mails.length,0);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(mails.length,0);
  const data=JSON.parse(x.value(x.listing,'Bildanalyse JSON'));
  assert.equal(data.notification_state,undefined);
});

test('unknown rent does not generate premature mail, even after extraction fails',()=>{
  const x=setup(),mails=[];x.ctx.MailApp={sendEmail:mail=>mails.push(mail)};
  x.ctx.callListingExtraction_=()=>{throw Error('429');};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'needs_review');
  assert.equal(mails.length,0);
});

test('unverified rent is retained for review but does not produce a notification',()=>{
  const x=setup(),mails=[];x.ctx.MailApp={sendEmail:mail=>mails.push(mail)};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(mails.length,0);
});

test('legacy GMX mail transport is never called during extraction or image processing',()=>{
  const x=setup();let attempts=0;
  x.ctx.callListingExtraction_=()=>{x.calls.push('email');return {provenance_version:1,fields:{
    title:'Wohnung',rent_eur:1100,area_m2:75,rooms:2,long_term:true,
    seasonal_or_short_term:false,student_only:false,terrace:null,pool:null,amenities:[],restrictions:[]
  },missing_fields:[]};};
  x.ctx.MailApp={sendEmail:()=>{attempts++;throw Error('Missing script.send_mail permission');}};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  const data=JSON.parse(x.value(x.listing,'Bildanalyse JSON'));
  assert.equal(attempts,0);assert.equal(data.notification_state,undefined);
  assert.equal(data.notification_error,undefined);assert.deepEqual(x.calls,['page','email','images']);
});

test('blacklisted, duplicate and confirmed unavailable listings do not send new-entry notifications',()=>{
  for(const mode of ['blacklist','duplicate','unavailable']){
    const x=setup({blocked:mode==='blacklist'});let sent=0;x.ctx.MailApp={sendEmail:()=>sent++};
    if(mode==='duplicate')x.ctx.checkDuplicateBeforeAi_=()=>({status:'duplicate',canonical:'fotocasa:999'});
    if(mode==='unavailable')x.ctx.fetchListingPageForProvider_=()=>({status:'unavailable',httpStatus:410,error:'HTTP 410'});
    x.ctx.processNextAiListing(x.ss);assert.equal(sent,0);
  }
});

test('existing pre-deploy rows are not retrospectively notified on completion',()=>{
  const x=setup();x.ctx.processNextAiListing(x.ss);
  const data=JSON.parse(x.value(x.listing,'Bildanalyse JSON'));
  delete data.notification_state;delete data.notification_phase;
  x.listing.rows[1][headers.indexOf('Bildanalyse JSON')]=JSON.stringify(data);
  let sent=0;x.ctx.MailApp={sendEmail:()=>sent++};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');assert.equal(sent,0);
});

test('new listing fetches page before one combined extraction and proceeds directly to images',()=>{
  const x=setup();let textCalls=0;
  x.ctx.fetchListingPageForProvider_=()=>({status:'ok',httpStatus:200,text:'Seitenangaben'});
  x.ctx.callListingExtraction_=(_,source,subject,body,url,page)=>{
    textCalls++;assert.equal(source,'email_and_page');assert.equal(body,'Fakten aus der Mail');
    assert.equal(page,'Seitenangaben');return {provenance_version:1,fields:{title:'Kombiniert',rent_eur:1100},missing_fields:[]};
  };
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(textCalls,1);
  assert.equal(x.value(x.listing,'Miete'),1100);
});
test('page fetch exception still permits combined extraction from mail',()=>{
  const x=setup();x.ctx.fetchListingPageForProvider_=()=>{throw new Error('offline');};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(JSON.parse(x.value(x.listing,'Bildanalyse JSON')).ai_pipeline.page_status,'fetch_error');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
});

test('deleted new listing is blacklisted before any row or AI call',()=>{
  const x=setup();x.ctx.fetchListingPageForProvider_=()=>({status:'unavailable',httpStatus:404,error:'HTTP 404'});
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'unavailable');
  assert.equal(x.value(x.listing,'Datensatz-ID'),undefined);
  assert.equal(x.value(x.queue,'KI Verarbeitungsstatus'),'completed');
  assert.equal(x.value(x.blacklist,'Sperrliste Datensatz-ID'),'idealista:123');
  assert.deepEqual(x.calls,[]);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_ready_jobs');
});

test('existing unavailable row is cleared only after confirmed blacklist write',()=>{
  const x=setup();x.ctx.processNextAiListing(x.ss);
  const data=JSON.parse(x.value(x.listing,'Bildanalyse JSON'));
  data.ai_pipeline.page_check={status:'unavailable',reason:'Anuncio no disponible'};
  x.listing.rows[1][headers.indexOf('Bildanalyse JSON')]=JSON.stringify(data);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'unavailable');
  assert.equal(x.value(x.listing,'Datensatz-ID'),'');
  assert.equal(x.value(x.listing,'Zu löschen'),false);
  assert.equal(x.value(x.blacklist,'Sperrliste Datensatz-ID'),'idealista:123');
  assert.equal(x.blacklist.rows.length,2);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_ready_jobs');
});
test('failed blacklist write retains existing listing and queues a retry',()=>{
  const x=setup();x.ctx.processNextAiListing(x.ss);
  const data=JSON.parse(x.value(x.listing,'Bildanalyse JSON'));
  data.ai_pipeline.page_check={status:'unavailable',reason:'HTTP 404'};
  x.listing.rows[1][headers.indexOf('Bildanalyse JSON')]=JSON.stringify(data);
  const range=x.blacklist.getRange.bind(x.blacklist);
  x.blacklist.getRange=(...args)=>({...range(...args),setValues(){throw new Error('write failed');}});
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'retry');
  assert.equal(x.value(x.listing,'Datensatz-ID'),'idealista:123');
});
test('confirmed page supplements mail and remains separated in stored result',()=>{
  const x=setup();
  x.ctx.fetchListingPageForProvider_=()=>({status:'ok',identity_id:'idealista:123',text:'ID 123'});
  x.ctx.callListingExtraction_=()=>({provenance_version:1,fields:{title:'Wohnung',rent_eur:950},page_fields:{rent_eur:900,area_m2:60,terrace:true},missing_fields:['area_m2'],page_check:{status:'matched',matched_listing_id:'idealista:123',reason:'Bestätigt'}});
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(x.value(x.listing,'Miete'),950);assert.equal(x.value(x.listing,'Fläche'),60);
  const data=JSON.parse(x.value(x.listing,'Bildanalyse JSON'));
  assert.equal(data.ai_pipeline.email_fields.area_m2,undefined);assert.equal(data.ai_pipeline.page_fields.area_m2,60);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(x.value(x.listing,'Terrasse Punkte'),10);
  assert.ok(!x.value(x.listing,'Offene Angaben').includes('Wohnfläche fehlt'));
});

test('unmatched page and mislabeled page quotes cannot populate sheet facts',()=>{
  for(const identity of ['idealista:999','idealista:123']) {
    const x=setup();
    x.ctx.fetchListingPageForProvider_=()=>({status:'ok',identity_id:identity,text:'1200 Euro. Terraza privada. 90 metros'});
    x.ctx.callListingExtraction_=()=>x.ctx.normalizeListingFacts_({fields:{
      rent_eur:[{value:950,source:'email',quote:'950 Euro'},{value:1200,source:'listing_page',quote:'1200 Euro'}],
      area_m2:[{value:90,source:'email',quote:'90 metros'}],
      terrace:[{value:true,source:'listing_page',quote:'Terraza privada'}]
    },page_check:{status:identity==='idealista:999'?'matched':'unclear',matched_listing_id:identity,reason:'Test'},missing_fields:[]},
    'email_and_page',{email:'950 Euro',listing_page:'1200 Euro. Terraza privada. 90 metros'},
    {rent_eur:{type:['number','null']},area_m2:{type:['number','null']},terrace:{type:['boolean','null']}});
    assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
    assert.equal(x.value(x.listing,'Miete'),950);assert.equal(x.value(x.listing,'Fläche'),'');
    const data=JSON.parse(x.value(x.listing,'Bildanalyse JSON'));
    assert.equal(data.ai_pipeline.page_fields.terrace,undefined);
    assert.equal(data.ai_pipeline.email_fields.area_m2,null);
    assert.equal(data.ai_pipeline.provenance_version,1);
    assert.equal(data.ai_pipeline.rejected_facts[0].field,'area_m2');
    assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
    assert.equal(x.value(x.listing,'Terrasse Punkte'),'');
  }
});
test('API error persists retry and repetition reuses existing row',()=>{
  const x=setup();x.ctx.callListingExtraction_=()=>{throw new Error('OpenAI HTTP 429');};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'retry');
  assert.equal(x.value(x.queue,'KI Verarbeitungsstatus'),'retry');
  assert.match(x.value(x.queue,'KI Fehler'),/429/);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_ready_jobs');
  x.setQueue('KI Wiederholung ab UTC','');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'retry');
  assert.equal(x.listing.rows.filter(r=>r[headers.indexOf('Datensatz-ID')]==='idealista:123').length,1);
});
test('missing AI key still permits the new-entry alert; conflicting target is rejected',()=>{
  const x=setup();x.props.delete('OPENAI_API_KEY');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'retry');
  assert.match(x.value(x.queue,'KI Fehler'),/OPENAI_API_KEY/);
  assert.equal(x.value(x.listing,'Datensatz-ID'),'idealista:123');
  x.props.set('WOHNUNGSAGENT_SPREADSHEET_ID','old-sheet');
  assert.throws(()=>x.ctx.processNextAiListing(x.ss),/weicht von CONFIG/);
});
test('page enrichment cannot replace facts already extracted from email',()=>{
  const x=setup();x.ctx.processNextAiListing(x.ss);
  const data=JSON.parse(x.value(x.listing,'Bildanalyse JSON'));
  data.ai_pipeline.page_checked=false;
  x.listing.rows[1][headers.indexOf('Bildanalyse JSON')]=JSON.stringify(data);
  x.ctx.fetchListingPageForProvider_=()=>({status:'ok',httpStatus:200,text:'Portal',identity_id:'idealista:123'});
  x.ctx.callListingExtraction_=()=>({provenance_version:1,fields:{title:'Abweichender Portaltitel',rent_eur:1000},missing_fields:[],page_check:{status:'matched',matched_listing_id:'idealista:123',reason:'ID bestätigt'}});
  x.ctx.processNextAiListing(x.ss);
  assert.equal(x.value(x.listing,'Titel'),'Wohnung aus E-Mail');
  assert.equal(x.value(x.listing,'Miete'),1000);
});
test('identity matching uses canonical listing ID in tracking variants and rejects conflicting rows',()=>{
  const x=setup(),cols=x.ctx.getListingColumns_(x.listing);
  x.listing.rows[1][headers.indexOf('Anzeigenlink')]='https://www.idealista.com/inmueble/123/?utm=old';
  assert.equal(x.ctx.findListingRow_(x.listing,cols,'idealista:123'),2);
  x.listing.rows[1][headers.indexOf('Datensatz-ID')]='idealista:999';
  assert.throws(()=>x.ctx.findListingRow_(x.listing,cols,'idealista:123'),/Widersprüchliche/);
});

test('multi-listing mail requires a listing-specific source when its page is offline',()=>{
  const x=setup();x.setQueue('Queue Inseratslinks JSON',JSON.stringify([
    'https://www.idealista.com/inmueble/123/','https://www.idealista.com/inmueble/456/']));
  const result=x.ctx.processNextAiListing(x.ss);
  assert.equal(result.reason,'missing_listing_source');
  assert.deepEqual(x.calls,['page']);
  assert.equal(x.value(x.listing,'Datensatz-ID'),undefined);
});

test('multi-listing mail processes each separately using confirmed page text',()=>{
  const x=setup();
  x.setQueue('Queue Inseratslinks JSON',JSON.stringify([
    'https://www.idealista.com/inmueble/123/','https://www.idealista.com/inmueble/456/']));
  x.ctx.fetchListingPageForProvider_=url=>{x.calls.push('page');return {
    status:'ok', text:'Immobilienseite für '+url, identity_id:x.ctx.getMailListingId(url)
  };};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(x.value(x.listing,'Datensatz-ID'),'idealista:123');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(x.value(x.queue,'KI Abgeschlossene Anzeigen JSON'),'["idealista:123"]');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(x.listing.rows.filter(r=>r[headers.indexOf('Datensatz-ID')]==='idealista:456').length,1);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_images');
  assert.equal(x.value(x.queue,'KI Verarbeitungsstatus'),'completed');
});

test('48-hour queue age is enforced before API requests and duplicates',()=>{
  const x=setup();
  x.setQueue('Queue Eingang UTC',new Date(Date.now()-49*3600000).toISOString());
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_ready_jobs');
  assert.deepEqual(x.calls,[]);
  assert.equal(x.value(x.listing,'Datensatz-ID'),undefined);
});

test('20 images stop after first ten across batches, another mail and subsequent retries',()=>{
  const x=setup({fileCount:20}), sent=[];
  const review=x.ctx.callImageReview_;
  x.ctx.callImageReview_=(config,batch,prior)=>{sent.push(...Array.from(batch,f=>f.file_id));return review(config,batch,prior);};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'processing');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.deepEqual(sent,Array.from({length:10},(_,i)=>'photo-'+(i+1)));
  assert.match(x.value(x.listing,'Zusammenfassung'),/ersten 10/);
  assert.ok(!x.value(x.listing,'Offene Angaben').includes('Bildanalyse unvollständig'));
  x.setQueue('Queue Gmail-ID','mail-2');
  x.setQueue('Queue Drive-Dateien JSON',JSON.stringify([{file_id:'photo-21',listing_id:'idealista:123'}]));
  x.setQueue('KI Verarbeitungsstatus','pending');x.setQueue('KI Abgeschlossene Anzeigen JSON','[]');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(sent.length,10);
});

test('image failure preserves selection, retry does not replace ten images with new arrivals',()=>{
  const x=setup({fileCount:15});
  x.ctx.processNextAiListing(x.ss);
  const review=x.ctx.callImageReview_;x.ctx.callImageReview_=()=>{throw new Error('API HTTP 429');};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'retry');
  const before=JSON.parse(x.value(x.listing,'Bildanalyse JSON')).ai_pipeline.image_selection.map(f=>f.file_id);
  assert.equal(before.length,10);
  x.setQueue('KI Wiederholung ab UTC','');x.ctx.callImageReview_=review;
  x.ctx.processNextAiListing(x.ss);x.ctx.processNextAiListing(x.ss);
  const after=JSON.parse(x.value(x.listing,'Bildanalyse JSON')).ai_pipeline.image_selection.map(f=>f.file_id);
  assert.deepEqual(before,after);
});
test('portal spoof host and corrupted existing JSON fail safely',()=>{
  const x=setup();
  delete x.ctx.fetchListingPageForProvider_;
  // Geladene Originalfunktion aus dem Modul in einem eigenen Kontext prüfen.
  const raw = vm.createContext({getMailListingId:()=> 'idealista:123'});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/AIProcessing.js'),'utf8'),raw);
  assert.equal(raw.fetchListingPageForProvider_('https://idealista.com.evil.test/inmueble/123/').status,'blocked');
  assert.throws(()=>raw.parseAiListingJson_('invalid-json'));
  assert.throws(()=>raw.parseAiListingJson_('[]'));
});

const portalCases=[
  ['idealista','https://www.idealista.com/inmueble/123/'],
  ['fotocasa','https://www.fotocasa.es/es/alquiler/vivienda/malaga/ascensor/123/d'],
  ['pisos','https://www.pisos.com/alquilar/piso-malaga-123_456/'],
  ['yaencontre','https://www.yaencontre.com/alquiler/piso/inmueble-456-123'],
  ['immoscout','https://www.immobilienscout24.de/expose/171726535'],
  ['milanuncios','https://www.milanuncios.com/ads/malaga-capital-619803957.htm']
];
function portalSetup(provider,url) {
  const x=setup(),id=x.ctx.getMailListingId(url);
  assert.ok(id && id.startsWith(provider+':'),'Portal-Parser muss eine stabile ID liefern: '+provider);
  x.setQueue('Queue Inseratslinks JSON',JSON.stringify([url]));
  x.setQueue('Queue Drive-Dateien JSON',JSON.stringify([{file_id:'photo-1',listing_id:id,source_url:'https://images.example.test/photo.jpg'}]));
  return {...x,id};
}
for(const [provider,url] of portalCases) {
  test(provider+': real domain and ID routing accepts a matching canonical listing page',()=>{
    const x=portalSetup(provider,url);let fetched=0;
    x.ctx.UrlFetchApp={fetch:(u,options)=>{
      fetched++;assert.equal(u,url);assert.equal(options.followRedirects,false);
      return {getResponseCode:()=>200,getContentText:()=>'<link rel="canonical" href="'+url+'"><h1>Wohnung</h1><main>Objektdaten</main>'};
    }};
    const page=x.providerPageFetcher(url);
    assert.equal(page.status,'ok');assert.equal(page.identity_id,x.id);assert.equal(fetched,1);
  });
  test(provider+': same source validation, text stage and original-image stage',()=>{
    const x=portalSetup(provider,url);let texts=0,fetches=0;
    x.ctx.fetchListingPageForProvider_=u=>{fetches++;assert.equal(u,url);return {status:'ok',identity_id:x.id,text:'Terraza privada'};};
    x.ctx.callListingExtraction_=(_,source)=>{
      texts++;assert.equal(source,'email_and_page');
      return x.ctx.normalizeListingFacts_({fields:{
        rent_eur:[{value:950,source:'email',quote:'950 Euro'}],
        terrace:[{value:true,source:'listing_page',quote:'Terraza privada'}]
      },page_check:{status:'matched',matched_listing_id:x.id,reason:'Bestätigte Identität'},missing_fields:[]},
      source,{email:'950 Euro',listing_page:'Terraza privada'},
      {rent_eur:{type:['number','null']},terrace:{type:['boolean','null']}});
    };
    assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
    assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
    assert.equal(x.value(x.listing,'Datensatz-ID'),x.id);
    assert.equal(x.value(x.listing,'Portal'),provider);
    assert.equal(x.value(x.listing,'Miete'),950);assert.equal(x.value(x.listing,'Terrasse Punkte'),10);
    assert.equal(texts,1);assert.equal(fetches,1);assert.ok(x.calls.includes('images'));
    assert.equal(JSON.parse(x.value(x.listing,'Bildanalyse JSON')).analyzed_file_ids.length,1);
  });
  test(provider+': unclear page cannot contribute facts',()=>{
    const x=portalSetup(provider,url);
    x.ctx.fetchListingPageForProvider_=()=>({status:'ok',identity_id:x.id,text:'Terraza privada'});
    x.ctx.callListingExtraction_=()=>x.ctx.normalizeListingFacts_({fields:{
      terrace:[{value:true,source:'listing_page',quote:'Terraza privada'}]
    },page_check:{status:'unclear',matched_listing_id:null,reason:'Zuordnung unklar'},missing_fields:[]},
    'email_and_page',{email:'Wohnung',listing_page:'Terraza privada'},{terrace:{type:['boolean','null']}});
    x.ctx.processNextAiListing(x.ss);x.ctx.processNextAiListing(x.ss);
    assert.equal(x.value(x.listing,'Terrasse Punkte'),'');
    assert.equal(x.value(x.listing,'Status'),'Verfügbarkeit ungeklärt');
  });
  test(provider+': unavailable page is blacklisted without AI or listing row',()=>{
    const x=portalSetup(provider,url);
    x.ctx.fetchListingPageForProvider_=()=>({status:'unavailable',httpStatus:404,error:'HTTP 404'});
    assert.equal(x.ctx.processNextAiListing(x.ss).status,'unavailable');
    assert.equal(x.value(x.blacklist,'Sperrliste Datensatz-ID'),x.id);
    assert.equal(x.value(x.listing,'Datensatz-ID'),undefined);
    assert.deepEqual(x.calls,[]);
  });
}

test('uncertain text API outcome stops automated duplicate requests',()=>{
  const x=setup();let requests=0;
  x.ctx.callListingExtraction_=()=>{requests++;throw new Error('socket closed without response');};
  const result=x.ctx.processNextAiListing(x.ss);
  assert.equal(result.status,'needs_review');
  assert.equal(x.value(x.queue,'KI Verarbeitungsstatus'),'needs_review');
  assert.match(x.value(x.queue,'KI Fehler'),/ungeklärt/);
  const stored=JSON.parse(x.value(x.listing,'Bildanalyse JSON'));
  assert.equal(stored.ai_pipeline.api_operation.status,'started');
  assert.equal(stored.ai_pipeline.api_operation.kind,'email_and_page');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_ready_jobs');
  assert.equal(requests,1);
  assert.match(x.value(x.queue,'KI Arbeitsschritt'),/needs_review/);
  assert.equal(x.value(x.queue,'KI Ergebnis gespeichert UTC'),'');
});

test('uncertain image API result retains extracted facts and selected batch',()=>{
  const x=setup();
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  x.ctx.callImageReview_=()=>{throw new Error('network timed out after dispatch');};
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'needs_review');
  const stored=JSON.parse(x.value(x.listing,'Bildanalyse JSON'));
  assert.ok(stored.ai_pipeline.email_fields);
  assert.equal(stored.ai_pipeline.api_operation.kind,'image_review');
  assert.deepEqual(Array.from(stored.ai_pipeline.api_operation.file_ids),['photo-1']);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_ready_jobs');
});

test('orphaned processing state is recovered under the exclusive lock using saved facts',()=>{
  const x=setup();
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  x.setQueue('KI Verarbeitungsstatus','processing');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(x.calls.filter(step=>step==='email').length,1);
  assert.equal(x.value(x.queue,'KI Verarbeitungsstatus'),'completed');
  assert.ok(x.value(x.queue,'KI Lauf-ID'));
  assert.ok(x.value(x.queue,'KI Ergebnis gespeichert UTC'));
});


