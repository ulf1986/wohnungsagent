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
    return { getValues:get, getValue:()=>get()[0][0], setValues:set, setValue:v=>set([[v]]), clearContent:()=>set([['']]) };
  }
}
const headers = ['Gesehen','Zu löschen','Punkte','E-Mail-Eingang','Vorschaubild','Titel','Fläche','Miete','Zusammenfassung',
  'Lage zu 29001','Entfernung zu 29001 km','Richtung von 29001','Bewertungsabdeckung (%)','Merkmale','Status','Portal','Anzeigenlink',
  'Anzeigendatum (Quelle)','Eingang (UTC)','Mietart / Laufzeit','Mietprüfung','Einschränkungen','Offene Angaben',
  'Terrasse Punkte','Pool Punkte','Bildbewertung Punkte','Distanz Punkte','Fläche Punkte','Gmail-Link','Datensatz-ID','Anzeigen-ID',
  'E-Mail-ID','KI-Bewertung','Bildanalyse JSON','Duplikatprüfung JSON','Suchfilter','Chat Nachricht','E-Mail Kontakt','WhatsApp Kontakt','Telefon Anruf'];

function setup({ blocked = false, images = true } = {}) {
  const calls = [], logs = [], props = new Map([['OPENAI_API_KEY','test-key'],['OPENAI_MODEL','test-model']]);
  const listing = new Sheet([headers, [false,false], [false,false]]);
  const blacklist = new Sheet([['Sperrliste Datensatz-ID'], ...(blocked ? [['idealista:123']] : [])]);
  let queue;
  const ss = { getSheetByName: name => ({ Anzeigen:listing, Verarbeitung:queue, Sperrliste:blacklist }[name]) };
  const ctx = vm.createContext({ console:{ log(){}, error(){}, warn(){} },
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)})},
    SpreadsheetApp:{openById:()=>ss,flush(){}},
    DriveApp:{getFileById:()=>({getSize:()=>5000})}
  });
  for(const name of ['Drive','Pisos','ImmoScout','Milanuncios','Diagnostics','GmailImport','Fotocasa','Idealista','Yaencontre','Main','AIProcessing'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script',name+'.js'),'utf8'),ctx);
  const qHeaders = vm.runInContext("['E-Mail-ID','Eingang','Verarbeitet','Status','Anzahl','IDs','Fehler',...MAIL_IMPORT.headers,...AI_PIPELINE.queueHeaders]",ctx);
  const row = qHeaders.map(()=>''), at = n=>qHeaders.indexOf(n);
  row[at('Queue Gmail-ID')]='mail-1'; row[at('Queue Eingang UTC')]='2026-10-15T12:00:00.000Z';
  row[at('Queue Betreff')]='Wohnung'; row[at('Queue Originaltext')]='Fakten aus der Mail';
  row[at('Queue Inseratslinks JSON')]=JSON.stringify(['https://www.idealista.com/inmueble/123/?tracking=a','https://www.idealista.com/inmueble/123/']);
  row[at('Queue Drive-Dateien JSON')]=JSON.stringify(images ? [{file_id:'photo-1',listing_id:'idealista:123',source_url:'https://img4.idealista.com/photo.jpg'}] : []);
  row[at('Queue Bildstatus')]='ready_for_ai';
  queue = new Sheet([qHeaders,row]);
  ctx.logImageDiagnostic=(stage,detail)=>logs.push({stage,...detail});
  ctx.callListingExtraction_=()=>{calls.push('email'); return {fields:{title:'Wohnung aus E-Mail',rent_eur:null,area_m2:70,rooms:null,
    long_term:null,student_only:null,seasonal_or_short_term:null,terrace:null,pool:null,amenities:[],restrictions:[]}, missing_fields:['rent_eur']};};
  ctx.fetchListingPageForProvider_=()=>{calls.push('page');return {status:'http_error',httpStatus:404,error:'HTTP 404'};};
  ctx.findDriveListingFiles_=()=>[];
  ctx.callImageReview_=()=>{calls.push('images');return {images:[{index:1,brightness:4,space:4,furniture_condition:4,care_renovation:4}],summary:'Helle Räume'};};
  const value = (sheet,col,row=1)=>sheet.rows[row]?.[sheet.rows[0].indexOf(col)];
  const setQueue = (col,v)=>queue.rows[1][at(col)]=v;
  return {ctx,listing,queue,blacklist,props,calls,logs,value,setQueue,ss};
}

test('ready mail becomes a row, survives offline page, completes photos and never creates duplicates',()=>{
  const x=setup();
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'email_extracted');
  assert.equal(x.value(x.listing,'Titel'),'Wohnung aus E-Mail');
  assert.equal(x.value(x.listing,'Eingang (UTC)'),'2026-10-15T12:00:00.000Z');
  assert.equal(x.value(x.listing,'Datensatz-ID'),'idealista:123');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'page_checked_http_error');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(x.value(x.listing,'KI-Bewertung'),'Abgeschlossen');
  assert.equal(x.value(x.listing,'Status'),'Vorläufig');
  assert.ok(!x.value(x.listing,'Merkmale').includes('null Zimmer'));
  assert.equal(x.value(x.listing,'Bewertungsabdeckung (%)'),20);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_ready_jobs');
  x.setQueue('KI Verarbeitungsstatus','pending'); x.setQueue('KI Abgeschlossene Anzeigen JSON','[]');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'completed');
  assert.equal(x.listing.rows.filter(r=>r[headers.indexOf('Datensatz-ID')]==='idealista:123').length,1);
  assert.deepEqual(x.calls,['email','page','images']);
});
test('no images can finalize facts without a missing image_review crash',()=>{
  const x=setup({images:false});
  x.ctx.processNextAiListing(x.ss); x.ctx.processNextAiListing(x.ss);
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'no_images');
  assert.equal(x.value(x.listing,'KI-Bewertung'),'Keine Fotos');
  assert.equal(x.value(x.listing,'Status'),'Vorläufig');
});
test('blacklist prevents row creation and all AI calls',()=>{
  const x=setup({blocked:true});
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'blocked');
  assert.equal(x.value(x.listing,'Datensatz-ID'),undefined);
  assert.deepEqual(x.calls,[]);
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
test('missing key and conflicting target are explicit failures before importing',()=>{
  const x=setup();x.props.delete('OPENAI_API_KEY');
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'retry');
  assert.match(x.value(x.queue,'KI Fehler'),/OPENAI_API_KEY/);
  assert.equal(x.value(x.listing,'Datensatz-ID'),undefined);
  x.props.set('WOHNUNGSAGENT_SPREADSHEET_ID','old-sheet');
  assert.throws(()=>x.ctx.processNextAiListing(x.ss),/weicht von CONFIG/);
});
test('page enrichment cannot replace facts already extracted from email',()=>{
  const x=setup();x.ctx.processNextAiListing(x.ss);
  x.ctx.fetchListingPageForProvider_=()=>({status:'ok',httpStatus:200,text:'Portal'});
  x.ctx.callListingExtraction_=()=>({fields:{title:'Abweichender Portaltitel',rent_eur:1000},missing_fields:[]});
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

test('multi-listing ready flag is not enough to authorize AI processing',()=>{
  const x=setup();x.setQueue('Queue Inseratslinks JSON',JSON.stringify([
    'https://www.idealista.com/inmueble/123/','https://www.idealista.com/inmueble/456/']));
  assert.equal(x.ctx.processNextAiListing(x.ss).reason,'ambiguous_listing');
  assert.deepEqual(x.calls,[]);
  assert.equal(x.value(x.listing,'Datensatz-ID'),undefined);
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
