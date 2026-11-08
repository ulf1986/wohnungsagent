const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {test}=require('node:test');

function setup(){
  const files=new Map(),requests=[],logs=[];
  const ctx=vm.createContext({console,
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,bytes)=>Array.from(crypto.createHash('sha256').update(Buffer.from(bytes)).digest()),
      base64Encode:bytes=>Buffer.from(bytes).toString('base64')},
    DriveApp:{getFileById:id=>{const f=files.get(id);if(!f)throw new Error('missing file');return {
      getBlob:()=>({getBytes:()=>f.bytes,getContentType:()=>f.mime}),getSize:()=>f.bytes.length};}},
    logImageDiagnostic:(stage,detail)=>logs.push({stage,...detail})
  });
  for(const name of ['AiInput','AIProcessing'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script',name+'.js'),'utf8'),ctx);
  ctx.openAiRequest_=(_,request)=>{requests.push(request);return {status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"fields":{},"missing_fields":[]}'}]}]};};
  function photo(id,seed=1){files.set(id,{mime:'image/jpeg',bytes:[255,216,255,...Array(2500).fill(seed)]});return {file_id:id,name:id+'.jpg'};}
  return {ctx,files,requests,logs,photo};
}

test('page metadata contributes labelled price and floor size without requiring JavaScript',()=>{
  const x=setup();
  const html='<html><head><meta itemprop="price" content="950"/>'+
    '<meta itemprop="floorSize" content="72 m²"/></head><body></body></html>';
  const previous=x.ctx.AI_PIPELINE; // constant is global lexical, not a ctx property
  vm.runInContext('AI_PIPELINE.maxPageTextChars = 5000',x.ctx);
  const text=x.ctx.compactListingPageText_(html);
  assert.match(text,/price: 950/);
  assert.match(text,/floorSize: 72 m²/);
});

test('combined text uses one request with separate clean bounded sources and full schema',()=>{
  const x=setup();
  x.ctx.callListingExtraction_({model:'test'},'email_and_page','Wohnung','<p>Mailpreis 1100</p>',
    'https://example.test/123?tracking=secret','<script>bad()</script><p>Terrasse</p>',null);
  assert.equal(x.requests.length,1);
  const request=x.requests[0],payload=JSON.parse(request.input[1].content[0].text);
  assert.equal(payload.email_text,'Mailpreis 1100');
  assert.equal(payload.page_text,'Terrasse');
  assert.equal(payload.listing_url,'https://example.test/123');
  assert.ok(request.text.format.schema.properties.fields.properties.rent_eur);
  assert.ok(request.text.format.schema.properties.fields.properties.rent_eur.items.properties.quote);
  assert.deepEqual(Array.from(request.text.format.schema.properties.fields.properties.rent_eur.items.required),['value','source','quote']);
  assert.deepEqual(Array.from(request.text.format.schema.properties.page_check.properties.status.enum),['matched','unavailable','unclear']);
  assert.match(request.input[0].content[0].text,/Widersprüchen/);
  assert.match(request.input[0].content[0].text,/Ergebniswerte immer auf Deutsch/);
  assert.match(request.input[0].content[0].text,/Zitate niemals übersetzen/);
});
test('combined text can extract from page alone and skips API only if both sources empty',()=>{
  const x=setup();
  x.ctx.callListingExtraction_({model:'test'},'email_and_page','','','https://example.test','Portaltext',null);
  assert.equal(x.requests.length,1);
  x.ctx.callListingExtraction_({model:'test'},'email_and_page','','','https://example.test','',null);
  assert.equal(x.requests.length,1);
});

test('real request adapter verifies quotes and routes each candidate by source',()=>{
  const x=setup();let calls=0;
  x.ctx.openAiRequest_=()=>{calls++;return {status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({
    fields:{rent_eur:[{value:1100,source:'email',quote:'1.100 €'},{value:1200,source:'listing_page',quote:'1.200 €'}],
      long_term:[{value:false,source:'email',quote:'Alquiler temporal'}],
      terrace:[{value:true,source:'listing_page',quote:'Terraza privada'}]},
    page_check:{status:'matched',matched_listing_id:'example:123',reason:'ID bestätigt'},missing_fields:[]
  })}]}]};};
  const result=x.ctx.callListingExtraction_({model:'test'},'email_and_page','Wohnung','Precio 1.100 €',
    'https://example.test/123','Precio 1.200 €. Terraza privada. Alquiler temporal.',null);
  assert.equal(calls,1);assert.equal(result.fields.rent_eur,1100);assert.equal(result.page_fields.rent_eur,1200);
  assert.equal(result.fields.long_term,null); // Das Zitat steht ausschließlich auf der Seite.
  assert.equal(result.fields.terrace,null);assert.equal(result.page_fields.terrace,true);
  assert.ok(result.rejected_facts.some(f=>f.field==='long_term'));
  assert.equal(result.provenance_version,1);
});
test('invalid types, paraphrased or missing quotes and duplicate conflicts are rejected',()=>{
  const x=setup(),spec={rent_eur:{type:['number','null']},terrace:{type:['boolean','null']},amenities:{type:'array'}};
  const r=x.ctx.normalizeListingFacts_({fields:{
    rent_eur:[{value:1100,source:'email',quote:'1100 Euro'},{value:1200,source:'email',quote:'1200 Euro'}],
    terrace:[{value:'true',source:'email',quote:'Terrasse'},{value:true,source:'listing_page',quote:'Nicht vorhandenes Zitat'}],
    amenities:[{value:['Aufzug',5],source:'email',quote:'Aufzug'}]
  }},'email_and_page',{email:'1100 Euro oder 1200 Euro. Terrasse. Aufzug',listing_page:'Keine Angaben'},spec);
  assert.equal(r.fields.rent_eur,null);assert.equal(r.fields.terrace,null);assert.equal(r.page_fields.terrace,null);
  assert.equal(r.fields.amenities.length,0);assert.equal(r.rejected_facts.length,4);
});
test('false and zero are preserved with verified quotes; wrong source is rejected in page-only mode',()=>{
  const x=setup(),r=x.ctx.normalizeListingFacts_({fields:{
    rent_eur:[{value:0,source:'listing_page',quote:'0 Euro'}],
    pool:[{value:false,source:'listing_page',quote:'sin piscina'},{value:true,source:'email',quote:'sin piscina'}]
  }},'listing_page',{email:'sin piscina',listing_page:'0 Euro, sin piscina'},
  {rent_eur:{type:['number','null']},pool:{type:['boolean','null']}});
  assert.equal(r.fields.rent_eur,0);assert.equal(r.fields.pool,false);assert.equal(r.rejected_facts.length,1);
});

test('first ten distinct photos preserve source order, reject badges and freeze selection',()=>{
  const x=setup();const files=[{...x.photo('badge'),name:'badge_ios.png'},x.photo('a',2),x.photo('alias',2),
    ...Array.from({length:15},(_,i)=>x.photo('p'+i,i+3))];
  const data={drive_files:files,ai_pipeline:{},analyzed_file_ids:[],image_reviews:[]};
  const selected=x.ctx.selectAiListingImages_(data);
  assert.deepEqual(Array.from(selected,f=>f.file_id),['a',...Array.from({length:9},(_,i)=>'p'+i)]);
  data.drive_files.unshift(x.photo('new-first',99));
  assert.deepEqual(Array.from(x.ctx.selectAiListingImages_(data),f=>f.file_id),Array.from(selected,f=>f.file_id));
});
test('historical ten analyzed photos exhaust lifetime budget and never open replacement slots',()=>{
  const x=setup(),old=Array.from({length:10},(_,i)=>'old'+i);
  const data={drive_files:[x.photo('new',100)],ai_pipeline:{},analyzed_file_ids:old,image_reviews:[]};
  const selected=x.ctx.selectAiListingImages_(data);
  assert.equal(selected.length,10);assert.ok(!selected.some(f=>f.file_id==='new'));
});
test('same photo under a new Drive ID after prior analysis does not consume another slot',()=>{
  const x=setup(),old=x.photo('old',3),alias=x.photo('alias',3),fresh=x.photo('fresh',4);
  const d={ai_pipeline:{},drive_files:[old,alias,fresh],analyzed_file_ids:['old'],image_reviews:[]};
  assert.deepEqual(Array.from(x.ctx.selectAiListingImages_(d),f=>f.file_id),['old','fresh']);
});
test('stored originals are base64 encoded byte-for-byte without resize; changed files fail',()=>{
  const x=setup(),f=x.photo('photo',6);
  const selected=x.ctx.selectAiListingImages_({ai_pipeline:{},drive_files:[f],analyzed_file_ids:[],image_reviews:[]});
  x.ctx.callImageReview_({model:'configured-model'},selected,[]);
  const image=x.requests[0].input[0].content.find(c=>c.type==='input_image');
  assert.match(x.requests[0].input[0].content[0].text,/einschließlich Bildbeschreibungen, Belegen und Zusammenfassung immer auf Deutsch/);
  assert.deepEqual(Buffer.from(image.image_url.split(',')[1],'base64'),Buffer.from(x.files.get('photo').bytes));
  assert.equal(image.detail,'high');assert.equal(x.requests[0].store,false);
  x.files.get('photo').bytes[4]=99;
  assert.throws(()=>x.ctx.callImageReview_({model:'configured-model'},selected,[]),/verändert/);
  assert.equal(x.requests.length,1);
});
test('irrelevant layout and raw HTML/JSON scripts are excluded from page facts',()=>{
  const x=setup();
  const html='<html><head><title>Wohnung</title><meta content="70 m²" name="description">'+
    '<script type="application/ld+json">{"@type":"Apartment","name":"Wohnung","address":{"streetAddress":"Calle Uno"},"publisher":{"secret":"AD_PAYLOAD"}}</script></head>'+
    '<body><nav>NAVIGATION</nav><aside>WERBUNG</aside><main><h1>Wohnung</h1><p>950 € Langzeitmiete</p><script>TRACKER</script><p>Terrasse</p></main><footer>FOOTER</footer></body></html>';
  const cleaned=x.ctx.extractListingPageText_(html);
  for(const fact of ['Calle Uno','70 m²','950 €','Langzeitmiete','Terrasse'])assert.ok(cleaned.includes(fact));
  for(const junk of ['<html','<script','NAVIGATION','WERBUNG','FOOTER','TRACKER','AD_PAYLOAD'])assert.ok(!cleaned.includes(junk));
});
test('email request contains compact text, no HTML, tracking URL or null page payload',()=>{
  const x=setup();x.ctx.callListingExtraction_({model:'test'},'email','<b>Wohnung</b>',
    '<nav>MENU</nav><p>70 m² für 950 €</p><footer>UNSUBSCRIBE</footer>','https://www.idealista.com/inmueble/123/?token=SECRET',null,null);
  const input=JSON.parse(x.requests[0].input[1].content[0].text);
  assert.equal(input.email_text,'70 m² für 950 €');assert.equal(input.subject,'Wohnung');
  assert.ok(!JSON.stringify(input).includes('SECRET'));assert.ok(!('page_text' in input));
  assert.ok(!('existing_fields' in input));
});
test('page request and schema ask only missing fields; no repeated email or subject',()=>{
  const x=setup();x.ctx.callListingExtraction_({model:'test'},'listing_page','unused subject','unused mail',
    'https://www.idealista.com/inmueble/123/','<p>Adresse Calle Dos</p>',{rent_eur:950,terrace:false,address:null});
  const req=x.requests[0],input=JSON.parse(req.input[1].content[0].text);
  assert.equal(input.existing_fields.rent_eur,950);assert.equal(input.existing_fields.terrace,false);
  assert.ok(!input.requested_fields.includes('rent_eur'));assert.ok(!input.requested_fields.includes('terrace'));
  assert.ok(input.requested_fields.includes('address'));
  assert.ok(!('subject' in input));assert.ok(!('email_text' in input));
  assert.ok(!req.text.format.schema.properties.fields.required.includes('rent_eur'));
  assert.ok(!('rent_eur' in req.text.format.schema.properties.fields.properties));
});
test('empty content skips API and text is bounded',()=>{
  const x=setup();x.ctx.callListingExtraction_({model:'test'},'email','x','<script>only tracker</script>','url',null,null);
  assert.equal(x.requests.length,0);
  x.ctx.callListingExtraction_({model:'test'},'email','x','A'.repeat(50000),'url',null,null);
  assert.equal(JSON.parse(x.requests[0].input[1].content[0].text).email_text.length,10000);
});
