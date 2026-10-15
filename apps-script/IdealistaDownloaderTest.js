/** Gezielter manueller Test. Keine Queue-/Anzeigen-/Label-/Triggeränderung. */
function testIdealistaDownloader() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Ein anderer Lauf ist aktiv.');
  beginImageDiagnostics('idealista_downloader_test');
  try {
    // Bewusst eine einzelne, vorab ausgewählte aktuelle Mail; kein historischer Scan.
    const mail = GmailApp.getMessageById('1a13f8c1d9ea39ad');
    if (Date.now() - mail.getDate().getTime() > 72 * 60 * 60 * 1000)
      throw new Error('Testmail ist älter als 72 Stunden. Neues Beispiel auswählen.');
    imageDiagnosticRun.mailId = mail.getId();
    imageDiagnosticRun.provider = 'idealista';
    const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
    const links = extractPropertyLinks(mail.getBody(), mail.getPlainBody());
    const ids = [...new Set(links.map(getMailListingId).filter(Boolean))];
    if (ids.length !== 1 || !/^idealista:\d+$/.test(ids[0]))
      throw new Error('Testmail enthält kein eindeutig einzelnes Idealista-Inserat.');
    const listingId = ids[0];
    if (readMailImageBlacklist(ss).has(listingId))
      throw new Error('Testangebot steht auf der Sperrliste; kein Download.');
    logImageDiagnostic('idealista_test_extract', {
      listing_id: listingId, status: 'identified', links: links.length, count: ids.length
    });

    // Vorhandene Quellreferenzen nur lesen und für den identischen Downloadweg nutzen.
    const queue = ss.getSheetByName(MAIL_IMPORT.sheetName);
    const queued = queue && readMailQueueIndex(queue)[mail.getId()];
    const existing = queued ? parseMailQueueFiles(queue.getRange(queued.row, 14).getValue()) : [];
    const mailUrls = extractIdealistaImages({ html: mail.getBody() });
    if (!mailUrls.length) throw new Error('Keine E-Mail-Bilder erkannt.');
    const preview = saveListingImages(getImageFolder(), listingId, mailUrls, existing);
    logImageDiagnostic('idealista_test_mail_images', {
      listing_id: listingId, images: mailUrls.length, files: preview.files.length,
      status: preview.errors.length ? 'retry' : 'completed', level: preview.errors.length ? 'WARN' : 'INFO'
    });
    const gallery = downloadIdealistaGallery(listingId.split(':')[1], preview.files);
    logImageDiagnostic('idealista_test_gallery', {
      listing_id: listingId, http_status: gallery.httpStatus, images: gallery.found,
      files: gallery.files.length, uploaded: gallery.created, status: gallery.status,
      level: gallery.complete ? 'INFO' : 'WARN', error: gallery.message || ''
    });
    let verified = 0;
    for (const reference of gallery.files) {
      const file = DriveApp.getFileById(reference.file_id);
      const blob = file.getBlob();
      const bytes = blob.getBytes().map(value => value & 255);
      const mime = blob.getContentType().split(';')[0].trim().toLowerCase();
      const signature = isIdealistaTestImage_(bytes, mime);
      logImageDiagnostic('idealista_test_file', {
        listing_id: listingId, source_url: reference.source_url, file_id: reference.file_id,
        mime, bytes: bytes.length, status: signature ? 'verified' : 'invalid_image',
        level: signature ? 'INFO' : 'ERROR'
      });
      if (signature) verified++;
    }
    const passed = preview.errors.length === 0 && gallery.complete &&
      gallery.files.length > 0 && verified === gallery.files.length;
    logImageDiagnostic('idealista_test_result', {
      listing_id: listingId, status: passed ? 'passed' : 'incomplete',
      files: gallery.files.length, count: verified, level: passed ? 'INFO' : 'WARN'
    });
    return { passed, listingId, mailImages: preview.files.length,
      galleryStatus: gallery.status, galleryImages: gallery.found, verified };
  } catch (error) {
    logImageDiagnostic('idealista_test_result', { status: 'failed', level: 'ERROR', error: error.message });
    throw error;
  } finally {
    finishImageDiagnostics();
    lock.releaseLock();
  }
}

/** Tatsächliche Dateisignatur statt allein des HTTP-Content-Type prüfen. */
function isIdealistaTestImage_(bytes, mime) {
  if (bytes.length < 2000) return false;
  const starts = signature => signature.every((value, index) => bytes[index] === value);
  if (mime === 'image/jpeg') return starts([255, 216, 255]);
  if (mime === 'image/png') return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (mime === 'image/webp') return starts([82, 73, 70, 70]) &&
    [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value);
  return false;
}
