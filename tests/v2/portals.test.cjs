const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function load(){
  const ctx=vm.createContext({console,WA2_TEST:true});
  for(const name of ['Config','Portals','AI','Page','Telegram']){
    const src=fs.readFileSync(path.join(__dirname,'../../apps-script/V2_'+name+'.js'),'utf8');
    vm.runInContext(src,ctx,{filename:name+'.js'});
  }
  return ctx;
}
test('stable provider-qualified identity and canonical URLs',()=>{
  const c=load();
  const urls=[
    ['https://www.idealista.com/inmueble/113040197/?utm_source=mail','idealista:113040197'],
    ['https://www.pisos.com/alquilar/piso-centro-69185207102_501122/','pisos:69185207102'],
    ['https://www.milanuncios.com/alquiler-de-pisos/centro-625396547.htm','milanuncios:625396547'],
    ['https://www.fotocasa.es/es/alquiler/vivienda/malaga-capuchinos/191299321/d','fotocasa:191299321'],
    ['https://www.yaencontre.com/alquiler/piso/malaga-centro-112586738','yaencontre:112586738']
  ];
  for(const [url,id]of urls)assert.equal(vm.runInContext('wa2GetPortalListing('+JSON.stringify(url)+').id',c),id);
  assert.equal(vm.runInContext('wa2GetPortalListing("https://evil.example/inmueble/12345678")',c),null);
});
test('Yaencontre individual alert with underscore listing ID is detected',()=>{
  const c=load();
  const url='https://www.yaencontre.com/alquiler/piso/inmueble-u15772368_57917264?utm_source=alerta-ye&utm_medium=email';
  c.url=url;
  const parsed=vm.runInContext('wa2GetPortalListing(url)',c);
  assert.equal(parsed.id,'yaencontre:57917264');
  assert.equal(parsed.url,'https://www.yaencontre.com/alquiler/piso/inmueble-u15772368_57917264');
  const text='Piso en alquiler en calle Martínez de la Rosa 850 €/mes 40 m² '+url;
  c.body=text;
  const listings=vm.runInContext('wa2ExtractListings("",body)',c);
  assert.equal(listings.length,1);
  assert.equal(listings[0].id,'yaencontre:57917264');
  assert.match(listings[0].emailExcerpt,/40 m²/);
  // A portal search/filter URL is not an individual listing.
  assert.equal(vm.runInContext('wa2GetPortalListing("https://www.yaencontre.com/alquiler/pisos/custom/e-alquiler-vivienda-habitual/f--1200euros")',c),null);
});
test('one email with multiple listings yields separate identities',()=>{
  const c=load();
  const html='<p>Piso 1. 950 € 75 m²</p><a href="https://www.idealista.com/inmueble/12345678/">Ver</a>'+
    '<p>Piso 2. 780 € 45 m²</p><a href="https://www.idealista.com/inmueble/99999999/">Ver</a>';
  const result=vm.runInContext('wa2ExtractListings('+JSON.stringify(html)+',"")',c);
  assert.equal(result.length,2);
  assert.equal(result[0].id,'idealista:12345678');
  assert.equal(result[1].id,'idealista:99999999');
  assert.notEqual(result[0].emailExcerpt,result[1].emailExcerpt);
});
test('literal numeric evidence verification detects fabrications',()=>{
  const c=load();
  assert.equal(vm.runInContext('wa2QuoteSupports("950 €",950,"Vivienda 950 € 75 m²","rent")',c),true);
  assert.equal(vm.runInContext('wa2QuoteSupports("1.250 €",1250,"Piso 1.250 € 95 m²","rent")',c),true);
  assert.equal(vm.runInContext('wa2QuoteSupports("950 €",1200,"Piso 950 €","rent")',c),false);
  assert.equal(vm.runInContext('wa2QuoteSupports("75 m²",75,"Piso 45 m²","area")',c),false);
});
test('page identity must be verified, never inferred from query URL',()=>{
  const c=load();
  assert.deepEqual(Array.from(vm.runInContext('wa2PageIdentity("<title>Piso en Málaga</title>")',c)),[]);
});
test('price is displayed even above historic 1200 Euro ceiling',()=>{
  const c=load();
  const row={provider:'idealista',rent:1500,area:85,url:'https://www.idealista.com/inmueble/12345678/'};
  const msg=vm.runInContext('wa2FormatMessage('+JSON.stringify(row)+')',c);
  assert.match(msg,/1500 €/);
  assert.match(msg,/85 m²/);
  assert.doesNotMatch(msg,/Bewertung|Bild/i);
});

test('Milanuncios tracking card resolves directly without fetching its photo',()=>{
  const c=load();
  let calls=0;
  c.UrlFetchApp={fetch:()=>{
    calls++;
    return {getResponseCode:()=>302,getAllHeaders:()=>({
      Location:'https://www.milanuncios.com/alquiler-de-pisos/malaga-centro-625396547.htm'
    })};
  }};
  const html='<a href="https://sgt.milanuncios.com/ls/click?t=abc">'+
    '<img src="https://images-re.milanuncios.com/images/ads/sample"></a>';
  c.html=html;
  const resolved=vm.runInContext('wa2ResolveMilanunciosTrackedLinks(html)',c);
  c.resolved=resolved;
  const listings=vm.runInContext('wa2ExtractListings(resolved,"")',c);
  assert.equal(calls,1);
  assert.equal(listings.length,1);
  assert.equal(listings[0].id,'milanuncios:625396547');
});
