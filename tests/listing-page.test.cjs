const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const url='https://www.fotocasa.es/es/alquiler/vivienda/malaga/x/123/d';
function setup(responses={}) {
  const calls=[],ctx=vm.createContext({
    normalizeProvider:()=> 'fotocasa',
    getMailListingId:u=>{const m=String(u||'').match(/^https:\/\/(?:www\.)?fotocasa\.es\/.*\/(\d+)\/d(?:[?#]|$)/);return m?'fotocasa:'+m[1]:null;},
    UrlFetchApp:{fetch:(u,options)=>{calls.push(u);assert.equal(options.followRedirects,false);const r=responses[u];if(!r)throw new Error('unexpected URL');return {getResponseCode:()=>r.code||200,getContentText:()=>r.html||'',getAllHeaders:()=>r.headers||{}};}},
    logImageDiagnostic(){}
  });
  for(const name of ['AiInput','AIProcessing'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/'+name+'.js'),'utf8'),ctx);
  return {ctx,calls};
}
test('propertyNotFound redirect is unavailable without fetching search results',()=>{
  const x=setup({[url]:{code:302,headers:{Location:'/es/alquiler/viviendas/malaga/l?propertyNotFound'}}});
  assert.equal(x.ctx.fetchListingPage_(url,'fotocasa').status,'unavailable');assert.equal(x.calls.length,1);
});
test('404 and 410 are unavailable; access blocks and challenges remain uncertain',()=>{
  for(const code of [404,410])assert.equal(setup({[url]:{code}}).ctx.fetchListingPage_(url,'fotocasa').status,'unavailable');
  for(const code of [403,429,503])assert.equal(setup({[url]:{code}}).ctx.fetchListingPage_(url,'fotocasa').status,'blocked');
  assert.equal(setup({[url]:{html:'<title>Just a moment...</title>'}}).ctx.fetchListingPage_(url,'fotocasa').status,'blocked');
});
test('200 deleted heading is unavailable; footer or script text is not a deletion signal',()=>{
  const x=setup();
  assert.equal(x.ctx.listingPageSignal_('<h2>Anuncio no disponible</h2>'),'unavailable');
  assert.equal(x.ctx.listingPageSignal_('<h1>Bonito piso</h1><script>anuncio no disponible</script><footer>anuncio eliminado</footer>'),'');
});
test('foreign and spoof redirects never reach a second fetch',()=>{
  for(const next of ['https://evil.test/','https://fotocasa.es.evil.test/','http://www.fotocasa.es/']){
    const x=setup({[url]:{code:302,headers:{Location:next}}});
    assert.equal(x.ctx.fetchListingPage_(url,'fotocasa').status,'blocked');assert.equal(x.calls.length,1);
  }
});
test('canonical identity is preserved in compact text; conflicting metadata is not confirmation',()=>{
  const html=`<link rel="canonical" href="${url}"><h1>Piso</h1><main>60 metros</main>`;
  const x=setup({[url]:{html}}),p=x.ctx.fetchListingPage_(url,'fotocasa');
  assert.equal(p.identity_id,'fotocasa:123');assert.match(p.text,/Seitenidentität/);
  assert.equal(x.ctx.listingPageIdentityIds_(html+`<meta property="og:url" content="${url.replace('123','999')}">`).length,2);
});
test('page fields accepted only with both technical identity and matching AI assessment',()=>{
  const x=setup(),result={provenance_version:1,fields:{rent_eur:950,terrace:null},page_fields:{rent_eur:900,terrace:true},
    page_check:{status:'matched',matched_listing_id:'fotocasa:123',reason:'ID und Daten passen'}};
  const accepted=x.ctx.acceptListingPageResult_(result,{status:'ok',identity_id:'fotocasa:123'},'fotocasa:123');
  assert.equal(accepted.fields.rent_eur,950);assert.equal(accepted.fields.terrace,true);
  assert.equal(accepted.conflicts[0].field,'rent_eur');assert.equal(accepted.conflicts[0].selected_source,'email');
  for(const identity_id of [null,'fotocasa:999']){
    const rejected=x.ctx.acceptListingPageResult_(result,{status:'ok',identity_id},'fotocasa:123');
    assert.equal(rejected.pageCheck.status,'unclear');assert.equal(rejected.fields.terrace,null);
  }
});

test('text response without validated source evidence fails closed',()=>{
  const x=setup();assert.throws(()=>x.ctx.acceptListingPageResult_({fields:{rent_eur:950}},{status:'ok'},'fotocasa:123'),/Quellenbelege/);
});
test('technical deletion overrides a hallucinated AI match and retains mail facts',()=>{
  const x=setup(),r=x.ctx.acceptListingPageResult_({provenance_version:1,fields:{rent_eur:950},page_fields:{pool:true},
    page_check:{status:'matched',matched_listing_id:'fotocasa:123'}},{status:'unavailable',error:'HTTP 404'},'fotocasa:123');
  assert.equal(r.pageCheck.status,'unavailable');assert.equal(r.fields.rent_eur,950);assert.equal(r.fields.pool,undefined);
});
test('open fields are German readable lines and remove facts filled from accepted page',()=>{
  const x=setup(),text=x.ctx.makeOpenFields_({ai_pipeline:{missing_fields:['terrace','long_term','distance_km_approx'],page_status:'ok',page_check:{status:'unclear'}},analyzed_file_ids:[]},{terrace:false});
  assert.match(text,/Langzeitmiete ungeklärt/);assert.match(text,/Entfernung/);assert.match(text,/\n/);assert.ok(!text.includes('long_term'));assert.ok(!text.includes('Terrasse unbekannt'));
});
test('distance is calculated from reference to listing, with correct cardinal direction',()=>{
  const x=setup();
  assert.equal(x.ctx.listingDistanceBearing_({lat:36.7,lng:-4.4},{lat:36.71,lng:-4.4}).direction,'N');
  assert.equal(x.ctx.listingDistanceBearing_({lat:36.7,lng:-4.4},{lat:36.7,lng:-4.41}).direction,'W');
  assert.ok(Math.abs(x.ctx.listingDistanceBearing_({lat:36.7,lng:-4.4},{lat:36.71,lng:-4.4}).distance_km-1.11)<0.02);
});
test('geocoding rejects ambiguous, partial and city-only results',()=>{
  const x=setup(),r={types:['street_address'],geometry:{location:{lat:36.7,lng:-4.4}},address_components:[
    {types:['locality'],long_name:'Málaga'},{types:['country'],short_name:'ES'},{types:['postal_code'],long_name:'29001'}]};
  assert.ok(x.ctx.uniqueListingGeocode_({status:'OK',results:[r]},true));
  assert.equal(x.ctx.uniqueListingGeocode_({status:'OK',results:[r,r]},false),null);
  assert.equal(x.ctx.uniqueListingGeocode_({status:'OK',results:[{...r,partial_match:true}]},false),null);
  assert.equal(x.ctx.uniqueListingGeocode_({status:'OK',results:[{...r,types:['locality']}]},false),null);
  assert.equal(x.ctx.uniqueListingGeocode_({status:'OK',results:[{...r,types:['route']}]},true),null);
});
test('title becomes descriptive rich hyperlink without changing listing URL column',()=>{
  const x=setup(),values={},cell=c=>({setValue:v=>{values[c]=v;},getValue:()=>'',setRichTextValue:v=>{values[c]=v;},setWrap:()=>{}});
  x.ctx.SpreadsheetApp={newRichTextValue:()=>{const rich={};return {setText(t){rich.text=t;return this;},setLinkUrl(u){rich.url=u;return this;},build(){return rich;}};}};
  const sheet={getRange:(_,c)=>cell(c),hideColumns:c=>{values.hidden=c;}};
  x.ctx.applyListingPresentation_(sheet,2,{'Titel':0,'Offene Angaben':1,'KI-Bewertung':2,'Status':3},
    {rooms:2,address:'Calle Ríos Rosas, Málaga'},url+'?tracking=abc',{ai_pipeline:{page_status:'ok',page_check:{status:'matched'}}});
  assert.equal(values[1].text,'2-Zimmer-Wohnung · Calle Ríos Rosas, Málaga');assert.equal(values[1].url,url);assert.equal(values.hidden,3);
});

test('verified location is calculated and reused; KI guesses never survive unavailable geocoding',()=>{
  const x=setup();let calls=0;
  const response=(lat,lng)=>({status:'OK',results:[{types:['street_address'],geometry:{location:{lat,lng}},address_components:[
    {types:['locality'],long_name:'Málaga'},{types:['country'],short_name:'ES'},{types:['postal_code'],long_name:'29001'}]}]});
  x.ctx.Maps={newGeocoder:()=>({setRegion(){return this;},setLanguage(){return this;},geocode(address){calls++;return response(address.includes('Alameda')?36.7:36.71,-4.4);}})};
  const data={ai_pipeline:{page_check:{status:'matched'}}},fields={address:'Calle Ejemplo 1, Málaga',direction:'W',distance_km_approx:99};
  x.ctx.populateListingLocation_(fields,data);assert.equal(fields.direction,'N');assert.equal(fields.distance_km_approx,1.11);
  x.ctx.populateListingLocation_(fields,data);assert.equal(calls,2);
  delete x.ctx.Maps;
  const other={address:'Calle Otra 1, Málaga',direction:'W',distance_km_approx:99};
  x.ctx.populateListingLocation_(other,{ai_pipeline:{}});assert.equal(other.direction,null);assert.equal(other.distance_km_approx,null);
});
