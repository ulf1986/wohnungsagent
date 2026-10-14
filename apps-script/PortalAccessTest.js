/**
 * PortalAccessTest.gs
 * Manueller Abruf-Test aus der Google-Apps-Script-Umgebung.
 *
 * Im Apps-Script-Editor einmal runPortalAccessTest() ausführen.
 * Ergebnisse stehen im neuen Tab „Portaltests“.
 */
const PORTAL_ACCESS_TEST = {
  sheetName: 'Portaltests',
  fallbackUrls: {
    fotocasa: 'https://www.fotocasa.es/es/alquiler/vivienda/malaga-capital/aire-acondicionado-terraza-ascensor-amueblado/190915459/d',
    idealista: 'https://www.idealista.com/inmueble/105447542/',
    yaencontre: 'https://www.yaencontre.com/alquiler/piso/inmueble-40316-112816100',
    immoscout: 'https://www.immobilienscout24.de/expose/171775817',
    pisos: 'https://www.pisos.com/alquilar/piso-centro_historico_la_merced29008-68347946552_100500/',
    milanuncios: 'https://www.milanuncios.com/alquiler-de-pisos-en-malaga-malaga/malaga-capital-613703744.htm'
  },
  providers: ['fotocasa', 'idealista', 'yaencontre', 'pisos', 'immoscout', 'milanuncios'],
  maxTextChars: 50000
};

/**
 * Prüft je Portal eine echte Queue-URL, ersatzweise die hinterlegte Test-URL.
 * Der Abruf entspricht dem Seitenabruf der Automation: UrlFetchApp, GET,
 * Weiterleitungen erlaubt, keine Browser-Cookies.
 */
function runPortalAccessTest() {
  const ss = SpreadsheetApp.openById(getWohnungsagentSpreadsheetId_());
  const urls = getPortalAccessTestUrls_(ss);
  const rows = [];

  for (const provider of PORTAL_ACCESS_TEST.providers) {
    const url = urls[provider] || PORTAL_ACCESS_TEST.fallbackUrls[provider];
    const started = new Date();
    let status = 0;
    let rawLength = 0;
    let textLength = 0;
    let result = 'error';
    let note = '';

    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'get',
        muteHttpExceptions: true,
        followRedirects: true,
        validateHttpsCertificates: true,
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': 'Wohnungsagent/1.0 (Google Apps Script portal access test)'
        }
      });
      status = response.getResponseCode();
      const html = response.getContentText() || '';
      rawLength = html.length;
      textLength = extractListingPageText_(html)
        .slice(0, PORTAL_ACCESS_TEST.maxTextChars).length;
      const lower = html.toLowerCase();
      const captcha = /(captcha|pardon our interruption|verify you are human|unusual traffic|automated queries)/i.test(html);
      const blockedStatus = [403, 429, 503].includes(status);

      if (captcha || blockedStatus) {
        result = 'blocked';
        note = captcha ? 'Bot-/CAPTCHA-Hinweis im Antworttext' : 'HTTP ' + status;
      } else if (status >= 200 && status < 300 && textLength >= 200) {
        result = 'ok';
      } else {
        result = 'not_usable';
        note = 'HTTP ' + status + '; auswertbarer Text: ' + textLength;
      }
    } catch (error) {
      result = 'error';
      note = String(error && error.message || error);
    }

    rows.push([
      started.toISOString(), provider, url, status, result,
      textLength, rawLength, note
    ]);
    console.log(provider + ': ' + result + ' (HTTP ' + status + ', Text ' + textLength + ')');
  }

  writePortalAccessTestRows_(ss, rows);
  return rows.map(row => ({
    provider: row[1], httpStatus: row[3], result: row[4],
    pageTextCharacters: row[5], note: row[7]
  }));
}

function getPortalAccessTestUrls_(ss) {
  const found = {};
  const queue = ss.getSheetByName(MAIL_IMPORT.sheetName);
  if (!queue || queue.getLastRow() < 2) return found;
  const headers = queue.getRange(1, 1, 1, queue.getLastColumn()).getValues()[0];
  const linksCol = headers.indexOf('Queue Inseratslinks JSON');
  if (linksCol < 0) return found;

  const values = queue.getRange(2, linksCol + 1, queue.getLastRow() - 1, 1).getValues();
  for (const [value] of values) {
    for (const url of parsePortalAccessJsonArray_(value)) {
      const id = getMailListingId(url);
      const provider = String(id || '').split(':')[0];
      if (PORTAL_ACCESS_TEST.providers.includes(provider) && !found[provider]) {
        found[provider] = url;
      }
    }
  }
  return found;
}

function parsePortalAccessJsonArray_(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (error) {
    return [];
  }
}

function writePortalAccessTestRows_(ss, rows) {
  let sheet = ss.getSheetByName(PORTAL_ACCESS_TEST.sheetName);
  if (!sheet) sheet = ss.insertSheet(PORTAL_ACCESS_TEST.sheetName);

  const headers = [
    'Zeit UTC', 'Portal', 'Test-URL', 'HTTP-Status', 'Ergebnis',
    'Seitentext Zeichen', 'Antwort Zeichen', 'Hinweis'
  ];
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  else {
    const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (current.join('|') !== headers.join('|')) throw new Error('Tab Portaltests hat unerwartete Spalten.');
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length)
    .setValues(rows);
  sheet.autoResizeColumns(1, headers.length);
}
