const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createEnvironment() {
  const source = fs.readFileSync('apps-script/GmailImport.js', 'utf8');
  const properties = new Map();
  const searches = [];
  const moved = [];
  const now = Date.now();
  function message(id, hoursOld) {
    let trash = false;
    return {
      getId: () => id,
      getDate: () => new Date(now - hoursOld * 3600000),
      isInTrash: () => trash,
      moveToTrash() { trash = true; moved.push(id); }
    };
  }
  let messages = [];
  const ctx = {
    PropertiesService: {getScriptProperties: () => ({
      getProperty: key => properties.get(key),
      setProperty: (key, value) => properties.set(key, value)
    })},
    GmailApp: {search: (q, offset, max) => {
      searches.push({q, offset, max});
      return [{getMessages: () => messages}];
    }},
    logImageDiagnostic() {},
    console
  };
  vm.runInNewContext(source + '\nthis.cleanup = cleanupQueuedSearchMailsAfterRetention_;', ctx);
  return {cleanup: ctx.cleanup, message, setMessages: x => {messages = x;}, searches, moved, properties, now};
}

test('only queued property alerts older than 48h are trashed', () => {
  const e = createEnvironment();
  e.setMessages([
    e.message('old-queued', 49),
    e.message('not-yet-48', 47.9),
    e.message('recent-queued', 12),
    e.message('unrelated-old', 240)
  ]);
  const toIso = hours => new Date(e.now - hours*3600000).toISOString();
  const queue = {
    'old-queued': {receivedAt: toIso(49),status:'blocked'},
    'not-yet-48': {receivedAt: toIso(47.9),status:'ready_for_ai'},
    'recent-queued': {receivedAt: toIso(12),status:'ready_for_ai'}
  };
  const result = e.cleanup(queue);
  assert.equal(result.moved, 1);
  assert.deepEqual(e.moved, ['old-queued']);
  assert.equal(e.searches.length, 2);
  assert.match(e.searches[0].q, /-in:trash/);
  assert.match(e.searches[1].q, /fotocasa/);
  assert.equal(e.cleanup(queue).status, 'not_due');
  assert.equal(e.searches.length, 2);
});

test('new queued emails never go straight to trash', () => {
  const source = fs.readFileSync('apps-script/GmailImport.js', 'utf8');
  assert.doesNotMatch(source, /trashQueuedSearchMail_\(/);
  assert.match(source, /retentionHours: 48/);
  assert.match(source, /cleanupQueuedSearchMailsAfterRetention_\(existing\)/);
});
