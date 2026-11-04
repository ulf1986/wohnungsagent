'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '../apps-script/AIProcessing.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const eligible = (rent, area) => context.hasListingHardLimitViolation_({rent_eur:rent,area_m2:area});

test('minimum area is 60 m²', () => {
  assert.equal(eligible(900, 59.9), true);
  assert.equal(eligible(900, 60), false);
  assert.equal(eligible(900, 61), false);
});

test('rent boundaries are inclusive', () => {
  assert.equal(eligible(799, 65), true);
  assert.equal(eligible(800, 65), false);
  assert.equal(eligible(1200, 65), false);
  assert.equal(eligible(1201, 65), true);
});

test('missing values are not treated as a numeric exclusion', () => {
  assert.equal(eligible(null, null), false);
  assert.equal(eligible('', ''), false);
});

test('eligibility classifier reflects numeric hard limits', () => {
  const f = {rent_eur:900,area_m2:59,rooms:2,long_term:true,seasonal_or_short_term:false};
  assert.equal(context.assessListingEligibility_(f, {}).status, 'Ausgeschlossen');
  f.area_m2=60;
  assert.equal(context.assessListingEligibility_(f, {}).status, 'Geeignet');
  f.rent_eur=799;
  assert.equal(context.assessListingEligibility_(f, {}).status, 'Ausgeschlossen');
  f.rent_eur=1201;
  assert.equal(context.assessListingEligibility_(f, {}).status, 'Ausgeschlossen');
});

test('provisional entries do not trigger an unverified notification', () => {
  const appendStart=source.indexOf('function appendListingRow_(');
  const notifyStart=source.indexOf('function notifyNewListing_(',appendStart);
  const append=source.slice(appendStart,notifyStart);
  assert.doesNotMatch(append,/\bnotifyNewListing_\s*\(/);
});
