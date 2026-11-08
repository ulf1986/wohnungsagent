/** Kleine KI-Eingaben; Drive-Originale und gespeicherte Quelldaten bleiben unverändert. */
function cleanAiText_(value, limit) {
  let text = String(value || '')
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(?:p|div|br|li|tr|h[1-6]|section|article|main)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&euro;|&#8364;/gi, '€')
    .replace(/&sup2;|&#178;|&#x0*b2;/gi, '²').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
  const lines = text.split(/\r?\n/).map(s => s.replace(/[ \t]+/g, ' ').trim());
  const seen = new Set();
  text = lines.filter(s => {
    if (!s || /^(?:unsubscribe|darse de baja|abmelden|cookie settings|aceptar cookies|manage cookies|download (?:our|the) app)\b/i.test(s)) return false;
    if (seen.has(s)) return false;
    seen.add(s); return true;
  }).join('\n');
  return text.slice(0, limit);
}

function compactListingPageText_(html) {
  const s = String(html || ''), pieces = [];
  const title = (s.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  if (title) pieces.push(title);
  for (const tag of s.match(/<meta\b[^>]*>/gi) || []) {
    if (!/(?:name|property)\s*=\s*["'](?:description|og:description|og:title)["']/i.test(tag)) continue;
    const content = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (content) pieces.push(content);
  }
  // Some portals expose listing essentials in itemprop and product meta tags
  // even when the visible page is rendered client-side. Preserve the label
  // so the strict source quote validator can still locate the evidence.
  for (const tag of s.match(/<meta\b[^>]*>/gi) || []) {
    const field=(tag.match(/(?:itemprop|name|property)\s*=\s*["'](price|priceCurrency|floorSize|numberOfRooms|numberOfBedrooms|product:price:amount)["']/i)||[])[1];
    const value=(tag.match(/\bcontent\s*=\s*["']([^"']{1,80})["']/i)||[])[1];
    if (!field || !value) continue;
    pieces.push(field+': '+value);
  }
  // Nur Inseratsfakten aus strukturierten Daten, niemals die gesamten Skriptobjekte.
  const allowed = ['name','description','address','floorSize','numberOfRooms','numberOfBedrooms',
    'numberOfBathroomsTotal','offers','price','priceCurrency','value','unitText','streetAddress',
    'addressLocality','addressRegion','postalCode','availability','amenityFeature','itemOffered'];
  const project = (item, depth=0) => {
    if (depth > 4 || item === null) return null;
    if (Array.isArray(item)) return item.slice(0,20).map(v => project(v,depth+1));
    if (typeof item !== 'object') return typeof item === 'string' ? cleanAiText_(item,2000) : item;
    const out = {};
    for (const key of allowed) if (item[key] !== undefined) out[key] = project(item[key],depth+1);
    return out;
  };
  for (const match of s.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]);
      const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      for (const node of nodes.slice(0,30)) {
        if (!/RealEstateListing|Apartment|House|Residence|Accommodation|Product/i.test(String(node['@type'] || ''))) continue;
        pieces.push(JSON.stringify(project(node)));
      }
    } catch (_) { /* Nicht lesbare strukturierte Daten durch sichtbaren Text ergänzen. */ }
  }
  const main = s.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1\s*>/i);
  pieces.push(main ? main[2] : s);
  return cleanAiText_(pieces.join('\n'), AI_PIPELINE.maxPageTextChars);
}

function aiImageHash_(fileId) {
  const blob = DriveApp.getFileById(fileId).getBlob();
  const mime = String(blob.getContentType()).split(';')[0].toLowerCase();
  const bytes = blob.getBytes();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime) || bytes.length < 2000)
    throw new Error('Keine nutzbare Original-Bilddatei: ' + fileId);
  return aiBytesHash_(bytes);
}

function aiBytesHash_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}

/** Auswahl einmal je Anzeigenzeile festschreiben; neue Mails erweitern sie nicht. */
function selectAiListingImages_(data) {
  const p = data.ai_pipeline;
  if (Array.isArray(p.image_selection)) {
    if (p.image_selection.length > AI_PIPELINE.maxImagesPerListing)
      throw new Error('Gespeicherte KI-Bildauswahl überschreitet zehn Bilder.');
    return p.image_selection;
  }
  const all = data.drive_files || [], selected = [], hashes = new Set(), ids = new Set();
  // Historische Bewertungen zählen zum Gesamtbudget; sie werden nicht gelöscht.
  const previous = [...new Set([...(data.analyzed_file_ids || []),
    ...(data.image_reviews || []).map(r => r.file_id)].filter(Boolean))];
  p.image_selection_legacy_count = previous.length;
  for (const id of previous.slice(0, AI_PIPELINE.maxImagesPerListing)) {
    const file = all.find(f => f.file_id === id) || {file_id:id};
    selected.push({...file}); ids.add(id);
  }
  for (const file of all) {
    if (selected.length >= AI_PIPELINE.maxImagesPerListing) break;
    if (!file || !file.file_id || ids.has(file.file_id)) continue;
    if (/(?:badge[_-]|app[_-]?store|google[-_]?play|tracking|pixel|logo)/i.test(String(file.name || '') + ' ' + String(file.source_url || ''))) continue;
    // Alte bewertete Originale nur hashen, wenn eine neue Datei hinzukommen soll.
    for (const old of selected) if (!old.content_hash && previous.includes(old.file_id)) {
      old.content_hash = aiImageHash_(old.file_id); hashes.add(old.content_hash);
    }
    const hash = aiImageHash_(file.file_id);
    if (hashes.has(hash)) continue;
    selected.push({...file,content_hash:hash}); hashes.add(hash); ids.add(file.file_id);
  }
  p.image_selection = selected;
  p.image_selection_limit = AI_PIPELINE.maxImagesPerListing;
  p.image_selection_available = all.length;
  p.image_selection_limited = all.length > selected.length && selected.length === AI_PIPELINE.maxImagesPerListing;
  return selected;
}
