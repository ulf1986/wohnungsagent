const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

function context() {
  const logs = [];
  const ctx = vm.createContext({
    console: { log: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text) },
    CONFIG: { spreadsheetId: 'test', sheetName: 'Anzeigen' }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Diagnostics.js'), 'utf8'), ctx);
  return { ctx, logs };
}
const json = value => JSON.parse(JSON.stringify(value));

function sink(initialRows = []) {
  const rows = initialRows.map(r => [...r]);
  let maxRows = 1;
  const sheet = {
    getRange(row, col, height = 1, width = 1) {
      return {
        getValues: () => Array.from({ length: height }, (_, i) =>
          Array.from({ length: width }, (_, j) => rows[row + i - 1]?.[col + j - 1] || '')),
        setValues(values) { values.forEach((r, i) => {
          rows[row + i - 1] ||= [];
          r.forEach((v, j) => { rows[row + i - 1][col + j - 1] = v; });
        }); }
      };
    },
    getLastRow: () => rows.length, getMaxRows: () => maxRows,
    insertRowsAfter(at, count) { maxRows += count; },
    setFrozenRows() {}, deleteRows(start, count) { rows.splice(start - 1, count); }
  };
  return { rows, sheet };
}

test('structured logs redact URL queries, omit mail content and correlate different sources', () => {
  const { ctx, logs } = context();
  ctx.beginImageDiagnostics('test');
  vm.runInContext("imageDiagnosticRun.mailId = 'gmail-123'", ctx);
  ctx.logImageDiagnostic('image_http', {
    source_url: 'https://images.test/photo?token=private-one', http_status: 404,
    body: 'PRIVATE MAIL BODY', token: 'PRIVATE TOKEN', status: 'failed',
    error: 'Fetch https://tracker.test/click?email=private#fragment failed'
  });
  ctx.logImageDiagnostic('image_http', { source_url: 'https://images.test/photo?token=private-two' });
  const events = logs.map(line => JSON.parse(line));
  assert.equal(events[1].mail_id, 'gmail-123');
  assert.equal(events[1].run_id, events[0].run_id);
  assert.equal(events[1].details.source_url, 'https://images.test/photo');
  assert.equal(events[1].details.http_status, 404);
  assert.notEqual(events[1].details.source_key, events[2].details.source_key);
  assert.ok(!logs.join('').includes('private'));
  assert.ok(!logs.join('').includes('PRIVATE'));
});

test('bounded sheet output keeps run_end, counts dropped records and uses one batch', () => {
  const { ctx } = context(), output = sink();
  let inserted = 0;
  ctx.SpreadsheetApp = { openById: () => ({
    getSheetByName: () => null,
    insertSheet: name => { assert.equal(name, 'Diagnose'); inserted++; return output.sheet; }
  }) };
  ctx.beginImageDiagnostics('test');
  for (let i = 0; i < 300; i++) ctx.logImageDiagnostic('event', { count: i });
  ctx.finishImageDiagnostics();
  assert.equal(inserted, 1);
  assert.equal(output.rows.length, 251); // Header plus 250 bounded events.
  assert.equal(output.rows.at(-1)[2], 'run_end');
  assert.ok(JSON.parse(output.rows.at(-1)[8]).dropped > 0);
  assert.equal(vm.runInContext('imageDiagnosticRun', ctx), null);
});

test('diagnostic retention deletes only oldest diagnostic rows and preserves the header', () => {
  const { ctx } = context(), output = sink();
  ctx.SpreadsheetApp = { openById: () => ({
    getSheetByName: () => output.rows.length ? output.sheet : null,
    insertSheet: () => output.sheet
  }) };
  vm.runInContext('IMAGE_DIAGNOSTICS.maxRows = 3', ctx);
  ctx.beginImageDiagnostics('first'); ctx.finishImageDiagnostics();
  const header = [...output.rows[0]];
  ctx.beginImageDiagnostics('second'); ctx.finishImageDiagnostics();
  assert.equal(output.rows.length, 4);
  assert.deepEqual(output.rows[0], header);
  assert.equal(output.rows.at(-1)[2], 'run_end');
});

test('a sheet failure cannot mask a processing error or retain stale run state', () => {
  const { ctx, logs } = context();
  ctx.SpreadsheetApp = { openById: () => { throw new Error('sink unavailable'); } };
  ctx.beginImageDiagnostics('test');
  assert.throws(() => ctx.runImageDiagnosticStage('download', () => { throw new Error('HTTP 503'); }), /HTTP 503/);
  assert.doesNotThrow(() => ctx.finishImageDiagnostics());
  assert.equal(vm.runInContext('imageDiagnosticRun', ctx), null);
  const end = logs.map(line => { try { return JSON.parse(line); } catch {} }).find(e => e?.stage === 'run_end');
  assert.equal(end.status, 'finished_with_errors');
  assert.equal(end.details.errors, 1);
});

test('unrecognized Diagnose headers are preserved and never overwritten', () => {
  const { ctx } = context(), output = sink([['unrelated content']]);
  const before = JSON.stringify(output.rows);
  ctx.SpreadsheetApp = { openById: () => ({ getSheetByName: () => output.sheet }) };
  ctx.beginImageDiagnostics('test'); ctx.finishImageDiagnostics();
  assert.equal(JSON.stringify(output.rows), before);
});

test('audit reports provenance, file ownership, completion, duplicate and malformed JSON without writes', () => {
  const { ctx, logs } = context();
  const rows = [
    ['Datensatz-ID', 'E-Mail-ID', 'Bildanalyse JSON'],
    ['fotocasa:1', 'mail-a', JSON.stringify({
      source_email_id: 'mail-b', ai_analysis_status: 'completed',
      drive_files: [{ file_id: 'file-a', listing_id: 'idealista:2' }], analyzed_file_ids: []
    })],
    ['fotocasa:1', 'mail-c', '{broken'],
    ['idealista:2', 'mail-d', JSON.stringify({
      source_email_id: 'mail-d', ai_analysis_status: 'completed',
      drive_files: [{ file_id: 'file-d', listing_id: 'idealista:2' }], analyzed_file_ids: ['file-d']
    })]
  ];
  const before = JSON.stringify(rows);
  const ss = { getSheetByName: () => ({
    getLastRow: () => rows.length, getLastColumn: () => rows[0].length,
    getRange: () => ({ getValues: () => rows.map(r => [...r]) })
  }) };
  const result = ctx.auditListingImageAssignments(ss);
  assert.deepEqual(json(result), { checked: 3, issues: 5 });
  const statuses = logs.map(line => JSON.parse(line).status);
  for (const status of [
    'source_email_mismatch', 'file_listing_mismatch', 'completed_with_unanalyzed_files',
    'duplicate_listing_id', 'invalid_json'
  ]) assert.ok(statuses.includes(status));
  assert.equal(JSON.stringify(rows), before);
});

test('manual audit releases its lock and touches no download or business-write services', () => {
  const { ctx } = context(), output = sink();
  let released = 0;
  const listings = { getLastRow: () => 1 };
  ctx.LockService = { getScriptLock: () => ({
    tryLock: () => true, releaseLock: () => released++
  }) };
  ctx.SpreadsheetApp = { openById: () => ({
    getSheetByName: name => name === 'Anzeigen' ? listings : output.rows.length ? output.sheet : null,
    insertSheet: name => { assert.equal(name, 'Diagnose'); return output.sheet; }
  }) };
  assert.deepEqual(json(ctx.runImageDiagnostics()), { checked: 0, issues: 0 });
  assert.equal(released, 1);
  assert.equal(output.rows.at(-1)[2], 'run_end');
});

