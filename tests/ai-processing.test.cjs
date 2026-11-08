const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { getMailListingId: (url) => { const match = String(url || '').match(/listing\/([^/?#]+)/); return match ? 'idealista:' + match[1] : ''; } };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../apps-script/AIProcessing.js'), 'utf8'),
  context,
  { filename: 'AIProcessing.js' }
);
const call = (expression) => vm.runInContext(expression, context);

test('monthly rent per square metre retains full precision and rejects missing or invalid inputs',()=>{
  assert.equal(context.listingRentPerSquareMeter_(1200,80),15);
  assert.equal(context.listingRentPerSquareMeter_(1234,73),1234/73);
  assert.equal(context.listingRentPerSquareMeter_('1200','80'),15);
  for(const invalid of ['',null,undefined,0,-1,Infinity,NaN,true,'Unbekannt']){
    assert.equal(context.listingRentPerSquareMeter_(1200,invalid),'');
    assert.equal(context.listingRentPerSquareMeter_(invalid,80),'');
  }
});

test('unit price mirrors price colors while preserving other gradient ranges and cell values',()=>{
  const range=(col,width)=>({getColumn:()=>col,getNumColumns:()=>width,getRow:()=>2,getNumRows:()=>5,col,width});
  const sourceRule={getGradientCondition:()=>({}),getRanges:()=>[range(2,3),range(11,1)],
    copy:()=>({setRanges(ranges){this.ranges=ranges;return this;},build(){return this;}})};
  const other={getGradientCondition:()=>null};let rules,colors;
  const sheet={getLastColumn:()=>11,getLastRow:()=>6,getConditionalFormatRules:()=>[sourceRule,other],
    setConditionalFormatRules:r=>{rules=r;},getRange:(row,col,n=1,m=1)=>row===1?
      {getValues:()=>[['Zu löschen','Wohnungsbewertung (0–100)','Preisbewertung (0–100)','Miete pro m²']]}:
      {...range(col,m),getBackgrounds:()=>[['#ff0000'],['#ffff00'],['#00ff00'],['#ffffff'],['#112233']],setBackgrounds:c=>{colors=c;}}};
  context.SpreadsheetApp={flush(){},InterpolationType:{NUMBER:'NUMBER'},newConditionalFormatRule:()=>({
    setGradientMinpointWithValue(color,type,value){this.min={color,type,value};return this;},
    setGradientMidpointWithValue(color,type,value){this.mid={color,type,value};return this;},
    setGradientMaxpointWithValue(color,type,value){this.max={color,type,value};return this;},
    setRanges(ranges){this.ranges=ranges;return this;},build(){return this;}})};
  context.syncListingUnitPriceColors_(sheet);
  assert.deepEqual(JSON.parse(JSON.stringify(rules[0].ranges.map(r=>[r.col,r.width]))),[[11,1]]);
  assert.equal(rules[2].ranges[0].col,2);assert.equal(rules[2].ranges[0].width,2);
  assert.equal(rules[2].min.color,'#f47f57');assert.equal(rules[2].min.value,'35');
  assert.equal(rules[2].mid.value,'50');assert.equal(rules[2].max.value,'75');
  assert.equal(rules[1],other);assert.deepEqual(colors,[['#ff0000'],['#ffff00'],['#00ff00'],['#ffffff'],['#112233']]);
});

test('updated listing facts immediately refresh the separate numeric unit rent column',()=>{
  const headers=['Miete','Fläche','Miete pro m²','Titel','Status','Mietprüfung'],values=[1200,80,'','','',''],formats={};
  const sheet={getRange:(_,c)=>({getValue:()=>values[c-1],setValue:v=>{values[c-1]=v;},setNumberFormat:f=>{formats[c-1]=f;}})};
  const cols=Object.fromEntries(headers.map((h,i)=>[h,i]));
  context.applyListingFields_(sheet,2,cols,{rent_eur:1500,area_m2:100},'email');
  assert.equal(values[2],15);assert.equal(formats[2],'0.00" €/m²"');
  context.applyListingFields_(sheet,2,cols,{area_m2:0},'listing_page');
  assert.equal(values[2],'');
});

test('Málaga reference: price ratings are independent 0–100 integers',()=>{
  const values=[[5,100],[8,94],[10,86],[12,76],[14,64],[16.5,50],[18,43],[20,34],[22,26],[25,17],[30,9],[40,0]];
  values.forEach(([price,rating])=>{
    assert.equal(call('scoreRentPerM2_('+(price*100)+',100)'),rating);
  });
  assert.equal(call('scoreRentPerM2_(1200, 80)'),58);
  assert.equal(call('scoreRentPerM2_(500,100)'),100);
  assert.equal(call('scoreRentPerM2_(2500,100)'),17);
  assert.equal(call('scoreRentPerM2_(1200,0)'),null);
  assert.equal(call('scoreRentPerM2_(null,80)'),null);
});
test('home rating uses photographs, terrace and pool, not rent or distance',()=>{
  const fn="calculateListingScore_";
  const img={images_actually_viewed:4,brightness:5,space:4,furniture_condition:5,care_renovation:5};
  const a=call(fn+"("+JSON.stringify({rent_eur:1000,area_m2:100,terrace:true,pool:false,distance_km_approx:1})+","+JSON.stringify(img)+")");
  assert.equal(a.priceScore,86);
  assert.equal(a.imagePoints,80);
  assert.equal(a.homeScore,90);
  assert.equal(a.coverage,100);
  const b=call(fn+"("+JSON.stringify({rent_eur:2200,area_m2:100,terrace:true,pool:false,distance_km_approx:9})+","+JSON.stringify(img)+")");
  assert.equal(b.homeScore,a.homeScore);
  assert.equal(b.priceScore,26);
  const unknown=call(fn+"({rent_eur:null,area_m2:null,terrace:null,pool:null}, {})");
  assert.equal(unknown.homeScore,null);
  assert.equal(unknown.priceScore,null);
  const noAmenities=call(fn+"({terrace:null,pool:null}, "+JSON.stringify(img)+")");
  assert.equal(noAmenities.coverage,85);
  assert.ok(noAmenities.homeScore>=0 && noAmenities.homeScore<=100);
});

test('rental checks only exclude explicit rule violations', () => {
  assert.match(call(`rentalDecision_({rent_eur:799,long_term:true})`), /unter 800/);
  assert.match(call(`rentalDecision_({rent_eur:1000,student_only:true})`), /Studierende/);
  assert.match(call(`rentalDecision_({rent_eur:1000,seasonal_or_short_term:true})`), /Kurzzeitmiete/);
  assert.equal(call(`rentalDecision_({rent_eur:1000,long_term:true})`), 'Langzeitmiete belegt');
  assert.equal(call(`rentalDecision_({rent_eur:null,long_term:null})`), 'Langzeitmiete offen');
});

test('image batch validation rejects missing, duplicate and out-of-range image scores', () => {
  const valid = {images:[{index:1,brightness:4,space:3,furniture_condition:4,care_renovation:5}]};
  assert.doesNotThrow(() => call(`validateImageReview_(${JSON.stringify(valid)},1)`));
  assert.throws(() => call(`validateImageReview_(${JSON.stringify({images:[]})},1)`), /für jedes Bild/);
  const invalid = {images:[{index:1,brightness:6,space:3,furniture_condition:4,care_renovation:5}]};
  assert.throws(() => call(`validateImageReview_(${JSON.stringify(invalid)},1)`), /Bildpunktwert/);
});

test('multi-listing image selection excludes unassigned and other-listing files', () => {
  const files = [
    {file_id:'a',listing_id:'idealista:1',name:'preview.jpg'},
    {file_id:'b',listing_id:'idealista:2',name:'preview2.jpg'},
    {file_id:'c',name:'idealista_1_01.jpg'},
    {file_id:'d',name:'mail_message_01.jpg'},
    {file_id:'e',listing_url:'https://example.test/listing/1'}
  ];
  assert.deepEqual(Array.from(call(`filterListingDriveFiles_(${JSON.stringify(files)}, 'idealista:1', false)`).map(file => file.file_id)), ['a','c','e']);
  assert.deepEqual(Array.from(call(`filterListingDriveFiles_(${JSON.stringify(files)}, 'idealista:1', true)`).map(file => file.file_id)), ['a','c','d','e']);
});


test('essential numeric fallback accepts only one clearly quoted price and area',()=>{
  assert.equal(context.recoverQuotedEssential_('Alquiler: 1.150 €/mes','rent_eur').value,1150);
  assert.equal(context.recoverQuotedEssential_('Superficie construida: 58 m²','area_m2').value,58);
  assert.equal(context.recoverQuotedEssential_('Superficie construida: 75 m²; jardín 20 m²','area_m2').value,75);
  assert.equal(context.recoverQuotedEssential_('80 m² construidos y 5 m² terraza','area_m2').value,80);
  assert.equal(context.recoverQuotedEssential_('Precio 1.100 €','rent_eur').value,1100);
  assert.equal(context.recoverQuotedEssential_('80 m² y 60 m²','area_m2'),null);
  assert.equal(context.recoverQuotedEssential_('1.000 €/mes o 1.250 €/mes','rent_eur'),null);
  assert.equal(context.recoverQuotedEssential_('3 hab. sin precio','rent_eur'),null);
});

test('listing summary is capped without changing short texts',()=>{
  assert.equal(context.compactListingSummary_('Hell und modern.'),'Hell und modern.');
  assert.ok(context.compactListingSummary_('Ein heller Raum. '+('Gut geschnitten. '.repeat(40))).length<=220);
});
