
/**
 * Pisos.gs
 * Wohnungsagent – Immobilienbilder
 *
 * Extrahiert Bild-URLs für pisos.com.
 *
 * Benötigt die Hilfsfunktionen aus Drive.gs:
 * - extractHtmlImageUrls()
 * - uniqueImageUrls()
 */

function extractPisosImages(data) {
  const candidates = [
    ...(Array.isArray(data.bild_urls) ? data.bild_urls : []),
    ...(Array.isArray(data.image_urls) ? data.image_urls : []),
    ...extractHtmlImageUrls(data.html || '')
  ];

  return uniqueImageUrls(candidates);
}
