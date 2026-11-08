const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('listing worker completes after text extraction, before image review', () => {
  const code = fs.readFileSync('apps-script/AIProcessing.js', 'utf8');
  const start = code.indexOf('function processAiQueueRow_(');
  const end = code.indexOf('function expireOldAiJobs_(', start);
  const active = code.slice(start, end);
  const migrate = active.indexOf('// Migration: finish old text-extracted jobs');
  const image = active.indexOf('const fileList = data.drive_files.filter(');
  assert.ok(migrate > 0 && image > migrate);
  assert.match(active.slice(0, image), /finalizeAiListing_\(sheet, listingRow, cols, data, emailFields\);\s*return \{ status: 'completed', listingId \};/);
  assert.match(active, /finalizeAiListing_\(sheet, listingRow, cols, data, checked.fields\)/);
  assert.doesNotMatch(code.slice(code.indexOf('function processNextAiListing('), code.indexOf('function reopenCompletedAiImageJobs_(')), /\breopenCompletedAiImageJobs_\(/);
});

test('Gmail import skips gallery and stores one preview per listing', () => {
  const code = fs.readFileSync('apps-script/GmailImport.js', 'utf8');
  const pipeline = code.slice(code.indexOf('function runGmailImagePipeline()'), code.indexOf('function sortListingsByMailReceived('));
  assert.doesNotMatch(pipeline, /downloadIdealistaGallery\(/);
  assert.doesNotMatch(pipeline, /processExistingListingImages\(\)/);
  assert.match(pipeline, /previewOwners\.has\(owner\)/);
});

test('Telegram displays only wanted rental facts and link', () => {
  const code = fs.readFileSync('scripts/telegram_listings.py', 'utf8');
  const card = code.slice(code.indexOf('def card(row):'), code.indexOf('def send(row):'));
  assert.match(card, /rent \/ area/);
  assert.match(card, /Einschränkungen/);
  assert.match(card, /Inserat öffnen/);
  assert.doesNotMatch(card, /Wohnungsbewertung|Preisbewertung|Zusammenfassung/);
});
