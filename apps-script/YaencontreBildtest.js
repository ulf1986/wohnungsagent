/**
 * Einmaliger Yaencontre-Downloadtest ohne Änderungen an Drive oder Sheets.
 * Testet zwei bereits bekannte Original-Bildadressen mit UrlFetchApp.
 */
function testYaencontreImageDownload() {
  const urls = [
    'https://media.yaencontre.com/img/photo/w630/69904/69904-57615233-1522604590.jpg',
    'https://media.yaencontre.com/img/photo/w630/69904/69904-57615233-1522604591.jpg'
  ];
  for (const url of urls) {
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'get',
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          Accept: 'image/jpeg,image/png,image/webp,image/avif,*/*'
        }
      });
      const status = response.getResponseCode();
      const headers = response.getHeaders();
      const type = String(headers['Content-Type'] || headers['content-type'] || '');
      const bytes = response.getBlob().getBytes();
      const magic = bytes.slice(0, 12).map(b => (b & 255).toString(16).padStart(2,'0')).join('');
      const isJpeg = magic.startsWith('ffd8ff');
      const isPng = magic.startsWith('89504e470d0a1a0a');
      const isWebp = magic.slice(8, 16) === '57454250';
      const image = isJpeg || isPng || isWebp;
      console.log(JSON.stringify({url, http:status, contentType:type, bytes:bytes.length,
        detectedImage:image, signature:magic}));
    } catch (error) {
      console.log(JSON.stringify({url,error:String(error.message || error)}));
    }
  }
}
