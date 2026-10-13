const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
function context() {
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
  for (const name of ['Drive', 'Pisos', 'GmailImport']) {
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
function runQueue(html, { blocked = [], oldFiles = [], failDownload = false } = {}) {
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
    getId: () => 'test-mail', getDate: () => new Date(),
    getBody: () => html, getPlainBody: () => '', getSubject: () => 'Pisos alert'
  };
  Object.assign(ctx, {
    CONFIG: { spreadsheetId: 'test', sheetName: 'Anzeigen' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), flush() {} },
    GmailApp: { getUserLabelByName: () => ({ getThreads: () => [{ getMessages: () => [mail] }] }) },
    prepareMailQueue() {}, readMailQueueIndex: () => ({ 'test-mail': { row: 2, status: 'retry' } }),
    readPreviouslyProcessedMailIds: () => new Set(), readMailImageBlacklist: () => new Set(blocked),
    getImageFolder: () => ({}), processExistingListingImages: () => ({}),
    checkListingImageAvailabilityInternal() {}, updateListingPreviewsInternal() {},
    sortListingsByMailReceived() {},
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

test('daily multi-listing email retains retry and separate file ownership', () => {
  const result = runQueue(fixture(daily));
  assert.equal(result.status[0], 'retry');
  assert.equal(result.status[2], '');
  assert.match(result.status[1], /Mehrfachangebote/);
  assert.equal(result.downloads, 10);
  assert.deepEqual(result.files.map(f => f.listing_id), ids.map(id => 'pisos:' + id));
});

test('blacklist prevents any download for blocked and mixed emails', () => {
  let result = runQueue(fixture(instant), { blocked: ['pisos:67520671658'] });
  assert.equal(result.status[0], 'blocked');
  assert.equal(result.downloads, 0);
  result = runQueue(fixture(daily), { blocked: ['pisos:68425628298'] });
  assert.equal(result.status[0], 'retry');
  assert.equal(result.downloads, 0);
});

test('shared photo across listings is ambiguous and keeps retry', () => {
  const ctx = context(), first = ctx.extractPisosMailImages(fixture(instant))[0];
  const html = '<a href="' + first.listing_url + '"><img src="' + first.source_url + '"></a>' +
    '<a href="https://www.pisos.com/alquilar/piso-other-123_456/"><img src="' + first.source_url + '"></a>';
  const result = runQueue(html);
  assert.equal(result.downloads, 1);
  assert.equal(result.status[0], 'retry');
  assert.match(result.status[1], /ohne eindeutige Inseratszuordnung/);
  assert.equal(result.files[0].listing_id, undefined);
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
