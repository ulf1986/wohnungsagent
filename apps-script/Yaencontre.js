
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

function fetchYaencontreListingPage(url) { return fetchListingPage_(url, 'yaencontre'); }
