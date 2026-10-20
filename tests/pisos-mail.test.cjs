const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function context() {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
  for (const name of ['Drive', 'Pisos', 'ImmoScout', 'Milanuncios', 'Diagnostics', 'GmailImport']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'apps-script', name + '.js'), 'utf8'), ctx);
  }
  return ctx;
}
const fixture = id => fs.readFileSync(path.join(__dirname, 'fixtures', id + '.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const daily = '1a133c1c7fd31731';
const instant = '1a13437fd8c3f700';
const ids = [
  '68425628298', '68421300106', '67552113571', '68404596353', '68387380941',
  '68363843378', '67548948904', '68345325813', '68356775936', '54229223518'
];
const photoNames = [
  'ea72ae38-b7c7-4102-b74c-d1a35b633784.jpg',
  'b4e755ad-5ec1-4dc0-b067-7ca18e639072.jpg',
  'd5e91476-3871-4123-9a07-714c437fc224.jpg',
  'd283f9e1-7e40-4310-9acf-6b140abf0001.jpg',
  '21702640-804b-4866-9a79-7194c39fe91a.jpg',
  '518711_68363843378_dd1b368e-85d0-4c1f-9cea-d1fa70c55bde.jpg',
  'b77c843e-be2b-4ee2-9c16-a3bdf23745ed.jpg',
  '500563_68345325813_e4e08c38-8a70-4e5c-9b76-bd08fff81f8c.jpg',
  '500563_68356775936_16_20261009121052416.jpg',
  '529912_54229223518_7351ecf9-f0a1-4a1e-8547-aa72bbc62026.jpg'
];

test('real daily layout: ten unique listings, ten correctly paired photos, no promotion', () => {
  const ctx = context(), html = fixture(daily);
  const links = plain(ctx.extractPropertyLinks(html, ''));
  assert.deepEqual(links.map(ctx.getMailListingId), ids.map(id => 'pisos:' + id));
  assert.ok(links.every(url => !url.includes('?')));
  const images = plain(ctx.extractPisosMailImages(html));
  assert.equal(images.length, 10);
  images.forEach((image, i) => {
    assert.equal(image.listing_id, 'pisos:' + ids[i]);
    assert.equal(ctx.getMailListingId(image.listing_url), image.listing_id);
    assert.equal(new URL(image.source_url).searchParams.get('imageUrl').split('/').pop(), photoNames[i]);
    assert.ok(!image.source_url.includes('&amp;'));
  });
  assert.deepEqual(plain(ctx.extractPropertyImageUrls(html)), images.map(i => i.source_url));
  assert.deepEqual(plain(ctx.extractPisosImages({ html })), images.map(i => i.source_url));
});

test('real instant layout: one listing and its JPEG thumbnail; price arrow excluded', () => {
  const ctx = context(), html = fixture(instant);
  const links = plain(ctx.extractPropertyLinks(html, ''));
  assert.equal(links.length, 1);
  assert.equal(ctx.getMailListingId(links[0]), 'pisos:67520671658');
  const images = plain(ctx.extractPisosMailImages(html));
  assert.equal(images.length, 1);
  assert.equal(images[0].listing_id, 'pisos:67520671658');
  assert.equal(new URL(images[0].source_url).searchParams.get('imageUrl'),
    '/1098/6016405/1098_1_foto_20260930185219988_67520671658.jpeg');
});

test('tracking variants, fragment and contact parameters deduplicate by listing', () => {
  const ctx = context(), url = ctx.extractPropertyLinks(fixture(instant), '')[0];
  const html = '<a href="' + url + '?utm_term=foto&amp;x=1">foto</a>' +
    "<a href='" + url + "?param=private#contact'>contact</a>" +
    '<a href=' + url + '?utm_term=titulo>title</a>';
  assert.deepEqual(plain(ctx.extractPropertyLinks(html, url + '?utm_term=plain')), [url]);
  assert.equal(ctx.getMailListingId(url.replace('/alquilar/', '/comprar/')), 'pisos:67520671658');
});

test('general links, promoted developments, spoof hosts and invalid image paths excluded', () => {
  const ctx = context();
  for (const url of [
    'https://www.pisos.com/', 'https://www.pisos.com/inmobiliaria-norando_homes/',
    'https://www.pisos.com/alquiler-residencial/pisos-malaga/',
    'https://www.pisos.com/landingalerta/?id=123', 'https://www.pisos.com/movil/',
    'https://www.pisos.com/promocion-campanillas29006-4594207751_109700/',
    'https://evil.pisos.com/alquilar/piso-malaga-123_456/',
    'https://pisos.com.evil.test/alquilar/piso-malaga-123_456/'
  ]) {
    assert.equal(ctx.getMailListingId(url), '');
    assert.deepEqual(plain(ctx.extractPropertyLinks('<a href="' + url + '">x</a>', '')), []);
  }
  for (const url of [
    'https://fotos.imghs.net/prof/logos/Logo_123.jpg',
    'https://fotos.imghs.net/img/pisos-media/alerts/assets/price-drop-arrow.png',
    'https://notifications.pisos.com/pixel?id=123',
    'https://statics.pisos.com/webcurier/images/appstore.png',
    'https://thumbnails.pisos.com/api/ThumbnailAlert/GetTaggedImage/?logoUrl=Logo_123.jpg',
    'https://thumbnails.pisos.com/api/ThumbnailAlert/GetTaggedImage/?imageUrl=%ZZ',
    'https://thumbnails.pisos.com/api/ThumbnailAlert/GetTaggedImage/?imageUrl=https://evil.test/photo.jpg',
    'https://thumbnails.pisos.com/api/ThumbnailAlert/GetTaggedImage/?imageUrl=/1/2/../photo.jpg'
  ]) assert.equal(ctx.isPropertyImageUrl(url), false, url);
});

test('photo attributes and encoded paths accepted only inside the listing anchor', () => {
  const ctx = context(), link = 'https://www.pisos.com/alquilar/piso-malaga-123_456/';
  const image = 'https://thumbnails.pisos.com/api/ThumbnailAlert/GetTaggedImage/?width=460&imageUrl=%2F456%2F123.456%2Fphoto.jpg';
  const direct = 'https://fotos.imghs.net/456/123.456/photo.jpg';
  const html = '<img src="' + image + '">' +
    '<a href=https://www.pisos.com/><img src="' + image + '"></a>' +
    '<a href=' + link + "><img data-src='" + image + "'><img srcset='" + direct + " 460w'></a>";
  assert.deepEqual(plain(ctx.extractPropertyImageUrls(html)), [image, direct]);
  assert.deepEqual(plain(ctx.extractPisosMailImages(html)).map(i => i.listing_id), ['pisos:123', 'pisos:123']);
});

// Exercise the real queue pipeline, stubbing only Google I/O and unrelated jobs.
function runQueue(html, { blocked = [], oldFiles = [], failDownload = false, fetch = null, receivedAt = new Date() } = {}) {
  const ctx = context(), writes = new Map();
  let downloads = 0;
  const sheet = {
    getRange(row, col) {
      return {
        getValue: () => JSON.stringify(oldFiles),
        setValues: values => writes.set(col, plain(values[0]))
      };
    }
  };
  const mail = {
    getId: () => 'test-mail', getDate: () => receivedAt,
    getBody: () => html, getPlainBody: () => '', getSubject: () => 'Pisos alert'
  };
  Object.assign(ctx, {
    UrlFetchApp: { fetch: fetch || (() => { throw new Error('Unexpected network access'); }) },
    CONFIG: { spreadsheetId: 'test', sheetName: 'Anzeigen' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), flush() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: () => null, setProperty() {}
    }) },
    GmailApp: {
      search: () => [{ getMessages: () => [mail] }],
      getMessageById: () => mail,
      getUserLabelByName: () => ({ getThreads: () => [{ getMessages: () => [mail] }] })
    },
    prepareMailQueue() {}, readMailQueueIndex: () => ({ 'test-mail': { row: 2, status: 'retry' } }),
    readPreviouslyProcessedMailIds: () => new Set(), readMailImageBlacklist: () => new Set(blocked),
    getImageFolder: () => ({}), processExistingListingImages: () => ({}),
    checkListingImageAvailabilityInternal() {}, updateListingPreviewsInternal() {},
    sortListingsByMailReceived() {},
    ensureListingRatingSchema_() {return {ready:true};},
    cleanupMarkedListings_() {return {deleted:0};}, backfillDuplicateRegistry_() {return {added:0};},
    reconcileExistingDuplicates_() {return {removed:0};}, recalculateExistingListingScores_() {return {rescored:0};},
    saveListingImages(folder, id, urls) {
      downloads += urls.length;
      return {
        created: failDownload ? 0 : urls.length,
        errors: failDownload ? ['HTTP 503'] : [],
        files: failDownload ? [] : urls.map((source_url, i) => ({
          file_id: 'file-' + i, source_url, name: id + '_' + i
        }))
      };
    }
  });
  ctx.runGmailImagePipeline();
  const data = writes.get(10);
  return {
    status: writes.get(15), downloads,
    links: data ? JSON.parse(data[2]) : [],
    files: data ? JSON.parse(data[4]) : []
  };
}

test('single listing reaches ready_for_ai with the correct file ownership', () => {
  const result = runQueue(fixture(instant));
  assert.equal(result.status[0], 'ready_for_ai');
  assert.ok(result.status[2]);
  assert.equal(result.downloads, 1);
  assert.equal(result.files[0].listing_id, 'pisos:67520671658');
  assert.equal(result.links.length, 1);
});

test('daily multi-listing email becomes ready with ten separately assigned photos', () => {
  const result = runQueue(fixture(daily));
  assert.equal(result.status[0], 'ready_for_ai');
  assert.ok(result.status[2]);
  assert.equal(result.downloads, 10);
  assert.deepEqual(result.files.map(f => f.listing_id), ids.map(id => 'pisos:' + id));
});

test('blacklist blocks only the affected listing in mixed digest', () => {
  let result = runQueue(fixture(instant), { blocked: ['pisos:67520671658'] });
  assert.equal(result.status[0], 'blocked');
  assert.equal(result.downloads, 0);
  result = runQueue(fixture(daily), { blocked: ['pisos:68425628298'] });
  assert.equal(result.status[0], 'ready_for_ai');
  assert.equal(result.downloads, 9);
  assert.equal(result.files.length, 9);
  assert.ok(result.files.every(file => file.listing_id !== 'pisos:68425628298'));
});

test('shared photo across listings is ambiguous and keeps retry', () => {
  const ctx = context(), first = ctx.extractPisosMailImages(fixture(instant))[0];
  const html = '<a href="' + first.listing_url + '"><img src="' + first.source_url + '"></a>' +
    '<a href="https://www.pisos.com/alquilar/piso-other-123_456/"><img src="' + first.source_url + '"></a>';
  const result = runQueue(html);
  assert.equal(result.downloads, 0);
  assert.equal(result.status[0], 'retry');
  assert.match(result.status[1], /ohne eindeutige Inseratszuordnung/);
  assert.equal(result.files.length, 0);
});

test('retries reuse stored photos, restore ownership, and retain retry on failed downloads', () => {
  const ctx = context(), photo = ctx.extractPisosMailImages(fixture(instant))[0];
  const result = runQueue(fixture(instant), {
    oldFiles: [{ file_id: 'existing', source_url: photo.source_url, listing_id: 'pisos:wrong' }]
  });
  assert.equal(result.downloads, 0);
  assert.equal(result.status[0], 'ready_for_ai');
  assert.equal(result.files[0].file_id, 'existing');
  assert.equal(result.files[0].listing_id, 'pisos:67520671658');
  assert.equal(runQueue(fixture(instant), { failDownload: true }).status[0], 'retry');
  assert.equal(runQueue('<a href="' + photo.listing_url + '">no photo</a>').status[0], 'retry');
});

test('other portals retain image extraction and stable listing IDs', () => {
  const ctx = context();
  const images = [
    'https://static.fotocasa.es/images/ads/photo.jpg',
    'https://media.yaencontre.com/img/photo/photo.jpg',
    'https://img4.idealista.com/photo.jpg'
  ];
  assert.deepEqual(plain(ctx.extractPropertyImageUrls(images.map(url => '<img src="' + url + '">').join(''))), images);
  assert.equal(ctx.getMailListingId('https://www.idealista.com/inmueble/123/'), 'idealista:123');
  assert.equal(ctx.getMailListingId('https://www.fotocasa.es/es/alquiler/vivienda/malaga/foo/123/d'), 'fotocasa:123');
  assert.equal(ctx.getMailListingId('https://www.yaencontre.com/alquiler/piso/inmueble-456-123'), 'yaencontre:123');
});

const scoutInstant = '1a1344e0f79ea479';
const scoutWelcome = '1a12727237a1b36c';
const scoutIds = [
  '171420671', '171446909', '170965656', '170964461', '170953342',
  '171065000', '170784443', '171342349', '170437956', '170127129'
];
const scoutPhotoIds = [
  '171446909', '170965656', '170964461', '171065000',
  '170784443', '171342349', '170437956', '170127129'
];
const scoutPhotoNames = [
  '149b7352-ff82-4cb1-96d2-44393ea30ab1-2105419490.jpg',
  'a8508f93-4f8b-492d-9150-972edd06cdd4-2095150024.jpg',
  '976c6283-e2a7-47a2-8325-e39f40e0acb3-2095126092.jpg',
  '57bc31a8-cc12-42d0-bf5b-33bb6d99e0e4-2097252960.jpg',
  '3b30f2a9-5cd5-4cec-96de-b1ebb9bc2d0b-2091511708.jpg',
  '7716a705-f548-4009-8a7f-4433ed99735f-2103126986.jpg',
  'b27ae5aa-f0cc-4a28-a6b9-4443a91d6cc2-2084084195.jpg',
  '8e6a4030-6374-43b6-8267-cf30ba27d8f1-2077304076.jpg'
];

test('ImmoScout original instant layout: canonical expose and one correctly assigned photo', () => {
  const ctx = context(), html = fixture(scoutInstant);
  const links = plain(ctx.extractPropertyLinks(html, ''));
  assert.deepEqual(links, ['https://www.immobilienscout24.de/expose/171726535']);
  const photos = plain(ctx.extractImmoScoutMailImages(html));
  assert.equal(photos.length, 1);
  assert.equal(photos[0].listing_id, 'immoscout:171726535');
  assert.equal(photos[0].listing_url, links[0]);
  assert.equal(photos[0].source_url,
    'https://pictures.immobilienscout24.de/listings/bfea1817-e6e8-41c8-935e-64e5d7d3d809-2111296186.jpg/ORIG/legacy_thumbnail/640x481/format/jpg/quality/50');
  assert.deepEqual(plain(ctx.extractPropertyImageUrls(html)), photos.map(p => p.source_url));
  assert.deepEqual(plain(ctx.extractImmoScoutImages({ html })), photos.map(p => p.source_url));
});

test('ImmoScout welcome layout: ten listings, eight paired photos and two ignored placeholders', () => {
  const ctx = context(), html = fixture(scoutWelcome);
  assert.deepEqual(plain(ctx.extractPropertyLinks(html, '')).map(ctx.getMailListingId),
    scoutIds.map(id => 'immoscout:' + id));
  const photos = plain(ctx.extractImmoScoutMailImages(html));
  assert.deepEqual(photos.map(p => p.listing_id), scoutPhotoIds.map(id => 'immoscout:' + id));
  photos.forEach((photo, i) => {
    assert.equal(new URL(photo.source_url).pathname.split('/')[2], scoutPhotoNames[i]);
    assert.equal(ctx.getMailListingId(photo.listing_url), photo.listing_id);
  });
  assert.deepEqual(plain(ctx.extractPropertyImageUrls(html)), photos.map(p => p.source_url));
});

test('ImmoScout tracked, direct and plain-text links deduplicate without personal parameters', () => {
  const ctx = context(), direct = 'https://www.immobilienscout24.de/expose/171726535';
  const tracked = 'https://push.search.is24.de/email/expose/171726535?PID=private&amp;savedSearchId=private';
  const html = '<a href="' + tracked + '">image</a>' +
    "<a href='" + direct + "/?utm_source=email#title'>title</a>" +
    '<a href=' + direct + '>button</a>';
  assert.deepEqual(plain(ctx.extractPropertyLinks(html, tracked.replace('&amp;', '&'))), [direct]);
  assert.equal(ctx.getMailListingId(tracked), 'immoscout:171726535');
  assert.equal(ctx.getMailListingId(direct), 'immoscout:171726535');
});

test('ImmoScout search links, logos, placeholders, tracking pixels and spoof hosts are excluded', () => {
  const ctx = context();
  for (const url of [
    'https://www.immobilienscout24.de/',
    'https://www.immobilienscout24.de/savedsearch/anonymous/delete?tokenV2=private',
    'https://push.search.is24.de/email/Suche/controller/executeSavedSearch/radius',
    'https://www.immobilienscout24.de/savedsearch/myscout/manage/',
    'https://www.immobilienscout24.de/impressum.html',
    'https://push.search.is24.de/email/expose/123abc',
    'https://evil.immobilienscout24.de/expose/123',
    'https://www.immobilienscout24.de.evil.test/expose/123'
  ]) {
    assert.equal(ctx.getMailListingId(url), '');
    assert.deepEqual(plain(ctx.extractPropertyLinks('<a href="' + url + '">x</a>', '')), []);
  }
  const photos = plain(ctx.extractImmoScoutMailImages(fixture(scoutInstant)));
  const urls = [
    'https://pictures.immobilienscout24.de/usercontent/agency.JPG/ORIG/resize/100x40%3E/quality/80',
    'https://www.static-immobilienscout24.de/statpic/mail/placeholder_no_image_v2.png',
    'https://push.search.is24.de/email/relevant_123.gif?savedSearchId=private',
    'https://pictures.immobilienscout24.de.evil.test/listings/photo.jpg',
    'https://pictures.immobilienscout24.de/listings/../usercontent/agency.jpg',
    'http://pictures.immobilienscout24.de/listings/photo.jpg'
  ];
  for (const url of urls) assert.equal(ctx.isPropertyImageUrl(url), false, url);
  assert.deepEqual(plain(ctx.extractImmoScoutImages({
    bild_urls: [photos[0].source_url, ...urls],
    image_urls: [photos[0].source_url]
  })), [photos[0].source_url]);
  assert.deepEqual(plain(ctx.extractPropertyImageUrls('<img src="' + photos[0].source_url + '">')), []);
});

test('ImmoScout single listing is ready, reuses stored files and preserves retry on failure', () => {
  let result = runQueue(fixture(scoutInstant));
  assert.equal(result.status[0], 'ready_for_ai');
  assert.equal(result.downloads, 1);
  assert.equal(result.files[0].listing_id, 'immoscout:171726535');
  assert.equal(result.files[0].listing_url, 'https://www.immobilienscout24.de/expose/171726535');
  result = runQueue(fixture(scoutInstant), { oldFiles: result.files });
  assert.equal(result.downloads, 0);
  assert.equal(result.status[0], 'ready_for_ai');
  assert.equal(runQueue(fixture(scoutInstant), { failDownload: true }).status[0], 'retry');
});

test('ImmoScout multi-listing passes; missing and shared photos remain safe', () => {
  let result = runQueue(fixture(scoutWelcome));
  assert.equal(result.status[0], 'ready_for_ai');
  assert.ok(result.status[2]);
  assert.equal(result.downloads, 8);
  assert.deepEqual(result.files.map(f => f.listing_id), scoutPhotoIds.map(id => 'immoscout:' + id));
  const ctx = context(), photo = ctx.extractImmoScoutMailImages(fixture(scoutInstant))[0];
  const shared = '<a href="' + photo.listing_url + '"><img src="' + photo.source_url + '"></a>' +
    '<a href="https://www.immobilienscout24.de/expose/123"><img src="' + photo.source_url + '"></a>';
  result = runQueue(shared);
  assert.equal(result.status[0], 'retry');
  assert.equal(result.downloads, 0);
  assert.equal(result.files.length, 0);
  assert.match(result.status[1], /ohne eindeutige Inseratszuordnung/);
  const missing = '<a href="' + photo.listing_url + '"><img src="https://www.static-immobilienscout24.de/statpic/mail/placeholder_no_image_v2.png"></a>';
  result = runQueue(missing);
  assert.equal(result.status[0], 'retry');
  assert.equal(result.downloads, 0);
});

test('ImmoScout blacklist stops downloads for single, mixed and placeholder-only blocked listings', () => {
  let result = runQueue(fixture(scoutInstant), { blocked: ['immoscout:171726535'] });
  assert.equal(result.status[0], 'blocked');
  assert.equal(result.downloads, 0);
  result = runQueue(fixture(scoutWelcome), { blocked: ['immoscout:171420671'] });
  assert.equal(result.status[0], 'ready_for_ai');
  assert.equal(result.downloads, 8);
  assert.ok(result.files.every(f => f.listing_id !== 'immoscout:171420671'));
});

test('Gmail scans only messages received within 48 hours', () => {
  const old = runQueue(fixture(instant), {
    receivedAt: new Date(Date.now() - 49 * 3600000)
  });
  assert.equal(old.downloads, 0);
  assert.equal(old.status, undefined);
});

test('Main registers ImmoScout for existing-listing imports and portal-name aliases', () => {
  const ctx = vm.createContext({ console });
  const sources = fs.readdirSync(path.join(root, 'apps-script')).filter(p => p.endsWith('.js'))
    .map(p => fs.readFileSync(path.join(root, 'apps-script', p), 'utf8')).join('\n');
  vm.runInContext(sources, ctx);
  for (const name of ['ImmoScout', 'ImmoScout24', 'ImmobilienScout24.de', 'Immobilien Scout24']) {
    assert.equal(ctx.normalizeProvider(name), 'immoscout');
  }
  assert.equal(vm.runInContext('CONFIG.providers.immoscout === extractImmoScoutImages', ctx), true);
});

const milanId = '1a13b58f7993b3f6';
const milanTarget = 'https://www.milanuncios.com/ads/malaga-capital-619803957.htm';
const milanPhoto = 'https://images-re.milanuncios.com/images/ads/cc274bf1-9612-46a5-aa76-48d34bca9598?rule=hw1200';
function redirectTo(target, status = 302) {
  return { getResponseCode: () => status, getAllHeaders: () => ({ Location: target }) };
}

test('Milanuncios original layout resolves only the photo anchor and pairs its ID', () => {
  const ctx = context(), calls = [];
  ctx.UrlFetchApp = { fetch: (url, options) => {
    calls.push(url);
    assert.equal(options.followRedirects, false);
    return redirectTo(milanTarget + '?utm_source=alert');
  } };
  const result = ctx.resolveMilanunciosMailLinks(fixture(milanId));
  assert.equal(result.errors.length, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /fixture_/);
  assert.deepEqual(plain(ctx.extractPropertyLinks(result.html, '')), [milanTarget]);
  assert.deepEqual(plain(ctx.extractMilanunciosMailImages(result.html)), [{
    listing_id: 'milanuncios:619803957', listing_url: milanTarget, source_url: milanPhoto
  }]);
  assert.deepEqual(plain(ctx.extractPropertyImageUrls(result.html)), [milanPhoto]);
});

test('Milanuncios queue ready after resolution; blacklist stops image download', () => {
  const fetch = () => redirectTo(milanTarget);
  let result = runQueue(fixture(milanId), { fetch });
  assert.equal(result.status[0], 'ready_for_ai');
  assert.equal(result.downloads, 1);
  assert.equal(result.files[0].listing_id, 'milanuncios:619803957');
  result = runQueue(fixture(milanId), { fetch, blocked: ['milanuncios:619803957'] });
  assert.equal(result.status[0], 'blocked');
  assert.equal(result.downloads, 0);
});

test('Milanuncios failed, looping and foreign redirects remain retry without fetching targets', () => {
  for (const [target, status] of [
    ['https://evil.test/ads/example-123.htm', 302],
    ['https://www.milanuncios.com/mis-alertas/eliminar', 302],
    ['https://www.milanuncios.com/', 403]
  ]) {
    let calls = 0;
    const fetch = () => { calls++; return redirectTo(target, status); };
    const result = runQueue(fixture(milanId), { fetch });
    assert.equal(result.status[0], 'retry');
    assert.equal(result.downloads, 0);
    assert.equal(calls, 1);
  }
  const ctx = context(); let loops = 0;
  ctx.UrlFetchApp = { fetch: () => { loops++; return redirectTo('http://sgt.milanuncios.com/ls/click?upn=loop'); } };
  const result = ctx.resolveMilanunciosMailLinks(fixture(milanId));
  assert.equal(loops, 3);
  assert.equal(result.errors.length, 1);
});

test('Milanuncios enforces card request limit and reports unresolved cards', () => {
  const ctx = context(); let calls = 0;
  ctx.UrlFetchApp = { fetch: () => { calls++; return redirectTo(milanTarget); } };
  const html = Array.from({ length: 10 }, (_, i) =>
    '<a href="http://sgt.milanuncios.com/ls/click?upn=' + i + '"><img src="' + milanPhoto + '"></a>').join('');
  const result = ctx.resolveMilanunciosMailLinks(html);
  assert.equal(calls, 8);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /Kartenlimit/);
});

test('Milanuncios unlinked photos, tracking pixels, logos and spoof hosts excluded', () => {
  const ctx = context();
  for (const url of [
    'https://www.milanuncios.com/', 'https://www.milanuncios.com/mis-alertas/',
    'https://evil.milanuncios.com/ads/malaga-123.htm',
    'https://www.milanuncios.com.evil.test/ads/malaga-123.htm'
  ]) assert.equal(ctx.getMailListingId(url), '');
  assert.equal(ctx.getMailListingId(milanTarget + '?utm_source=email'), 'milanuncios:619803957');
  assert.equal(ctx.getMailListingId('https://www.milanuncios.com/alquiler-de-pisos/malaga-123.htm'), 'milanuncios:123');
  assert.deepEqual(plain(ctx.extractPropertyImageUrls('<img src="' + milanPhoto + '">')), []);
  for (const url of [
    'http://sgt.milanuncios.com/wf/open?upn=token',
    'https://cdn.braze.eu/appboy/logo.png',
    'https://images-re.milanuncios.com.evil.test/images/ads/photo',
    'https://images-re.milanuncios.com/images/logo'
  ]) assert.equal(ctx.isPropertyImageUrl(url), false);
  assert.deepEqual(plain(ctx.extractMilanunciosImages({ bild_urls: [milanPhoto, milanPhoto] })), [milanPhoto]);
});

test('shared-lock recovery retries an orphaned mail immediately but backs off real errors', () => {
  const ctx = context();
  const justNow = new Date().toISOString();
  assert.equal(ctx.mailQueueNeedsRetry({status:'processing',updatedAt:justNow}),true);
  assert.equal(ctx.mailQueueNeedsRetry({status:'retry',updatedAt:justNow}),false);
  assert.equal(ctx.mailQueueNeedsRetry({status:'retry',
    updatedAt:new Date(Date.now()-31*60000).toISOString()}),true);
});

test('incremental Gmail discovery checkpoints and skips redundant scans for 15 minutes',()=>{
  const ctx=context(), values=new Map(), calls=[];
  const msg={getId:()=> 'new-1',getDate:()=>new Date(Date.now()-1000),getSubject:()=> 'alert'};
  ctx.PropertiesService={getScriptProperties:()=>({
    getProperty:k=>values.get(k)||null, setProperty:(k,v)=>values.set(k,v)
  })};
  ctx.GmailApp={search:(query)=>{calls.push(query);return [{getMessages:()=>[msg]}];},getMessageById:()=>null};
  ctx.logImageDiagnostic=()=>{};
  const first=ctx.collectMailCandidates_({},new Set());
  assert.equal(first.length,1);
  assert.equal(calls.length,1);
  assert.ok(first.scanCheckpoint);
  assert.ok(calls[0].includes('label:'));
  values.set('WOHNUNGSAGENT_GMAIL_DISCOVERY_UTC',first.scanCheckpoint);
  values.set('WOHNUNGSAGENT_GMAIL_RECONCILE_UTC',first.scanCheckpoint);
  const second=ctx.collectMailCandidates_({},new Set());
  assert.equal(second.length,0);
  assert.equal(calls.length,1);
});

test('known retry is loaded by Gmail message ID without rescanning conversations',()=>{
  const ctx=context(), values=new Map(), calls=[];
  const msg={getId:()=> 'retry-1',getDate:()=>new Date()};
  const now=new Date().toISOString();
  values.set('WOHNUNGSAGENT_GMAIL_DISCOVERY_UTC',now);
  values.set('WOHNUNGSAGENT_GMAIL_RECONCILE_UTC',now);
  ctx.PropertiesService={getScriptProperties:()=>({
    getProperty:k=>values.get(k)||null,setProperty:(k,v)=>values.set(k,v)
  })};
  ctx.GmailApp={search:()=>{throw new Error('Unnecessary full search');},
    getMessageById:id=>{calls.push(id);return msg;}};
  ctx.logImageDiagnostic=()=>{};
  const got=ctx.collectMailCandidates_({'retry-1':{
    status:'retry',receivedAt:now,
    updatedAt:new Date(Date.now()-31*60000).toISOString()
  }},new Set());
  assert.deepEqual(Array.from(got.map(x=>x.getId())),['retry-1']);
  assert.deepEqual(calls,['retry-1']);
});

test('incomplete Gmail discovery does not publish a new cursor',()=>{
  const ctx=context(), propWrites=[], msg=i=>({
    getId:()=> 'mail-'+i,getDate:()=>new Date(Date.now()-1000)
  });
  ctx.PropertiesService={getScriptProperties:()=>({
    getProperty:()=>null,setProperty:(k,v)=>propWrites.push([k,v])
  })};
  ctx.GmailApp={search:()=>Array.from({length:16},(_,i)=>({
    getMessages:()=>[msg(i)]
  })),getMessageById:()=>null};
  ctx.logImageDiagnostic=()=>{};
  const candidates=ctx.collectMailCandidates_({},new Set());
  assert.equal(candidates.length,15);
  assert.equal(candidates.scanCheckpoint,undefined);
  assert.deepEqual(propWrites,[]);
});
