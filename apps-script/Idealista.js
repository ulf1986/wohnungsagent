
function extractIdealistaImages(data) {
  const candidates = [
    ...(data.bild_urls || []),
    ...(data.image_urls || []),
    ...extractHtmlImageUrls(data.html || '')
  ];

  // Nur Inseratsfotos vom Idealista-Bilddienst, keine Logos oder App-Store-Badges.
  return uniqueImageUrls(candidates).filter(url =>
    /^https:\/\/img\d*\.idealista\.com\/[^?#]*\/id\.pro\.es\.image\.master\/[^?#]+\.(?:jpe?g|png|webp)(?:[?#]|$)/i.test(url)
  );
}
