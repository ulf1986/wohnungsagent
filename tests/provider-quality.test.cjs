const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ctx=vm.createContext({console,logImageDiagnostic:()=>{}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/ProviderQuality.js'),'utf8'),ctx);
test('quality metrics accept euro and square metre formatting',()=>{
  assert.equal(ctx.providerQualityNumeric_('1.180 €'),1180);
  assert.equal(ctx.providerQualityNumeric_('950 €'),950);
  assert.equal(ctx.providerQualityNumeric_('70 m²'),70);
  assert.equal(ctx.providerQualityNumeric_('65,5 m²'),65.5);
  assert.equal(ctx.providerQualityNumeric_(''),null);
  assert.equal(ctx.providerQualityNumeric_('kein Preis'),null);
});
test('provider counters ignore only genuinely missing price or area',()=>{
  const rows=[['Datensatz-ID','Portal','Miete','Fläche'],
    ['yaencontre:1','yaencontre','1.180 €','70 m²'],
    ['yaencontre:2','yaencontre','','66 m²'],
    ['idealista:3','idealista','900 €','']];
  const sheet={
    getLastRow:()=>rows.length,getLastColumn:()=>4,
    getRange:(r,c,n=1,m=1)=>({getValues:()=>Array.from({length:n},(_,i)=>rows[r+i-1].slice(c-1,c-1+m))})
  };
  const result=ctx.auditProviderDataQuality_({getSheetByName:name=>name==='Anzeigen'?sheet:null});
  assert.equal(result.checked,3);
  assert.equal(result.providers.yaencontre.missing_rent,1);
  assert.equal(result.providers.yaencontre.missing_area,0);
  assert.equal(result.providers.idealista.missing_area,1);
});
