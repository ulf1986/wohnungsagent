const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const json = value => JSON.parse(JSON.stringify(value));
const events = logs => logs.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });

function context({ configuredFolder = true } = {}) {
  const logs = [], files = [], properties = new Map();
  const parentCalls = { read: 0, create: 0, search: 0 };
  if (configuredFolder) properties.set('WOHNUNGSAGENT_LOG_FOLDER_ID', 'folder-test');
  const folder = {
    getId: () => 'folder-test',
    createFile(name, content, mime) {
      const file = {
        name, content, mime, writes: 1,
        getId: () => 'log-' + files.indexOf(file),
        getUrl: () => 'https://drive.google.com/file/d/' + file.getId() + '/view',
        setContent(next) { file.content = next; file.writes++; return file; }
      };
      files.push(file); return file;
    }
  };
  const parent = {
    getFoldersByName(name) {
      assert.equal(name, 'Wohnungsagent – Logs'); parentCalls.search++;
      return { hasNext: () => false };
    },
    createFolder(name) { assert.equal(name, 'Wohnungsagent – Logs'); parentCalls.create++; return folder; }
  };
  const ctx = vm.createContext({
    console: { log: text => logs.push(text), warn: text => logs.push(text), error: text => logs.push(text) },
    CONFIG: { spreadsheetId: 'sheet-current', sheetName: 'Anzeigen' },
    SpreadsheetApp: { openById() { throw new Error('Logging must never open a spreadsheet'); } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: name => properties.get(name) || '',
      setProperty(name, value) { properties.set(name, value); return this; }
    }) },
    DriveApp: {
      getFolderById: id => { assert.equal(id, 'folder-test'); return folder; },
      getFileById: id => {
        parentCalls.read++;
        assert.equal(id, ctx.expectedSheetId || 'sheet-current');
        return { getParents: () => ({ hasNext: () => true, next: () => parent }) };
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Diagnostics.js'), 'utf8'), ctx);
  return { ctx, logs, files, folder, properties, parentCalls };
}

test('file and console logs identify implementation, target sheet and the same run', () => {
  const { ctx, logs, files, properties } = context();
  ctx.beginImageDiagnostics('test');
  ctx.logImageDiagnostic('mail_extract', { mail_id: 'gmail-123', listing_id: 'pisos:456', images: 1 });
  ctx.finishImageDiagnostics();
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^wohnungsagent_.*\.jsonl$/);
  assert.equal(files[0].mime, 'text/plain');
  assert.ok(files[0].content.endsWith('\n'));
  const stored = files[0].content.trim().split('\n').map(JSON.parse);
  assert.deepEqual(stored.map(e => e.stage), ['run_start', 'mail_extract', 'run_end']);
  assert.ok(stored.every(e => e.schema_version === 2 && e.spreadsheet_id === 'sheet-current'));
  assert.ok(stored.every(e => e.implementation === 'image-import-1.x'));
  assert.ok(stored.every(e => e.run_id === stored[0].run_id));
  assert.equal(stored[1].mail_id, 'gmail-123');
  assert.equal(properties.get('WOHNUNGSAGENT_LAST_LOG_FILE_ID'), files[0].getId());
  assert.ok(events(logs).some(e => e.stage === 'log_file' && e.file_id === files[0].getId()));
});

test('V2 resolver wins over legacy fallback and is recorded without accessing sheet cells', () => {
  const { ctx, files } = context();
  ctx.getWohnungsagentSpreadsheetId_ = () => 'sheet-v2';
  vm.runInContext('const AI_PIPELINE = {}', ctx);
  ctx.beginImageDiagnostics('audit_only'); ctx.finishImageDiagnostics();
  const start = JSON.parse(files[0].content.split('\n')[0]);
  assert.equal(start.implementation, 'wohnungsagent-2.0');
  assert.equal(start.spreadsheet_id, 'sheet-v2');
});

test('structured logs redact URL queries and credentials and correlate different sources', () => {
  const { ctx, files } = context();
  ctx.beginImageDiagnostics('test');
  vm.runInContext("imageDiagnosticRun.mailId = 'gmail-123'", ctx);
  ctx.logImageDiagnostic('image_http', {
    source_url: 'https://images.test/photo?token=private-one', http_status: 404,
    body: 'PRIVATE MAIL BODY', token: 'PRIVATE TOKEN', status: 'failed',
    error: 'Fetch https://tracker.test/click?email=private#fragment Bearer private-token sk-privatekey failed'
  });
  ctx.logImageDiagnostic('image_http', { source_url: 'https://images.test/photo?token=private-two' });
  ctx.finishImageDiagnostics();
  const stored = files[0].content.trim().split('\n').map(JSON.parse);
  assert.equal(stored[1].mail_id, 'gmail-123');
  assert.equal(stored[1].details.source_url, 'https://images.test/photo');
  assert.equal(stored[1].details.http_status, 404);
  assert.notEqual(stored[1].details.source_key, stored[2].details.source_key);
  assert.ok(!files[0].content.includes('private'));
  assert.ok(!files[0].content.includes('PRIVATE'));
});

test('a start checkpoint survives interrupted runs and errors are saved immediately', () => {
  const { ctx, files } = context();
  ctx.beginImageDiagnostics('test');
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].content.trim().split('\n').map(JSON.parse).map(e => e.stage), ['run_start']);
  ctx.logImageDiagnostic('download', { level: 'ERROR', error: 'HTTP 503', status: 'failed' });
  assert.equal(files[0].writes, 2);
  assert.equal(JSON.parse(files[0].content.trim().split('\n').at(-1)).stage, 'download');
  assert.ok(!files[0].content.includes('"stage":"run_end"')); // No false completed marker.
});

test('successful stages checkpoint and finished runs have an explicit warning summary', () => {
  const { ctx, files } = context();
  ctx.beginImageDiagnostics('test');
  ctx.runImageDiagnosticStage('extract', () => ctx.logImageDiagnostic('item', { level: 'WARN', status: 'no_photo' }));
  assert.equal(JSON.parse(files[0].content.trim().split('\n').at(-1)).stage, 'extract');
  ctx.finishImageDiagnostics();
  const end = JSON.parse(files[0].content.trim().split('\n').at(-1));
  assert.equal(end.status, 'finished_with_warnings');
  assert.equal(end.details.warnings, 1);
  assert.equal(vm.runInContext('imageDiagnosticRun', ctx), null);
});

test('event cap keeps run_end and reports dropped records without unbounded file growth', () => {
  const { ctx, files } = context();
  vm.runInContext('IMAGE_DIAGNOSTICS.maxEvents = 10; IMAGE_DIAGNOSTICS.checkpointEvery = 5', ctx);
  ctx.beginImageDiagnostics('test');
  for (let i = 0; i < 30; i++) ctx.logImageDiagnostic('event', { count: i });
  ctx.finishImageDiagnostics();
  const stored = files[0].content.trim().split('\n').map(JSON.parse);
  assert.equal(stored.length, 10);
  assert.equal(stored.at(-1).stage, 'run_end');
  assert.ok(stored.at(-1).details.dropped > 0);
  assert.equal(files[0].writes, 3); // Start, event 5, finish.
});

test('every run creates its own file and never appends to another run', () => {
  const { ctx, files } = context();
  ctx.beginImageDiagnostics('first'); ctx.finishImageDiagnostics();
  const firstContent = files[0].content;
  ctx.beginImageDiagnostics('second'); ctx.finishImageDiagnostics();
  assert.equal(files.length, 2);
  assert.notEqual(files[0].name, files[1].name);
  assert.equal(files[0].content, firstContent);
});

test('log folder is created alongside the actual target sheet once and reused', () => {
  const { ctx, properties, parentCalls } = context({ configuredFolder: false });
  ctx.getWohnungsagentSpreadsheetId_ = () => 'sheet-v2';
  ctx.expectedSheetId = 'sheet-v2';
  ctx.beginImageDiagnostics('first'); ctx.finishImageDiagnostics();
  ctx.beginImageDiagnostics('second'); ctx.finishImageDiagnostics();
  assert.equal(properties.get('WOHNUNGSAGENT_LOG_FOLDER_ID'), 'folder-test');
  assert.equal(parentCalls.read, 1);
  assert.equal(parentCalls.search, 1);
  assert.equal(parentCalls.create, 1);
});

test('Drive failures do not mask processing errors; a failed checkpoint can retry', () => {
  const { ctx, logs, folder, files } = context();
  const create = folder.createFile;
  folder.createFile = () => { throw new Error('Drive unavailable'); };
  assert.doesNotThrow(() => ctx.beginImageDiagnostics('test'));
  assert.throws(() => ctx.runImageDiagnosticStage('download', () => { throw new Error('HTTP 503'); }), /HTTP 503/);
  folder.createFile = create;
  ctx.finishImageDiagnostics();
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(files[0].content.trim().split('\n').at(-1)).status, 'finished_with_errors');
  assert.ok(logs.some(line => line.includes('Logdatei nicht gespeichert')));
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
  const statuses = events(logs).map(e => e.status);
  for (const status of [
    'source_email_mismatch', 'file_listing_mismatch', 'completed_with_unanalyzed_files',
    'duplicate_listing_id', 'invalid_json'
  ]) assert.ok(statuses.includes(status));
  assert.equal(JSON.stringify(rows), before);
});

test('manual audit releases its lock, writes only a logfile and uses no download service', () => {
  const { ctx, files } = context();
  let released = 0;
  ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => released++ }) };
  ctx.SpreadsheetApp = { openById: () => ({
    getSheetByName: name => {
      assert.equal(name, 'Anzeigen');
      return { getLastRow: () => 1 };
    }
  }) };
  assert.deepEqual(json(ctx.runImageDiagnostics()), { checked: 0, issues: 0 });
  assert.equal(released, 1);
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(files[0].content.trim().split('\n').at(-1)).stage, 'run_end');
});
