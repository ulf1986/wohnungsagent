/**
 * Optional low-latency delivery from the AI worker. The existing GitHub
 * sender remains a fallback until direct credentials are activated.
 *
 * Script Properties (never commit secrets):
 * TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WOHNUNGSAGENT_DIRECT_TELEGRAM_ACTIVE
 *
 * Activate only after adding both credentials in Apps Script settings.
 * In-flight evaluations are sent once they reach a final eligible state.
 */
const WA_TELEGRAM_DIRECT = {
  sentColumn: 'Telegram Versand UTC',
  activeProperty: 'WOHNUNGSAGENT_DIRECT_TELEGRAM_ACTIVE',
  latencySheet: 'E2E-Laufzeiten'
};

function directTelegramReady_() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty(WA_TELEGRAM_DIRECT.activeProperty) === 'true' &&
    !!props.getProperty('TELEGRAM_BOT_TOKEN') &&
    !!props.getProperty('TELEGRAM_CHAT_ID');
}

function directTelegramCellText_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function directTelegramNumber_(value) {
  const raw = directTelegramCellText_(value)
    .replace(/\s|€/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
  const n = Number(raw);
  return raw && Number.isFinite(n) ? n : null;
}

function directTelegramEscape_(value) {
  return directTelegramCellText_(value).replace(/&/g,'&amp;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** A fresh completed AI assessment is eligible or needs manual fact-checking. */
function directTelegramCandidate_(row) {
  const id = directTelegramCellText_(row['Datensatz-ID']);
  const url = directTelegramCellText_(row['Anzeigenlink']);
  const status = directTelegramCellText_(row['Status']).toLowerCase();
  const ai = directTelegramCellText_(row['KI-Bewertung']).toLowerCase();
  const rent = directTelegramNumber_(row['Miete']);
  const area = directTelegramNumber_(row['Fläche']);
  if (!id || !/^https:\/\//i.test(url) || ai !== 'abgeschlossen' ||
      directTelegramCellText_(row['Telegram Versand UTC'])) return null;
  if (directTelegramCellText_(row['Zu löschen']).toLowerCase() === 'true' ||
      ['ausgeschlossen', 'nicht verfügbar'].includes(status)) return null;
  if (rent !== null && (rent < 800 || rent > 1200)) return null;
  if (area !== null && area < 60) return null;
  // Don't send ambiguous entries as approved apartments.
  const confirmed = status === 'geeignet' && rent !== null && area !== null;
  return {id, url, rent, area, confirmed,
    title:directTelegramCellText_(row['Titel']),
    received:directTelegramCellText_(row['Eingang (UTC)']),
    homeScore:directTelegramCellText_(row['Wohnungsbewertung (0–100)']),
    priceScore:directTelegramCellText_(row['Preisbewertung (0–100)'])};
}

function directTelegramMessage_(candidate) {
  const c = candidate;
  const lines = [
    c.confirmed ? '✅ <b>Wohnung: KI-Prüfung abgeschlossen</b>' :
                  '🔎 <b>Wohnung: manuell prüfen</b>',
    'Inserat: <code>' + directTelegramEscape_(c.id) + '</code>'
  ];
  if (c.title) lines.push(directTelegramEscape_(c.title).slice(0,130));
  lines.push('Miete: ' + (c.rent === null ? 'unbekannt' : c.rent + ' €'));
  lines.push('Fläche: ' + (c.area === null ? 'unbekannt' : c.area + ' m²'));
  if (c.homeScore) lines.push('Wohnungsbewertung: ' + directTelegramEscape_(c.homeScore) + '/100');
  if (c.priceScore) lines.push('Preisbewertung: ' + directTelegramEscape_(c.priceScore) + '/100');
  if (!c.confirmed) lines.push('Bitte unbestätigte Wohnungsdaten prüfen.');
  lines.push('<a href="' + directTelegramEscape_(c.url) + '">Inserat öffnen</a>');
  return lines.join('\n');
}

function directTelegramLatency_(ss, candidate, deliveredAt) {
  try {
    let sheet = ss.getSheetByName(WA_TELEGRAM_DIRECT.latencySheet);
    if (!sheet) {
      sheet = ss.insertSheet(WA_TELEGRAM_DIRECT.latencySheet);
      sheet.appendRow(['Datensatz-ID','E-Mail Eingang UTC',
        'Telegram Versand UTC','E2E Minuten','Ergebnis']);
    }
    const incoming = Date.parse(candidate.received);
    const minutes = Number.isFinite(incoming) ?
      Math.round((deliveredAt.getTime()-incoming)/6000)/10 : '';
    sheet.appendRow([candidate.id,candidate.received,deliveredAt.toISOString(),
      minutes,candidate.confirmed?'geeignet':'manuell_pruefen']);
  } catch(error) {
    console.warn('E2E-Metrik nicht gespeichert: ' + error.message);
  }
}

/**
 * Called while the AI worker holds ScriptLock, after a persisted completed step.
 * Never throws into the paid AI processing path. Failed sends remain unsent and
 * will be picked up by the GitHub fallback.
 */
function notifyCompletedListingDirect_(ss, listingId) {
  if (!directTelegramReady_() || !listingId) return {status:'not_enabled'};
  try {
    const sheet = ss.getSheetByName('Anzeigen');
    if (!sheet || sheet.getLastRow()<2) return {status:'no_listing'};
    const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
    const idIndex = headers.indexOf('Datensatz-ID');
    if (idIndex<0) return {status:'no_id_column'};
    const ids = sheet.getRange(2,idIndex+1,sheet.getLastRow()-1,1).getValues();
    const found = ids.findIndex(r=>String(r[0]).trim()===String(listingId));
    if(found<0) return {status:'not_found'};
    const rowNo = found+2;
    let sentIndex = headers.indexOf(WA_TELEGRAM_DIRECT.sentColumn);
    if(sentIndex<0) {
      sentIndex = headers.length;
      sheet.getRange(1,sentIndex+1).setValue(WA_TELEGRAM_DIRECT.sentColumn);
      headers.push(WA_TELEGRAM_DIRECT.sentColumn);
    }
    const values = sheet.getRange(rowNo,1,1,headers.length).getValues()[0];
    const data = {};
    headers.forEach((h,i)=>{ data[String(h)] = values[i]; });
    const candidate = directTelegramCandidate_(data);
    if(!candidate) return {status:'not_eligible_or_already_sent'};
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty('TELEGRAM_BOT_TOKEN');
    const response = UrlFetchApp.fetch('https://api.telegram.org/bot' +
      encodeURIComponent(token) + '/sendMessage', {
      method:'post',contentType:'application/json',muteHttpExceptions:true,
      payload:JSON.stringify({chat_id:props.getProperty('TELEGRAM_CHAT_ID'),
        text:directTelegramMessage_(candidate),parse_mode:'HTML',
        disable_web_page_preview:true})
    });
    const reply = JSON.parse(response.getContentText());
    if(response.getResponseCode()!==200 || !reply.ok)
      throw new Error('Telegram HTTP ' + response.getResponseCode());
    const deliveredAt = new Date();
    sheet.getRange(rowNo,sentIndex+1).setValue(deliveredAt.toISOString());
    SpreadsheetApp.flush();
    directTelegramLatency_(ss,candidate,deliveredAt);
    console.log('Telegram Direktversand: ' + candidate.id);
    return {status:'sent',listingId:candidate.id};
  } catch(error) {
    console.error('Telegram Direktversand fehlgeschlagen für ' +
      String(listingId) + ': ' + error.message);
    return {status:'failed',error:String(error.message)};
  }
}

/** Safe manual activation after properties are configured. */
function activateDirectTelegram() {
  const p = PropertiesService.getScriptProperties();
  if(!p.getProperty('TELEGRAM_BOT_TOKEN') || !p.getProperty('TELEGRAM_CHAT_ID'))
    throw new Error('TELEGRAM_BOT_TOKEN und TELEGRAM_CHAT_ID in Apps Script Properties setzen.');
  p.setProperty(WA_TELEGRAM_DIRECT.activeProperty,'true');
  console.log('Direktversand aktiviert; GitHub bleibt Fallback.');
  return true;
}
