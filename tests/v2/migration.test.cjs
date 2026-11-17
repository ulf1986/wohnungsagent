const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
test('one-time migration seeds only actually delivered legacy IDs and is idempotent',()=>{
  const props=new Map([['WA2_ENABLED','false']]),files=new Map();
  let number=0;
  const folder={
    getId:()=>'privateFolder',
    getFilesByName:name=>{const found=[...files.values()].filter(x=>x.name===name);let i=0;
      return {hasNext:()=>i<found.length,next:()=>found[i++]};},
    createFile:(name,data)=>{
      const id='f'+(++number);
      const f={id,name,data,getId:()=>id,
        getBlob:()=>({getDataAsString:()=>f.data}),
        setContent:value=>{f.data=value;},
        makeCopy:other=>folder.createFile(other,f.data)};
      files.set(id,f);return f;
    }
  };
  const getProp=k=>props.get(k)||null;
  const c=vm.createContext({
    console,
    PropertiesService:{getScriptProperties:()=>({
      getProperty:getProp,setProperty:(k,v)=>props.set(k,String(v))})},
    DriveApp:{createFolder:()=>folder,getFolderById:()=>folder,
      getFileById:id=>files.get(id)},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    SpreadsheetApp:{openById:()=>({getSheetByName:()=>({getDataRange:()=>({
      getValues:()=>[
        ['Datensatz-ID','Telegram Versand UTC'],
        ['fotocasa:191299321','2026-11-10'],
        ['idealista:87654321','']
      ]})})})},
    UrlFetchApp:{fetch:()=>({
      getResponseCode:()=>200,
      getContentText:()=>JSON.stringify({body:
        'Legacy history:\n'+String.fromCharCode(96).repeat(3)+'json\n'+JSON.stringify({version:1,
          sent:['idealista:113040197','yaencontre:112586738']})+'\n'+String.fromCharCode(96).repeat(3)})
    })}
  });
  for(const name of ['Config','Registry','Migration'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../../apps-script/V2_'+name+'.js'),'utf8'),c);
  c.CONFIG={spreadsheetId:'legacy-sheet'};
  const result=vm.runInContext('wa2MigrateHistory()',c);
  assert.equal(result.legacySentImported,3);
  assert.equal(getProp('WA2_MIGRATION_COMPLETE'),'true');
  const registry=JSON.parse([...files.values()].find(x=>x.name==='registry.json').data);
  assert.equal(registry.records['idealista:113040197'].status,'sent');
  assert.equal(registry.records['yaencontre:112586738'].status,'sent');
  assert.equal(registry.records['fotocasa:191299321'].status,'sent');
  assert.equal(registry.records['idealista:87654321'],undefined);
  assert.equal(vm.runInContext('wa2MigrateHistory().status',c),'already_migrated');
});
