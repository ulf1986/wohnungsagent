const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function environment({area=75,rent=950,telegramFailure=false}={}){
  const props=new Map([['WA2_ENABLED','true'],['OPENAI_API_KEY','fake-openai'],
    ['OPENAI_MODEL','mock-model'],['TELEGRAM_BOT_TOKEN','fake-telegram'],['TELEGRAM_CHAT_ID','123']]);
  const files=new Map(),folders=new Map();
  let nextId=1,apiCalls=0,telegramCalls=0,gmailSearches=0;
  function newFile(name,data){
    const id='file'+nextId++;
    const file={name,id,data,
      getId:()=>id,
      getBlob:()=>({getDataAsString:()=>file.data}),
      setContent:x=>{file.data=x;},
      makeCopy:other=>newFile(other,file.data)
    };
    files.set(id,file);return file;
  }
  const folder={
    getId:()=>'folder1',
    getFilesByName:n=>{
      const matches=[...files.values()].filter(f=>f.name===n);let i=0;
      return {hasNext:()=>i<matches.length,next:()=>matches[i++]};
    },
    createFile:(name,data)=>newFile(name,data)
  };
  folders.set('folder1',folder);
  const mail={
    getDate:()=>new Date(),
    getId:()=>'gmail-1',getSubject:()=>'Idealista nuevas viviendas',
    getBody:()=>'<p>Piso en Malaga por '+rent+' € y '+area+' m²</p><a href="https://www.idealista.com/inmueble/12345678/">Ver anuncio</a>',
    getPlainBody:()=>''};
  const mocks={
    console:{log(){},warn(){},error(){}},
    PropertiesService:{getScriptProperties:()=>({
      getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,String(v))})},
    DriveApp:{
      createFolder:()=>folder,getFolderById:id=>folders.get(id),getFileById:id=>files.get(id)},
    GmailApp:{
      search:()=>{gmailSearches++;return [{getMessages:()=>[mail]}];},
      getMessageById:id=>id===mail.getId()?mail:null},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    UrlFetchApp:{fetch:(url,options)=>{
      if(url.includes('api.openai.com')){
        apiCalls++;
        const payload=JSON.parse(options.payload);
        const item=JSON.parse(payload.input[1].content[0].text).listings[0];
        const response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({
          listings:[{listing_id:item.listing_id,price_eur:rent,area_m2:area,
            price_source:'email',area_source:'email',price_quote:rent+' €',area_quote:area+' m²'}]
        })}]}]};
        return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(response)};
      }
      if(url.includes('api.telegram.org')){
        telegramCalls++;
        return {getResponseCode:()=>telegramFailure?500:200,
          getContentText:()=>JSON.stringify(telegramFailure?{ok:false}:{ok:true,result:{message_id:777}})};
      }
      throw Error('Unexpected live URL: '+url);
    }}
  };
  const ctx=vm.createContext(mocks);
  for(const name of ['Config','Portals','Registry','Gmail','Page','AI','Telegram','Monitoring','Main']){
    const src=fs.readFileSync(path.join(__dirname,'../../apps-script/V2_'+name+'.js'),'utf8');
    vm.runInContext(src,ctx,{filename:name+'.js'});
  }
  const run=()=>vm.runInContext('wa2Run()',ctx);
  const registry=()=>JSON.parse([...files.values()].find(f=>f.name==='registry.json').data);
  const state=()=>JSON.parse([...files.values()].find(f=>f.name==='state.json').data);
  return {run,registry,state,props,get apiCalls(){return apiCalls},
    get telegramCalls(){return telegramCalls},get gmailSearches(){return gmailSearches}};
}
test('new email -> one AI request -> one Telegram delivery -> durable sent state',()=>{
  const e=environment();
  const result=e.run();
  assert.equal(result.status,'ok');
  assert.equal(e.apiCalls,1);
  assert.equal(e.telegramCalls,1);
  assert.equal(e.registry().records['idealista:12345678'].status,'sent');
  e.run();
  assert.equal(e.apiCalls,1);
  assert.equal(e.telegramCalls,1);
  assert.equal(e.gmailSearches,2);
});
test('59 m² is excluded, 60 m² is delivered',()=>{
  const small=environment({area:59});small.run();
  assert.equal(small.registry().records['idealista:12345678'].status,'excluded');
  assert.equal(small.telegramCalls,0);
  const exact=environment({area:60});exact.run();
  assert.equal(exact.registry().records['idealista:12345678'].status,'sent');
  assert.equal(exact.telegramCalls,1);
});
test('rent above 1200 euros is accepted',()=>{
  const e=environment({rent:1500,area:80});e.run();
  assert.equal(e.registry().records['idealista:12345678'].status,'sent');
});
test('telegram definite failure stores facts and retries without repeated AI call',()=>{
  const e=environment({telegramFailure:true});e.run();
  assert.equal(e.registry().records['idealista:12345678'].status,'notify_retry');
  assert.equal(e.apiCalls,1);
  e.run();assert.equal(e.apiCalls,1);
});
test('disabled agent does not access any external service',()=>{
  const e=environment();e.props.set('WA2_ENABLED','false');
  assert.equal(e.run().status,'disabled');
  assert.equal(e.gmailSearches,0);
});
