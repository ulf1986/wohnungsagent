/**
 * Compact, non-destructive Anzeigen view for text-only apartment processing.
 *
 * Keep historical/technical columns physically present: import, deduplication,
 * Telegram and schema migrations still access them by header or legacy index.
 * Only the following headers are visible to the user.
 */
const LISTING_COMPACT_VIEW = Object.freeze({
  sheetName: 'Anzeigen',
  visible: [
    'Zu löschen',
    'Vorschaubild',
    'Titel',
    'Miete',
    'Fläche',
    'Miete pro m²',
    'Mietart / Laufzeit',
    'Mietprüfung',
    'Einschränkungen'
  ]
});

function applyCompactListingView_(ss) {
  const sheet = ss.getSheetByName(LISTING_COMPACT_VIEW.sheetName);
  if (!sheet) throw new Error('Pflichtblatt Anzeigen fehlt');
  const count = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, count).getValues()[0]
    .map(value => String(value || '').trim());
  const visible = new Set(LISTING_COMPACT_VIEW.visible);
  const missing = LISTING_COMPACT_VIEW.visible.filter(name => !headers.includes(name));
  if (missing.length) throw new Error('Kompakte Anzeigenansicht: Spalten fehlen: ' + missing.join(', '));
  // Only mutate intervals whose first column has the wrong visibility.
  // Group consecutive columns to minimize calls to the Sheets API.
  let changed = 0;
  for (let i = 0; i < count;) {
    const show = visible.has(headers[i]);
    let end = i + 1;
    while (end < count && visible.has(headers[end]) === show) end++;
    const first = i + 1, span = end - i;
    let wrong = false;
    for (let col = first; col < first + span; col++) {
      if (sheet.isColumnHiddenByUser(col) === show) {
        wrong = true;
        break;
      }
    }
    if (wrong) {
      if (show) sheet.showColumns(first, span);
      else sheet.hideColumns(first, span);
      changed++;
    }
    i = end;
  }
  return {visible: LISTING_COMPACT_VIEW.visible.length, columns: count, changedGroups: changed};
}
