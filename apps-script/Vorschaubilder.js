/**
 * Ein echtes Zellbild pro Anzeige (Spalte "Vorschaubild").
 * Private Drive-Bilder werden per data:-URL eingebettet; keine Freigabe.
 * Bei jedem Durchlauf alle vorhandenen Anzeigen mit Datensatz-ID abgleichen.
 * Erst nach erfolgreichem Schreiben werden alte schwebende Bilder entfernt.
 */
const PREVIEW_CONFIG = {
  marker: 'WOHNUNGSAGENT_PREVIEW',
  columnWidth: 120,
  rowHeight: 92
};

function updateListingPreviews() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('Vorschaubilder: Skript bereits beschäftigt.');
    return;
  }
  try {
    updateListingPreviewsInternal();
  } finally {
    lock.releaseLock();
  }
}

function updateListingPreviewsInternal() {
  const sheet = SpreadsheetApp.openById(CONFIG.spreadsheetId)
    .getSheetByName(CONFIG.sheetName);
  if (!sheet) throw new Error('Anzeigen-Tabelle nicht gefunden.');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const column = name => {
    const index = headers.indexOf(name);
    if (index < 0) throw new Error('Spalte fehlt: ' + name);
    return index + 1;
  };
  const idCol = column('Datensatz-ID');
  const jsonCol = column('Bildanalyse JSON');
  const previewCol = column('Vorschaubild');
  const aiCol = column('KI-Bewertung');
  const deleteCol = column('Zu löschen');
  const rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const valid = new Set();
  const migrated = new Set();
  let inserted = 0, retained = 0, skipped = 0;

  // Kein Bulk-Schreiben auf leere Platzhalterzeilen.
  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const row = rows[i];
    const listingId = String(row[idCol - 1] || '').trim();
    if (!listingId) continue;
    valid.add(rowNumber);

    let data;
    try {
      data = JSON.parse(String(row[jsonCol - 1] || '{}'));
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('Bildanalyse JSON ist kein Objekt');
    } catch (error) {
      sheet.getRange(rowNumber, aiCol).setValue('JSON-Fehler');
      console.warn('Vorschaubilder: Zeile ' + rowNumber + ': ' + error.message);
      skipped++;
      continue;
    }
    sheet.getRange(rowNumber, aiCol).setValue(determineAiPreviewStatus(data));
    if (row[deleteCol - 1] === true) continue;

    const file = selectListingPreviewFiles(data.drive_files, 1)[0];
    if (!file) continue;
    const marker = [PREVIEW_CONFIG.marker, listingId, file.file_id].join('|');
    const cell = sheet.getRange(rowNumber, previewCol);
    const value = cell.getValue();

    if (value && value.valueType === SpreadsheetApp.ValueType.IMAGE &&
        value.getAltTextTitle() === marker) {
      retained++;
      migrated.add(rowNumber);
      continue;
    }

    try {
      const driveFile = DriveApp.getFileById(file.file_id);
      if (driveFile.isTrashed()) throw new Error('Datei im Papierkorb');
      const blob = driveFile.getBlob();
      const mime = String(blob.getContentType()).split(';')[0].toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/gif'].includes(mime))
        throw new Error('Bildformat nicht unterstützt: ' + mime);

      // SetSourceUrl akzeptiert auch Base64-data-URLs. Der Google-Drive-
      // Datei-Zugriff bleibt privat, ohne Freigabe oder öffentliche URL.
      const dataUrl = 'data:' + mime + ';base64,' +
        Utilities.base64Encode(blob.getBytes());
      const image = SpreadsheetApp.newCellImage()
        .setSourceUrl(dataUrl)
        .setAltTextTitle(marker)
        .setAltTextDescription('Wohnungsagent ' + listingId)
        .build();
      cell.setValue(image);
      SpreadsheetApp.flush();
      const confirmed = cell.getValue();
      if (!confirmed || confirmed.valueType !== SpreadsheetApp.ValueType.IMAGE)
        throw new Error('Zellbild nach Schreiben nicht nachweisbar');
      migrated.add(rowNumber);
      inserted++;
    } catch (error) {
      skipped++;
      console.warn('Zellbild ' + listingId + ': ' + error.message);
    }
  }

  // Alte schwebende Bilder NUR in der Vorschau-Spalte und erst dann
  // entfernen, wenn das zugehörige echte Zellbild geprüft wurde.
  let removed = 0;
  for (const image of sheet.getImages()) {
    const anchor = image.getAnchorCell();
    if (anchor.getColumn() !== previewCol) continue;
    if (!migrated.has(anchor.getRow())) continue;
    image.remove();
    removed++;
  }

  sheet.setColumnWidth(previewCol, PREVIEW_CONFIG.columnWidth);
  for (const rowNumber of valid) {
    sheet.setRowHeight(rowNumber, PREVIEW_CONFIG.rowHeight);
  }
  SpreadsheetApp.flush();
  console.log('Zellvorschaubilder: ' + JSON.stringify({
    listings: valid.size, inserted, retained, skipped,
    removedFloating: removed
  }));
}

function determineAiPreviewStatus(data) {
  const status = String(data.ai_analysis_status || '').toLowerCase();
  if (status === 'completed') return 'Abgeschlossen';
  if (status === 'pending') return 'Ausstehend';
  if (status === 'processing') return 'In Bearbeitung';
  if (status === 'retry' || status === 'error') return 'Fehler / erneut prüfen';
  const files = Array.isArray(data.drive_files) ? data.drive_files : [];
  return files.length ? 'Nicht bewertet' : 'Keine Fotos';
}

function selectListingPreviewFiles(files, limit) {
  if (!Array.isArray(files)) return [];
  const seen = new Set(), selected = [];
  for (const file of files) {
    if (!file || !file.file_id) continue;
    const identity = 'drive:' + String(file.file_id);
    if (seen.has(identity)) continue;
    seen.add(identity);
    selected.push(file);
    if (selected.length >= limit) break;
  }
  return selected;
}
