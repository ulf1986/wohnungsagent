
function extractIdealistaImages(data) {
  const candidates = [
    ...(data.bild_urls || []),
    ...(data.image_urls || []),
    ...extractHtmlImageUrls(data.html || '')
  ];

  return uniqueImageUrls(candidates);
}

function fetchIdealistaListingPage(url) { return fetchListingPage_(url, 'idealista'); }
