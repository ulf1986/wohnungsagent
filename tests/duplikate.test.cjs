const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
class Sheet {
  constructor(rows){this.rows=rows.map(r=>[...r]);this.width=Math.max(...rows.map(x=>x.length),7);this.deleted=[];}
  getLastRow(){return this.rows.length;}
  getLastColumn(){return this.width;}
  setFrozenRows(){}
  getRange(r,c,n=1,m=1){
    const get=()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>this.rows[r+i-1]?.[c+j-1]??''));
    const set=arr=>{arr.forEach((row,i)=>{this.rows[r+i-1]||=[];row.forEach((v,j)=>this.rows[r+i-1][c+j-1]=v);});};
    return {getValues:get,getValue:()=>get()[0][0],setValues:set,setValue:v=>set([[v]]),
      clearContent:()=>set(Array.from({length:n},()=>Array(m).fill(''))),copyFormatToRange:()=>{} };
  }
  deleteRow(row){this.deleted.push(row);this.rows.splice(row-1,1);}
  deleteColumn(column){this.rows.forEach(r=>r.splice(column-1,1));this.width--;}
  insertColumnAfter(column){this.rows.forEach(r=>r.splice(column,0,''));this.width++;}

}
const header=['Zu löschen','Wohnungsbewertung (0–100)','Preisbewertung (0–100)','E-Mail-Eingang','Vorschaubild','Titel','Fläche','Miete','Zusammenfassung',
  'Lage zu 29001','Entfernung zu 29001 km','Richtung von 29001','Bewertungsabdeckung (%)','Merkmale','Status','Portal',
  'Anzeigenlink','Anzeigendatum (Quelle)','Eingang (UTC)','Mietart / Laufzeit','Mietprüfung','Einschränkungen','Offene Angaben',
  'Terrasse Punkte','Pool Punkte','Bildbewertung Punkte','Distanz Punkte','Fläche Punkte','Gmail-Link','Datensatz-ID','Anzeigen-ID','E-Mail-ID','KI-Bewertung','Bildanalyse JSON'];
function listing(id,files,{rent=1100,area=70,address='Calle Uno'}={}){
  const row=Array(header.length).fill('');
  const set=(n,v)=>row[header.indexOf(n)]=v;
  set('Zu löschen',false);set('Datensatz-ID',id);
  set('Anzeigenlink','https://example.test/'+id);set('Titel','2-Zimmer-Wohnung');
  set('Miete',rent);set('Fläche',area);set('E-Mail-ID','test-mail');
  set('Bildanalyse JSON',JSON.stringify({drive_files:files.map(file_id=>({file_id})),
    extracted_fields:{rent_eur:rent,area_m2:area,address,terrace:true,pool:false},
    image_review:{images_actually_viewed:2,brightness:5,space:4,furniture_condition:4,care_renovation:4}}));
  return row;
}
function setup(listings=[]){
  const sheet=new Sheet([header,...listings]),block=new Sheet([['Sperrliste Datensatz-ID','Original-URL','Ausschlussgrund']]);
  const byName={Anzeigen:sheet,Sperrliste:block};
  const ss={getSheetByName:name=>byName[name],insertSheet(name){const x=new Sheet([Array(7).fill('')]);byName[name]=x;return x;}};
  const decoded=new Map();
  function image(kind,variant){
    const w=64,h=48,pix=new Uint8Array(w*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const index=(y*w+x)*4;
      const v=kind===1?(x*21+y*3+Math.floor(x/7)*70)%256:(x*7+y*41+Math.floor(y/6)*80)%256;
      pix[index]=v;pix[index+1]=v;pix[index+2]=v;pix[index+3]=255;
    }
    return {width:w,height:h,data:pix};
  }
  const ctx=vm.createContext({
    console,Uint8Array,SpreadsheetApp:{flush(){}},
    readMailImageBlacklist:()=>new Set(block.rows.slice(1).map(r=>String(r[0]).toLowerCase())),
    logImageDiagnostic(){},
    DriveApp:{getFileById:id=>({getBlob:()=>({
      getContentType:()=> 'image/jpeg', getBytes:()=>[id.includes('second')?2:1]
    })})},
    decode:bytes=>image(bytes[0]===2?2:1)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/Duplikate.js'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/AIProcessing.js'),'utf8'),ctx);
  return {ctx,ss,sheet,block,byName,listing};
}
const plain=x=>JSON.parse(JSON.stringify(x));
test('Hamming is a pure 64-bit distance, matching only similar image hashes',()=>{
  const {ctx}=setup();
  assert.equal(ctx.dedupHashDistance_('0000000000000000','ffffffffffffffff'),64);
  assert.equal(ctx.dedupHashDistance_('0000000000000000','000000000000000f'),4);
  assert.equal(ctx.dedupHashDistance_('0000000000000000','invalid'),64);
});
test('image matching requires two different photo matches before suppressing another portal',()=>{
  const {ctx,ss}=setup([listing('idealista:1',['first-a','second-a'])]);
  assert.deepEqual(plain(ctx.backfillDuplicateRegistry_(ss,1)),{added:1,matched:0});
  const two=ctx.checkDuplicateBeforeAi_(ss,'fotocasa:9','https://fotocasa.test/9',
    [{file_id:'first-b'},{file_id:'second-b'}]);
  assert.equal(two.status,'duplicate');assert.equal(two.canonical,'idealista:1');
  const one=ctx.checkDuplicateBeforeAi_(ss,'yaencontre:8','https://yaencontre.test/8',
    [{file_id:'first-c'}]);
  assert.notEqual(one.status,'duplicate');
  const registry=ctx.readDuplicateRegistry_(ss.getSheetByName('Duplikate'));
  assert.equal(registry.find(x=>x.id==='fotocasa:9').canonical,'idealista:1');
});
test('reconciliation retains source aliases and removes less complete duplicate rows only',()=>{
  const {ctx,ss,sheet}=setup([
    listing('idealista:1',['first-a','second-a'],{rent:1200,area:80}),
    listing('fotocasa:2',['first-b','second-b'],{rent:null,area:null,address:null})
  ]);
  const indexed=ctx.backfillDuplicateRegistry_(ss,8);
  assert.equal(indexed.added,2);assert.equal(indexed.matched,1);
  const merged=ctx.reconcileExistingDuplicates_(ss);
  assert.equal(merged.removed,1);
  assert.equal(sheet.rows.length,2);
  const data=JSON.parse(sheet.rows[1][header.indexOf('Bildanalyse JSON')]);
  assert.equal(data.alternate_portals[0].id,'fotocasa:2');
  assert.equal(ctx.readDuplicateRegistry_(ss.getSheetByName('Duplikate')).length,2);
});
test('user-marked rows are blocked before actual row removal',()=>{
  const {ctx,ss,sheet,block}=setup([listing('idealista:1',['first-a','second-a'])]);
  sheet.rows[1][header.indexOf('Zu löschen')]=true;
  const result=ctx.cleanupMarkedListings_(ss);
  assert.equal(result.deleted,1);
  assert.equal(sheet.rows.length,1);
  assert.equal(block.rows[1][0],'idealista:1');
  assert.equal(ctx.cleanupMarkedListings_(ss).deleted,0);
});


test('schema migration removes Gesehen, keeps delete flag, inserts price score and preserves all listing IDs',()=>{
  const {ctx,ss,sheet}=setup([listing('idealista:999',['first-a'])]);
  // Recreate the exact pre-migration layout: Gesehen | Zu löschen | Punkte | E-Mail-Eingang.
  sheet.deleteColumn(3);
  sheet.rows[0].splice(0,0,'Gesehen');sheet.rows[1].splice(0,0,true);sheet.width++;
  sheet.rows[0][2]='Punkte';
  sheet.rows[1][2]=42;
  const originalId=sheet.rows[1][sheet.rows[0].indexOf('Datensatz-ID')];
  const migrated=ctx.ensureListingRatingSchema_(ss);
  assert.equal(migrated.ready,true);
  assert.equal(sheet.rows[0][0],'Zu löschen');
  assert.equal(sheet.rows[0][1],'Wohnungsbewertung (0–100)');
  assert.equal(sheet.rows[0][2],'Preisbewertung (0–100)');
  assert.equal(sheet.rows[0][3],'E-Mail-Eingang');
  assert.equal(sheet.rows[1][0],false);
  assert.equal(sheet.rows[1][1],'');
  assert.equal(sheet.rows[1][2],'');
  assert.equal(sheet.rows[1][sheet.rows[0].indexOf('Datensatz-ID')],originalId);
  assert.equal(ctx.ensureListingRatingSchema_(ss).ready,true);
  assert.equal(sheet.rows[0].filter(x=>x==='Preisbewertung (0–100)').length,1);
});
test('existing listings re-score from cached AI findings without model calls',()=>{
  const {ctx,ss,sheet}=setup([listing('idealista:77',['first-a','second-a'])]);
  const result=ctx.recalculateExistingListingScores_(ss,5);
  assert.equal(result.rescored,1);
  const values=sheet.rows[1],h=sheet.rows[0],json=JSON.parse(values[h.indexOf('Bildanalyse JSON')]);
  assert.equal(json.scoring.version,3);
  assert.ok(values[h.indexOf('Wohnungsbewertung (0–100)')]>=0);
  assert.ok(values[h.indexOf('Preisbewertung (0–100)')]>=0);
  assert.equal(ctx.recalculateExistingListingScores_(ss,5).rescored,0);
});
