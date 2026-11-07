/** Independent serial AI consumer. Import and AI keep the same ScriptLock. */
const AI_WORKER = {
  handler: 'runAiQueueWorker',
  intervalMinutes: 1,
  budgetMs: 120000,
  reserveMs: 60000,
  maxSteps: 6,
  importTurnProperty: 'WOHNUNGSAGENT_IMPORT_WAITING_UNTIL',
  runsSheet: 'KI-Läufe'
};

function requestAiImportTurn_() {
  PropertiesService.getScriptProperties().setProperty(AI_WORKER.importTurnProperty,
    String(Date.now() + 6 * 60000));
}

function clearAiImportTurn_() {
  PropertiesService.getScriptProperties().deleteProperty(AI_WORKER.importTurnProperty);
}

function aiImportTurnRequested_() {
  const until = Number(PropertiesService.getScriptProperties()
    .getProperty(AI_WORKER.importTurnProperty));
  return Number.isFinite(until) && until > Date.now();
}

/** Caller holds ScriptLock. Existing imports migrate on their next run after deploy. */
function ensureAiWorkerTrigger_() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === AI_WORKER.handler);
  if (!triggers.length)
    ScriptApp.newTrigger(AI_WORKER.handler).timeBased()
      .everyMinutes(AI_WORKER.intervalMinutes).create();
  // Keep one worker when setup has previously been run more than once.
  for (const trigger of triggers.slice(1)) ScriptApp.deleteTrigger(trigger);
  return true;
}

/** Process checkpoints sequentially, without waiting for another five-minute tick. */
function drainAiQueue_(ss, queue, options) {
  const settings = Object.assign({}, AI_WORKER, options || {});
  const started = Date.now();
  let steps = 0;
  let result = {status: 'no_ready_jobs'};
  while (steps < settings.maxSteps &&
         Date.now() - started < settings.budgetMs - settings.reserveMs) {
    if (aiImportTurnRequested_()) break;
    const stepStarted = Date.now();
    result = processNextAiListing(ss, queue);
    if (result.status === 'empty' || result.status === 'no_ready_jobs') break;
    steps++;
    waMonitorAi_(imageDiagnosticRun && imageDiagnosticRun.mailId, result);
    logImageDiagnostic('ai_worker_step', {
      status: result.status, listing_id: result.listingId || '',
      duration_ms: Date.now() - stepStarted, count: steps,
      error: result.error || '', level: result.status === 'retry' ? 'WARN' : 'INFO'
    });
    // A definite rejection with a persisted retry is safe to skip; unknown
    // results/errors must not cause an immediate duplicate paid operation.
    if (!['text_extracted', 'completed', 'processing', 'pending', 'no_images',
      'blocked', 'unavailable', 'duplicate', 'retry', 'needs_review'].includes(result.status) &&
      !String(result.status).startsWith('page_checked_')) break;
  }
  return {status: steps ? 'batch_finished' : result.status, steps,
    lastStatus: result.status, durationMs: Date.now() - started};
}

/** No Gmail scanning or gallery maintenance in this trigger. */
function runAiQueueWorker() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return {status: 'busy', steps: 0};
  let diagnosticsStarted = false;
  let failed = false;
  try {
    // A skipped importer gets the next turn instead of competing indefinitely
    // against the minute worker. The marker expires if the importer is removed.
    if (aiImportTurnRequested_()) return {status: 'import_waiting', steps: 0};
    const ss = SpreadsheetApp.openById(getWohnungsagentSpreadsheetId_());
    const queue = ss.getSheetByName(AI_PIPELINE.queueSheetName);
    if (!queue) return {status: 'empty', steps: 0};
    // Idle ticks do not create a Drive logfile or a monitoring row.
    const ready = processNextAiListing(ss, queue, {peek: true});
    if (ready.status !== 'ready') return {status: ready.status, steps: 0};
    beginImageDiagnostics('ai_worker');
    diagnosticsStarted = true;
    waMonitorStart_();
    return drainAiQueue_(ss, queue);
  } catch (error) {
    failed = true;
    if (diagnosticsStarted) waMonitorIssue_('KI-Worker: ' + error.message);
    console.error('KI-Worker: ' + error.message);
    throw error;
  } finally {
    try {
      if (diagnosticsStarted) {
        try { waMonitorFinish_(failed, AI_WORKER.runsSheet); }
        finally { finishImageDiagnostics(); }
      }
    } finally {
      try { SpreadsheetApp.flush(); }
      finally { lock.releaseLock(); }
    }
  }
}
