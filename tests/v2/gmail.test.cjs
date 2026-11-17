const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function ctxForGmail(messages){
  let calls=0;
  const ctx=vm.createContext({
    GmailApp:{search:(query,offset,limit)=>{
      calls++;
      if(query.includes('from:(fotocasa.es)'))return [];
      return messages.slice(offset,offset+limit).map(m=>({getMessages:()=>[m]}));
    }},
    console
  });
  for(const name of ['Config','Registry','Gmail']){
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../../apps-script/V2_'+name+'.js'),'utf8'),ctx);
  }
  return {ctx,get calls(){return calls}};
}
test('saturated Gmail searches are paginated without dropping mail IDs',()=>{
  const base=Date.now();
  const emails=Array.from({length:100},(_,i)=>({
    getId:()=>String(i),getDate:()=>new Date(base-10000-i*1000),
    getSubject:()=>'New listings'
  }));
  const env=ctxForGmail(emails);
  const state={version:2,mailQueue:[],indexedMailIds:{},lastScanUtc:'',checkpointUtc:''};
  let scans=0;
  while(scans<12){
    const now=base+scans*16*60000;
    env.ctx.state=state;env.ctx.now=now;
    const result=vm.runInContext('wa2Discover(state,now)',env.ctx);
    // External value injection, not a global declaration in the app.
    scans++;
    if(!result.limited)break;
  }
  assert.equal(Object.keys(state.indexedMailIds).length,100);
  assert.equal(state.mailQueue.length,100);
  assert.ok(state.checkpointUtc);
  assert.ok(scans>1);
  assert.equal(env.calls,scans*2);
});
test('Gmail search is throttled to the selected interval',()=>{
  const e=ctxForGmail([]);
  const state={version:2,mailQueue:[],indexedMailIds:{},lastScanUtc:'',checkpointUtc:''};
  const now=Date.now();
  e.ctx.state=state;e.ctx.now=now;
  vm.runInContext('wa2Discover(state,now)',e.ctx);
  assert.equal(vm.runInContext('wa2SearchDue(state,now+5*60000)',e.ctx),false);
  assert.equal(vm.runInContext('wa2SearchDue(state,now+16*60000)',e.ctx),true);
});
