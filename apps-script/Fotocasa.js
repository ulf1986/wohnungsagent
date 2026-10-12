
/**
 * Fotocasa.gs
 * Wohnungsagent – Fotocasa-Bildextraktion
 *
 * Verwendet die Funktionen aus Drive.gs.
 */

function extractFotocasaImages(data) {
  const candidates = [
    ...(Array.isArray(data.bild_urls)
      ? data.bild_urls
      : []),

    ...(Array.isArray(data.image_urls)
      ? data.image_urls
      : []),

    ...extractHtmlImageUrls(data.html || '')
  ];

  return uniqueImageUrls(candidates).filter(url =>
    /^https:\/\/static\.fotocasa\.es\/images\/(?:ads|anuncio)\//i
      .test(url)
  );
}
