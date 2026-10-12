
/**
 * Trigger.gs
 * Wohnungsagent – Zeitsteuerung
 *
 * Ein gemeinsamer Trigger alle 5 Minuten.
 */

/**
 * Einmalig ausführen.
 */
function setupGmailImageTrigger() {
  const oldFunctions = [
    'runImageImport',
    'runGmailImagePipeline'
  ];

  // Eigene alte Pipeline-Trigger entfernen.
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (
      oldFunctions.includes(
        trigger.getHandlerFunction()
      )
    ) {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // Neuen gemeinsamen Trigger erstellen.
  ScriptApp.newTrigger('runGmailImagePipeline')
    .timeBased()
    .everyMinutes(5)
    .create();

  console.log(
    'Gmail-/Bildimport: alle 5 Minuten aktiviert.'
  );

  checkGmailImageTrigger();
}


/**
 * Zeigt die vorhandenen Pipeline-Trigger.
 */
function checkGmailImageTrigger() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter(trigger =>
      [
        'runImageImport',
        'runGmailImagePipeline'
      ].includes(trigger.getHandlerFunction())
    );

  for (const trigger of triggers) {
    console.log(
      'Funktion: ' +
      trigger.getHandlerFunction() +
      ', Trigger-ID: ' +
      trigger.getUniqueId()
    );
  }

  console.log(
    'Anzahl Pipeline-Trigger: ' +
    triggers.length
  );
}


/**
 * Deaktiviert die automatische Verarbeitung.
 */
function removeGmailImageTrigger() {
  const functions = [
    'runImageImport',
    'runGmailImagePipeline'
  ];

  let removed = 0;

  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (
      functions.includes(
        trigger.getHandlerFunction()
      )
    ) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  }

  console.log(
    'Entfernte Pipeline-Trigger: ' + removed
  );
}
