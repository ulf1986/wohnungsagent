
/**
 * Main.gs
 * Wohnungsagent – bestehende Anzeigen und Bilder
 */

const CONFIG = {
  spreadsheetId:
    '1_X-jdVIKwbqDABIssOOCjLC41qRqpb01paV1RtruMwg',
  sheetName: 'Anzeigen',
  folderProperty: 'WOHNUNGSAGENT_IMAGE_FOLDER_ID',
  maxImagesPerListing: 40,
  processingTimeoutMinutes: 20,
  retryDelayMinutes: 30,

  providers: {
    fotocasa: extractFotocasaImages,
    idealista: extractIdealistaImages,
    yaencontre: extractYaencontreImages,
    pisos: extractPisosImages,
    immoscout: extractImmoScoutImages
  }
};

/**
 * Importiert Bilddateien der bereits bekannten Anzeigen.
 * Kann manuell ausgeführt werden.
 */
function runImageImport() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    console.log('Bildimport läuft bereits.');
    return;
  }

  try {
    console.log(JSON.stringify(
      processExistingListingImages()
    ));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Kann auch innerhalb der Gmail-Pipeline aufgerufen
 * werden, wenn diese den Skript-Lock bereits besitzt.
 */
function processExistingListingImages() {
  const sheet = SpreadsheetApp
    .openById(getWohnungsagentSpreadsheetId_())
    .getSheetByName(CONFIG.sheetName);

  if (!sheet) {
    throw new Error('Tabellenblatt Anzeigen fehlt.');
  }

  const headers = sheet.getRange(
    1, 1, 1, sheet.getLastColumn()
  ).getValues()[0];

  const idCol = requireImageColumn(
    headers, 'Datensatz-ID'
  );
  const portalCol = requireImageColumn(
    headers, 'Portal'
  );
  const jsonCol = requireImageColumn(
    headers, 'Bildanalyse JSON'
  );
  const deleteCol = requireImageColumn(
    headers, 'Zu löschen'
  );
  const listingNumberCol = requireImageColumn(
    headers, 'Anzeigen-ID'
  );

  const lastRow = sheet.getLastRow();

  const stats = {
    processed: 0,
    uploaded: 0,
    completed: 0,
    no_images: 0,
    retry: 0,
    skipped: 0,
    galleries: 0
  };

  if (lastRow < 2) return stats;

  const rows = sheet.getRange(
    2, 1, lastRow - 1, sheet.getLastColumn()
  ).getValues();

  const ids = [...new Set(
    rows
      .filter(row => row[deleteCol] !== true)
      .map(row => String(row[idCol] || '').trim())
      .filter(Boolean)
  )];

  const folder = getImageFolder();

  for (const listingId of ids) {
    try {
      const current = findImageListing(
        sheet, idCol, listingId
      );

      if (!current) continue;

      if (current.values[deleteCol] === true) {
        stats.skipped++;
        continue;
      }

      const portal = normalizeProvider(
        current.values[portalCol]
      );

      const handler = CONFIG.providers[portal];

      if (!handler) {
        stats.skipped++;
        continue;
      }

      let data = parseImageJson(
        current.values[jsonCol]
      );

      // IDEALISTA: auch bereits fertige Anzeigen
      // auf fehlende Galeriebilder prüfen.
      if (portal === 'idealista') {
        const number = String(
          current.values[listingNumberCol] || ''
        ).trim() || listingId.split(':')[1];

        const knownTotal = Number(
          data.bildanzahl_inserat || 0
        );

        const galleryState =
          data.idealista_galerie || {};

        const checkedAt = Date.parse(
          galleryState.checked_at || ''
        );

        const elapsed = Number.isFinite(checkedAt)
          ? Date.now() - checkedAt
          : Infinity;

        const fileCount = Array.isArray(data.drive_files)
          ? data.drive_files.length
          : 0;

        const needsGallery =
          !galleryState.complete &&
          (
            elapsed >= 24 * 60 * 60 * 1000 ||
            (
              galleryState.status !== 'not_found' &&
              knownTotal > fileCount &&
              elapsed >= 30 * 60 * 1000
            )
          );

        if (/^\d+$/.test(number) && needsGallery) {
          const gallery = downloadIdealistaGallery(
            number,
            data.drive_files || []
          );

          const wrote = updateImageImportJson(
            sheet, idCol, jsonCol, deleteCol,
            listingId, fresh => {
              fresh.idealista_galerie = {
                status: gallery.status,
                http_status: gallery.httpStatus,
                found: gallery.found,
                checked_at: gallery.checked_at,
                complete: gallery.complete,
                error: gallery.errors.join(' | ')
              };

              if (gallery.status === 'completed' ||
                  gallery.status === 'retry') {
                fresh.drive_files = gallery.files;

                // Bild-URLs nun aus der Galerie übernehmen.
                fresh.bild_urls = gallery.urls;

                fresh.image_import = {
                  status: gallery.complete
                    ? 'completed'
                    : 'retry',
                  updated_at: new Date().toISOString(),
                  attempts: Number(
                    fresh.image_import?.attempts || 0
                  ) + 1,
                  source_signature:
                    getImageSourceSignature(
                      gallery.urls
                    ),
                  image_count: gallery.files.length,
                  expected_count: gallery.urls.length,
                  error: gallery.complete
                    ? null
                    : gallery.errors.join(' | ')
                };

                // Alte KI-Wertung ist nach einer
                // Galerieerweiterung nicht mehr vollständig.
                const oldAnalyzed =
                  fresh.analyzed_file_ids || [];

                const newIds = gallery.files
                  .map(file => file.file_id);

                if (
                  newIds.some(id =>
                    !oldAnalyzed.includes(id)
                  )
                ) {
                  fresh.ai_analysis_status = 'pending';
                }
              }

              return fresh;
            }
          );

          if (wrote) {
            stats.galleries++;
            stats.uploaded += gallery.created;
          }

          if (gallery.status !== 'completed') {
            // Bei 404 die bisherigen Bilder behalten.
            // Keine Leermeldung darüber schreiben.
            if (gallery.status === 'retry') {
              stats.retry++;
            }
            continue;
          }

          data = wrote;
        }
      }

      // Standardimport: Fotocasa, Yaencontre, Pisos,
      // und Idealista bei vorhandenen E-Mail-Bild-URLs.
      const urls = handler(data)
        .slice(0, CONFIG.maxImagesPerListing);

      const signature = getImageSourceSignature(
        urls
      );

      if (!shouldProcessImageImport(data, signature)) {
        stats.skipped++;
        continue;
      }

      const previousFiles =
        Array.isArray(data.drive_files)
          ? data.drive_files
          : [];

      const attempts =
        Number(data.image_import?.attempts || 0) + 1;

      if (!urls.length) {
        // E-Mail-Queue kann Drive-Bilder liefern, ohne bild_urls im
        // Anzeigen-JSON zu hinterlegen. Diese Bilder nicht als fehlend
        // deklarieren. Sind keine Dateien bekannt: zeitgesteuert retry.
        const hasFiles = previousFiles.some(file => file && file.file_id);
        updateImageImportJson(
          sheet, idCol, jsonCol, deleteCol,
          listingId, fresh => {
            const files = Array.isArray(fresh.drive_files)
              ? fresh.drive_files.filter(file => file && file.file_id)
              : [];
            fresh.image_import = {
              status: files.length ? 'files_available' : 'retry',
              updated_at: new Date().toISOString(),
              attempts,
              source_signature: signature,
              image_count: files.length,
              error: files.length ? null : 'Keine Quell-URLs oder Drive-Dateien'
            };
            if (files.some(file =>
              !(fresh.analyzed_file_ids || []).includes(file.file_id)
            )) {
              fresh.ai_analysis_status = 'pending';
            }
            return fresh;
          }
        );
        if (hasFiles) stats.completed++;
        else stats.retry++;
        stats.processed++;
        continue;
      }

      const claim = updateImageImportJson(
        sheet, idCol, jsonCol, deleteCol,
        listingId, fresh => {
          const currentSignature =
            getImageSourceSignature(
              handler(fresh).slice(
                0, CONFIG.maxImagesPerListing
              )
            );

          if (currentSignature !== signature) {
            return null;
          }

          fresh.image_import = {
            status: 'processing',
            updated_at: new Date().toISOString(),
            attempts,
            source_signature: signature
          };

          return fresh;
        }
      );

      if (!claim) {
        stats.skipped++;
        continue;
      }

      const result = saveListingImages(
        folder, listingId, urls, previousFiles
      );

      const savedUrls = new Set(
        result.files.map(file => file.source_url)
      );

      const complete = urls.every(
        url => savedUrls.has(url)
      );

      // Existierende Referenzen ebenfalls bewahren.
      const allFiles = [...result.files];
      const knownIds = new Set(
        allFiles.map(file => file.file_id)
      );

      for (const file of previousFiles) {
        if (
          file.file_id &&
          !knownIds.has(file.file_id)
        ) {
          allFiles.push(file);
          knownIds.add(file.file_id);
        }
      }

      const committed = updateImageImportJson(
        sheet, idCol, jsonCol, deleteCol,
        listingId, fresh => {
          if (
            fresh.image_import?.source_signature
              !== signature ||
            fresh.image_import?.status !== 'processing'
          ) {
            return null;
          }

          fresh.drive_files = allFiles;

          fresh.image_import = {
            status: complete ? 'completed' : 'retry',
            updated_at: new Date().toISOString(),
            attempts,
            source_signature: signature,
            image_count: allFiles.length,
            expected_count: urls.length,
            error: complete
              ? null
              : result.errors.join(' | ')
          };

          if (
            allFiles.some(file =>
              !(fresh.analyzed_file_ids || [])
                .includes(file.file_id)
            )
          ) {
            fresh.ai_analysis_status = 'pending';
          }

          return fresh;
        }
      );

      if (!committed) {
        stats.retry++;
        continue;
      }

      stats.processed++;
      stats.uploaded += result.created;

      if (complete) stats.completed++;
      else stats.retry++;

    } catch (error) {
      stats.retry++;
      console.error(
        listingId + ': ' + error.message
      );
    }
  }

  return stats;
}

function requireImageColumn(headers, name) {
  const index = headers.indexOf(name);
  if (index < 0) {
    throw new Error('Spalte fehlt: ' + name);
  }
  return index;
}

function normalizeProvider(value) {
  const name = String(value || '')
    .toLowerCase()
    .trim();

  if (name.includes('fotocasa')) return 'fotocasa';
  if (name.includes('idealista')) return 'idealista';
  if (name.includes('yaencontre')) return 'yaencontre';
  if (name.includes('pisos')) return 'pisos';
  if (name.includes('immoscout') || name.includes('immobilienscout') ||
      name.includes('immobilien scout')) return 'immoscout';

  return '';
}

function parseImageJson(value) {
  if (!value) return {};

  const parsed = JSON.parse(String(value));

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return {};
  }

  return parsed;
}

function getImageSourceSignature(urls) {
  const normalized = [...new Set(urls)].sort();

  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(normalized)
  );

  return bytes.map(byte =>
    ('0' + (byte & 255).toString(16)).slice(-2)
  ).join('');
}

function shouldProcessImageImport(data, signature) {
  const state = data.image_import || {};

  if (state.source_signature !== signature) {
    return true;
  }

  if (
    state.status === 'completed' ||
    state.status === 'files_available'
  ) {
    return false;
  }

  const elapsed =
    Date.now() -
    (Date.parse(state.updated_at || '') || 0);

  if (state.status === 'processing') {
    return elapsed >=
      CONFIG.processingTimeoutMinutes * 60000;
  }

  if (state.status === 'retry' || state.status === 'no_images') {
    return elapsed >=
      CONFIG.retryDelayMinutes * 60000;
  }

  return true;
}

function findImageListing(sheet, idCol, listingId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const ids = sheet.getRange(
    2, idCol + 1, lastRow - 1, 1
  ).getValues();

  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === listingId) {
      const rowNumber = i + 2;

      return {
        rowNumber,
        values: sheet.getRange(
          rowNumber,
          1,
          1,
          sheet.getLastColumn()
        ).getValues()[0]
      };
    }
  }

  return null;
}

/**
 * JSON nur anhand stabiler Datensatz-ID verändern.
 * Fremde Felder unverändert lassen.
 */
function updateImageImportJson(
  sheet, idCol, jsonCol, deleteCol,
  listingId, updater
) {
  const current = findImageListing(
    sheet, idCol, listingId
  );

  if (!current) return null;

  if (current.values[deleteCol] === true) {
    return null;
  }

  const data = parseImageJson(
    current.values[jsonCol]
  );

  const updated = updater(data);
  if (!updated) return null;

  const currentId = String(
    sheet.getRange(
      current.rowNumber, idCol + 1
    ).getValue()
  ).trim();

  if (currentId !== listingId) return null;

  sheet.getRange(
    current.rowNumber, jsonCol + 1
  ).setValue(JSON.stringify(updated));

  SpreadsheetApp.flush();

  return updated;
}

