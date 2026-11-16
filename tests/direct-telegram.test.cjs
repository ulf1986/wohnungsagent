const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/TelegramDirect.js'), 'utf8'), ctx);
function candidate(row) { return ctx.directTelegramCandidate_(row); }
const base = {
  'Datensatz-ID':'idealista:123', 'Anzeigenlink':'https://www.idealista.com/inmueble/123/',
  'KI-Bewertung':'Abgeschlossen', Status:'Geeignet', Miete:1100,
  'Fläche':80, 'Telegram Versand UTC':''
};
test('direct delivery only accepts completed, eligible, unsent listings',()=>{
  assert.equal(candidate(base).confirmed,true);
  assert.equal(candidate({...base,'KI-Bewertung':'Pending'}),null);
  assert.equal(candidate({...base,'Telegram Versand UTC':'2026-11-16T10:00:00Z'}),null);
  assert.equal(candidate({...base,Miete:750}),null);
  assert.equal(candidate({...base,'Fläche':55}),null);
  assert.equal(candidate({...base,Status:'Ausgeschlossen'}),null);
  assert.equal(candidate({...base,'Anzeigenlink':'javascript:alert(1)'}),null);
});
test('unknown facts get manual check, never an approved label',()=>{
  const c = candidate({...base,Status:'Verfügbarkeit ungeklärt',Miete:'','Fläche':''});
  assert.equal(c.confirmed,false);
  assert.match(ctx.directTelegramMessage_(c),/manuell prüfen/);
});
test('messages escape user-controlled HTML and retain safe links',()=>{
  const c = candidate({...base,Titel:'<script>&"'});
  const message=ctx.directTelegramMessage_(c);
  assert.ok(!message.includes('<script>'));
  assert.match(message,/&lt;script&gt;&amp;&quot;/);
});
test('retry selection yields to fresh items without starvation',()=>{
  const props = {};
  const ai = vm.createContext({
    PropertiesService:{getScriptProperties:()=>({
      getProperty:k=>props[k] || null,
      setProperty:(k,v)=>{props[k]=v;}})}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/AIProcessing.js'), 'utf8'), ai);
  const now=Date.parse('2026-11-16T10:00:00Z');
  const columns={'Queue Eingang UTC':0,'Queue Bildstatus':1};
  const ix={status:2,retryAt:3};
  const rows=[
    [new Date(now-3600000),'ready_for_ai','retry',''],
    [new Date(now-120000),'ready_for_ai','pending','']
  ];
  const select=()=>ai.chooseAiQueueTarget_(rows,columns,ix,now,true).rowNumber;
  assert.deepEqual([select(),select(),select(),select(),select()],[3,3,3,3,2]);
  assert.equal(select(),3);
});
