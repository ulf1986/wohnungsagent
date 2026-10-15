/**
 * Milanuncios: nur Exposé- und Foto-Links aus Immobilienkarten.
 * Tracking nur am echten Fotoanker auflösen, nie Such-/Abmeldebuttons.
 */
function getMilanunciosListing(url) {
  const match = cleanMailUrl(url).match(
    /^https?:\/\/(?:www\.)?milanuncios\.com\/(ads|alquiler-de-pisos|alquiler-de-apartamentos|alquiler-de-casas|alquiler-de-aticos|alquiler-de-duplex)\/([a-z0-9_-]+)-(\d+)\.htm(?:[?#]|$)/i
  );
  return match ? {
    listing_id: 'milanuncios:' + match[3],
    url: 'https://www.milanuncios.com/' + match[1].toLowerCase() +
      '/' + match[2] + '-' + match[3] + '.htm'
  } : null;
}

function isMilanunciosPropertyImageUrl(url) {
  return /^https:\/\/images-re\.milanuncios\.com\/images\/ads\/[a-z0-9_-]+(?:\?[^<>"'\s#]*)?$/i
    .test(cleanMailUrl(url));
}

function isMilanunciosPhotoTrackingUrl(url) {
  return /^https?:\/\/sgt\.milanuncios\.com\/ls\/click\?[^<>"'\s]+$/i.test(url);
}

function extractMilanunciosMailImages(html) {
  const images = [], seen = new Set();
  for (const anchor of String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const listing = getMilanunciosListing(getMailHtmlAttribute('<a ' + anchor[1] + '>', 'href'));
    if (!listing) continue;
    for (const tag of anchor[2].match(/<img\b[^>]*>/gi) || []) {
      const url = getMailHtmlAttribute(tag, 'src') || getMailHtmlAttribute(tag, 'data-src');
      if (!isMilanunciosPropertyImageUrl(url)) continue;
      const key = listing.listing_id + '|' + url;
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({ listing_id: listing.listing_id, listing_url: listing.url, source_url: url });
    }
  }
  return images;
}

/** Maximal 8 Karten und 3 erlaubte Redirects, keine Zielseite herunterladen. */
function resolveMilanunciosMailLinks(html) {
  const cache = new Map(), errors = [];
  const resolved = String(html || '').replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
    (anchor, attrs, body) => {
      const photo = (body.match(/<img\b[^>]*>/gi) || []).some(tag =>
        isMilanunciosPropertyImageUrl(getMailHtmlAttribute(tag, 'src') ||
          getMailHtmlAttribute(tag, 'data-src')));
      const href = getMailHtmlAttribute('<a ' + attrs + '>', 'href');
      if (!photo || !isMilanunciosPhotoTrackingUrl(href)) return anchor;
      if (!cache.has(href)) {
        let target = '', current = href;
        try {
          if (cache.size >= 8) throw new Error('Milanuncios: Kartenlimit erreicht');
          for (let i = 0; i < 3; i++) {
            const response = UrlFetchApp.fetch(current, {
              followRedirects: false, muteHttpExceptions: true, validateHttpsCertificates: true
            });
            const status = response.getResponseCode();
            logImageDiagnostic('milanuncios_resolve', {
              status: String(status), source_url: current
            });
            if (![301, 302, 303, 307, 308].includes(status))
              throw new Error('Milanuncios-Link: HTTP ' + status);
            const headers = response.getAllHeaders();
            let location = headers.Location || headers.location || '';
            if (Array.isArray(location)) location = location[0];
            location = cleanMailUrl(location);
            const listing = getMilanunciosListing(location);
            if (listing) { target = listing.url; break; }
            if (!isMilanunciosPhotoTrackingUrl(location))
              throw new Error('Milanuncios: unerwartetes Weiterleitungsziel');
            current = location;
          }
          if (!target) throw new Error('Milanuncios: keine eindeutige Inserats-ID');
        } catch (error) {
          errors.push(error.message);
          logImageDiagnostic('milanuncios_resolve', { level: 'WARN', status: 'retry', error: error.message });
        }
        cache.set(href, target);
      }
      const target = cache.get(href);
      return target ? '<a href="' + target + '">' + body + '</a>' : anchor;
    });
  return { html: resolved, errors };
}

function extractMilanunciosImages(data) {
  return uniqueImageUrls([
    ...(Array.isArray(data.bild_urls) ? data.bild_urls : []),
    ...(Array.isArray(data.image_urls) ? data.image_urls : []),
    ...extractMilanunciosMailImages(data.html || '').map(image => image.source_url)
  ].filter(isMilanunciosPropertyImageUrl));
}

