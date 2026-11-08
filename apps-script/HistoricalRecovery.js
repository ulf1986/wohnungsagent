/**
 * One-time, bounded recovery of incomplete Yaencontre rows from the *persisted*
 * original email in Verarbeitung. This uses no Gmail/API request and never
 * combines evidence from two different listings in a digest.
 *
 * The Gmail pipeline owns its lock. Do not lock again from this helper.
 */
function backfillYaencontreMailFacts_(ss, batchSize) {
  const props=PropertiesService.getScriptProperties();
  const key='YAENCONTRE_MAIL_FACT_BACKFILL_CURSOR_V1';
  if(props.getProperty(key)==='DONE') return {checked:0,recovered:0,done:true};
  const sheet=ss.getSheetByName('Anzeigen');
  const queue=ss.getSheetByName('Verarbeitung');
  if(!sheet||!queue)throw new Error('Yaencontre Backfill: Anzeigen oder Verarbeitung fehlt');
  const cols=getListingColumns_(sheet);
  const qHeaders=queue.getRange(1,1,1,queue.getLastColumn()).getValues()[0];
  const mailCol=qHeaders.indexOf('Queue Gmail-ID')+1;
  const textCol=qHeaders.indexOf('Queue Originaltext')+1;
  if(mailCol<1||textCol<1)throw new Error('Yaencontre Backfill: Quelltext-Spalten fehlen');
  const last=sheet.getLastRow();
  if(last<2){props.setProperty(key,'DONE');return {checked:0,recovered:0,done:true};}
  const mailBody=new Map();
  if(queue.getLastRow()>1){
    const q=queue.getRange(2,Math.min(mailCol,textCol),queue.getLastRow()-1,
      Math.abs(textCol-mailCol)+1).getValues();
    const mi=mailCol-Math.min(mailCol,textCol),ti=textCol-Math.min(mailCol,textCol);
    for(const row of q){
      const id=String(row[mi]||'').trim();
      if(id&&!mailBody.has(id))mailBody.set(id,String(row[ti]||''));
    }
  }
  const rows=sheet.getRange(2,1,last-1,sheet.getLastColumn()).getValues();
  let cursor=Math.max(2,Number(props.getProperty(key))||2);
  let checked=0,recovered=0;
  const max=Math.min(last+1,cursor+Math.max(1,Math.min(12,Number(batchSize)||6)));
  for(;cursor<max;cursor++){
    const row=rows[cursor-2];
    if(String(row[cols['Portal']]||'').toLowerCase()!=='yaencontre')continue;
    if(String(row[cols['Zu löschen']]||'').toLowerCase()==='true')continue;
    const id=String(row[cols['Datensatz-ID']]||'').trim();
    const mail=String(row[cols['E-Mail-ID']]||'').trim();
    if(!/^yaencontre:\d+$/.test(id)||!mail||!mailBody.has(mail))continue;
    const oldRent=Number(row[cols['Miete']])>0;
    const oldArea=Number(row[cols['Fläche']])>0;
    if(oldRent&&oldArea)continue;
    const card=extractYaencontreMailCard_(mailBody.get(mail),id);
    checked++;
    if(!card)continue;
    let data;
    try{data=parseAiListingJson_(row[cols['Bildanalyse JSON']]);}
    catch(e){continue;}
    const fields={};
    const proof=[];
    for(const [key,isKnown] of [['rent_eur',oldRent],['area_m2',oldArea]]) {
      if(isKnown)continue;
      const fact=recoverQuotedEssential_(card,key);
      if(!fact)continue;
      fields[key]=fact.value;
      proof.push({field:key,source:'email',value:fact.value,
        quote:fact.quote,method:'historic_listing_mail'});
    }
    if(!proof.length)continue;
    const p=data.ai_pipeline=data.ai_pipeline||{};
    p.email_fields=Object.assign({},p.email_fields||{},fields);
    p.field_provenance=(p.field_provenance||[]).concat(proof);
    data.extracted_fields=Object.assign({},data.extracted_fields||{},fields);
    data.historic_email_recovery_v1={
      at:new Date().toISOString(),source_mail_id:mail,
      recovered_fields:Object.keys(fields)
    };
    for(const [field,value] of Object.entries(fields))
      setListingValue_(sheet,cursor,cols,field==='rent_eur'?'Miete':'Fläche',value);
    updateListingRentPerSquareMeter_(sheet,cursor,cols);
    const eligibility=assessListingEligibility_(data.extracted_fields,data);
    if(eligibility.status==='Ausgeschlossen'){
      setListingValue_(sheet,cursor,cols,'Status','Ausgeschlossen');
      setListingValue_(sheet,cursor,cols,'Mietprüfung',eligibility.reason);
    }
    writeListingJson_(sheet,cursor,cols,data);
    recovered++;
    logImageDiagnostic('historic_mail_recovery',{listing_id:id,
      status:'recovered',count:proof.length});
  }
  props.setProperty(key,cursor>last?'DONE':String(cursor));
  return {checked,recovered,done:cursor>last,next_row:cursor};
}
