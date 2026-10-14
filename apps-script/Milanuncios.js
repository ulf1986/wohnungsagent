/**
 * Milanuncios: echte Einzelanzeigen aus weitergeleiteten Mail-Links.
 *
 * Die Alarmmails enthalten SendGrid-Tracking-URLs (sgt.milanuncios.com).
 * Der Location-Header wird ohne Abruf des Inhalts bis zur kanonischen
 * Milanuncios-Anzeige verfolgt. Andere Ziele werden verworfen.
 */
const MILANUNCIOS = { trackingHost: 'sgt.milanuncios.com', maxTrackingLinks: 25, maxRedirects: 4 };

function getMilanunciosListing(url) {
  const value = cleanMailUrl(url);
  const match = value.match(
    /^https?:\/\/(?:www\.)?milanuncios\.com\/[^?#]*?-([0-9]{6,})\.htm(?:[?#]|$)/i
  );
  if (!match) return null;
  const canonical = value.split('#')[0].split('?')[0];
  return { listing_id: 'milanuncios:' + match[1], url: canonical };
}

function resolveMilanunciosTrackingLinks_(candidates) {
  const result = [];
  const seen = new Set();
  for (const raw of candidates || []) {
    const url = cleanMailUrl(raw);
    const host = (url.match(/^https?:\/\/([^/?#]+)/i) || [])[1];
    if (!host || host.toLowerCase() !== MILANUNCIOS.trackingHost || seen.has(url)) continue;
    seen.add(url);
    if (seen.size > MILANUNCIOS.maxTrackingLinks) break;
    const listing = resolveMilanunciosTrackingLink_(url);
    if (listing) result.push(listing.url);
  }
  return result;
}

function resolveMilanunciosTrackingLink_(url) {
  let next = cleanMailUrl(url);
  for (let hop = 0; hop < MILANUNCIOS.maxRedirects; hop++) {
    let response;
    try {
      response = UrlFetchApp.fetch(next, {
        method: 'get',
        muteHttpExceptions: true,
        followRedirects: false,
        validateHttpsCertificates: true,
        headers: { Accept: 'text/html,application/xhtml+xml' }
      });
    } catch (error) {
      console.warn('Milanuncios-Tracking-Link nicht auflösbar: ' + error.message);
      return null;
    }
    const status = response.getResponseCode();
    const headers = response.getHeaders() || {};
    const location = headers.Location || headers.location || '';
    if (status >= 300 && status < 400 && location) {
      next = resolveMilanunciosRedirectUrl_(next, location);
      if (!next) return null;
      const listing = getMilanunciosListing(next);
      if (listing) return listing;
      continue;
    }
    return getMilanunciosListing(next);
  }
  return getMilanunciosListing(next);
}

function resolveMilanunciosRedirectUrl_(base, location) {
  const value = cleanMailUrl(location);
  if (/^https?:\/\//i.test(value)) return value;
  const origin = (String(base).match(/^(https?:\/\/[^/?#]+)/i) || [])[1];
  if (!origin) return '';
  if (value.startsWith('/')) return origin + value;
  return origin + '/' + value.replace(/^\.\//, '');
}

function extractMilanunciosImages(data) {
  const candidates = [
    ...(Array.isArray(data.bild_urls) ? data.bild_urls : []),
    ...(Array.isArray(data.image_urls) ? data.image_urls : [])
  ];
  return uniqueImageUrls(candidates.filter(isMilanunciosPropertyImageUrl));
}

function isMilanunciosPropertyImageUrl(url) {
  const value = cleanMailUrl(url);
  return /^https:\/\/images(?:-re)?\.milanuncios\.com\/[^\s<>"']+\.(?:jpg|jpeg|png|webp)(?:\?[^#]*)?$/i.test(value);
}

function fetchMilanunciosListingPage(url) { return fetchListingPage_(url, 'milanuncios'); }
