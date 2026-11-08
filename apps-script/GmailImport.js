
/**
 * GmailImport.gs
 * Wohnungsagent – Gmail und Idealista-Galerien
 *
 * Benötigt:
 * - Main.gs
 * - Drive.gs
 * - IdealistaGalerie.gs
 *
 * Gmail lesen; nach gesicherter Queue-Übernahme Suchauftrags-Mails in Papierkorb verschieben.
 * Keine E-Mails verschicken.
 */

const MAIL_IMPORT = {
  label: 'Wohnungssuche/Suchaufträge',
  trashAfterQueueReady: true,
  sheetName: 'Verarbeitung',

  lookbackDays: 2,
  maxThreads: 200,
  maxMessagesPerRun: 15,
  // Keep one five-minute pipeline trigger; Gmail discovery is less frequent.
  discoveryIntervalMinutes: 15,
  discoveryOverlapMinutes: 15,
  reconciliationIntervalHours: 12,
  maxRetryMessagesPerRun: 5,
  gmailCursorKey: 'WOHNUNGSAGENT_GMAIL_DISCOVERY_UTC',
  gmailReconcileKey: 'WOHNUNGSAGENT_GMAIL_RECONCILE_UTC',
  gmailCooldownKey: 'WOHNUNGSAGENT_GMAIL_PAUSE_UNTIL',
  quotaCooldownMinutes: 60,
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
  if (typeof requestAiImportTurn_ === 'function') requestAiImportTurn_();
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    console.log('Pipeline läuft bereits.');
    return;
  }
  let waPipelineFailed_ = false;
  try {
    if (typeof clearAiImportTurn_ === 'function') clearAiImportTurn_();
    beginImageDiagnostics('gmail_pipeline');
    waMonitorStart_();
    const ss = SpreadsheetApp.openById(
      CONFIG.spreadsheetId
    );

    // Migrate legacy columns before any code reads or writes listing headers.
    runImageDiagnosticStage('rating_columns', () => ensureListingRatingSchema_(ss));

    // User deletions must be honored before mail import and before any AI requests.
    runImageDiagnosticStage('marked_deletions', () => cleanupMarkedListings_(ss));
    // One-time, bounded local backfill from persisted Yaencontre mail cards.
    if (typeof backfillYaencontreMailFacts_ === 'function')
      runImageDiagnosticStage('historic_mail_facts', () => backfillYaencontreMailFacts_(ss, 6));
    // Recent Yaencontre mails may contain property photos absent from old rows.
    // Gmail reads are limited to existing message IDs less than 48 hours old.
    // Stop historic photo recovery; the email thumbnail is enough.
    // Incremental index build: no OpenAI calls; bounded work per trigger.
    runImageDiagnosticStage('duplicate_backfill', () => backfillDuplicateRegistry_(ss, 6));
    if (typeof detectTextDuplicateCandidates_ === 'function')
      runImageDiagnosticStage('duplicate_text_candidates', () => detectTextDuplicateCandidates_(ss, 10));
    runImageDiagnosticStage('duplicate_reconcile', () => reconcileExistingDuplicates_(ss));
    // No recurring photo-based scoring of existing listings.
    if (typeof auditProviderDataQuality_ === 'function')
      runImageDiagnosticStage('provider_quality', () => auditProviderDataQuality_(ss));
    // Expensive recovery is deliberately excluded from the 5-minute Gmail trigger.
    // Run recoverMissingListingEssentials_ separately after clearing the mail backlog.

    const queue = ss.getSheetByName(
      MAIL_IMPORT.sheetName
    );

    if (!queue) {
      throw new Error(
        'Tabellenblatt Verarbeitung fehlt'
      );
    }

    prepareMailQueue(queue);
    // Discovery scans only messages newer than the persisted cursor.
    // Independently registered retries are loaded by Gmail message ID,
    // never by rescanning every old conversation.
    const existing = readMailQueueIndex(queue);
    const processed = readPreviouslyProcessedMailIds(queue);
    let selected = [];
    try {
      selected = collectMailCandidates_(existing, processed);
    } catch (error) {
      // A Gmail quota error must not stop Drive/Sheet follow-up work.
      logImageDiagnostic('mail_scan', {
        level: 'ERROR', status: 'failed', error: String(error.message || error)
      });
      waMonitorIssue_('Gmail-Suche: ' + error.message);
      console.error('Gmail-Suche: ' + error.message);
      if (/zu häufig aufgerufen: *gmail|too many times.*gmail|quota.*gmail/i.test(String(error.message || error))) {
        const until = new Date(Date.now() + MAIL_IMPORT.quotaCooldownMinutes * 60000).toISOString();
        PropertiesService.getScriptProperties().setProperty(MAIL_IMPORT.gmailCooldownKey, until);
        logImageDiagnostic('gmail_quota', {
          level: 'WARN', status: 'paused', reason: 'Gmail-Limit', until
        });
      }
    }
    const blockedIds = readMailImageBlacklist(ss);
    logImageDiagnostic('mail_scan', {
      status: 'selected', count: selected.length, files: selected.length
    });

    const stats = {
      candidates: selected.length,
      processed: 0,
      completed: 0,
      no_images: 0,
      retry: 0,
      uploaded: 0,
      gallery_unavailable: 0,
      blocked: 0
    };

    let scanPersisted = true;
    for (const mail of selected) {
      // Do not start another costly mail/image download near the runtime budget.
      // Remaining messages stay queued for the next trigger.
      if (Date.now() - pipelineStartedAt >=
          (typeof AI_PIPELINE !== 'undefined' ? AI_PIPELINE.timeBudgetMs : 180000)) {
        logImageDiagnostic('mail_import', {
          status: 'deferred', reason: 'Zeitbudget vor nächstem Mailimport',
          remaining: selected.length - stats.processed
        });
        scanPersisted = false;
        waMonitorIssue_('Gmail-Import wegen Zeitbudget verschoben; ' +
          (selected.length - stats.processed) + ' E-Mails warten');
        break;
      }
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

        // ImmoScout mails add only redundant referrals. Skip the entire sender,
        // including any Pisos links that might be embedded in those messages.
        if (isDisabledImmoScoutMail_(mail)) {
          setMailQueueStatus(queue, row, 'blocked',
            'ImmoScout-Import deaktiviert', new Date().toISOString());
          stats.blocked++;
          logImageDiagnostic('mail_skip',{status:'blocked',reason:'immoscout_disabled'});
          trashQueuedSearchMail_(mail, 'blocked');
          continue;
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
        if (blockedInMail.length === propertyIds.length && propertyIds.length) {
          setMailQueueStatus(queue, row, 'blocked',
            'Sperrliste: ' + blockedInMail.join(', '), new Date().toISOString());
          stats.blocked++;
          waMonitorMail_(mailId, 'blocked', 'Sperrliste', propertyIds);
          trashQueuedSearchMail_(mail, 'blocked');
          continue;
        }
        // Persist source links before images or AI. This enables an early
        // manual-review Telegram message even if subsequent downloads fail.
        // The sender rechecks Sperrliste and does not notify blocked IDs.
        queue.getRange(row, 12, 1, 1).setValues([[JSON.stringify(links)]]);
        SpreadsheetApp.flush();
        // Eine gesperrte Anzeige darf nicht die übrigen Angebote derselben Mail stoppen.
        const eligibleIds = propertyIds.filter(id => !blockedIds.has(id));
        const allMailImageUrls = extractPropertyImageUrls(html);
        const linkedImages = [
          ...extractPisosMailImages(html),
          ...extractYaencontreMailImages(html),
          ...extractAnchoredPortalMailImages_(html, 'fotocasa'),
          ...extractAnchoredPortalMailImages_(html, 'idealista'),
          ...extractMilanunciosMailImages(html)
        ];
        const photoOwners = url => [...new Set(linkedImages
          .filter(image => image.source_url === url)
          .map(image => image.listing_id).filter(Boolean))];
        const isLinkedPhoto = url => isPropertyImageUrl(url);
        const ambiguousPhotos = allMailImageUrls.filter(url => photoOwners(url).length > 1);
        // In Sammelmails ausschließlich eindeutig einem nicht gesperrten
        // Inserat zugewiesene Mailfotos herunterladen.
        const mailImageUrls = propertyIds.length === 1
          ? allMailImageUrls
          : allMailImageUrls.filter(url => {
              const owners = photoOwners(url);
              return owners.length === 1 && eligibleIds.includes(owners[0]);
            });
        const fileOwner = file => {
          if (isLinkedPhoto(file.source_url)) {
            const owners = photoOwners(file.source_url);
            return owners.length === 1 ? owners[0] : '';
          }
          const direct = file.listing_id || getMailListingId(file.listing_url || '');
          if (direct) return direct;
          const match = String(file.name || '').toLowerCase().match(
            /^(idealista|fotocasa|yaencontre|pisos|milanuncios)_(\d+)_/
          );
          return match ? match[1] + ':' + match[2] : '';
        };
        const oldFiles = parseMailQueueFiles(
          queue.getRange(row, 14).getValue()
        ).filter(file => isPropertyImageUrl(file.source_url) &&
          (propertyIds.length === 1 ||
            eligibleIds.includes(fileOwner(file))) &&
          (!isLinkedPhoto(file.source_url) ||
            (photoOwners(file.source_url).length === 1 ||
              (propertyIds.length === 1 && /^(?:yaencontre|fotocasa|idealista):/.test(propertyIds[0])))));

        const allFiles = [...oldFiles];
        const fileIds = new Set(
          allFiles.map(file => file.file_id)
        );

        let uploaded = 0;
        const errors = [...milan.errors];
        if (ambiguousPhotos.length) errors.push('Bild ohne eindeutige Inseratszuordnung');
        logImageDiagnostic('mail_images', {
          images: mailImageUrls.length, files: oldFiles.length, links: linkedImages.length,
          status: mailImageUrls.length ? 'found' : 'no_property_images'
        });
        let galleryUnavailable = false;

        const imageUrls = [...mailImageUrls];

        // Lightweight mode: no Idealista gallery downloads or backfill.

        // Vorhandene E-Mail-Vorschaubilder
        // zusätzlich erhalten bzw. herunterladen.
        const storedUrls = new Set(
          allFiles.map(file => file.source_url)
        );

        const remainingUrls =
          mailImageUrls.filter(url => !storedUrls.has(url)).slice(0, 1);

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
              !isYaencontrePropertyImageUrl(file.source_url) &&
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
        // Thumbnail-only: never retry a mail just to download all gallery photos.
        const allSaved = true;

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

        // Sammelmails dürfen in die KI-Queue: dort wird JEDE ID einzeln
        // verarbeitet. Ohne eindeutig zugewiesenes Bild nur Text/Portal nutzen.
        const oneListing = propertyIds.length === 1;
        const safeOwnership = oneListing || allFiles.every(file =>
          !file.file_id || !isPropertyImageUrl(file.source_url) ||
          eligibleIds.includes(fileOwner(file)));
        // Photo fetch errors must not hold up an identifiable listing forever.
        // The AI stage can retrieve listing-page text and mark missing photos.
        // Preserve ownership validation so a digest never assigns foreign photos.
        const fallbackOnImageFailure = mailImageUrls.length > 0 &&
          !ambiguousPhotos.length && errors.length > 0;
        const ready = eligibleIds.length > 0 &&
          (oneListing || safeOwnership) &&
          (status === 'completed' || status === 'no_images' ||
           status === 'gallery_unavailable' || fallbackOnImageFailure || errors.length > 0);
        if (ready && status !== 'completed') {
          logImageDiagnostic('mail_text_fallback', {
            status: 'ready_without_complete_images', mail_id: mailId,
            count: eligibleIds.length, files: allFiles.length,
            reason: errors.join(' | ').slice(0, 250) || 'incomplete_images'
          });
        }
        if (ready) status = 'ready_for_ai';
        else if (status === 'completed' || status === 'no_images' ||
                 status === 'gallery_unavailable') status = 'retry';

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

        waMonitorMail_(mailId, status, errors.join(' | ') ||
          (status === 'ready_for_ai' ? 'Zur KI freigegeben' : 'Bild-/Linkprüfung'), propertyIds);
        stats.processed++;
        stats.uploaded += uploaded;

        if (status === 'ready_for_ai') {
          stats.completed++;
          trashQueuedSearchMail_(mail, status);
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
        waMonitorMail_(mailId, 'retry', error.message, []);

        console.error(
          mailId + ': ' + error.message
        );

        if (row) {
          setMailQueueStatus(
            queue, row, 'retry',
            error.message, ''
          );
        } else {
          scanPersisted = false;
        }
      }
    }

    if (scanPersisted && selected.scanCheckpoint) {
      const p = PropertiesService.getScriptProperties();
      p.setProperty(MAIL_IMPORT.gmailCursorKey, selected.scanCheckpoint);
      if (selected.reconciled) p.setProperty(MAIL_IMPORT.gmailReconcileKey, selected.scanCheckpoint);
      logImageDiagnostic('gmail_checkpoint', { status: 'saved' });
    }
    if (stats.candidates && stats.processed === 0 && stats.blocked === 0)
      waMonitorIssue_('Gmail-Kandidaten vorhanden, aber keine Mail verarbeitet oder gesperrt');
    waMonitorStats_(stats);
    console.log('Gmail: ' + JSON.stringify(stats));
    if (imageDiagnosticRun) {
      imageDiagnosticRun.mailId = '';
      imageDiagnosticRun.provider = '';
    }
    logImageDiagnostic('mail_summary', {
      count: stats.processed, uploaded: stats.uploaded, errors: stats.retry,
      status: stats.retry ? 'has_retries' : 'completed'
    });
    // The independent worker consumes AI stages between import runs. If trigger
    // installation is denied, preserve the previous inline consumer as fallback.
    let independentWorker = false;
    try {
      independentWorker = ensureAiWorkerTrigger_();
    } catch (error) {
      waMonitorIssue_('KI-Worker-Trigger nicht eingerichtet: ' + error.message);
    }
    if (!independentWorker && Date.now() - pipelineStartedAt <
        (typeof AI_PIPELINE !== 'undefined' ? AI_PIPELINE.timeBudgetMs - 30000 : 150000)) {
      if (typeof AI_PIPELINE !== 'undefined') {
        try {
        runImageDiagnosticStage('ai_processing', () => {
          const result = processNextAiListing(ss, queue);
          waMonitorAi_(imageDiagnosticRun && imageDiagnosticRun.mailId, result);
          logImageDiagnostic('ai_result', {
            status: result.status, listing_id: result.listingId || '',
            error: result.error || '',
            level: result.status === 'retry' ? 'WARN' : 'INFO'
          });
          return result;
        });
        } catch (error) {
          logImageDiagnostic('ai_error', {
          status: 'failed', level: 'ERROR', error: String(error.message || error)
        });
        waMonitorIssue_('KI-Verarbeitung: ' + error.message);
        console.error('KI-Verarbeitung: ' + error.message);
        } finally {
          if (imageDiagnosticRun) {
          imageDiagnosticRun.mailId = '';
          imageDiagnosticRun.provider = '';
        }
        }
      }
    }
    try {
      runImageDiagnosticStage('identity_audit', () => auditListingImageAssignments(ss));
    } catch (error) {
      console.error('Identitätsprüfung: ' + error.message);
    }

// 1. Bestehende Anzeigen und Galerien aktualisieren.
try {
  const imageStats = { skipped: true, reason: 'thumbnail_only' };

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
    waPipelineFailed_ = true;
    waMonitorIssue_('Pipeline: ' + error.message);
    logImageDiagnostic('pipeline_error', { level: 'ERROR', status: 'failed', error: error.message });
    throw error;
  } finally {
    try {
      try { waMonitorFinish_(waPipelineFailed_); }
      finally { finishImageDiagnostics(); }
    } finally {
      lock.releaseLock();
    }
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
      receivedAt: String(cells[1] || ''),
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
 * Incremental Gmail discovery. Gmail search returns threads; only the
 * matching recent messages are inspected. Persist the cursor ONLY after a
 * complete, untruncated scan whose eligible messages all fit this run.
 * Retry rows are fetched individually by Gmail ID, not through history scans.
 *
 * Calling this requires the pipeline-wide ScriptLock.
 */
/** Never trash retry or unfinished messages. Queue and image metadata are saved first. */
function trashQueuedSearchMail_(mail, status) {
  if (!MAIL_IMPORT.trashAfterQueueReady ||
      !['ready_for_ai','blocked'].includes(status)) return false;
  try {
    mail.moveToTrash();
    logImageDiagnostic('gmail_cleanup', {status:'trashed',mail_id:mail.getId(),reason:status});
    return true;
  } catch(error) {
    logImageDiagnostic('gmail_cleanup', {status:'failed',level:'WARN',mail_id:mail.getId(),error:String(error.message||error)});
    return false;
  }
}

function collectMailCandidates_(existing, processed) {
  const now = Date.now();
  const cutoff = now - MAIL_IMPORT.lookbackDays * 86400000;
  const props = PropertiesService.getScriptProperties();
  const pauseUntil = Date.parse(String(props.getProperty(MAIL_IMPORT.gmailCooldownKey) || ''));
  if (Number.isFinite(pauseUntil) && now < pauseUntil) {
    logImageDiagnostic('gmail_quota', { status: 'paused', reason: 'Gmail-Kontingent', until: new Date(pauseUntil).toISOString() });
    return [];
  }
  const key = MAIL_IMPORT.gmailCursorKey;
  const reconcileKey = MAIL_IMPORT.gmailReconcileKey;
  const saved = Date.parse(String(props.getProperty(key) || ''));
  const previous = Number.isFinite(saved) && saved <= now ? saved : NaN;
  const lastReconcile = Date.parse(String(props.getProperty(reconcileKey) || ''));
  const reconcileDue = !Number.isFinite(lastReconcile) ||
    now - lastReconcile >= MAIL_IMPORT.reconciliationIntervalHours * 3600000;
  const scanDue = reconcileDue || !Number.isFinite(previous) ||
    now - previous >= MAIL_IMPORT.discoveryIntervalMinutes * 60000;
  const eligible = (id, date) => {
    if (date < cutoff || date > now) return false;
    if (!existing[id] && processed.has(id)) return false;
    const queued = existing[id];
    return !queued || (
      !['completed', 'ready_for_ai', 'blocked'].includes(queued.status) &&
      mailQueueNeedsRetry(queued)
    );
  };

  // Oldest outstanding jobs first; bounded to avoid costly Gmail calls.
  const retries = Object.keys(existing)
    .filter(id => {
      const item = existing[id];
      const t = Date.parse(String(item.receivedAt || ''));
      return Number.isFinite(t) && t >= cutoff && t <= now &&
        !['completed', 'ready_for_ai', 'blocked'].includes(item.status) &&
        mailQueueNeedsRetry(item);
    })
    .sort((a, b) => Date.parse(existing[a].receivedAt) - Date.parse(existing[b].receivedAt))
    .slice(0, MAIL_IMPORT.maxRetryMessagesPerRun);

  const result = [];
  const seen = new Set();
  // Process recent discovery first so retry-heavy queues cannot starve new mail.
  let scanComplete = false;
  let limited = false;
  let discovered = 0;
  if (scanDue) {
    const start = reconcileDue || !Number.isFinite(previous) ? cutoff :
      Math.max(cutoff, previous - MAIL_IMPORT.discoveryOverlapMinutes * 60000);
    const after = ' after:' + Math.floor(start / 1000);
    // Fotocasa changed the subject to "Nuevo · Piso ..." and its Gmail
    // filter no longer attaches Wohnungssuche/Suchaufträge. Discover these
    // separately without admitting reminders, favorites or replies.
    // Include Trash: search-alert messages are deliberately moved there after
    // durable queuing. Without in:anywhere a recovery scan silently misses them.
    const searches = [
      { query: 'in:anywhere label:"' + MAIL_IMPORT.label.replace(/"/g, '') + '"' + after, portal: '' },
      { query: 'in:anywhere from:(fotocasa.es)' + after, portal: 'fotocasa' }
    ];
    let threadCount = 0;
    for (const search of searches) {
      const threads = GmailApp.search(search.query, 0, MAIL_IMPORT.maxThreads);
      threadCount += threads.length;
      if (threads.length >= MAIL_IMPORT.maxThreads) limited = true;
      for (const thread of threads) {
        for (const mail of thread.getMessages()) {
          if (search.portal === 'fotocasa' &&
              !/^\s*Nuevo\s*[·-]/i.test(String(mail.getSubject() || ''))) continue;
          const date = mail.getDate().getTime();
          if (date < start || date < cutoff || date > now) continue;
          const id = mail.getId();
          if (seen.has(id)) continue;
          seen.add(id);
          if (!eligible(id, date)) continue;
          result.push(mail);
          discovered++;
        }
      }
    }
    result.sort((a, b) => a.getDate().getTime() - b.getDate().getTime());
    // Never advance the cursor past messages that could not be enqueued.
    scanComplete = !limited && result.length <= MAIL_IMPORT.maxMessagesPerRun;
    logImageDiagnostic('gmail_discovery', {
      status: scanComplete ? 'checkpoint_ready' : 'backlog_retained',
      count: discovered, files: threadCount,
      reason: limited ? 'thread_limit' : result.length > MAIL_IMPORT.maxMessagesPerRun ? 'mail_limit' : ''
    });
  }

  // Remaining capacity: retry only known queue IDs, without thread scans.
  if (result.length < MAIL_IMPORT.maxMessagesPerRun) {
    for (const id of retries) {
      if (seen.has(id) || result.length >= MAIL_IMPORT.maxMessagesPerRun) continue;
      const mail = GmailApp.getMessageById(id);
      if (mail) {
        seen.add(id);
        result.push(mail);
      }
    }
  }
  const chosen = result.slice(0, MAIL_IMPORT.maxMessagesPerRun);
  if (scanDue && scanComplete) {
    chosen.scanCheckpoint = new Date(now).toISOString();
    chosen.reconciled = reconcileDue;
  }
  return chosen;
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

  // The caller holds the global ScriptLock. If this message still says
  // 'processing', its previous owner can no longer be running concurrently.
  // Resume immediately and reuse its already persisted Drive references.
  if (item.status === 'processing') return true;

  // Explicit retry errors still back off to avoid hammering broken portals.
  const time = Date.parse(item.updatedAt || '');
  if (!Number.isFinite(time)) return true;
  return Date.now() - time >= MAIL_IMPORT.retryDelayMinutes * 60000;
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

/** ImmoScout is not an import source, even when its email contains other links. */
function isDisabledImmoScoutMail_(mail) {
  const from=String(mail && typeof mail.getFrom==='function' ? mail.getFrom() : '').toLowerCase();
  return /@(?:[a-z0-9-]+\.)*(?:immobilienscout24\.de|is24\.de)(?:>|\s|$)/i.test(from);
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
  if (isPisosPropertyImageUrl(url) || isYaencontrePropertyImageUrl(url) ||
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
    ...extractPisosMailImages(html), ...extractYaencontreMailImages(html),
    ...extractAnchoredPortalMailImages_(html,'fotocasa'),
    ...extractAnchoredPortalMailImages_(html,'idealista'),
    ...extractMilanunciosMailImages(html)
  ]) {
    result.add(image.source_url);
  }
  return [...result];
}

/**
 * Assign Fotocasa / Idealista images only if their enclosing anchor points to
 * exactly the same listing. Unanchored images remain usable only in single ads.
 */
function extractAnchoredPortalMailImages_(html, provider) {
  if (!['fotocasa','idealista'].includes(provider)) return [];
  const results=[],seen=new Set();
  for(const a of String(html||'').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)){
    const listingUrl=getMailHtmlAttribute('<a '+a[1]+'>','href');
    const listingId=getMailListingId(listingUrl);
    if(!listingId||!listingId.startsWith(provider+':'))continue;
    for(const tag of a[2].match(/<img\b[^>]*>/gi)||[]){
      const src=getMailHtmlAttribute(tag,'src')||getMailHtmlAttribute(tag,'data-src');
      if(!isPropertyImageUrl(src))continue;
      const host=(String(src).match(/^https:\/\/([^/]+)/i)||[])[1]||'';
      if(provider==='fotocasa'&&host!=='static.fotocasa.es')continue;
      if(provider==='idealista'&&!/(^|\.)img\d*\.idealista\.com$/i.test(host))continue;
      const key=listingId+'|'+src;if(seen.has(key))continue;
      seen.add(key);results.push({listing_id:listingId,listing_url:listingUrl,source_url:src});
    }
  }
  return results;
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


