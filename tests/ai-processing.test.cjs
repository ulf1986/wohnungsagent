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
  assert.equal(call('scoreRentPerM2_(1000, 100)'), 40);
  assert.equal(call('scoreRentPerM2_(1600, 100)'), 16);
  assert.equal(call('scoreRentPerM2_(2000, 100)'), 0);
  assert.equal(call('scoreRentPerM2_(500, 100)'), 40);
  assert.equal(call('scoreRentPerM2_(3000, 100)'), 0);
  assert.equal(call('scoreRentPerM2_(1000, 0)'), null);
});

test('distance score is capped at 25 through 1 km and falls linearly to zero at 8 km', () => {
  assert.equal(call('scoreDistanceKm_(0.5)'), 25);
  assert.equal(call('scoreDistanceKm_(1)'), 25);
  assert.equal(call('scoreDistanceKm_(1.8)'), 22);
  assert.equal(call('scoreDistanceKm_(8)'), 0);
  assert.equal(call('scoreDistanceKm_(9)'), 0);
  assert.equal(call('scoreDistanceKm_(null)'), null);
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
