# Schnellere KI-Verarbeitung

## Verhalten nach dem Deployment

Der Mailimport läuft weiterhin alle fünf Minuten. Beim ersten Import nach dem
Deployment richtet `ensureAiWorkerTrigger_` einen separaten Minuten-Trigger für
`runAiQueueWorker` ein. Es ist kein zusätzlicher manueller Setup-Aufruf nötig,
sofern der ausführende Nutzer Trigger anlegen darf. Bei fehlender Berechtigung
protokolliert der Import eine Warnung und nutzt die bisherige Inline-KI als Fallback.

Der Worker bearbeitet ausschließlich freigegebene KI-Einträge. Er führt weder
Gmail-Suche noch die allgemeine Galeriepflege aus. Mehrere Schritte derselben
Anzeige und danach weitere Anzeigen können innerhalb eines Aufrufs folgen.
Die bestehende Zuordnung und Abschlussliste von Sammelmails bleiben erhalten.

## Zeitbudget und gegenseitiger Ausschluss

Ein Worker hat ein weiches Budget von 120 Sekunden und startet nach 60 Sekunden
keinen weiteren Schritt. Die übrigen 60 Sekunden sind Reserve für einen bereits
begonnenen Schritt. Ein laufender externer Aufruf kann das Budget überschreiten;
die Reserve ist kein Netzwerk-Timeout. Zusätzlich sind höchstens sechs Schritte
pro Aufruf erlaubt. Jeder Schritt speichert seinen bisherigen Checkpoint.

Import, manueller KI-Aufruf und Worker verwenden denselben ScriptLock.
Es gibt damit weiterhin genau einen schreibenden Pipeline-Lauf gleichzeitig.
Ein belegter Worker-Trigger beendet sich ohne API-Aufruf. Meldet der Import
seinen Bedarf an, gibt der Worker nach dem aktuellen Schritt ab. Weitere Worker
warten auf den nächsten Import. Die Anforderung verfällt nach sechs Minuten,
falls der Import entfernt oder unterbrochen wurde.

Diese erste Ausbaustufe vermeidet die künstliche Fünf-Minuten-Pause zwischen
KI-Schritten. Sie implementiert keine parallelen OpenAI-Aufrufe und keine
vollständig getrennte Queue-Zeile pro Inserat. Dafür wären zusätzliche
Reservierungen und eine Migration der bestehenden Sammelmails erforderlich.

## Kosten, Wiederholungen und Beobachtbarkeit

Anzahl und Auswahl der maximal zehn Bilder sowie die API-Modelle bleiben gleich.
Der höhere Durchsatz kann vorhandenes Guthaben schneller verbrauchen. Die
vorhandenen Retry-Zeitpunkte, 48-Stunden-Auswahlgrenze, Abschlusslisten und
`needs_review`-Sperren gelten weiter. Ungeklärte API-Operationen werden nicht
automatisch erneut kostenpflichtig ausgeführt.

Leere Minuten-Aufrufe erzeugen keine Drive-Logdatei und keine Laufzeile.
Aktive Worker schreiben ihre Dauer nach `KI-Läufe`. Einzelschritte erscheinen
mit Laufzeit im JSONL-Ereignis `ai_worker_step` und in `Entscheidungen`.
Der Mailimport behält sein Blatt `Läufe`. Ein gesunder Worker kann somit einen
ausgefallenen Mailimport im bisherigen Pipeline-Monitoring nicht verdecken.

Die bestehenden Telegram- und Watchdog-Workflows bleiben unverändert. Insbesondere
verwendet deren `AI_QUEUE_STALLED`-Regel weiterhin das ursprüngliche Mailalter.
Eine Korrektur dieses Alarms und ein schnellerer Telegram-Versand sind separate
Änderungen, weil GitHub-Workflows auf `main` ohne Apps-Script-Deployment aktiv werden.

## Prüfen und aktivieren

1. `node --test tests/*.test.cjs` und Syntaxprüfung aller Apps-Script-Dateien ausführen.
2. Änderungen können direkt auf `main` gespeichert werden. Der vorhandene
   Deployment-Workflow wird ausschließlich per `workflow_dispatch` mit `DEPLOY`
   gestartet. Ein Commit allein ändert den Online-Apps-Script-Code nicht.
3. Nach dem manuell gestarteten Deployment den nächsten Mailimport abwarten.
   In Apps Script muss genau ein `runAiQueueWorker`-Trigger sichtbar sein.
4. In `KI-Läufe`, `Entscheidungen` und JSONL die tatsächliche Schrittzahl und
   Laufzeiten prüfen. Der Minuten-Takt ist ein Zeitplan, keine garantierte Latenz.
5. `removeGmailImageTrigger` entfernt auch den Worker. Soll nur die neue
   Architektur zurückgenommen werden, den vorherigen Commit erneut deployen
   und den Worker-Trigger entfernen; den Mailimport dabei weiterlaufen lassen.

Die Tests verwenden lokale Mocks. Sie starten kein Deployment, legen keine
produktiven Trigger an und senden keine kostenpflichtigen API-Anfragen.
