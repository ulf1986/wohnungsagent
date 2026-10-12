
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

  lookbackDays: 7,
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
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    console.log('Pipeline läuft bereits.');
    return;
  }

  try {
    const ss = SpreadsheetApp.openById(
      CONFIG.spreadsheetId
    );

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
           queued.status === 'no_images' ||
           queued.status === 'gallery_unavailable' ||
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

        const html = mail.getBody() || '';
        const plain = mail.getPlainBody() || '';

        const links = extractPropertyLinks(
          html, plain
        );

        // Vor JEGLICHEM Download Anzeigen-IDs aus den Links bestimmen.
        const propertyIds = [...new Set(links.map(getMailListingId).filter(Boolean))];
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

        const oldFiles = parseMailQueueFiles(
          queue.getRange(row, 14).getValue()
        );

        const allFiles = [...oldFiles];
        const fileIds = new Set(
          allFiles.map(file => file.file_id)
        );

        let uploaded = 0;
        const errors = [];
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

        const ready =
          status === 'completed' ||
          status === 'no_images' ||
          status === 'gallery_unavailable';

        setMailQueueStatus(
          queue,
          row,
          status,
          errors.join(' | ') ||
            (galleryUnavailable
              ? 'Galerie nicht vollständig erreichbar'
              : ''),
          ready ? new Date().toISOString() : ''
        );

        stats.processed++;
        stats.uploaded += uploaded;

        if (status === 'completed') {
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

// 1. Bestehende Anzeigen und Galerien aktualisieren.
try {
  const imageStats = processExistingListingImages();

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
      checkListingImageAvailabilityInternal();
    } catch (error) {
      console.error('Fehler bei der Bild-Verfügbarkeitsprüfung: ' + error.message);
    }

    // 3. Ein Zellvorschaubild pro Anzeige und KI-Status aktualisieren.
    // und die sichtbaren KI-Statuswerte aktualisieren.
    try {
      updateListingPreviewsInternal();

      console.log(
        'Vorschaubilder und KI-Status aktualisiert.'
      );
    } catch (error) {
      console.error(
        'Fehler bei der Vorschau-Aktualisierung: ' +
        error.message
      );
    }
  } finally {
    lock.releaseLock();
  }
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
    /href\s*=\s*["']([^"']+)["']/gi
  );

  for (const match of htmlLinks) {
    candidates.push(match[1]);
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
      'pisos.com'
    ].some(domain =>
      host === domain ||
      host.endsWith('.' + domain)
    );

    if (!allowed) continue;

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
function extractPropertyImageUrls(html) {
  const candidates = extractHtmlImageUrls(html);
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
      (
        host === 'yaencontre.com' ||
        host.endsWith('.yaencontre.com')
      ) &&
      /\.(jpg|jpeg|png|webp)$/.test(path);

    const pisos =
      (
        host === 'pisos.com' ||
        host.endsWith('.pisos.com')
      ) &&
      /\.(jpg|jpeg|png|webp)$/.test(path);

    if (
      fotocasa || idealista ||
      yaencontre || pisos
    ) {
      result.add(url);
    }
  }

  return [...result];
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
  const value = String(url || '');
  const rules = [
    ['idealista', /(?:^|\.)idealista\.com\/inmueble\/(\d+)/i],
    ['fotocasa', /(?:^|\.)fotocasa\.es\/es\/alquiler\/vivienda\/[^?#]*?\/(\d+)\/d(?:[?#]|$)/i],
    ['yaencontre', /(?:^|\.)yaencontre\.com\/alquiler\/[^?#]*?-(\d+)(?:[?#]|$)/i],
    ['pisos', /(?:^|\.)pisos\.com\/comprar\/[^?#]*?-(\d+)(?:[?#]|$)/i]
  ];
  for (const [portal, pattern] of rules) {
    const match = value.match(pattern);
    if (match) return portal + ':' + match[1];
  }
  return '';
}
