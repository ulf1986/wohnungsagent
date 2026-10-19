
/**
 * GmailImport.gs
 * Wohnungsagent – Gmail und Idealista-Galerien
 *
 * Benötigt:
 * - Main.gs
 * - Drive.gs
 * - IdealistaGalerie.gs
 *
 * Gmail ausschließlich lesen.
 * Keine E-Mails verschicken.
 */

const MAIL_IMPORT = {
  label: 'Wohnungssuche/Suchaufträge',
  sheetName: 'Verarbeitung',

  lookbackDays: 2,
  maxThreads: 200,
  maxMessagesPerRun: 15,

  processingTimeoutMinutes: 20,
  retryDelayMinutes: 30,

  headers: [
    'Queue Gmail-ID',
    'Queue Eingang UTC',
    'Queue Betreff',
    'Queue Originaltext',
    'Queue Inseratslinks JSON',
    'Queue Bild-URLs JSON',
    'Queue Drive-Dateien JSON',
    'Queue Bildstatus',
    'Queue Fehler',
    'Queue Bereit UTC'
  ]
};

/**
 * Hauptfunktion des 5-Minuten-Triggers.
 */
function runGmailImagePipeline() {
  const pipelineStartedAt = Date.now();
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    console.log('Pipeline läuft bereits.');
    return;
  }

  beginImageDiagnostics('gmail_pipeline');
  try {
    const ss = SpreadsheetApp.openById(
      CONFIG.spreadsheetId
    );

    // Migrate legacy columns before any code reads or writes listing headers.
    runImageDiagnosticStage('rating_columns', () => ensureListingRatingSchema_(ss));

    // User deletions must be honored before mail import and before any AI requests.
    runImageDiagnosticStage('marked_deletions', () => cleanupMarkedListings_(ss));
    // Incremental index build: no OpenAI calls; bounded work per trigger.
    runImageDiagnosticStage('duplicate_backfill', () => backfillDuplicateRegistry_(ss, 6));
    runImageDiagnosticStage('duplicate_reconcile', () => reconcileExistingDuplicates_(ss));
    runImageDiagnosticStage('rescore_existing', () => recalculateExistingListingScores_(ss, 10));

    const queue = ss.getSheetByName(
      MAIL_IMPORT.sheetName
    );

    if (!queue) {
      throw new Error(
        'Tabellenblatt Verarbeitung fehlt'
      );
    }

    prepareMailQueue(queue);

    const label = GmailApp.getUserLabelByName(
      MAIL_IMPORT.label
    );

    if (!label) {
      throw new Error(
        'Gmail-Label fehlt: ' + MAIL_IMPORT.label
      );
    }

    const blockedIds = readMailImageBlacklist(ss);

    const existing = readMailQueueIndex(queue);
    const processed = readPreviouslyProcessedMailIds(
      queue
    );

    const cutoff = Date.now() -
      MAIL_IMPORT.lookbackDays * 86400000;

    const threads = label.getThreads(
      0, MAIL_IMPORT.maxThreads
    );

    const candidates = [];
    const seen = new Set();

    for (const thread of threads) {
      for (const mail of thread.getMessages()) {
        if (mail.getDate().getTime() < cutoff) {
          continue;
        }

        const id = mail.getId();
        if (seen.has(id)) continue;
        seen.add(id);

        const queued = existing[id];

        if (!queued && processed.has(id)) {
          continue;
        }

        if (
          queued &&
          (queued.status === 'completed' ||
           queued.status === 'ready_for_ai' ||
           queued.status === 'blocked')
        ) {
          continue;
        }

        if (
          queued &&
          !mailQueueNeedsRetry(queued)
        ) {
          continue;
        }

        candidates.push(mail);
      }
    }

    candidates.sort(
      (a, b) =>
        a.getDate().getTime() -
        b.getDate().getTime()
    );

    const selected = candidates.slice(
      0, MAIL_IMPORT.maxMessagesPerRun
    );
    logImageDiagnostic('mail_scan', {
      status: 'selected', count: candidates.length, files: selected.length
    });

    const stats = {
      candidates: candidates.length,
      processed: 0,
      completed: 0,
      no_images: 0,
      retry: 0,
      uploaded: 0,
      gallery_unavailable: 0,
      blocked: 0
    };

    for (const mail of selected) {
      const mailId = mail.getId();
      if (imageDiagnosticRun) {
        imageDiagnosticRun.mailId = mailId;
        imageDiagnosticRun.provider = '';
      }
      logImageDiagnostic('mail_start', { mail_id: mailId, status: 'processing' });
      let row = existing[mailId]
        ? existing[mailId].row
        : null;

      try {
        if (!row) {
          row = createMailQueueRow(queue, mail);
        }

        setMailQueueStatus(
          queue, row, 'processing', '', ''
        );

        logImageDiagnostic('provider_extract', { status: 'started' });
        const milan = resolveMilanunciosMailLinks(mail.getBody() || '');
        const html = milan.html;
        const plain = mail.getPlainBody() || '';

        const links = extractPropertyLinks(
          html, plain
        );

        // Vor JEGLICHEM Download Anzeigen-IDs aus den Links bestimmen.
        const propertyIds = [...new Set(links.map(getMailListingId).filter(Boolean))];
        if (imageDiagnosticRun) imageDiagnosticRun.provider = getImageDiagnosticProvider({ observed_id: propertyIds });
        logImageDiagnostic('provider_extract', {
          status: 'completed', observed_id: propertyIds, links: links.length, count: propertyIds.length
        });
        logImageDiagnostic('mail_extract', {
          mail_id: mailId, links: links.length, count: propertyIds.length,
          observed_id: propertyIds, status: propertyIds.length ? 'identified' : 'no_listing_id'
        });
        const blockedInMail = propertyIds.filter(id => blockedIds.has(id));
        if (blockedInMail.length) {
          const allBlocked = blockedInMail.length === propertyIds.length;
          // Bei mehreren Immobilien in einer Mail sind die HTML-Bilder
          // keiner einzelnen ID verlässlich zugeordnet. Sicher überspringen.
          setMailQueueStatus(queue, row,
            allBlocked ? 'blocked' : 'retry',
            (allBlocked ? 'Sperrliste: ' : 'Gemischte Mail, keine sichere Bildzuordnung: ') +
              blockedInMail.join(', '), allBlocked ? new Date().toISOString() : '');
          stats.blocked++;
          console.log(mailId + ': Bilddownload unterbunden wegen Sperrliste ' +
            blockedInMail.join(', '));
          continue;
        }

        const mailImageUrls =
          extractPropertyImageUrls(html);
        const linkedImages = [
          ...extractPisosMailImages(html),
          ...extractImmoScoutMailImages(html),
          ...extractMilanunciosMailImages(html)
        ];

        const oldFiles = parseMailQueueFiles(
          queue.getRange(row, 14).getValue()
        ).filter(file => isPropertyImageUrl(file.source_url) &&
          (!(isPisosPropertyImageUrl(file.source_url) ||
              isImmoScoutPropertyImageUrl(file.source_url) ||
              isMilanunciosPropertyImageUrl(file.source_url)) ||
            linkedImages.some(image => image.source_url === file.source_url)));

        const allFiles = [...oldFiles];
        const fileIds = new Set(
          allFiles.map(file => file.file_id)
        );

        let uploaded = 0;
        const errors = [...milan.errors];
        logImageDiagnostic('mail_images', {
          images: mailImageUrls.length, files: oldFiles.length, links: linkedImages.length,
          status: mailImageUrls.length ? 'found' : 'no_property_images'
        });
        let galleryUnavailable = false;

        const imageUrls = [...mailImageUrls];

        // Galerien der verlinkten Idealista-Inserate.
        const idealistaIds = [
          ...new Set(
            links
              .map(extractIdealistaListingId)
              .filter(Boolean)
          )
        ];

        for (const listingId of idealistaIds) {
          const relatedFiles = allFiles.filter(
            file =>
              String(file.name || '').startsWith(
                'idealista_' + listingId + '_'
              )
          );

          const gallery = downloadIdealistaGallery(
            listingId, relatedFiles
          );

          uploaded += gallery.created;

          if (gallery.status !== 'completed') {
            galleryUnavailable = true;

            console.warn(
              'Idealista ' + listingId +
              ': ' + gallery.status +
              ' (' + gallery.message + ')'
            );

            if (gallery.status === 'retry') {
              errors.push(
                'Idealista ' + listingId +
                ': unvollständiger Bilddownload'
              );
            }
          }

          for (const url of gallery.urls || []) {
            if (!imageUrls.includes(url)) {
              imageUrls.push(url);
            }
          }

          for (const file of gallery.files || []) {
            if (
              file.file_id &&
              !fileIds.has(file.file_id)
            ) {
              allFiles.push(file);
              fileIds.add(file.file_id);
            }
          }
        }

        // Vorhandene E-Mail-Vorschaubilder
        // zusätzlich erhalten bzw. herunterladen.
        const storedUrls = new Set(
          allFiles.map(file => file.source_url)
        );

        const remainingUrls =
          mailImageUrls.filter(
            url => !storedUrls.has(url)
          );

        if (remainingUrls.length) {
          const result = saveListingImages(
            getImageFolder(),
            'mail_' + mailId,
            remainingUrls,
            oldFiles
          );

          uploaded += result.created;
          errors.push(...result.errors);

          for (const file of result.files) {
            if (
              file.file_id &&
              !fileIds.has(file.file_id)
            ) {
              allFiles.push(file);
              fileIds.add(file.file_id);
            }
          }
        }

        // Verlinkte Fotos nur freigeben, wenn ihr Link eine eindeutige ID liefert.
        for (const file of allFiles) {
          if (!isPisosPropertyImageUrl(file.source_url) &&
              !isImmoScoutPropertyImageUrl(file.source_url) &&
              !isMilanunciosPropertyImageUrl(file.source_url)) continue;
          const owners = [...new Set(linkedImages
            .filter(image => image.source_url === file.source_url)
            .map(image => image.listing_id))];
          delete file.listing_id;
          delete file.listing_url;
          if (owners.length === 1) {
            file.listing_id = owners[0];
            file.listing_url = linkedImages.find(image =>
              image.source_url === file.source_url).listing_url;
          } else {
            errors.push('Bild ohne eindeutige Inseratszuordnung');
          }
        }

        // Betreff, Text, Links, Bildreferenzen.
        queue.getRange(
          row, 10, 1, 5
        ).setValues([[
          mail.getSubject(),
          plain.slice(0, 30000),
          JSON.stringify(links),
          JSON.stringify(imageUrls),
          JSON.stringify(allFiles)
        ]]);

        SpreadsheetApp.flush();

        const savedUrls = new Set(
          allFiles.map(file => file.source_url)
        );

        // Der technische Download aller Bild-URLs,
        // die wir tatsächlich kennen.
        const allSaved = imageUrls.every(
          url => savedUrls.has(url)
        );

        let status;

        if (errors.length || !allSaved) {
          status = 'retry';
        } else if (!allFiles.length) {
          status = galleryUnavailable
            ? 'gallery_unavailable'
            : 'no_images';
        } else {
          status = 'completed';
        }

        // Nur eine eindeutig zugeordnete Immobilie mit Drive-Bildern
        // darf in die KI-Queue. Bildlose Angebote bleiben im Retry.
        const oneListing = propertyIds.length === 1;
        const ready = status === 'completed' &&
          allFiles.some(file => file.file_id && file.source_url) &&
          (oneListing || allFiles.every(file =>
            !file.file_id || !isPropertyImageUrl(file.source_url) ||
            (file.listing_id && propertyIds.includes(file.listing_id))));
        if (ready) status = 'ready_for_ai';
        else if (status === 'completed') status = 'retry';
        else if (status === 'no_images' || status === 'gallery_unavailable')
          status = 'retry';

        setMailQueueStatus(
          queue,
          row,
          status,
          errors.join(' | ') ||
            (galleryUnavailable
              ? 'Galerie nicht vollständig erreichbar'
              : propertyIds.length > 1
                ? 'Mehrfachangebote: Bilder noch nicht eindeutig zugeordnet'
                : ''),
          ready ? new Date().toISOString() : ''
        );

        stats.processed++;
        stats.uploaded += uploaded;

        if (status === 'ready_for_ai') {
          stats.completed++;
        } else if (status === 'no_images') {
          stats.no_images++;
        } else if (
          status === 'gallery_unavailable'
        ) {
          stats.gallery_unavailable++;
        } else {
          stats.retry++;
        }

        console.log(
          mailId + ': ' + status +
          ', Drive-Dateien ' + allFiles.length
        );

      } catch (error) {
        logImageDiagnostic('mail_error', { mail_id: mailId, level: 'ERROR', status: 'retry', error: error.message });
        stats.retry++;

        console.error(
          mailId + ': ' + error.message
        );

        if (row) {
          setMailQueueStatus(
            queue, row, 'retry',
            error.message, ''
          );
        }
      }
    }

    console.log('Gmail: ' + JSON.stringify(stats));
    if (imageDiagnosticRun) {
      imageDiagnosticRun.mailId = '';
      imageDiagnosticRun.provider = '';
    }
    logImageDiagnostic('mail_summary', {
      count: stats.processed, uploaded: stats.uploaded, errors: stats.retry,
      status: stats.retry ? 'has_retries' : 'completed'
    });
    // Eine KI-Stufe je Lauf; bei langen Downloads bleibt sie für den nächsten Lauf liegen.
    if (typeof AI_PIPELINE !== 'undefined' && Date.now() - pipelineStartedAt < AI_PIPELINE.timeBudgetMs) {
      try {
        runImageDiagnosticStage('ai_processing', () => {
          const result = processNextAiListing(ss, queue);
          logImageDiagnostic('ai_result', { status: result.status, listing_id: result.listingId || '',
            error: result.error || '', level: result.status === 'retry' ? 'WARN' : 'INFO' });
          return result;
        });
      } catch (error) {
        console.error('KI-Verarbeitung: ' + error.message);
      } finally {
        if (imageDiagnosticRun) { imageDiagnosticRun.mailId = ''; imageDiagnosticRun.provider = ''; }
      }
    } else {
      logImageDiagnostic('ai_processing', { status: 'deferred', reason: 'Zeitbudget nach Bildimport' });
    }
    try {
      runImageDiagnosticStage('identity_audit', () => auditListingImageAssignments(ss));
    } catch (error) {
      console.error('Identitätsprüfung: ' + error.message);
    }

// 1. Bestehende Anzeigen und Galerien aktualisieren.
try {
  const imageStats = runImageDiagnosticStage('listing_import', () => processExistingListingImages());

  console.log(
        'Bestehende Anzeigen: ' +
        JSON.stringify(imageStats)
      );
    } catch (error) {
      console.error(
        'Fehler beim Anzeigen-Bildimport: ' +
        error.message
      );
    }

    // Original-Bildquellen auch bei bereits importierten Anzeigen prüfen.
    // Nur wiederholt bestätigte HTTP 404/410 führen zur Sperrung.
    try {
      runImageDiagnosticStage('availability', () => checkListingImageAvailabilityInternal());
    } catch (error) {
      console.error('Fehler bei der Bild-Verfügbarkeitsprüfung: ' + error.message);
    }

    // 3. Ein Zellvorschaubild pro Anzeige und KI-Status aktualisieren.
    // und die sichtbaren KI-Statuswerte aktualisieren.
    try {
      runImageDiagnosticStage('previews', () => updateListingPreviewsInternal());

      console.log(
        'Vorschaubilder und KI-Status aktualisiert.'
      );
    } catch (error) {
      console.error(
        'Fehler bei der Vorschau-Aktualisierung: ' +
        error.message
      );
    }
    // Anzeigen immer nach ursprünglichem E-Mail-Eingang sortieren.
    try {
      runImageDiagnosticStage('sort', () => sortListingsByMailReceived(ss));
    } catch (error) {
      console.error('Sortierung nach E-Mail-Eingang: ' + error.message);
    }
  } catch (error) {
    logImageDiagnostic('pipeline_error', { level: 'ERROR', status: 'failed', error: error.message });
    throw error;
  } finally {
    finishImageDiagnostics();
    lock.releaseLock();
  }
}

/**
 * Sortiert ganze Datenzeilen, einschließlich Zellbilder und Checkboxen.
 * Eingang (UTC) enthält ISO-8601-Strings, die chronologisch sortierbar sind.
 */
function sortListingsByMailReceived(ss) {
  const sheet = ss.getSheetByName(CONFIG.sheetName);
  if (!sheet || sheet.getLastRow() < 3) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const receivedIndex = headers.indexOf('Eingang (UTC)');
  if (receivedIndex < 0) throw new Error('Spalte Eingang (UTC) fehlt');
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .sort([{column: receivedIndex + 1, ascending: true}]);
}

/**
 * Queue-Header H:Q einrichten.
 */
function prepareMailQueue(sheet) {
  const first = 8;
  const width = MAIL_IMPORT.headers.length;
  const needed = first + width - 1;

  if (sheet.getMaxColumns() < needed) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      needed - sheet.getMaxColumns()
    );
  }

  const range = sheet.getRange(
    1, first, 1, width
  );

  const current = range.getValues()[0];

  for (let i = 0; i < width; i++) {
    if (
      current[i] &&
      current[i] !== MAIL_IMPORT.headers[i]
    ) {
      throw new Error(
        'Bereits belegte Spalte: ' + (first + i)
      );
    }
  }

  range.setValues([MAIL_IMPORT.headers]);
}

/**
 * Bereits vorhandene Queue-Einträge.
 */
function readMailQueueIndex(sheet) {
  const index = {};

  if (sheet.getLastRow() < 2) return index;

  const rows = sheet.getRange(
    2, 8, sheet.getLastRow() - 1, 9
  ).getValues();

  rows.forEach((cells, i) => {
    const id = String(cells[0] || '').trim();
    if (!id) return;

    const marker = String(
      cells[8] || ''
    ).split(' | ')[0];

    index[id] = {
      row: i + 2,
      status: String(cells[7] || ''),
      updatedAt: marker
    };
  });

  return index;
}

/**
 * Erfolgreich durch ChatGPT bearbeitete Mails.
 * Alte Protokollspalten A:G bleiben geschützt.
 */
function readPreviouslyProcessedMailIds(sheet) {
  const ids = new Set();

  if (sheet.getLastRow() < 2) return ids;

  const rows = sheet.getRange(
    2, 1, sheet.getLastRow() - 1, 4
  ).getValues();

  for (const row of rows) {
    const id = String(row[0] || '').trim();
    const status = String(row[3] || '')
      .trim().toLowerCase();

    if (
      id &&
      ['erfolgreich', 'success', 'completed']
        .includes(status)
    ) {
      ids.add(id);
    }
  }

  return ids;
}

/**
 * Nach Abbruch bzw. Fehler erneut versuchen.
 */
function mailQueueNeedsRetry(item) {
  if (
    item.status !== 'processing' &&
    item.status !== 'retry'
  ) {
    return true;
  }

  const time = Date.parse(item.updatedAt || '');
  if (!Number.isFinite(time)) return true;

  const timeout = item.status === 'processing'
    ? MAIL_IMPORT.processingTimeoutMinutes
    : MAIL_IMPORT.retryDelayMinutes;

  return Date.now() - time >= timeout * 60000;
}

function createMailQueueRow(sheet, mail) {
  const row = Math.max(
    sheet.getLastRow() + 1, 2
  );

  sheet.getRange(
    row, 8, 1, 10
  ).setValues([[
    mail.getId(),
    mail.getDate().toISOString(),
    mail.getSubject(),
    '',
    '[]',
    '[]',
    '[]',
    'pending',
    '',
    ''
  ]]);

  return row;
}

function setMailQueueStatus(
  sheet, row, status, error, readyAt
) {
  logImageDiagnostic('queue_status', {
    row, status, error: error || '', level: status === 'retry' ? 'WARN' : 'INFO'
  });
  const now = new Date().toISOString();

  const detail = (
    status === 'processing' ||
    status === 'retry'
  )
    ? now + (error ? ' | ' + error : '')
    : String(error || '');

  sheet.getRange(
    row, 15, 1, 3
  ).setValues([[
    status,
    detail,
    readyAt || ''
  ]]);

  SpreadsheetApp.flush();
}

function parseMailQueueFiles(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

/**
 * Immobilienlinks aus E-Mail ermitteln.
 * Für Idealista nur echte /inmueble/ Links.
 */
function extractPropertyLinks(html, plain) {
  const candidates = [];

  const htmlLinks = String(html).matchAll(
    /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
  );

  for (const match of htmlLinks) {
    candidates.push(match[1] || match[2] || match[3]);
  }

  candidates.push(...(
    String(plain).match(
      /https?:\/\/[^\s<>"']+/gi
    ) || []
  ));

  const result = new Set();

  for (const raw of candidates) {
    const url = cleanMailUrl(raw);
    const match = url.match(
      /^https?:\/\/([^\/?#]+)(?:[\/?#]|$)/i
    );

    if (!match) continue;

    const host = match[1].toLowerCase();

    const allowed = [
      'fotocasa.es',
      'idealista.com',
      'yaencontre.com',
      'pisos.com',
      'immobilienscout24.de',
      'push.search.is24.de',
      'milanuncios.com'
    ].some(domain =>
      host === domain ||
      host.endsWith('.' + domain)
    );

    if (!allowed) continue;
    // Stylesheets und verlinkte Layoutbilder sind keine Inseratslinks.
    if (/\.(?:png|jpg|jpeg|gif|webp|css)(?:[?#]|$)/i.test(url)) continue;

    if (host === 'milanuncios.com' || host.endsWith('.milanuncios.com')) {
      const listing = getMilanunciosListing(url);
      if (listing) result.add(listing.url);
      continue;
    }

    if (host === 'immobilienscout24.de' || host.endsWith('.immobilienscout24.de') ||
        host === 'push.search.is24.de') {
      const listing = getImmoScoutListing(url);
      if (listing) result.add(listing.url);
      continue;
    }

    if (host === 'pisos.com' || host.endsWith('.pisos.com')) {
      const listing = getPisosListing(url);
      if (listing) result.add(listing.url);
      continue;
    }

    if (
      host.endsWith('idealista.com') &&
      !/\/inmueble\/\d+/i.test(url)
    ) {
      continue;
    }

    result.add(url.split('#')[0]);
  }

  return [...result];
}

/**
 * Idealista-Anzeigen-ID.
 */
function extractIdealistaListingId(url) {
  const match = String(url).match(
    /^https?:\/\/(?:[^\/]+\.)?idealista\.com\/inmueble\/(\d+)/i
  );

  return match ? match[1] : '';
}

/**
 * Bild-URLs aus dem E-Mail-HTML.
 */
function isPropertyImageUrl(url) {
  if (isPisosPropertyImageUrl(url) || isImmoScoutPropertyImageUrl(url) ||
      isMilanunciosPropertyImageUrl(url)) return true;
  const match = String(url || '').match(/^https:\/\/([^\/?#]+)(\/[^?#]*)/i);
  if (!match) return false;
  const host = match[1].toLowerCase(), path = match[2].toLowerCase();
  return (host === 'media.yaencontre.com' &&
    path.startsWith('/img/photo/') && /\.(jpg|jpeg|png|webp)$/.test(path)) ||
    (host === 'static.fotocasa.es' &&
      (/^\/images\/ads\//.test(path) || /^\/images\/anuncio\//.test(path))) ||
    (/(^|\.)img\d*\.idealista\.com$/.test(host));
}

function extractPropertyImageUrls(html) {
  const candidates = extractHtmlImageUrls(html);
  // Fotocasa sometimes uses picture/source attributes outside img tags.
  const more = String(html || '').match(/https:\/\/static\.fotocasa\.es\/images\/ads\/[^\s"'<>]+/gi) || [];
  candidates.push(...more);
  const result = new Set();

  for (const raw of candidates) {
    const url = cleanMailUrl(raw);

    const match = url.match(
      /^https:\/\/([^\/?#]+)(\/[^?#]*)/i
    );

    if (!match) continue;

    const host = match[1].toLowerCase();
    const path = match[2].toLowerCase();

    const fotocasa =
      host === 'static.fotocasa.es' &&
      (
        path.includes('/images/ads/') ||
        path.includes('/images/anuncio/')
      );

    const idealista =
      /(^|\.)img\d*\.idealista\.com$/
        .test(host);

    const yaencontre =
      host === 'media.yaencontre.com' &&
      path.startsWith('/img/photo/') &&
      /\.(jpg|jpeg|png|webp)$/.test(path);

    if (
      (fotocasa || idealista || yaencontre) &&
      isPropertyImageUrl(url)
    ) {
      result.add(url);
    }
  }

  // Fotos dieser Portale benötigen den Inseratslink im umschließenden Bildblock.
  for (const image of [
    ...extractPisosMailImages(html), ...extractImmoScoutMailImages(html),
    ...extractMilanunciosMailImages(html)
  ]) {
    result.add(image.source_url);
  }
  return [...result];
}

/** Tag-Attribute: beide Anführungszeichen und unquoted HTML unterstützen. */
function getMailHtmlAttribute(tag, name) {
  const pattern = new RegExp(
    '\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'
  );
  const match = String(tag).match(pattern);
  return match ? cleanMailUrl(match[1] || match[2] || match[3] || '') : '';
}

function cleanMailUrl(value) {
  return String(value || '')
    .trim()
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/gi, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<');
}


/** Sperrliste!A:C: keine neuen Downloads für gesperrte Inserate. */
function readMailImageBlacklist(ss) {
  const sheet = ss.getSheetByName('Sperrliste');
  if (!sheet) throw new Error('Pflichtblatt Sperrliste fehlt – kein Bilddownload');
  const last = sheet.getLastRow();
  if (last < 2) return new Set();
  return new Set(sheet.getRange(2, 1, last - 1, 1).getValues()
    .map(row => String(row[0] || '').trim().toLowerCase()).filter(Boolean));
}

/** Portal und Datensatz-ID nur aus eindeutig erkennbaren Anzeigenlinks. */
function getMailListingId(url) {
  const milan = getMilanunciosListing(url);
  if (milan) return milan.listing_id;
  const immoscout = getImmoScoutListing(url);
  if (immoscout) return immoscout.listing_id;
  const pisos = getPisosListing(url);
  if (pisos) return pisos.listing_id;
  const value = String(url || '');
  const rules = [
    ['idealista', /(?:^|\.)idealista\.com\/inmueble\/(\d+)/i],
    ['fotocasa', /(?:^|\.)fotocasa\.es\/es\/alquiler\/vivienda\/[^?#]*?\/(\d+)\/d(?:[?#]|$)/i],
    ['yaencontre', /(?:^|\.)yaencontre\.com\/alquiler\/[^?#]*?-(\d+)(?:[?#]|$)/i]
  ];
  for (const [portal, pattern] of rules) {
    const match = value.match(pattern);
    if (match) return portal + ':' + match[1];
  }
  return '';
}

