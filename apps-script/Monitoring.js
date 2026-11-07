/**
 * Wohnungsagent: sichtbares, fehlertolerantes Monitoring.
 * Technische JSONL-Diagnose bleibt die detaillierte Quelle.
 * Laeufe: ein Eintrag je beendetem Pipeline-Lauf.
 * Entscheidungen: eine Zeile je Mail-Import bzw. KI-Entscheidung.
 */
const WA_MONITOR = {
  runs: 'Läufe',
  decisions: 'Entscheidungen',
  runHeaders: ['Lauf-ID','Start (UTC)','Ende (UTC)','Dauer (s)','Status',
    'E-Mails ausgewählt','E-Mails bearbeitet','Zur KI bereit','Gesperrt',
    'Wiederholungen','KI-Ergebnis','KI-Anzeigen-ID','Fehler / Hinweis',
    'Letzter E-Mail-Eingang (UTC)','Letzte Queue-Aktualisierung (UTC)'],
  decisionHeaders: ['Zeit (UTC)','Lauf-ID','Stufe','Gmail-ID','Datensatz-ID',
    'Status','Grund / Hinweis','Haupteintrag-ID']
};
let waMonitorRun_ = null;

function waMonitorStart_() {
  try {
    waMonitorRun_ = {id: imageDiagnosticRun && imageDiagnosticRun.id ||
      new Date().toISOString(), started: Date.now(), stats: null, ai: null,
      issues: [], decisions: []};
  } catch (e) { console.warn('Monitor Start: ' + e.message); }
}
function waMonitorIssue_(reason) {
  if (waMonitorRun_) waMonitorRun_.issues.push(String(reason || '').slice(0, 450));
}
function waMonitorMail_(mailId, status, reason, ids) {
  if (!waMonitorRun_) return;
  const listingIds = Array.isArray(ids) && ids.length ? ids : [''];
  for (const listingId of listingIds) {
    waMonitorRun_.decisions.push([new Date().toISOString(),waMonitorRun_.id,
      'Gmail',String(mailId||''),String(listingId||''),String(status||''),
      String(reason||'').slice(0,500),'']);
  }
}
function waMonitorAi_(mailId, result) {
  if (!waMonitorRun_) return;
  const r = result || {};
  waMonitorRun_.ai = r;
  if (r.status === 'empty' || r.status === 'no_ready_jobs') return;
  waMonitorRun_.decisions.push([new Date().toISOString(),waMonitorRun_.id,
    'KI',String(mailId||''),String(r.listingId||''),String(r.status||''),
    String(r.error||r.reason||r.canonicalListingId||
      (r.status==='completed'?'Abgeschlossen':'')).slice(0,500),
    String(r.canonicalListingId||'')]);
}
function waMonitorStats_(stats) {
  if (waMonitorRun_) waMonitorRun_.stats = Object.assign({}, stats);
}
function waMonitorSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const existing = sheet.getRange(1,1,1,headers.length).getValues()[0];
  if (existing.every((v,i)=>v===headers[i])) return sheet;
  // Alte Lauf-Historie ist leer, andernfalls nichts ueberschreiben.
  if (sheet.getLastRow() === 1 && existing.some(Boolean)) {
    const old = existing.filter(Boolean);
    if (name === WA_MONITOR.runs &&
        old[0] === 'Lauf-ID' && old[1] !== headers[1]) {
      sheet.getRange(1,1,1,headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      return sheet;
    }
  }
  if (existing.some(Boolean))
    throw new Error('Monitor-Schema abweichend: ' + name);
  sheet.getRange(1,1,1,headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  return sheet;
}
function waMonitorLastQueue_(ss) {
  const q = ss.getSheetByName('Verarbeitung');
  if (!q || q.getLastRow()<2) return ['', ''];
  const end=q.getLastRow();
  const first=Math.max(2,end-30);
  const rows=q.getRange(first,8,end-first+1,13).getValues();
  let newest='',changed='';
  for (const row of rows) {
    const at=row[1] instanceof Date ? row[1].toISOString() : String(row[1]||'');
    const updated=row[12] instanceof Date ? row[12].toISOString() : String(row[12]||'');
    if (at>newest)newest=at;
    if (updated>changed)changed=updated;
  }
  return [newest,changed];
}
function waMonitorFinish_(failed, runsSheetName) {
  const m = waMonitorRun_;
  waMonitorRun_ = null;
  if (!m) return;
  try {
    const ss=SpreadsheetApp.openById(CONFIG.spreadsheetId);
    const s=m.stats||{};
    const note=m.issues.join(' | ').slice(0,900);
    const status=failed?'failed':m.issues.length||s.retry?'warning':'ok';
    const last=waMonitorLastQueue_(ss);
    const runs=waMonitorSheet_(ss,runsSheetName || WA_MONITOR.runs,WA_MONITOR.runHeaders);
    runs.appendRow([m.id,new Date(m.started).toISOString(),new Date().toISOString(),
      Math.round((Date.now()-m.started)/1000),status,s.candidates||0,
      s.processed||0,s.completed||0,s.blocked||0,s.retry||0,
      m.ai && m.ai.status||'',m.ai && m.ai.listingId||'',note,last[0],last[1]]);
    if(m.decisions.length) {
      const sheet=waMonitorSheet_(ss,WA_MONITOR.decisions,WA_MONITOR.decisionHeaders);
      // Batch write to avoid per-listing API calls.
      const start=sheet.getLastRow()+1;
      sheet.getRange(start,1,m.decisions.length,WA_MONITOR.decisionHeaders.length)
        .setValues(m.decisions);
    }
  } catch (e) {
    console.warn('Monitoring konnte nicht gespeichert werden: '+e.message);
  }
}

/** Manuell ausfuehrbarer Check; keine Abhaengigkeit von Gmail API. */
function checkWohnungsagentHealth() {
  const ss=SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const runs=ss.getSheetByName(WA_MONITOR.runs);
  if (!runs || runs.getLastRow()<2)
    return {status:'unknown',reason:'Noch kein protokollierter Pipeline-Lauf'};
  const end=runs.getLastRow();
  const row=runs.getRange(end,1,1,WA_MONITOR.runHeaders.length).getValues()[0];
  const finished=Date.parse(String(row[2]||''));
  const age=Date.now()-finished;
  const result={status:age>20*60000?'failed':String(row[4]||'unknown'),
    lastRun:String(row[2]||''),ageMinutes:Math.round(age/60000),
    lastMail:String(row[13]||''),lastQueueUpdate:String(row[14]||''),
    reason:age>20*60000?'Kein abgeschlossener Lauf seit mehr als 20 Minuten':
      String(row[12]||'')};
  console.log(JSON.stringify(result));
  return result;
}

