/**
 * Allowlisted, bounded listing-page fallback, adapted from AIProcessing.js.
 * Page facts require an identity marker matching the requested listing.
 */
function wa2ExtractPageText(html) {
  let s=String(html||'');
  s=s.replace(/<(script|style|svg|nav|footer|header|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');
  return wa2HtmlText(s).slice(0,8500);
}
function wa2PageIdentity(html) {
  const raw=String(html||'');
  const identity=[];
  for(const tag of raw.match(/<(?:link|meta)\b[^>]*>/gi)||[]){
    if(!/\b(?:canonical|og:url)\b/i.test(tag))continue;
    const m=tag.match(/(?:href|content)\s*=\s*["']([^"']+)/i);
    if(m)identity.push(m[1]);
  }
  const jsonUrls=raw.match(/https?:\\?\/\\?\/(?:www\.)?(?:idealista\.com|pisos\.com|fotocasa\.es|yaencontre\.com|milanuncios\.com)\/[^"'\\\s<>]+/gi)||[];
  identity.push(...jsonUrls.slice(0,6).map(x=>x.replace(/\\\//g,'/')));
  return [...new Set(identity.map(u=>wa2GetPortalListing(u)).filter(Boolean).map(x=>x.id))];
}
function wa2FetchPage(listing) {
  let url=listing.url;
  for(let hop=0;hop<4;hop++){
    const identity=wa2GetPortalListing(url);
    if(!identity||identity.id!==listing.id)return {status:'identity_mismatch',text:''};
    let response;
    try {
      response=UrlFetchApp.fetch(url,{method:'get',followRedirects:false,
        muteHttpExceptions:true,validateHttpsCertificates:true,
        headers:{Accept:'text/html,application/xhtml+xml'}});
    }catch(e){return {status:'network_error',text:''};}
    const code=response.getResponseCode();
    if([301,302,303,307,308].includes(code)){
      const h=response.getAllHeaders();let next=h.Location||h.location;
      if(Array.isArray(next))next=next[0];
      if(!next)return {status:'redirect_missing',text:''};
      if(next.startsWith('/'))next='https://'+url.match(/^https:\/\/([^/]+)/)[1]+next;
      url=wa2CleanUrl(next);
      continue;
    }
    if(code!==200)return {status:'http_'+code,text:''};
    const html=response.getContentText();
    if(/captcha|verify you are human|access denied|just a moment/i.test(html.slice(0,2000)))
      return {status:'blocked',text:''};
    const matches=wa2PageIdentity(html);
    if(matches.length!==1||matches[0]!==listing.id)
      return {status:'identity_unconfirmed',text:''};
    const text=wa2ExtractPageText(html);
    return {status:text?'ok':'empty',text};
  }
  return {status:'too_many_redirects',text:''};
}
