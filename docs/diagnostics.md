# Fehleranalyse: separate Logdateien

## Ablage

Jeder Lauf schreibt eine eigene UTF-8-JSONL-Datei in Google Drive, zum Beispiel:

    wohnungsagent_2026-10-15T07-30-00-000Z_ab12cd34.jsonl

Der Ordner **Wohnungsagent – Logs** wird neben dem tatsächlich verwendeten
Spreadsheet angelegt. Seine ID wird unter der Script Property
WOHNUNGSAGENT_LOG_FOLDER_ID gespeichert und anschließend wiederverwendet.
Ein bereits gesetzter Ordner wird respektiert. Die zuletzt erzeugte Datei ist
über WOHNUNGSAGENT_LAST_LOG_FILE_ID auffindbar; ihr Link steht auch in der Konsole
als log_file-Ereignis. Dateien bleiben privat; es werden keine Freigaben geändert.

Es werden keine neuen Logzeilen in Anzeigen, Verarbeitung, Läufe oder Diagnose
geschrieben. Das bisherige Diagnoseblatt enthält nur seine vorhandenen Einträge.
Bestehende fachliche Queue-/Statusfelder der Importpipeline bleiben bestehen.

## Eindeutige Zuordnung zum System

Jede Ereigniszeile enthält:

- schema_version: Formatversion des Logs
- implementation: image-import-1.x oder wohnungsagent-2.0
- spreadsheet_id: tatsächlich für diesen Lauf verwendetes Ziel
- at und run_id: UTC-Zeit und gemeinsame Lauf-ID
- stage, level, status, duration_ms
- mail_id und listing_id, soweit im Verarbeitungsschritt bekannt
- begrenzte Details zu Anzahl, HTTP-Status, Bildgröße oder Fehlermeldung

Bei Version 2.0 wird der dortige getWohnungsagentSpreadsheetId_-Resolver benutzt,
einschließlich der optionalen WOHNUNGSAGENT_SPREADSHEET_ID-Konfiguration.
Das Logging selbst ändert das aktive Ziel-Sheet nicht.

Der zuletzt geprüfte main-Stand verwendete das ältere Sheet
1bVko9OSTD5QtPsIuxmDDrGO-8S-L6iK0TnHPvI3HwvM. Das saubere Neustart-Sheet ist
1_X-jdVIKwbqDABIssOOCjLC41qRqpb01paV1RtruMwg. Die 2.0-KI-Implementierung lag
zum Zeitpunkt der Logging-Umstellung im separaten offenen Pull Request #1.
Eine Umstellung auf diese Pipeline muss unabhängig vom Logging erfolgt sein.

## Abbrüche und Fehler

Der erste Checkpoint enthält run_start und wird vor der Verarbeitung gespeichert.
Weitere Checkpoints erfolgen nach je 25 Ereignissen, nach abgeschlossenen
Verarbeitungsstufen und sofort bei einem ERROR. Der Abschluss ergänzt run_end.
Ein fehlendes run_end bedeutet: der Abschluss wurde nicht gespeichert; daraus
darf kein erfolgreicher Lauf abgeleitet werden. Die letzten Ereignisse vor
einem harten Timeout können seit dem letzten Checkpoint fehlen.

Pro Datei werden höchstens 1.000 Ereignisse gespeichert, einschließlich run_end.
Ausgelassene Ereignisse sowie Warnungs-/Fehlerzahlen stehen in der Abschlusszeile.
Zusätzlich werden alle Ereignisse in die Apps-Script-Konsole geschrieben.
Drive-Fehler erscheinen dort und dürfen die eigentliche Verarbeitung nicht
abbrechen. Das Log wird bei einem späteren Checkpoint erneut zu speichern versucht.

Mailtexte, Betreffzeilen und unbekannte Detailfelder werden nicht protokolliert.
URL-Querys, URL-Fragmente, Bearer-Tokens und API-Key-Muster werden entfernt.
source_key erlaubt den Abgleich von Ereignissen derselben ursprünglichen
Bild-URL, ohne deren Query-Parameter zu speichern.

## Lesender Bestandscheck

Im Apps-Script-Editor **runImageDiagnostics** ausführen. Die Funktion liest
Anzeigen und speichert ausschließlich die Logdatei. Sie lädt keine Bilder,
sortiert keine Anzeigen und repariert keine Zuordnung. Gemeldet werden:

- abweichende source_email_id gegenüber der Anzeigenzeile
- fremde listing_id an einer Bildreferenz
- doppelte Datensatz-IDs oder ungültiges JSON
- completed bei noch nicht erfassten analyzed_file_ids

Eine abweichende Quell-E-Mail ist ein Warnsignal, allein kein Beweis für ein
fremdes Foto: dieselbe Anzeige kann in mehreren E-Mails vorkommen.

## Weitere Ausgaben

Apps Script > Ausführungen enthält die Konsolenausgabe einschließlich Logdatei-Link.
Der GitHub-Workflow Mail importer regression tests prüft Syntax und Regressionen
und speichert einen herunterladbaren JUnit-Bericht für sieben Tage.
Er führt keinen Deploy aus.

Die Ereignisstufen umfassen mail_scan, mail_extract, mail_images, image_http,
image_content, image_download, queue_status, identity_audit, listing_write,
listing_import, availability, availability_result, previews, sort und run_end.

## Milanuncios

Die Original-Suchmail 1a13b58f7993b3f6 wurde live verarbeitet:
Foto-Link HTTP 302 auf Anzeige 619803957, JPEG heruntergeladen, ready_for_ai.

Nur Tracking-Links direkt um echte images-re.milanuncios.com-Immobilienfotos
werden aufgelöst: maximal acht Karten und drei Redirects je Karte. Such-,
Änderungs- und Abmeldebuttons werden nicht aufgerufen. Unklare Ziele bleiben
retry. Die Sperrliste wird vor dem Bilddownload geprüft.
