/**
 * Direct text-only Telegram delivery. Network ambiguity is NOT retried blindly.
 */
function wa2EscapeHtml(s) {
  return String(s===null||s===undefined?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function wa2FormatMessage(row) {
  const manual=row.area===null||row.area===undefined;
  const lines=[];
  if(manual)lines.push('Fläche unbekannt, bitte prüfen');
  lines.push(wa2EscapeHtml(row.provider.charAt(0).toUpperCase()+row.provider.slice(1)));
  lines.push('Miete: '+(row.rent===null||row.rent===undefined?'unbekannt':row.rent+' €'));
  lines.push('Fläche: '+(manual?'unbekannt':row.area+' m²'));
  lines.push('<a href="'+wa2EscapeHtml(row.url)+'">Inserat öffnen</a>');
  return lines.join('\n');
}
function wa2SendTelegram(credentials,message) {
  let response;
  try{
    response=UrlFetchApp.fetch('https://api.telegram.org/bot'+credentials.botToken+'/sendMessage',{
      method:'post',contentType:'application/json',muteHttpExceptions:true,
      payload:JSON.stringify({chat_id:credentials.chatId,text:message,
        parse_mode:'HTML',disable_web_page_preview:true})
    });
  }catch(e){
    const error=new Error('Telegram Zustellung nicht eindeutig');
    error.uncertain=true;throw error;
  }
  const code=response.getResponseCode();
  let parsed;
  try{parsed=JSON.parse(response.getContentText());}catch(e){
    const error=new Error('Telegram Antwort nicht lesbar');
    error.uncertain=true;throw error;
  }
  if(code!==200||!parsed.ok)throw new Error('Telegram HTTP '+code);
  return {messageId:parsed.result&&parsed.result.message_id||null};
}
function wa2DeliverOne(holder,row,credentials,state) {
  if(!row||!['ready','notify_retry'].includes(row.status))return false;
  if(row.nextAt&&Date.parse(row.nextAt)>Date.now())return false;
  // Durable intent prevents an unbounded duplicate after a process crash.
  row.status='sending';row.updatedAt=new Date().toISOString();
  wa2SaveJson(holder,'registry');
  try{
    const result=wa2SendTelegram(credentials,wa2FormatMessage(row));
    row.status=row.area===null||row.area===undefined?'manual_review':'sent';
    row.sentAt=new Date().toISOString();
    row.telegramMessageId=result.messageId;
    row.lastError='';
    row.updatedAt=row.sentAt;
    wa2SaveJson(holder,'registry');
    state.totals.sent=(state.totals.sent||0)+1;
    const received=Date.parse(row.receivedAt||'');
    if(Number.isFinite(received)){
      const minutes=Math.max(0,(Date.now()-received)/60000);
      if(!state.metrics)state.metrics={sampleCount:0,totalLatencyMinutes:0,maxLatencyMinutes:0};
      state.metrics.sampleCount++;
      state.metrics.totalLatencyMinutes+=minutes;
      state.metrics.maxLatencyMinutes=Math.max(state.metrics.maxLatencyMinutes,minutes);
      state.metrics.lastLatencyMinutes=Math.round(minutes*10)/10;
    }
    return true;
  }catch(e){
    if(e.uncertain){
      row.status='unknown_delivery';row.lastError=e.message;
      row.updatedAt=new Date().toISOString();
    }else {
      row.status='notify_retry';
      wa2ScheduleRetry(row,e.message,Date.now());
    }
    wa2SaveJson(holder,'registry');
    return false;
  }
}
