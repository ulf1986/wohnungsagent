
/**
 * Drive.gs
 * Wohnungsagent – Immobilienbilder
 *
 * Download und Speicherung in Google Drive.
 * Verwendet CONFIG aus Main.gs.
 */


/**
 * Zentralen Bilderordner aus Skripteigenschaften laden.
 */
function getImageFolder() {
  const folderId = PropertiesService
    .getScriptProperties()
    .getProperty(CONFIG.folderProperty);

  if (!folderId) {
    throw new Error(
      'Skripteigenschaft fehlt: ' +
      CONFIG.folderProperty
    );
  }

  return DriveApp.getFolderById(folderId);
}


/**
 * Bilder herunterladen oder vorhandene Dateien benutzen.
 *
 * Rückgabe:
 * {
 *   files: [...],
 *   created: Anzahl neuer Uploads,
 *   errors: [...]
 * }
 */
function saveListingImages(folder, listingId, urls, existing) {
  const files = [];
  const errors = [];
  let created = 0;

  const safeId = String(listingId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_');

  const oldFiles = Array.isArray(existing)
    ? existing
    : [];

  const imageUrls = uniqueImageUrls(urls || [])
    .slice(0, CONFIG.maxImagesPerListing || 10);

  for (const [index, url] of imageUrls.entries()) {
    const baseFilename =
      safeId + '_' +
      String(index + 1).padStart(2, '0');

    // Bereits gespeicherte Datei anhand der Drive-ID
    // und der ursprünglichen Bild-URL erkennen.
    const previous = oldFiles.find(item =>
      item.source_url === url && item.file_id
    );

    if (previous) {
      try {
        const file = DriveApp.getFileById(
          previous.file_id
        );

        if (!file.isTrashed()) {
          files.push(
            buildImageFileReference(file, url)
          );
          continue;
        }
      } catch (error) {
        console.warn(
          listingId +
          ': alte Dateireferenz nicht erreichbar'
        );
      }
    }

    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'get',
        muteHttpExceptions: true,
        followRedirects: true,
        validateHttpsCertificates: true,
        headers: {
          Accept: 'image/jpeg,image/png,image/webp'
        }
      });

      const status = response.getResponseCode();

      if (status !== 200) {
        throw new Error('HTTP ' + status);
      }

      const blob = response.getBlob();

      const mime = String(blob.getContentType())
        .split(';')[0]
        .trim()
        .toLowerCase();

      const extensions = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp'
      };

      const extension = extensions[mime];

      if (!extension) {
        throw new Error(
          'Ungeeigneter Dateityp: ' + mime
        );
      }

      const sizeBytes = blob.getBytes().length;

      if (sizeBytes < 2000) {
        throw new Error(
          'Bilddatei zu klein: ' +
          sizeBytes + ' Bytes'
        );
      }

      const filename = baseFilename + '.' + extension;

      // Vorhandene Dateien nur wiederverwenden,
      // wenn die Quell-URL eindeutig übereinstimmt.
      const matches = folder.getFilesByName(filename);

      let file = null;

      while (matches.hasNext()) {
        const candidate = matches.next();

        if (candidate.isTrashed()) continue;

        const matchingReference = oldFiles.some(item =>
          item.file_id === candidate.getId() &&
          item.source_url === url
        );

        if (matchingReference) {
          file = candidate;
          break;
        }
      }

      if (!file) {
        let targetName = filename;

        // Bei gleichnamiger Datei einen Hash ergänzen,
        // damit keine Bilder überschrieben werden.
        if (folder.getFilesByName(filename).hasNext()) {
          const suffix = getUrlHashPrefix(url);

          targetName = baseFilename +
            '_' + suffix + '.' + extension;
        }

        const sameName = folder.getFilesByName(
          targetName
        );

        while (sameName.hasNext()) {
          const candidate = sameName.next();

          if (candidate.isTrashed()) continue;

          const known = oldFiles.some(item =>
            item.file_id === candidate.getId() &&
            item.source_url === url
          );

          if (known) {
            file = candidate;
            break;
          }
        }

        if (!file) {
          file = folder.createFile(
            blob.setName(targetName)
          );

          created++;

          console.log(
            'Bild gespeichert: ' +
            targetName +
            ' (' + sizeBytes + ' Bytes)'
          );
        }
      }

      files.push(
        buildImageFileReference(file, url)
      );

    } catch (error) {
      const message =
        listingId + ' Bild ' + (index + 1) +
        ': ' + error.message;

      errors.push(message);
      console.warn(message);
    }
  }

  return {
    files,
    created,
    errors
  };
}


/**
 * Einheitliche Drive-Dateireferenz.
 */
function buildImageFileReference(file, url) {
  return {
    file_id: file.getId(),
    name: file.getName(),
    source_url: url,
    drive_url: file.getUrl()
  };
}


/**
 * Kurzer SHA-256-Hash für eindeutige Dateinamen.
 */
function getUrlHashPrefix(url) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(url)
  );

  return bytes.slice(0, 6)
    .map(byte =>
      ('0' + (byte & 255).toString(16)).slice(-2)
    ).join('');
}


/**
 * Bild-URLs bereinigen und Duplikate entfernen.
 *
 * Tracking-Pixel, Logos und technische Bilder
 * werden ausgeschlossen.
 */
function uniqueImageUrls(urls) {
  const result = [];
  const seen = new Set();

  for (const original of urls) {
    if (typeof original !== 'string') {
      continue;
    }

    const url = original
      .trim()
      .replace(/&amp;/gi, '&')
      .replace(/\\u0026/gi, '&');

    // Fotocasa-Tracking-Pixel für E-Mail-Öffnungen.
    // Kein Immobilienfoto, daher ohne Warnung ignorieren.
    if (
      /^https?:\/\/sgt\.fotocasa\.es\/wf\/open(?:[/?#]|$)/i
        .test(url)
    ) {
      continue;
    }

    // Nur vollständige HTTPS-Bildadressen erlauben.
    if (
      !/^https:\/\/[^\/\s]+\/\S+/i.test(url)
    ) {
      console.warn(
        'Ungültige Bild-URL: ' +
        String(url).slice(0, 200)
      );
      continue;
    }

    if (/[<>"'\s]/.test(url)) {
      console.warn(
        'Ungültige Zeichen in Bild-URL'
      );
      continue;
    }

    const pathname = url
      .split('?')[0]
      .toLowerCase();

    // Typische Tracking- und Layoutbilder ausschließen.
    if (
      /(?:logo|tracking|pixel|spacer|avatar|favicon|icon)/
        .test(pathname)
    ) {
      continue;
    }

    if (!seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }

  return result;
}


/**
 * Bild-URLs aus HTML-img-Tags extrahieren.
 *
 * Unterstützt:
 * src, data-src, srcset, data-srcset.
 */
function extractHtmlImageUrls(html) {
  const urls = [];

  const tags = String(html)
    .match(/<img\b[^>]*>/gi) || [];

  const attributes = [
    'src',
    'data-src',
    'srcset',
    'data-srcset'
  ];

  for (const tag of tags) {
    for (const attr of attributes) {
      const pattern = new RegExp(
        `\\b${attr}\\s*=\\s*["']([^"']+)["']`,
        'i'
      );

      const match = tag.match(pattern);

      if (!match) {
        continue;
      }

      for (const candidate of match[1].split(',')) {
        const url = candidate
          .trim()
          .split(/\s+/)[0];

        if (url) {
          urls.push(url);
        }
      }
    }
  }

  return uniqueImageUrls(urls);
}
