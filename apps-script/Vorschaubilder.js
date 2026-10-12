/**
 * Vorschaubilder.gs – bis zu drei private Drive-Fotos je Anzeige.
 * Keine Freigabe oder Veröffentlichung von Drive-Dateien.
 * Läuft innerhalb des Locks der Gmail-Pipeline; separat auch manuell.
 */
const PREVIEW_CONFIG = {
  maxImages: 3,
  imageWidth: 68,
  imageHeight: 68,
  spacing: 7,
  offsetX: 6,
  offsetY: 10,
  columnWidth: 236,
  rowHeight: 88,
  marker: 'WOHNUNGSAGENT_PREVIEW'
};

function updateListingPreviews() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('Vorschaubilder: Skript ist bereits beschäftigt.');
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

  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
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

  const rows = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const statuses = [];
  const desired = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const listingId = String(row[idCol - 1] || '').trim();
    if (!listingId) {
      statuses.push(['']);
      continue;
    }
    let data;
    try {
      const raw = row[jsonCol - 1];
      data = raw ? JSON.parse(String(raw)) : {};
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('JSON muss ein Objekt enthalten');
      }
    } catch (error) {
      statuses.push(['JSON-Fehler']);
      console.warn('Vorschaubilder: Ungültiges JSON in Zeile ' + (i + 2));
      continue;
    }
    statuses.push([determineAiPreviewStatus(data)]);
    if (row[deleteCol - 1] === true) continue;
    const files = selectListingPreviewFiles(data.drive_files, PREVIEW_CONFIG.maxImages);
    for (let slot = 0; slot < files.length; slot++) {
      const file = files[slot];
      desired.push({
        listingId,
        rowNumber: i + 2,
        slot,
        file,
        marker: makePreviewMarker(listingId, slot, file.file_id)
      });
    }
  }

  sheet.setColumnWidth(previewCol, PREVIEW_CONFIG.columnWidth);
  sheet.getRange(2, aiCol, statuses.length, 1).setValues(statuses);
  sheet.getRange(2, aiCol, statuses.length, 1)
    .setHorizontalAlignment('center');

  const wantedByMarker = new Map(desired.map(item => [item.marker, item]));
  const retained = new Set();
  for (const image of sheet.getImages()) {
    const marker = String(image.getAltTextTitle() || '');
    if (!marker.startsWith(PREVIEW_CONFIG.marker + '|')) continue;
    const want = wantedByMarker.get(marker);
    const anchor = image.getAnchorCell();
    if (want && !retained.has(marker) &&
        anchor.getRow() === want.rowNumber &&
        anchor.getColumn() === previewCol) {
      retained.add(marker);
      positionPreviewImage(image, want.slot);
    } else {
      image.remove(); // ausschließlich eigene markierte Vorschaubilder
    }
  }

  let inserted = 0;
  let skipped = 0;
  for (const item of desired) {
    if (retained.has(item.marker)) continue;
    try {
      const file = DriveApp.getFileById(item.file.file_id);
      if (file.isTrashed()) throw new Error('Drive-Datei im Papierkorb');
      const blob = file.getBlob();
      const mime = String(blob.getContentType()).split(';')[0].toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/gif'].includes(mime)) {
        throw new Error('Nicht unterstütztes Format: ' + mime);
      }
      const x = PREVIEW_CONFIG.offsetX + item.slot *
        (PREVIEW_CONFIG.imageWidth + PREVIEW_CONFIG.spacing);
      const image = sheet.insertImage(blob, previewCol, item.rowNumber,
        x, PREVIEW_CONFIG.offsetY);
      positionPreviewImage(image, item.slot);
      image.setAltTextTitle(item.marker);
      image.setAltTextDescription(
        'Wohnungsagent ' + item.listingId + ', Foto ' + (item.slot + 1));
      inserted++;
    } catch (error) {
      skipped++;
      console.warn('Vorschaubild ' + item.listingId +
        ' / ' + (item.slot + 1) + ': ' + error.message);
    }
  }

  sheet.setRowHeights(2, rows.length, PREVIEW_CONFIG.rowHeight);
  SpreadsheetApp.flush();
  console.log('Vorschaubilder: ' + JSON.stringify({
    listings: rows.length,
    requestedImages: desired.length,
    retained: retained.size,
    inserted,
    skipped,
    statusesUpdated: statuses.length
  }));
}

function positionPreviewImage(image, slot) {
  image.setWidth(PREVIEW_CONFIG.imageWidth);
  image.setHeight(PREVIEW_CONFIG.imageHeight);
  image.setAnchorCellXOffset(PREVIEW_CONFIG.offsetX + slot *
    (PREVIEW_CONFIG.imageWidth + PREVIEW_CONFIG.spacing));
  image.setAnchorCellYOffset(PREVIEW_CONFIG.offsetY);
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
  const selected = [];
  const seen = new Set();
  for (const file of files) {
    if (!file || !file.file_id) continue;
    const source = String(file.source_url || '');
    const match = source.match(
      /\/id\.pro\.es\.image\.master\/(?:[a-f0-9]{2}\/){3}(\d+)\./i);
    const identity = match ? 'idealista:' + match[1]
      : 'drive:' + String(file.file_id);
    if (seen.has(identity)) continue;
    seen.add(identity);
    selected.push(file);
    if (selected.length >= limit) break;
  }
  return selected;
}

function makePreviewMarker(listingId, slot, fileId) {
  return [PREVIEW_CONFIG.marker, listingId, slot, fileId].join('|');
}
