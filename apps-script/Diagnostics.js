/**
 * Strukturierte Konsolenlogs und begrenztes Diagnoseblatt.
 * Keine Mailtexte, Betreffzeilen, Zugangsdaten oder URL-Querys protokollieren.
 */
const IMAGE_DIAGNOSTICS = {
  sheetName: 'Diagnose', maxEvents: 250, maxRows: 5000,
  headers: ['Zeit UTC', 'Lauf-ID', 'Stufe', 'Ebene', 'Gmail-ID',
    'Datensatz-ID', 'Status', 'Dauer ms', 'Details JSON']
};
let imageDiagnosticRun = null;

function beginImageDiagnostics(kind) {
  imageDiagnosticRun = {
    id: new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 10),
    started: Date.now(), events: [], dropped: 0, errors: 0, warnings: 0
  };
  logImageDiagnostic('run_start', { status: kind });
}

function safeImageDiagnosticValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map(safeImageDiagnosticValue);
  return String(value === undefined ? '' : value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => url.split(/[?#]/)[0])
    .slice(0, 1000);
}

function logImageDiagnostic(stage, detail) {
  // Protokollfehler dürfen die Verarbeitung nicht abbrechen.
  try {
    const input = detail || {}, details = {};
    const fields = ['source_url', 'http_status', 'mime', 'bytes', 'count', 'links',
      'images', 'files', 'uploaded', 'row', 'expected_id', 'observed_id',
      'expected_email_id', 'observed_email_id', 'error', 'reason', 'dropped', 'errors'];
    for (const name of fields) {
      if (input[name] !== undefined) details[name] = safeImageDiagnosticValue(input[name]);
    }
    if (input.source_url) {
      let hash = 2166136261;
      for (const char of String(input.source_url)) {
        hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619);
      }
      details.source_key = (hash >>> 0).toString(16); // Korrelations-ID, keine URL-Query.
    }
    const event = {
      at: new Date().toISOString(), run_id: imageDiagnosticRun ? imageDiagnosticRun.id : 'manual',
      stage: String(stage), level: input.level || 'INFO',
      mail_id: input.mail_id || (imageDiagnosticRun && imageDiagnosticRun.mailId) || '',
      listing_id: input.listing_id || '',
      status: input.status || '', duration_ms: input.duration_ms === undefined ? '' : input.duration_ms,
      details
    };
    if (imageDiagnosticRun && event.level === 'ERROR') imageDiagnosticRun.errors++;
    if (imageDiagnosticRun && event.level === 'WARN') imageDiagnosticRun.warnings++;
    console.log(JSON.stringify(event));
    if (imageDiagnosticRun) {
      if (imageDiagnosticRun.events.length < IMAGE_DIAGNOSTICS.maxEvents - 1)
        imageDiagnosticRun.events.push(event);
      else imageDiagnosticRun.dropped++;
    }
  } catch (error) {
    console.warn('Diagnoseereignis konnte nicht erstellt werden');
  }
}

function runImageDiagnosticStage(stage, action) {
  const started = Date.now();
  logImageDiagnostic(stage, { status: 'started' });
  try {
    const result = action();
    logImageDiagnostic(stage, { status: 'completed', duration_ms: Date.now() - started });
    return result;
  } catch (error) {
    logImageDiagnostic(stage, {
      level: 'ERROR', status: 'failed', duration_ms: Date.now() - started,
      error: error.message
    });
    throw error;
  }
}

function finishImageDiagnostics() {
  if (!imageDiagnosticRun) return;
  const run = imageDiagnosticRun;
  const finish = {
    at: new Date().toISOString(), run_id: run.id, stage: 'run_end',
    level: run.errors || run.warnings ? 'WARN' : 'INFO', mail_id: '', listing_id: '',
    status: run.errors ? 'finished_with_errors' : run.warnings ? 'finished_with_warnings' : 'finished',
    duration_ms: Date.now() - run.started,
    details: { dropped: run.dropped, errors: run.errors, warnings: run.warnings }
  };
  console.log(JSON.stringify(finish));
  run.events.push(finish);
  try {
    const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
    let sheet = ss.getSheetByName(IMAGE_DIAGNOSTICS.sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(IMAGE_DIAGNOSTICS.sheetName);
      sheet.getRange(1, 1, 1, IMAGE_DIAGNOSTICS.headers.length).setValues([IMAGE_DIAGNOSTICS.headers]);
      sheet.setFrozenRows(1);
    }
    const headers = sheet.getRange(1, 1, 1, IMAGE_DIAGNOSTICS.headers.length).getValues()[0];
    if (headers.some((h, i) => h !== IMAGE_DIAGNOSTICS.headers[i]))
      throw new Error('Diagnose-Header weichen ab; kein Schreibzugriff');
    const rows = run.events.map(event => [
      event.at, event.run_id, event.stage, event.level, event.mail_id,
      event.listing_id, event.status, event.duration_ms, JSON.stringify(event.details)
    ].map(value => typeof value === 'string' && /^[=+\-@]/.test(value) ? "'" + value : value));
    const start = sheet.getLastRow() + 1;
    const needed = start + rows.length - 1;
    if (sheet.getMaxRows() < needed)
      sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
    sheet.getRange(start, 1, rows.length, IMAGE_DIAGNOSTICS.headers.length).setValues(rows);
    const excess = sheet.getLastRow() - 1 - IMAGE_DIAGNOSTICS.maxRows;
    if (excess > 0) sheet.deleteRows(2, excess); // Nur alte Diagnosezeilen.
  } catch (error) {
    console.warn('Diagnoseblatt nicht geschrieben: ' + safeImageDiagnosticValue(error.message));
  } finally {
    imageDiagnosticRun = null;
  }
}

/** Anzeigen nur lesen. Abweichungen melden, keine automatische Reparatur. */
function auditListingImageAssignments(ss) {
  const sheet = ss.getSheetByName(CONFIG.sheetName);
  if (!sheet || sheet.getLastRow() < 2) return { checked: 0, issues: 0 };
  const rows = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = rows.shift(), column = name => {
    const index = headers.indexOf(name);
    if (index < 0) throw new Error('Audit-Spalte fehlt: ' + name);
    return index;
  };
  const idCol = column('Datensatz-ID'), mailCol = column('E-Mail-ID');
  const jsonCol = column('Bildanalyse JSON'), seen = new Set();
  let checked = 0, issues = 0;
  for (const [index, row] of rows.entries()) {
    const id = String(row[idCol] || '').trim();
    if (!id) continue;
    checked++;
    const mail = String(row[mailCol] || '').trim();
    const report = (reason, extra) => {
      issues++;
      logImageDiagnostic('identity_audit', Object.assign({
        level: 'WARN', listing_id: id, mail_id: mail,
        status: reason, row: index + 2
      }, extra || {}));
    };
    if (seen.has(id)) report('duplicate_listing_id');
    seen.add(id);
    let data;
    try {
      data = JSON.parse(String(row[jsonCol] || '{}'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Kein JSON-Objekt');
    } catch (error) {
      report('invalid_json', { error: error.message }); continue;
    }
    if (data.source_email_id && mail && String(data.source_email_id) !== mail)
      report('source_email_mismatch', { expected_email_id: mail, observed_email_id: data.source_email_id });
    const files = Array.isArray(data.drive_files) ? data.drive_files.filter(Boolean) : [];
    for (const file of files) {
      if (file.listing_id && file.listing_id !== id)
        report('file_listing_mismatch', { expected_id: id, observed_id: file.listing_id });
    }
    const analyzed = new Set(Array.isArray(data.analyzed_file_ids) ? data.analyzed_file_ids : []);
    if (data.ai_analysis_status === 'completed' &&
        files.some(file => file.file_id && !analyzed.has(file.file_id)))
      report('completed_with_unanalyzed_files', { files: files.length, count: analyzed.size });
  }
  logImageDiagnostic('identity_audit', { status: issues ? 'issues_found' : 'consistent', count: checked, errors: issues });
  return { checked, issues };
}

/** Manueller Prüflauf: keine Downloads, Sortierungen oder Anzeigenänderungen. */
function runImageDiagnostics() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { console.log('Diagnose: Pipeline beschäftigt'); return; }
  beginImageDiagnostics('audit_only');
  try {
    return runImageDiagnosticStage('identity_audit', () =>
      auditListingImageAssignments(SpreadsheetApp.openById(CONFIG.spreadsheetId)));
  } finally {
    finishImageDiagnostics();
    lock.releaseLock();
  }
}

