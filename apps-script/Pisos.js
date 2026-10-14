/**
 * Pisos.com: einzelne Inserate und ihre verlinkten E-Mail-Fotos.
 * Suchseiten, Makler, Neubauprojekte und Layoutbilder sind keine Inserate.
 */
function getPisosListing(url) {
  const value = cleanMailUrl(url);
  const match = value.match(
    /^https?:\/\/(?:www\.)?pisos\.com\/(alquilar|comprar)\/([^/?#]+)-(\d+)_(\d+)\/?(?:[?#]|$)/i
  );
  if (!match) return null;
  return {
    listing_id: 'pisos:' + match[3],
    url: 'https://www.pisos.com/' + match[1].toLowerCase() +
      '/' + match[2] + '-' + match[3] + '_' + match[4] + '/'
  };
}

/** Nur echte Fotoquellen, keine Logos, Pfeile oder Tracking-Pixel. */
function isPisosPropertyImageUrl(url) {
  const value = cleanMailUrl(url);
  if (/[<>"'\s]/.test(value)) return false;
  const thumbnail = value.match(
    /^https:\/\/thumbnails\.pisos\.com\/api\/ThumbnailAlert\/GetTaggedImage\/\?([^#]+)$/i
  );
  let imagePath = '';
  if (thumbnail) {
    const parameter = thumbnail[1].match(/(?:^|&)imageUrl=([^&]+)/i);
    if (!parameter) return false;
    try {
      imagePath = decodeURIComponent(parameter[1]);
    } catch (error) {
      return false;
    }
  } else {
    const direct = value.match(
      /^https:\/\/fotos\.imghs\.net(\/[^?#]+)(?:[?#]|$)/i
    );
    if (!direct) return false;
    imagePath = direct[1];
  }
  return /^\/\d+\/\d+(?:\.\d+)?\/[a-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(imagePath);
}

/** Bildzuordnung ausschließlich innerhalb desselben <a>-Blocks. */
function extractPisosMailImages(html) {
  const images = [];
  const seen = new Set();
  for (const anchor of String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const listing = getPisosListing(
      getMailHtmlAttribute('<a ' + anchor[1] + '>', 'href')
    );
    if (!listing) continue;
    for (const tag of anchor[2].match(/<img\b[^>]*>/gi) || []) {
      for (const attr of ['src', 'data-src', 'srcset', 'data-srcset']) {
        const value = getMailHtmlAttribute(tag, attr);
        const candidates = /srcset$/.test(attr) ? value.split(',') : [value];
        for (const candidate of candidates) {
          const url = candidate.trim().split(/\s+/)[0];
          if (!isPisosPropertyImageUrl(url)) continue;
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

function extractPisosImages(data) {
  const candidates = [
    ...(Array.isArray(data.bild_urls) ? data.bild_urls : []),
    ...(Array.isArray(data.image_urls) ? data.image_urls : []),
    ...extractPisosMailImages(data.html || '').map(image => image.source_url)
  ];
  return uniqueImageUrls(candidates.filter(isPisosPropertyImageUrl));
}

function fetchPisosListingPage(url) { return fetchListingPage_(url, 'pisos'); }
