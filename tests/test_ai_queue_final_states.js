const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('apps-script/AIProcessing.js', 'utf8');
const saved = [];
const ctx = {
  SpreadsheetApp: {flush() {}},
  logImageDiagnostic() {},
  console,
  Date,
  Math,
  Number,
  String
};
vm.createContext(ctx);
vm.runInContext(source + '\nthis.__test = {scheduleAiRetry_, expireOldAiJobs_};', ctx);

const ix = {status: 17, error: 18, updated: 19, listingId: 20,
  retryAt: 21, attempts: 22};
const qi = {'Queue Bildstatus': 14, 'Queue Eingang UTC': 8, 'Queue Gmail-ID': 7};

function mockSheet() {
  const cells = new Map();
  function key(r, c) { return r + ':' + c; }
  return {
    cells,
    getRange(row, col, height = 1, width = 1) {
      return {
        getValue() { return cells.get(key(row, col)); },
        setValue(v) { cells.set(key(row, col), v); },
        setValues(matrix) {
          for (let r = 0; r < height; r++)
            for (let c = 0; c < width; c++)
              cells.set(key(row + r, col + c), matrix[r][c]);
        }
      };
    },
    value(r, c) { return cells.get(key(r, c)); }
  };
}

test('two definite failures become failed_final without a third AI request', () => {
  const sheet = mockSheet();
  const statuses = [];
  for (let k = 0; k < 3; k++) {
    const result = ctx.__test.scheduleAiRetry_(sheet, 2, ix, 'HTTP 500', 'exception');
    statuses.push(result.status);
    assert.equal(result.attempts, k + 1);
  }
  assert.deepEqual(statuses, ['retry', 'failed_final', 'failed_final']);
  assert.equal(sheet.value(2, ix.status + 1), 'failed_final');
  assert.equal(sheet.value(2, ix.retryAt + 1), '');
  assert.match(sheet.value(2, ix.error + 1), /Endgültig nach 2 Fehlversuchen/);
});

test('expiry affects only old unfinished AI jobs, never uncertain operations', () => {
  const sheet = mockSheet();
  const now = Date.parse('2026-11-08T09:00:00Z');
  function row(mail, age, aiState) {
    const values = Array(29).fill('');
    values[qi['Queue Gmail-ID']] = mail;
    values[qi['Queue Eingang UTC']] = new Date(now - age * 3600000).toISOString();
    values[qi['Queue Bildstatus']] = 'ready_for_ai';
    values[ix.status] = aiState;
    return values;
  }
  const entries = [
    row('old', 49, 'retry'),
    row('uncertain', 51, 'needs_review'),
    row('completed', 55, 'completed'),
    row('recent', 2, 'pending'),
  ];
  const expired = ctx.__test.expireOldAiJobs_(sheet, entries, ix, qi, now);
  assert.equal(expired, 1);
  assert.equal(sheet.value(2, ix.status + 1), 'expired');
  assert.equal(sheet.value(3, ix.status + 1), undefined);
  assert.equal(sheet.value(4, ix.status + 1), undefined);
  assert.equal(sheet.value(5, ix.status + 1), undefined);
});
