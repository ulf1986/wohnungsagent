const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../apps-script/IdealistaDownloaderTest.js'), 'utf8');

test('Idealista mail extractor rejects app badges, logos and spoof hosts', () => {
  const ctx = vm.createContext({ uniqueImageUrls: urls => [...new Set(urls)], extractHtmlImageUrls: () => [] });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../apps-script/Idealista.js'), 'utf8'), ctx);
  const photo = 'https://img4.idealista.com/blur/500_375_mq/0/id.pro.es.image.master/90/6e/3d/1479149352.jpg';
  const urls = [photo, photo, 'https://st3.idealista.com/static/common/emails/img/badge_ios.png',
    'https://st3.idealista.com/static/common/emails/img/badge_android.png',
    'https://st3.idealista.com/static/common/emails/img/badge_huawei.png',
    photo.replace('img4.idealista.com', 'img4.idealista.com.evil.test')];
  assert.deepEqual(Array.from(ctx.extractIdealistaImages({ bild_urls: urls })), [photo]);
});

function context({ blocked = false, stale = false, galleryComplete = true, invalidImage = false } = {}) {
  const calls = [], events = [];
  const jpeg = [255, 216, 255, ...new Array(2000).fill(0)];
  const ctx = vm.createContext({
    console, CONFIG: { spreadsheetId: 'target' }, MAIL_IMPORT: { sheetName: 'Verarbeitung' },
    imageDiagnosticRun: null,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => calls.push('unlock') }) },
    beginImageDiagnostics() { ctx.imageDiagnosticRun = {}; calls.push('begin'); },
    finishImageDiagnostics() { calls.push('finish'); },
    logImageDiagnostic(stage, detail) { events.push({ stage, ...detail }); },
    GmailApp: { getMessageById: () => ({ getId: () => 'mail', getDate: () => new Date(Date.now() - (stale ? 96 : 1) * 3600000),
      getBody: () => '<html>', getPlainBody: () => '' }) },
    SpreadsheetApp: { openById: id => { assert.equal(id, 'target'); return { getSheetByName: () => null }; } },
    extractPropertyLinks: () => ['https://www.idealista.com/inmueble/123/'],
    getMailListingId: () => 'idealista:123', readMailImageBlacklist: () => new Set(blocked ? ['idealista:123'] : []),
    extractIdealistaImages: () => ['https://img.idealista.com/one.jpg'], getImageFolder: () => 'folder',
    saveListingImages(folder, id, urls) { calls.push('preview'); assert.equal(id, 'idealista:123');
      return { files: [{ file_id: 'preview', source_url: urls[0] }], errors: [] }; },
    downloadIdealistaGallery(id, previous) { calls.push('gallery'); assert.equal(id, '123'); assert.equal(previous[0].file_id, 'preview');
      return { complete: galleryComplete, status: galleryComplete ? 'completed' : 'blocked', httpStatus: galleryComplete ? 200 : 403,
        found: 1, created: 1, files: [...previous, { file_id: 'gallery', source_url: 'https://img.idealista.com/two.jpg' }] }; },
    DriveApp: { getFileById: () => ({ getBlob: () => ({ getBytes: () => invalidImage ? new Array(2200).fill(65) : jpeg,
      getContentType: () => 'image/jpeg' }) }) }
  });
  vm.runInContext(source, ctx);
  return { ctx, calls, events };
}

test('isolated test uses existing preview/gallery paths, reads stored bytes and releases lock', () => {
  const { ctx, calls, events } = context();
  const result = ctx.testIdealistaDownloader();
  assert.equal(result.passed, true); assert.equal(result.verified, 2);
  assert.deepEqual(calls, ['begin', 'preview', 'gallery', 'finish', 'unlock']);
  assert.equal(events.filter(e => e.stage === 'idealista_test_file' && e.file_id).length, 2);
});
test('blacklisted or stale example never downloads and always releases lock', () => {
  for (const options of [{ blocked: true }, { stale: true }]) {
    const { ctx, calls } = context(options);
    assert.throws(() => ctx.testIdealistaDownloader());
    assert.deepEqual(calls, ['begin', 'finish', 'unlock']);
  }
});
test('blocked gallery or fake image content cannot pass', () => {
  for (const options of [{ galleryComplete: false }, { invalidImage: true }]) {
    assert.equal(context(options).ctx.testIdealistaDownloader().passed, false);
  }
});
test('image signature check accepts JPEG PNG WebP and rejects tiny or mislabeled content', () => {
  const { ctx } = context();
  for (const [mime, signature] of [['image/jpeg', [255,216,255]], ['image/png', [137,80,78,71,13,10,26,10]],
    ['image/webp', [82,73,70,70,0,0,0,0,87,69,66,80]]]) {
    assert.equal(ctx.isIdealistaTestImage_([...signature, ...new Array(2000).fill(0)], mime), true);
    assert.equal(ctx.isIdealistaTestImage_(signature, mime), false);
  }
  assert.equal(ctx.isIdealistaTestImage_(new Array(2200).fill(65), 'image/jpeg'), false);
});
