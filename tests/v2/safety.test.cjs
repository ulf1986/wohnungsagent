const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function createCtx(){
  const c=vm.createContext({console});
  for(const name of ['Config','Portals','Registry','AI','Telegram','Monitoring']){
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../../apps-script/V2_'+name+'.js'),'utf8'),c);
  }
  return c;
}
test('stale sending intent is flagged as uncertain delivery instead of resent',()=>{
  const c=createCtx();
  const row={status:'sending',updatedAt:new Date().toISOString()};
  c.row=row;
  assert.equal(vm.runInContext('wa2Due(row,Date.now())',c),false);
  assert.equal(vm.runInContext('wa2Terminal("unknown_delivery")',c),true);
});
test('monitor identifies broken Gmail, ambiguous Telegram and dead jobs',()=>{
  const c=createCtx(),now=Date.now();
  c.now=now;
  c.state={lastScanUtc:new Date(now-3600000).toISOString(),
    mailQueue:[{receivedAt:new Date(now-3600000).toISOString()}]};
  c.registry={records:{a:{status:'unknown_delivery'},b:{status:'failed_final'}}};
  const errors=vm.runInContext('wa2HealthStatus(state,registry,now)',c);
  assert.deepEqual(Array.from(errors),['GMAIL_STALE','MAIL_BACKLOG','PROCESSING_FAILED','TELEGRAM_UNCERTAIN']);
});
test('malformed stored JSON is rejected rather than silently reset',()=>{
  const c=createCtx();
  c.wa2StoreFile=()=>({getBlob:()=>({getDataAsString:()=>'{bad'})});
  assert.throws(()=>vm.runInContext("wa2LoadJson('k','n',{version:2})",c),/beschädigt/);
});
test('unknown area Telegram message is explicitly identified as unverified',()=>{
  const c=createCtx();
  c.row={provider:'fotocasa',rent:850,area:null,url:'https://www.fotocasa.es/es/alquiler/vivienda/malaga/191299321/d'};
  const value=vm.runInContext('wa2FormatMessage(row)',c);
  assert.match(value,/Fläche unbekannt, bitte prüfen/);
  assert.doesNotMatch(value,/0 m²/);
});
