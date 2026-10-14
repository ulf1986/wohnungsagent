/**
 * ImmoScout24: Exposé-Links und eindeutig verlinkte E-Mail-Fotos.
 * Keine Suchseiten, Anbieterlogos, Platzhalter oder Tracking-Pixel.
 */
function getImmoScoutListing(url) {
  const match = cleanMailUrl(url).match(
    /^https?:\/\/(?:push\.search\.is24\.de\/email|(?:www\.)?immobilienscout24\.de)\/expose\/(\d+)\/?(?:[?#]|$)/i
  );
  if (!match) return null;
  return {
    listing_id: 'immoscout:' + match[1],
    url: 'https://www.immobilienscout24.de/expose/' + match[1]
  };
}

function isImmoScoutPropertyImageUrl(url) {
  const value = cleanMailUrl(url);
  if (/[<>"'\s]/.test(value)) return false;
  return /^https:\/\/pictures\.immobilienscout24\.de\/listings\/[a-z0-9_-]+\.(?:jpg|jpeg|png|webp)(?:\/[a-z0-9_%.-]+)*(?:\?[^#]*)?$/i.test(value);
}

/** Die Exposé-ID kommt vom Bildlink, niemals vom Dateinamen des Fotos. */
function extractImmoScoutMailImages(html) {
  const images = [];
  const seen = new Set();
  for (const anchor of String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const listing = getImmoScoutListing(
      getMailHtmlAttribute('<a ' + anchor[1] + '>', 'href')
    );
    if (!listing) continue;
    for (const tag of anchor[2].match(/<img\b[^>]*>/gi) || []) {
      for (const attr of ['src', 'data-src', 'srcset', 'data-srcset']) {
        const value = getMailHtmlAttribute(tag, attr);
        const candidates = /srcset$/.test(attr) ? value.split(',') : [value];
        for (const candidate of candidates) {
          const url = candidate.trim().split(/\s+/)[0];
          if (!isImmoScoutPropertyImageUrl(url)) continue;
          const key = listing.listing_id + '|' + url;
          if (seen.has(key)) continue;
          seen.add(key);
          images.push({
            listing_id: listing.listing_id,
            listing_url: listing.url,
            source_url: url
          });
        }
      }
    }
  }
  return images;
}

function extractImmoScoutImages(data) {
  const candidates = [
    ...(Array.isArray(data.bild_urls) ? data.bild_urls : []),
    ...(Array.isArray(data.image_urls) ? data.image_urls : []),
    ...extractImmoScoutMailImages(data.html || '').map(image => image.source_url)
  ];
  return uniqueImageUrls(candidates.filter(isImmoScoutPropertyImageUrl));
}

function fetchImmoScoutListingPage(url) { return fetchListingPage_(url, 'immoscout'); }
