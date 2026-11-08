const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('compact listings shows only requested fields and keeps internal data intact', () => {
  const code = fs.readFileSync('apps-script/ListingsView.js', 'utf8');
  const context = vm.createContext({});
  vm.runInContext(code + '\nthis.apply = applyCompactListingView_;', context);
  const headers = [
    'Zu löschen', 'Wohnungsbewertung (0–100)', 'Preisbewertung (0–100)',
    'Miete pro m²', 'E-Mail-Eingang', 'Datensatz-ID', 'Vorschaubild',
    'Miete', 'Fläche', 'Anzeigenlink', 'Titel', 'Mietart / Laufzeit',
    'Mietprüfung', 'Einschränkungen', 'Bildanalyse JSON'
  ];
  const hidden = new Set();
  const sheet = {
    getLastColumn: () => headers.length,
    getRange: () => ({getValues: () => [headers]}),
    isColumnHiddenByUser: col => hidden.has(col),
    hideColumns: (start, span) => {for (let c = start; c < start + span; c++) hidden.add(c);},
    showColumns: (start, span) => {for (let c = start; c < start + span; c++) hidden.delete(c);}
  };
  const ss = {getSheetByName: name => name === 'Anzeigen' ? sheet : null};
  const first = context.apply(ss);
  assert.equal(first.visible, 10);
  assert.equal(hidden.has(headers.indexOf('Bildanalyse JSON') + 1), true);
  assert.equal(hidden.has(headers.indexOf('Wohnungsbewertung (0–100)') + 1), true);
  assert.equal(hidden.has(headers.indexOf('Anzeigenlink') + 1), true);
  for (const name of ['Miete', 'Fläche', 'Miete pro m²', 'Vorschaubild',
                       'Titel', 'E-Mail-Eingang', 'Mietprüfung', 'Einschränkungen']) {
    assert.equal(hidden.has(headers.indexOf(name) + 1), false, name);
  }
  assert.equal(context.apply(ss).changedGroups, 0);
});
