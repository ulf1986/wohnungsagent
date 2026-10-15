/** Eine KI-Stufe manuell verarbeiten, ohne Mail-/Bildimport oder Triggeränderung. */
function runAiProcessing() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Ein anderer Lauf ist aktiv.');
  try {
    beginImageDiagnostics('ai_processing');
    const ss = SpreadsheetApp.openById(getWohnungsagentSpreadsheetId_());
    const result = processNextAiListing(ss);
    logImageDiagnostic('ai_result', {
      listing_id: result.listingId || '', status: result.status,
      count: result.analyzed || 0, level: result.status === 'retry' ? 'WARN' : 'INFO',
      error: result.error || ''
    });
    if (imageDiagnosticRun) { imageDiagnosticRun.mailId = ''; imageDiagnosticRun.provider = ''; }
    updateListingPreviewsInternal();
    sortListingsByMailReceived(ss);
    return result;
  } catch (error) {
    logImageDiagnostic('ai_error', { status: 'failed', level: 'ERROR', error: error.message });
    throw error;
  } finally {
    finishImageDiagnostics();
    lock.releaseLock();
  }
}
