/**
 * Private JSONL-Datei je Lauf. Keine Logs in Anzeigen-/Diagnose-Sheets.
 * Ein Start-Checkpoint bleibt auch bei Abbruch/Timeout erhalten.
 */
const IMAGE_DIAGNOSTICS = {
  schemaVersion: 3, maxEvents: 1000, checkpointEvery: 25,
  folderProperty: 'WOHNUNGSAGENT_LOG_FOLDER_ID',
  lastFileProperty: 'WOHNUNGSAGENT_LAST_LOG_FILE_ID',
  folderName: 'Logs'
};
let imageDiagnosticRun = null;

function getImageLogContext() {
  const spreadsheetId = typeof getWohnungsagentSpreadsheetId_ === 'function'
    ? getWohnungsagentSpreadsheetId_() : CONFIG.spreadsheetId;
  return {
    schema_version: IMAGE_DIAGNOSTICS.schemaVersion,
    implementation: typeof AI_PIPELINE === 'undefined' ? 'image-import-1.x' : 'wohnungsagent-2.0',
    spreadsheet_id: spreadsheetId
  };
}

function beginImageDiagnostics(kind) {
  imageDiagnosticRun = {
    id: new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 10),
    started: Date.now(), kind: String(kind || 'manual'), context: getImageLogContext(),
    events: [], dropped: 0, errors: 0, warnings: 0, file: null, persistedCount: 0
  };
  logImageDiagnostic('run_start', { status: imageDiagnosticRun.kind });
  checkpointImageDiagnostics();
}

function safeImageDiagnosticValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map(safeImageDiagnosticValue);
  return String(value === undefined ? '' : value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => url.split(/[?#]/)[0])
    .replace(/\b(?:Bearer\s+|sk-)[a-z0-9_.-]+/gi, '[REDACTED]')
    .slice(0, 1000);
}

/** Nur bekannte Anbieterkennungen speichern; niemals Absender oder Mailtext. */
function getImageDiagnosticProvider(detail) {
  const input = detail || {}, known = ['fotocasa', 'idealista', 'yaencontre', 'pisos', 'immoscout', 'milanuncios'];
  const names = values => [...new Set(values.map(value => String(value || '').toLowerCase().split(':')[0])
    .filter(value => known.includes(value)))];
  if (known.includes(input.provider)) return input.provider;
  const ids = names([input.listing_id].concat(input.observed_id || []));
  if (ids.length) return ids.length === 1 ? ids[0] : 'mixed';
  const host = String(input.source_url || '').match(/^https?:\/\/([^/:?#]+)/i);
  if (host) {
    const domain = host[1].toLowerCase();
    const portals = [['fotocasa', 'fotocasa.es'], ['idealista', 'idealista.com'],
      ['yaencontre', 'yaencontre.com'], ['pisos', 'pisos.com'],
      ['immoscout', 'immobilienscout24.de'], ['milanuncios', 'milanuncios.com']];
    for (const [provider, suffix] of portals)
      if (domain === suffix || domain.endsWith('.' + suffix)) return provider;
  }
  return imageDiagnosticRun && imageDiagnosticRun.provider || 'unknown';
}

function logImageDiagnostic(stage, detail) {
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
      details.source_key = (hash >>> 0).toString(16);
    }
    const run = imageDiagnosticRun;
    const event = Object.assign({}, run ? run.context : getImageLogContext(), {
      at: new Date().toISOString(), run_id: run ? run.id : 'manual',
      stage: safeImageDiagnosticValue(stage), level: input.level || 'INFO',
      component: /^(run_|mail_|queue_status|pipeline_error|identity_audit|listing_import|availability|previews|sort)/.test(stage)
        ? 'pipeline' : 'converter',
      provider: getImageDiagnosticProvider(input),
      mail_id: safeImageDiagnosticValue(input.mail_id || (run && run.mailId) || ''),
      listing_id: safeImageDiagnosticValue(input.listing_id || ''),
      status: safeImageDiagnosticValue(input.status || ''),
      duration_ms: input.duration_ms === undefined ? '' : input.duration_ms, details
    });
    if (run && event.level === 'ERROR') run.errors++;
    if (run && event.level === 'WARN') run.warnings++;
    console.log(JSON.stringify(event));
    if (run) {
      if (run.events.length < IMAGE_DIAGNOSTICS.maxEvents - 1) run.events.push(event);
      else run.dropped++;
      if (event.level === 'ERROR' ||
          (run.events.length > run.persistedCount &&
            run.events.length % IMAGE_DIAGNOSTICS.checkpointEvery === 0))
        checkpointImageDiagnostics();
    }
  } catch (error) {
    console.warn('Logereignis konnte nicht erstellt werden');
  }
}

/** Ordner neben dem tatsächlich verwendeten Sheet; ID dauerhaft merken. */
function getImageLogFolder() {
  const properties = PropertiesService.getScriptProperties();
  const configured = properties.getProperty(IMAGE_DIAGNOSTICS.folderProperty);
  if (configured) return DriveApp.getFolderById(configured);
  const context = imageDiagnosticRun ? imageDiagnosticRun.context : getImageLogContext();
  const parents = DriveApp.getFileById(context.spreadsheet_id).getParents();
  if (!parents.hasNext()) throw new Error('Logordner fehlt: kein übergeordneter Sheet-Ordner');
  const parent = parents.next(), folders = parent.getFoldersByName(IMAGE_DIAGNOSTICS.folderName);
  const folder = folders.hasNext() ? folders.next() : parent.createFolder(IMAGE_DIAGNOSTICS.folderName);
  properties.setProperty(IMAGE_DIAGNOSTICS.folderProperty, folder.getId());
  return folder;
}

/** Bei Fehlern bleibt die Pipeline funktionsfähig, die Konsole enthält den Hinweis. */
function checkpointImageDiagnostics() {
  const run = imageDiagnosticRun;
  if (!run || !run.events.length || run.events.length === run.persistedCount) return;
  try {
    const content = run.events.map(event => JSON.stringify(event)).join('\n') + '\n';
    if (!run.file) {
      const name = 'wohnungsagent_' + run.id.replace(/[:.]/g, '-') + '.jsonl';
      run.file = getImageLogFolder().createFile(name, content, 'text/plain');
      PropertiesService.getScriptProperties()
        .setProperty(IMAGE_DIAGNOSTICS.lastFileProperty, run.file.getId());
      console.log(JSON.stringify({
        stage: 'log_file', run_id: run.id, file_id: run.file.getId(), url: run.file.getUrl()
      }));
    } else {
      run.file.setContent(content);
    }
    run.persistedCount = run.events.length;
  } catch (error) {
    console.warn('Logdatei nicht gespeichert: ' + safeImageDiagnosticValue(error.message));
  }
}

function runImageDiagnosticStage(stage, action) {
  const started = Date.now();
  logImageDiagnostic(stage, { status: 'started' });
  try {
    const result = action();
    logImageDiagnostic(stage, { status: 'completed', duration_ms: Date.now() - started });
    checkpointImageDiagnostics();
    return result;
  } catch (error) {
    logImageDiagnostic(stage, {
      level: 'ERROR', status: 'failed', duration_ms: Date.now() - started, error: error.message
    });
    throw error;
  }
}

function finishImageDiagnostics() {
  if (!imageDiagnosticRun) return;
  const run = imageDiagnosticRun;
  try {
    const finish = Object.assign({}, run.context, {
      at: new Date().toISOString(), run_id: run.id, stage: 'run_end',
      component: 'pipeline', provider: 'unknown',
      level: run.errors || run.warnings ? 'WARN' : 'INFO', mail_id: '', listing_id: '',
      status: run.errors ? 'finished_with_errors' : run.warnings ? 'finished_with_warnings' : 'finished',
      duration_ms: Date.now() - run.started,
      details: { dropped: run.dropped, errors: run.errors, warnings: run.warnings }
    });
    console.log(JSON.stringify(finish));
    run.events.push(finish);
    checkpointImageDiagnostics();
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

