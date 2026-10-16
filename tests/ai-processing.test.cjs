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

test('Málaga reference: price ratings are independent 0–100 integers',()=>{
  const values=[[10,100],[12,90],[14,75],[16.5,50],[18,30],[20,10],[22,0]];
  values.forEach(([price,rating])=>{
    assert.equal(call('scoreRentPerM2_('+(price*100)+',100)'),rating);
  });
  assert.equal(call('scoreRentPerM2_(1200, 80)'),65);
  assert.equal(call('scoreRentPerM2_(500,100)'),100);
  assert.equal(call('scoreRentPerM2_(2500,100)'),0);
  assert.equal(call('scoreRentPerM2_(1200,0)'),null);
  assert.equal(call('scoreRentPerM2_(null,80)'),null);
});
test('home rating uses photographs, terrace and pool, not rent or distance',()=>{
  const fn="calculateListingScore_";
  const img={images_actually_viewed:4,brightness:5,space:4,furniture_condition:5,care_renovation:5};
  const a=call(fn+"("+JSON.stringify({rent_eur:1000,area_m2:100,terrace:true,pool:false,distance_km_approx:1})+","+JSON.stringify(img)+")");
  assert.equal(a.priceScore,100);
  assert.equal(a.imagePoints,80);
  assert.equal(a.homeScore,90);
  assert.equal(a.coverage,100);
  const b=call(fn+"("+JSON.stringify({rent_eur:2200,area_m2:100,terrace:true,pool:false,distance_km_approx:9})+","+JSON.stringify(img)+")");
  assert.equal(b.homeScore,a.homeScore);
  assert.equal(b.priceScore,0);
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
