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

test('rent score is linear from 10 to 20 EUR per m2 and integer-rounded', () => {
  assert.equal(call('scoreRentPerM2_(1000, 100)'), 55);
  assert.equal(call('scoreRentPerM2_(1600, 100)'), 22);
  assert.equal(call('scoreRentPerM2_(2000, 100)'), 0);
  assert.equal(call('scoreRentPerM2_(500, 100)'), 55);
  assert.equal(call('scoreRentPerM2_(3000, 100)'), 0);
  assert.equal(call('scoreRentPerM2_(1000, 0)'), null);
});

test('score excludes distance and combines rent, image, terrace and pool', () => {
  const score=call("calculateListingScore_({rent_eur:1000,area_m2:100,terrace:true,pool:false}, {images_actually_viewed:3,brightness:5,space:4,furniture_condition:5,care_renovation:5})");
  assert.equal(score.rentPoints,55);
  assert.equal(score.imagePoints,28);
  assert.equal(score.terracePoints,10);
  assert.equal(score.poolPoints,0);
  assert.equal(score.coverage,100);
  assert.equal(score.total,93);
  const far=call("calculateListingScore_({rent_eur:1000,area_m2:100,terrace:true,pool:false,distance_km_approx:9}, {images_actually_viewed:3,brightness:5,space:4,furniture_condition:5,care_renovation:5})");
  assert.equal(far.total,score.total);
  const unknown=call("calculateListingScore_({rent_eur:null,area_m2:null,terrace:null,pool:null}, {})");
  assert.equal(unknown.coverage,0);
  assert.equal(unknown.total,0);
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
