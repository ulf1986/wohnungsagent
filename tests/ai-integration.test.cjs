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
  row[at('Queue Gmail-ID')]='mail-1'; row[at('Queue Eingang UTC')]='2026-10-15T12:00:00.000Z';
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

test('ready mail becomes a row, survives offline page, completes photos and never creates duplicates',()=>{
  const x=setup();
  assert.equal(x.ctx.processNextAiListing(x.ss).status,'text_extracted');
  assert.equal(x.value(x.listing,'Titel'),'Wohnung aus E-Mail');
  assert.equal(x.value(x.listing,'Eingang (UTC)'),'2026-10-15T12:00:00.000Z');
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

test('multi-listing ready flag is not enough to authorize AI processing',()=>{
  const x=setup();x.setQueue('Queue Inseratslinks JSON',JSON.stringify([
    'https://www.idealista.com/inmueble/123/','https://www.idealista.com/inmueble/456/']));
  assert.equal(x.ctx.processNextAiListing(x.ss).reason,'ambiguous_listing');
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
