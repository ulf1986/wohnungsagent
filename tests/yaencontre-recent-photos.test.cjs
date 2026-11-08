const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
class Sheet {
  constructor(rows){this.rows=rows;}
  getLastRow(){return this.rows.length;}
  getLastColumn(){return this.rows[0].length;}
  getRange(r,c,n=1,m=1) {
    const get=()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>this.rows[r+i-1]?.[c+j-1]??''));
    return {getValues:get,getValue:()=>get()[0][0],setValue:v=>{this.rows[r-1][c-1]=v;}};
  }
}
function setup(ageHours){
  const now=Date.now(),mailId='recent-mail',url='https://www.yaencontre.com/alquiler/piso/inmueble-55-123';
  const listing=new Sheet([['Datensatz-ID','Bildanalyse JSON','E-Mail-ID'],['yaencontre:123','{"drive_files":[]}',mailId]]);
  const queue=new Sheet([['Queue Gmail-ID','Queue Eingang UTC','Queue Betreff','Queue Originaltext','Queue Inseratslinks JSON'],
    [mailId,new Date(now-ageHours*3600000).toISOString(),'Yaencontre','','["'+url+'"]']]);
  const props=new Map(),calls=[];
  const ctx=vm.createContext({
    console,Date,
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||'',setProperty:(k,v)=>props.set(k,String(v))})},
    GmailApp:{getMessageById:id=>{calls.push('gmail');return {getDate:()=>new Date(now-ageHours*3600000),getBody:()=>'<html>listing</html>'};}},
    getMailListingId:()=> 'yaencontre:123',
    extractYaencontreMailImages:()=>[{listing_id:'yaencontre:123',listing_url:url,
      source_url:'https://media.yaencontre.com/img/photo/w1024/55/55-photo.jpg'}],
    isListingBlacklisted_:()=>false,
    getImageFolder:()=>({}),
    saveListingImages:(_,id,urls)=>{calls.push('download');return {created:1,errors:[],
      files:[{file_id:'photo-one',source_url:urls[0]}]};},
    logImageDiagnostic:()=>{}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/YaencontreRecentPhotos.js'),'utf8'),ctx);
  return {ctx,props,calls,ss:{getSheetByName:k=>({Verarbeitung:queue,Anzeigen:listing})[k]},listing};
}
test('Yaencontre historical photo recovery never reads email older than 48 hours',()=>{
  const x=setup(49);
  const result=x.ctx.recoverRecentYaencontreMailImages_(x.ss);
  assert.equal(result.mails,0);
  assert.deepEqual(x.calls,[]);
});
test('Yaencontre recent HTML photos get attached to their exact listing without AI',()=>{
  const x=setup(12);
  const result=x.ctx.recoverRecentYaencontreMailImages_(x.ss);
  assert.equal(result.mails,1);
  assert.equal(result.photos,1);
  assert.deepEqual(x.calls,['gmail','download']);
  const data=JSON.parse(x.listing.rows[1][1]);
  assert.equal(data.drive_files.length,1);
  assert.equal(data.drive_files[0].listing_id,'yaencontre:123');
  assert.equal(data.drive_files[0].file_id,'photo-one');
  x.ctx.recoverRecentYaencontreMailImages_(x.ss);
  assert.deepEqual(x.calls,['gmail','download']);
});
