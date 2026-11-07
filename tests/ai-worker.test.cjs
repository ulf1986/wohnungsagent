const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup({results = [], locked = false, ready = true} = {}) {
  let time = 1000000, calls = 0, release = 0, logs = 0, finish = null;
  const props = {}, triggers = [], deleted = [];
  class Clock extends Date { static now() { return time; } }
  const context = vm.createContext({Date: Clock, console: {error(){},log(){}},
    AI_PIPELINE: {queueSheetName:'Verarbeitung'}, imageDiagnosticRun: null,
    PropertiesService: {getScriptProperties:()=>({getProperty:k=>props[k] || null,
      setProperty:(k,v)=>{props[k]=v;},deleteProperty:k=>{delete props[k];}})},
    LockService:{getScriptLock:()=>({tryLock:()=>!locked,releaseLock:()=>{release++;}})},
    SpreadsheetApp:{openById:()=>({getSheetByName:()=>({})}),flush(){}},
    getWohnungsagentSpreadsheetId_:()=> 'sheet',
    beginImageDiagnostics:()=>{logs++;context.imageDiagnosticRun={mailId:'mail'};},
    waMonitorStart_(){},waMonitorIssue_(){},waMonitorAi_(){},logImageDiagnostic(){},
    waMonitorFinish_:(failed,sheet)=>{finish={failed,sheet};},finishImageDiagnostics(){},
    processNextAiListing:(_,__,options)=>{
      if(options?.peek) return {status:ready?'ready':'no_ready_jobs'};
      const result=results[calls++] || {status:'no_ready_jobs'};
      time+=result.ms || 0;
      if(result.fail) throw Error(result.fail);
      if(result.importWaiting) context.requestAiImportTurn_();
      return result;
    },
    ScriptApp:{getProjectTriggers:()=>triggers,
      deleteTrigger:t=>deleted.push(t),newTrigger:handler=>({timeBased(){return this;},
        everyMinutes(n){this.interval=n;return this;},create(){triggers.push({getHandlerFunction:()=>handler});}})}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/AiWorker.js'),'utf8'),context);
  return {context,triggers,deleted,props,advance:ms=>{time+=ms;},
    stats:()=>({calls,release,logs,finish})};
}

test('text, image batches and next listing run without another trigger',()=>{
  const x=setup({results:[{status:'text_extracted'},{status:'processing'},{status:'completed'},
    {status:'blocked'},{status:'no_ready_jobs'}]});
  assert.equal(x.context.runAiQueueWorker().steps,4);
  assert.deepEqual(x.stats(),{calls:5,release:1,logs:1,finish:{failed:false,sheet:'KI-Läufe'}});
});

test('soft time budget reserves time for the next external operation',()=>{
  const x=setup({results:[{status:'text_extracted',ms:61000},{status:'completed'}]});
  assert.equal(x.context.runAiQueueWorker().steps,1);
  assert.equal(x.stats().calls,1);
});

test('step cap bounds fast repeat work',()=>{
  const x=setup({results:Array.from({length:10},()=>({status:'completed'}))});
  assert.equal(x.context.runAiQueueWorker().steps,6);
  assert.equal(x.stats().calls,6);
});

test('busy trigger never reads queue or releases another execution lock',()=>{
  const x=setup({locked:true});assert.equal(x.context.runAiQueueWorker().status,'busy');
  assert.deepEqual(x.stats(),{calls:0,release:0,logs:0,finish:null});
});

test('idle tick creates no diagnostics or run rows',()=>{
  const x=setup({ready:false});assert.equal(x.context.runAiQueueWorker().steps,0);
  assert.deepEqual(x.stats(),{calls:0,release:1,logs:0,finish:null});
});

test('unexpected result stops the batch instead of repeating an uncertain operation',()=>{
  const x=setup({results:[{status:'unexpected'},{status:'completed'}]});
  assert.equal(x.context.runAiQueueWorker().steps,1);assert.equal(x.stats().calls,1);
});

test('failure records failed worker and releases lock',()=>{
  const x=setup({results:[{fail:'API interrupted'}]});
  assert.throws(()=>x.context.runAiQueueWorker(),/API interrupted/);
  assert.equal(x.stats().release,1);assert.equal(x.stats().finish.failed,true);
});

test('diagnostic finalization failure still releases lock',()=>{
  const x=setup();x.context.finishImageDiagnostics=()=>{throw Error('Drive unavailable');};
  assert.throws(()=>x.context.runAiQueueWorker(),/Drive unavailable/);
  assert.equal(x.stats().release,1);
});

test('import request yields after current step and blocks subsequent ticks until import',()=>{
  const x=setup({results:[{status:'completed',importWaiting:true},{status:'completed'}]});
  assert.equal(x.context.runAiQueueWorker().steps,1);
  assert.equal(x.context.runAiQueueWorker().status,'import_waiting');
  x.context.clearAiImportTurn_();
  assert.equal(x.context.runAiQueueWorker().steps,1);
});

test('abandoned import request expires',()=>{
  const x=setup();x.context.requestAiImportTurn_();
  assert.equal(x.context.runAiQueueWorker().status,'import_waiting');
  x.advance(6*60000+1);assert.notEqual(x.context.runAiQueueWorker().status,'import_waiting');
});

test('worker trigger installation is idempotent and removes only duplicate workers',()=>{
  const x=setup();x.context.ensureAiWorkerTrigger_();x.context.ensureAiWorkerTrigger_();
  assert.equal(x.triggers.length,1);
  const other={getHandlerFunction:()=> 'runGmailImagePipeline'};
  const duplicate={getHandlerFunction:()=> 'runAiQueueWorker'};
  x.triggers.push(other,duplicate);x.context.ensureAiWorkerTrigger_();
  assert.deepEqual(x.deleted,[duplicate]);
});
