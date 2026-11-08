/** Lightweight per-provider data-quality counters. No network requests or AI calls. */
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
    if(!(Number(rents[i][0])>0))row.missing_rent++;
    if(!(Number(areas[i][0])>0))row.missing_area++;
  }
  for(const [provider,v] of Object.entries(stats)) {
    logImageDiagnostic('provider_quality',{
      provider,count:v.total,missing_rent:v.missing_rent,
      missing_area:v.missing_area,status:'audited'
    });
  }
  return {checked,providers:stats};
}
