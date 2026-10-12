
/**
 * IdealistaGalerie.gs
 * Vollständige Idealista-Fotogalerie
 *
 * Abhängigkeiten: Drive.gs, Main.gs
 *
 * Kein Bot-Schutz wird umgangen.
 * Keine Dateien werden öffentlich freigegeben.
 */

const IDEALISTA_GALERIE = {
  maxImages: 40,
  preferredSizes: [
    'WEB_DETAIL_TOP-L-L',
    'WEB_DETAIL-M-L',
    '500_375_mq'
  ]
};

/**
 * Liest die Inseratsseite und extrahiert Bild-URLs.
 */
function fetchIdealistaGallery(listingId) {
  const id = String(listingId || '').trim();

  if (!/^\d+$/.test(id)) {
    throw new Error('Ungültige Idealista-ID: ' + id);
  }

  const pageUrl =
    'https://www.idealista.com/inmueble/' + id + '/';

  let response;

  try {
    response = UrlFetchApp.fetch(pageUrl, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true,
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-ES,es;q=0.9'
      }
    });
  } catch (error) {
    return idealistaGalleryResult(
      id, 'error', 0, [], error.message
    );
  }

  const httpStatus = response.getResponseCode();

  if (httpStatus === 404) {
    return idealistaGalleryResult(
      id, 'not_found', 404, [],
      'Originalanzeige antwortet mit HTTP 404'
    );
  }

  if (httpStatus === 403 || httpStatus === 429) {
    return idealistaGalleryResult(
      id, 'blocked', httpStatus, [],
      'Zugriff eingeschränkt'
    );
  }

  if (httpStatus !== 200) {
    return idealistaGalleryResult(
      id, 'error', httpStatus, [],
      'HTTP ' + httpStatus
    );
  }

  const html = response.getContentText();

  const title = (
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    || []
  )[1] || '';

  // Nur eine tatsächlich erkennbare Inseratsseite
  // akzeptieren, nicht bloß HTTP 200.
  if (
    !html.includes('id.pro.es.image.master') ||
    !title.toLowerCase().includes('idealista')
  ) {
    return idealistaGalleryResult(
      id, 'unverified', httpStatus, [],
      'Keine verifizierbare Inseratsgalerie'
    );
  }

  const urls = extractIdealistaGalleryUrls(html);

  return idealistaGalleryResult(
    id,
    urls.length ? 'ok' : 'unverified',
    httpStatus,
    urls,
    urls.length
      ? 'Bildadressen extrahiert'
      : 'Keine Objektbilder identifiziert'
  );
}

function idealistaGalleryResult(
  listingId, status, httpStatus, urls, message
) {
  return {
    listingId,
    status,
    httpStatus,
    urls,
    found: urls.length,
    message,
    checked_at: new Date().toISOString()
  };
}

/**
 * Findet physisch unterschiedliche Aufnahmen.
 * Dateinummer bzw. Bild-ID ist der Schlüssel.
 */
function extractIdealistaGalleryUrls(html) {
  const normalized = String(html || '')
    .replace(/\\\//g, '/')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u003A/gi, ':')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&');

  const matches = normalized.match(
    /https:\/\/img\d*\.idealista\.com\/[^\s"'<>\\]+/gi
  ) || [];

  const images = new Map();

  for (let candidate of matches) {
    candidate = candidate
      .replace(/[),;\]}]+$/, '')
      .trim();

    const match = candidate.match(
      /^(https:\/\/img\d*\.idealista\.com)\/blur\/[^\/]+\/\d+\/(id\.pro\.es\.image\.master\/(?:[a-f\d]{2}\/){3}(\d+))\.(jpg|jpeg|webp|png)/i
    );

    if (!match) continue;

    const host = match[1];
    const path = match[2];
    const imageId = match[3];
    const ext = match[4].toLowerCase();

    const preferredUrl =
      host + '/blur/' +
      IDEALISTA_GALERIE.preferredSizes[0] +
      '/0/' + path + '.jpg';

    // Eine Aufnahme nur einmal aufnehmen.
    if (!images.has(imageId)) {
      images.set(imageId, {
        id: imageId,
        url: preferredUrl,
        fallback: candidate,
        ext
      });
    }
  }

  return [...images.values()]
    .slice(0, IDEALISTA_GALERIE.maxImages)
    .map(item => item.url);
}

/**
 * Findet Galerie und speichert Fotos.
 *
 * Bei nicht erreichbarer Seite werden vorhandene
 * Dateireferenzen unverändert zurückgegeben.
 */
function downloadIdealistaGallery(
  listingId, existingFiles
) {
  const previous = Array.isArray(existingFiles)
    ? existingFiles
    : [];

  const gallery = fetchIdealistaGallery(listingId);

  console.log(
    'Idealista ' + listingId +
    ': HTTP ' + gallery.httpStatus +
    ', Status ' + gallery.status +
    ', erkannte Bilder ' + gallery.found
  );

  if (gallery.status !== 'ok') {
    return {
      ...gallery,
      files: previous,
      created: 0,
      errors: [gallery.message],
      complete: false
    };
  }

  const previousLimit = CONFIG.maxImagesPerListing;

  try {
    CONFIG.maxImagesPerListing =
      IDEALISTA_GALERIE.maxImages;

    const result = saveListingImages(
      getImageFolder(),
      'idealista:' + listingId,
      gallery.urls,
      previous
    );

    const stored = new Set(
      result.files.map(file => file.source_url)
    );

    const complete = gallery.urls.every(
      url => stored.has(url)
    );

    // Alte E-Mail-Vorschaubilder weiter behalten,
    // wenn sie nicht in der neuen Galerie auftauchen.
    const combined = [...result.files];
    const ids = new Set(
      combined.map(file => file.file_id)
    );

    for (const old of previous) {
      if (old.file_id && !ids.has(old.file_id)) {
        combined.push(old);
        ids.add(old.file_id);
      }
    }

    console.log(
      'Idealista ' + listingId +
      ': neue Dateien ' + result.created +
      ', Galerie ' + result.files.length +
      '/' + gallery.urls.length
    );

    return {
      ...gallery,
      status: complete ? 'completed' : 'retry',
      files: combined,
      created: result.created,
      errors: result.errors,
      complete
    };
  } finally {
    CONFIG.maxImagesPerListing = previousLimit;
  }
}

/**
 * Manueller Test ohne Download.
 */
function testIdealistaGalerie() {
  for (const id of ['112791795', '112793654']) {
    const result = fetchIdealistaGallery(id);

    console.log(JSON.stringify({
      listingId: id,
      status: result.status,
      httpStatus: result.httpStatus,
      found: result.found,
      urls: result.urls.slice(0, 5)
    }));
  }
}
