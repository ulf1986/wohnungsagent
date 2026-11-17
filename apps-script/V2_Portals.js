/**
 * Listing identity and text extraction. Derived from legacy GmailImport,
 * Pisos, Milanuncios and extractListingMailExcerpt_ (without image dependencies).
 */
function wa2Unescape(s) {
  return String(s || '').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'").replace(/&nbsp;/gi,' ')
    .replace(/&#(\d+);/g, (_,n)=>String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCharCode(parseInt(n,16)));
}
function wa2CleanUrl(input) {
  const raw=wa2Unescape(input).trim().replace(/[)>.,;]+$/,'');
  if (!/^https?:\/\//i.test(raw) || /[\s<>"']/.test(raw)) return '';
  const withoutFragment=raw.split('#')[0];
  return withoutFragment.replace(/^http:\/\//i,'https://');
}
function wa2GetPortalListing(input) {
  const url=wa2CleanUrl(input);
  const m=url.match(/^https:\/\/([^\/?#]+)(\/[^?#]*)(?:\?[^#]*)?$/i);
  if (!m) return null;
  const host=m[1].toLowerCase(), path=m[2];
  const domain = d => host===d || host.endsWith('.'+d);
  let match, provider, canonical;
  if (domain('idealista.com') && (match=path.match(/^\/inmueble\/(\d+)\/?/i))) {
    provider='idealista'; canonical='https://www.idealista.com/inmueble/'+match[1]+'/';
  } else if (domain('pisos.com') && (match=path.match(/^\/(alquilar|comprar)\/([^/?#]+)-(\d+)_(\d+)\/?/i))) {
    provider='pisos';
    canonical='https://www.pisos.com/'+match[1].toLowerCase()+'/'+match[2]+'-'+match[3]+'_'+match[4]+'/';
    match[1]=match[3];
  } else if (domain('milanuncios.com') && (match=path.match(/^\/(ads|alquiler-de-pisos|alquiler-de-apartamentos|alquiler-de-casas|alquiler-de-aticos|alquiler-de-duplex)\/([a-z0-9_-]+)-(\d+)\.htm/i))) {
    provider='milanuncios'; canonical='https://www.milanuncios.com/'+match[1].toLowerCase()+'/'+match[2]+'-'+match[3]+'.htm';
    match[1]=match[3];
  } else if (domain('fotocasa.es') && (match=path.match(/\/(\d{6,})(?:\/d)?\/?$/i))) {
    provider='fotocasa'; canonical='https://www.fotocasa.es'+path;
  } else if (domain('yaencontre.com') && (match=path.match(/-(\d{6,})(?:\/)?$/i))) {
    provider='yaencontre'; canonical='https://www.yaencontre.com'+path;
  } else return null;
  return {id:provider+':'+match[1],provider,url:canonical};
}
function wa2ExtractLinks(html,plain) {
  const candidates=[];
  for (const m of String(html||'').matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))
    candidates.push(m[1]||m[2]||m[3]);
  for (const m of String(plain||'').match(/https?:\/\/[^\s<>"']+/gi)||[]) candidates.push(m);
  const out=new Map();
  for (const raw of candidates) {
    const item=wa2GetPortalListing(raw);
    if (item && !out.has(item.id)) out.set(item.id,item);
  }
  return [...out.values()].slice(0,WA2_CONFIG.maxListingsPerMail);
}
function wa2HtmlText(html) {
  let s=String(html||'').replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');
  s=s.replace(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_,a,b,c,body)=>' '+body.replace(/<[^>]*>/g,' ')+' '+(a||b||c)+' ');
  s=s.replace(/<\/(?:p|div|tr|td|li|h[1-6]|section|article)>|<br\b[^>]*>/gi,'\n');
  return wa2Unescape(s.replace(/<[^>]*>/g,' ')).replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
/** Legacy-style per-card boundaries, intentionally no image extraction. */
function wa2ExtractMailExcerpt(text,id,total) {
  const s=String(text||''), occurrences=[];
  const re=/https?:\/\/[^\s<>"']+/gi;let m;
  while((m=re.exec(s))!==null){
    const item=wa2GetPortalListing(m[0]);
    if(item)occurrences.push({id:item.id,start:m.index,end:m.index+m[0].length});
  }
  const mine=occurrences.find(x=>x.id===id);
  if(!mine) return total===1?s.slice(0,4500):'';
  let start=Math.max(0,mine.start-450);
  for(const prev of occurrences) if(prev.id!==id && prev.start<mine.start) start=Math.max(start,prev.end);
  let end=Math.min(s.length,mine.end+2200);
  for(const next of occurrences)if(next.id!==id&&next.start>mine.start){end=Math.min(end,next.start);break;}
  return s.slice(start,Math.max(start,end)).slice(0,3500).trim();
}
function wa2ExtractListings(html,plain) {
  const listings=wa2ExtractLinks(html,plain);
  const text=wa2HtmlText(html)||String(plain||'');
  return listings.map(item=>Object.assign({},item,{
    emailExcerpt:wa2ExtractMailExcerpt(text,item.id,listings.length)
  }));
}
function wa2LooksComplete(excerpt) {
  const s=String(excerpt||'');
  return /(?:\d[\d., ]*\s*€|\b(?:precio|alquiler|renta)\s*:?\s*€?\s*\d)/i.test(s)
    && /\b\d[\d., ]*\s*m(?:²|2|\b)|\b(?:superficie|metros)\s*:?\s*\d/i.test(s);
}
