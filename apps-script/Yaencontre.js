
/**
 * Yaencontre.gs
 * Wohnungsagent – Immobilienbilder
 *
 * Extrahiert Bild-URLs für yaencontre.com.
 *
 * Verwendet bereits gespeicherte Bildadressen
 * oder HTML-Inhalte aus Bildanalyse JSON.
 *
 * Benötigt die Hilfsfunktionen aus Drive.gs:
 * - extractHtmlImageUrls()
 * - uniqueImageUrls()
 */

function extractYaencontreImages(data) {
  const candidates = [
    ...(Array.isArray(data.bild_urls) ? data.bild_urls : []),
    ...(Array.isArray(data.image_urls) ? data.image_urls : []),
    ...extractHtmlImageUrls(data.html || '')
  ];

  return uniqueImageUrls(candidates);
}

/** Only actual listing photos from Yaencontre, never layout/promo images. */
function isYaencontrePropertyImageUrl(url) {
  return /^https:\\/\\/media\\.yaencontre\\.com\\/img\\/photo\\/[^\\s<>"']+\\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(cleanMailUrl(url));
}
/**
 * Safe ownership for Yaencontre digest photos: photo must be inside a link to
 * the specific listing, preventing unrelated cards from sharing thumbnails.
 */
function extractYaencontreMailImages(html) {
  const out=[],seen=new Set();
  for(const anchor of String(html||'').matchAll(/<a\\b([^>]*)>([\\s\\S]*?)<\\/a\\s*>/gi)){
    const url=getMailHtmlAttribute('<a '+anchor[1]+'>','href');
    const listingId=getMailListingId(url);
    if(!/^yaencontre:\\d+$/.test(listingId||''))continue;
    for(const tag of anchor[2].match(/<img\\b[^>]*>/gi)||[]){
      const src=getMailHtmlAttribute(tag,'src')||getMailHtmlAttribute(tag,'data-src');
      if(!isYaencontrePropertyImageUrl(src))continue;
      const key=listingId+'|'+src;
      if(seen.has(key))continue;
      seen.add(key);
      out.push({listing_id:listingId,listing_url:url,source_url:src});
    }
  }
  return out;
}
