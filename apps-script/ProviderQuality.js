/** Lightweight per-provider data-quality counters. No network requests or AI calls. */
/** Locale-aware numeric test for the displayed German/Spanish spreadsheet format. */
function providerQualityNumeric_(raw) {
  if(typeof raw==='number')return Number.isFinite(raw)&&raw>0?raw:null;
  let s=String(raw==null?'':raw).trim().replace(/[^0-9,.-]/g,'');
  if(!s)return null;
  if(s.includes(',')&&s.includes('.'))s=s.replace(/\./g,'').replace(',','.');
  else if(s.includes(','))s=s.replace(',','.');
  else if(/^\d{1,3}(?:\.\d{3})+$/.test(s))s=s.replace(/\./g,'');
  const value=Number(s);
  return Number.isFinite(value)&&value>0?value:null;
}

function auditProviderDataQuality_(ss) {
  const sheet=ss.getSheetByName('Anzeigen');
  if(!sheet||sheet.getLastRow()<2)return {checked:0,providers:{}};
  const header=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
  const idx=name=>{const i=header.indexOf(name);if(i<0)throw new Error('Datenqualitäts-Spalte fehlt: '+name);return i+1;};
  const rentCol=idx('Miete'),areaCol=idx('Fläche'),portalCol=idx('Portal'),idCol=idx('Datensatz-ID');
  const count=sheet.getLastRow()-1;
  // Narrow-column reads avoid reloading large cached AI JSON documents.
  const [ids,portals,rents,areas]=[idCol,portalCol,rentCol,areaCol].map(col=>
    sheet.getRange(2,col,count,1).getValues());
  const stats={};
  let checked=0;
  for(let i=0;i<count;i++) {
    const id=String(ids[i][0]||'').trim();
    if(!id)continue;
    const portal=String(portals[i][0]||'').trim().toLowerCase()||'unknown';
    const row=stats[portal]||(stats[portal]={total:0,missing_rent:0,missing_area:0});
    checked++;row.total++;
    if(providerQualityNumeric_(rents[i][0])===null)row.missing_rent++;
    if(providerQualityNumeric_(areas[i][0])===null)row.missing_area++;
  }
  for(const [provider,v] of Object.entries(stats)) {
    logImageDiagnostic('provider_quality',{
      provider,count:v.total,missing_rent:v.missing_rent,
      missing_area:v.missing_area,status:'audited'
    });
  }
  return {checked,providers:stats};
}
