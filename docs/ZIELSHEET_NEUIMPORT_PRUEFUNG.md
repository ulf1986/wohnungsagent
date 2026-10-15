# Ziel-Sheet und kontrollierter Neuimport

Prüfung am 15.10.2026. Dieser Auftrag bereitet Änderungen vor. Es wurden keine Apps-Script-Funktionen ausgeführt, Trigger gespeichert/geändert, Gmail-Labels geändert, Sheet-Zellen beschrieben oder Neuimporte gestartet. Kein clasp push und kein Deployment durch den Bearbeiter.

## 1. Git, produktiver Stand und Clasp

- Ausgangspunkt und geprüfter GitHub-main: `b1c2efc062a0a46f19f1549f2323c38c8e5892f7`. Der lokale Arbeitsordner enthält keinen Git-Checkout; Dateien wurden gegen diesen unveränderlichen GitHub-Stand abgeglichen. GitHub ist die Referenz für die Versionshistorie.
- [Manueller Deploy 38718419649](https://github.com/ulf1986/wohnungsagent/actions/runs/38718419649) hat am 15.10.2026 um 10:11 UTC diesen Commit erfolgreich per clasp push übertragen. Dieser Lauf bestand bereits; er wurde in diesem Auftrag nur gelesen. Ein nachträglicher manueller Eingriff im Online-Editor lässt sich damit allein nicht ausschließen.
- `apps-script/.clasp.json`: Script-ID `14WM3bv3Ubr-ZI9K-qRfcNo3tj9TkZM14EQQJqlAxinrt2w9IaONBYyij`, rootDir leer, also relativ zum Ordner apps-script. Manifest: V8, Europe/Madrid.
- `.github/workflows/deploy-apps-script.yml` ist ausschließlich manuell startbar (`workflow_dispatch`, Bestätigung DEPLOY). Der Workflow installiert Clasp 3.4.1 und verwendet `CLASPRC_JSON`. Das Secret wurde nicht ausgelesen. Lokal ist Clasp nicht auf PATH verfügbar; für den vorhandenen GitHub-Deploy ist das nicht erforderlich.
- [Produktives Apps-Script-Projekt](https://script.google.com/home/projects/14WM3bv3Ubr-ZI9K-qRfcNo3tj9TkZM14EQQJqlAxinrt2w9IaONBYyij/triggers): Oberfläche schreibgeschützt geprüft. Genau ein zeitbasierter Trigger, `runGmailImagePipeline`, alle fünf Minuten, Testbereitstellung/Head. Zuletzt in der Ansicht ausgeführt: 15.10.2026 14:18:10 Berliner Zeit; angezeigte historische Fehlerrate 4 %. Dialog nur gelesen und abgebrochen, nicht gespeichert.
- `runGmailImagePipeline` verarbeitet die Mail-Bildqueue, protokolliert Diagnoseereignisse und ruft anschließend `auditListingImageAssignments`, `processExistingListingImages`, `checkListingImageAvailabilityInternal`, `updateListingPreviewsInternal` und `sortListingsByMailReceived` auf. Fehler einzelner Folgestufen werden protokolliert. Ein erfolgreicher Gesamtlauf beweist deshalb keine neu angelegte Anzeigenzeile.

## 2. Aktuelle und richtige Spreadsheet-Konfiguration

Vor dieser Korrektur steht in `apps-script/Main.js`, `CONFIG.spreadsheetId`:

`1bVko9OSTD5QtPsIuxmDDrGO-8S-L6iK0TnHPvI3HwvM` (altes Sheet).

Eindeutig vorgesehen ist [Wohnungsagent – Neustart (sauberes Sheet)](https://docs.google.com/spreadsheets/d/1_X-jdVIKwbqDABIssOOCjLC41qRqpb01paV1RtruMwg/edit), vom Nutzer Wohnungsagent 2.0 genannt:

`1_X-jdVIKwbqDABIssOOCjLC41qRqpb01paV1RtruMwg`.

Die Zuordnung wird durch die live gelesenen Metadaten, den Nutzerkontext und den bestehenden 2.0-Pull-Request bestätigt. Beide Sheets besitzen dieselben Anzeigen-Spalten (40) und die Blätter Anzeigen, Verarbeitung, Läufe, Einstellungen und Sperrliste. Im neuen Sheet waren bei der Prüfung AD1:AF1000 (IDs) und Q1:Q1000 (Inseratslinks) nur die Überschriften befüllt. Checkboxen in ansonsten leeren Zeilen sind keine Immobilien. Die gelesenen Sperrlisten A1:C100 stimmen vollständig überein: 51 Einträge. Die neue Queue H1:Q10 enthält nur die Überschrift.

Auf main ist CONFIG bereits die zentrale Konfiguration. GmailImport.js, Main.js, BildVerfuegbarkeit.js, Vorschaubilder.js und der Diagnose-Audit öffnen über diese ID. Es gibt dort keinen implementierten Spreadsheet-Resolver und keinen wirksamen Script-Property-Override für die Ziel-ID. Diagnostics.js unterstützt einen optionalen V2-Resolver, fällt auf main aber auf CONFIG zurück. `.clasp.json` bestimmt das Skriptprojekt, nicht das Daten-Sheet. Eine Script-Property `WOHNUNGSAGENT_SPREADSHEET_ID` würde auf diesem Stand das Routing nicht korrigieren.

## 3. Ursache und bewusst begrenzte Codeänderung

Die zentrale Konstante auf main wurde beim Vorbereiten des neuen Sheets nicht umgestellt. Zusätzlich ist die neue KI-Pipeline nur im offenen [PR #1](https://github.com/ulf1986/wohnungsagent/pull/1), Branch `docs/apps-script-ai-pipeline-design` (geprüfter Head `b26a2af878d73b0b7a1446603521b41097cfa604`). Sie ist nicht Bestandteil von b1c2efc.

Die einzige produktive Codeänderung dieses Auftrags ist der Austausch des ID-Literals in `Main.js`, `CONFIG.spreadsheetId`. Keine Funktion wurde hinzugefügt, entfernt, umbenannt oder umstrukturiert. Alle sechs Anbieter-Parser, Bilderfunktionen, vorhandene Bewertungs-/Dublettenfelder und Sperrlistenprüfungen bleiben unverändert. Keine zweite Importlogik.

Wesentliche Grenze: main erzeugt eine Bildqueue bis `ready_for_ai` und aktualisiert Bilder bereits existierender Anzeigen. Es enthält keinen aktiven KI-Consumer, der neue Immobilienzeilen aus dieser Queue anlegt. Die Zielkorrektur allein aktiviert 2.0 nicht und behebt diesen zweiten Grund für fehlende Anzeigen nicht. Den vorhandenen PR separat prüfen und integrieren; hier wird er ausdrücklich nicht aktiviert.

## 4. Statussteuerung und Dublettenerkennung

- Eingang: Gmail-Label `Wohnungssuche/Suchaufträge`. Nur Nachrichten der letzten sieben Tage, maximal 200 Label-Threads, maximal 15 Nachrichten pro Lauf, älteste zuerst. Ein weiteres Portal-Label wird auf main nicht zusätzlich abgefragt. Gmail wird nur gelesen; der Verarbeitungsstatus liegt im Sheet.
- Verarbeitung A:G ist die frühere Verarbeitungshistorie. `readPreviouslyProcessedMailIds` erkennt Erfolgreich/success/completed ohne Beachtung der Großschreibung. Eine solche Gmail-ID wird ohne vorhandenen Queue-Eintrag übersprungen.
- Verarbeitung H:Q ist die aktuelle Bildqueue. `readMailQueueIndex` indiziert Gmail-ID; completed, ready_for_ai und blocked werden übersprungen. processing wird nach 20 Minuten erneut prüfbar, retry nach 30 Minuten. Queue-status ready_for_ai bedeutet fertige Bildvorbereitung, nicht angelegte Immobilie.
- `getMailListingId` und bestehende Portal-Parser ermitteln stabile IDs wie pisos:123; Dateireferenzen und Quellen werden wiederverwendet. Das verhindert wiederholte Bilddownloads, ersetzt aber keinen transaktionalen Dublettenschutz beim Anlegen neuer Anzeigen. Auf main existiert dieser Anlegeschritt nicht. Eine portalübergreifende semantische Dublettengarantie lässt sich daraus nicht ableiten.
- `readMailImageBlacklist` prüft Datensatz-IDs aus Sperrliste Spalte A des konfigurierten Sheets vor Downloads. Vollständig gesperrte Nachrichten werden blocked, gemischte Nachrichten retry. Kein Angebot aus einer gemischten Mail pauschal freigeben.
- In den gelesenen alten Bereichen: 129 Queue-Einträge (75 ready_for_ai, 39 blocked, 15 retry), 33 Erfolgseinträge in A:G. Erfolg im alten Sheet bei Abwesenheit im neuen Sheet ist kein Beweis für eine fehlerhafte Erfolgsmeldung: Das neue Sheet wurde separat angelegt, und Anzeigen können später entfernt/gesperrt worden sein. Die alte Historie daher pro Datensatz mit Anzeigen und Sperrliste abgleichen. ready_for_ai ohne Anzeigenzeile ist durch den fehlenden Consumer erklärbar.

## 5. Vorbereiteter Neuimport-Prüfplan

Ein rein lokaler JSON-Prüfplan liegt unter `.local-mail-tests/neuimport-pruefplan-2026-10-15.json`. Er enthält Gmail-IDs und ermittelte Inserats-IDs, keine Mailtexte oder Bilddateien. Er wurde offline aus bereits gelesenen Bereichen mit den unveränderten bestehenden ID-Parsern erstellt. Es gibt keinen Executor, keine Google-Schreiboperation und keine Importfreigabe. Private Bestandsdaten werden nicht ins Repository aufgenommen.

| Ergebnis für alte Queue-Zeilen 2:180 | Nachrichten |
| --- | ---: |
| Fehlend, ein eindeutiges Inserat, ID nicht gesperrt, innerhalb Kandidaten eindeutig | 38 |
| Wiederholung einer bereits vorgemerkten ID | 8 |
| Alle erkannten Inserate heute gesperrt | 45 |
| Gemischte gesperrte/ungesperrte Inserate | 1 |
| Mehrere Inserate, manuelle Zuordnungsprüfung nötig | 14 |
| Keine eindeutige ID aus gespeicherten Links, manuelle Prüfung nötig | 23 |

Die abweichende Zahl gesperrter Nachrichten gegenüber dem Queue-status ist möglich, weil der Plan die aktuelle Sperrliste gegen alle gespeicherten IDs prüft. Die 33 Erfolgseinträge werden zusätzlich als Abgleichfälle ausgewiesen, nicht als freigegebene Neuimporte. Der Plan ist eine Momentaufnahme der gelesenen Bereiche, kein vollständiges Gmail-Inventar. Bei unresolved Milanuncios-Weiterleitungen wird offline nichts nachgeladen. Die 38 Kandidaten sind vor Ausführung erneut zu prüfen, auch anhand kanonischer Links und möglicher portalübergreifender Dubletten.

Vorgehen für einen später gesondert freigegebenen Neuimport:

1. Altes und neues Sheet einschließlich Sperrliste, Verarbeitung und Drive-Referenzen sichern. Den vorhandenen 2.0-Schreiber und seine ID-/URL-Dublettenprüfung im separaten PR prüfen; ohne ihn keinen Anzeigen-Neuimport starten.
2. Ziel-ID aus dem tatsächlich produktiven Laufprotokoll verifizieren. Alle Ziel-IDs und kanonischen Inseratslinks sowie die Vereinigung beider aktuellen Sperrlisten erneut lesen. Neue Sperreinträge seit diesem Snapshot berücksichtigen. Keine alten Bildanalyse-JSONs ungeprüft kopieren; bestehende Identitätswarnungen machen eine Neuzuordnung erforderlich.
3. Aus Quellqueue, A:G-Erfolgshistorie und Gmail ein explizites Inventar für einen festgelegten Zeitraum bilden. Auch Nachrichten außerhalb des Sieben-Tage-Fensters und jenseits der 200-Thread-Grenze erfassen. Die beiden historischen Pisos-Gmail-IDs 1a133c1c7fd31731 und 1a13437fd8c3f700 dabei einzeln zuordnen. Nicht global Labels oder Erfolgsstatus zurücksetzen und nicht pauschal lookbackDays erhöhen.
4. Für jede stabile Inserats-ID: gesperrt -> ausschließen; bereits im Ziel per ID oder kanonischer URL -> überspringen; Wiederholung im Inventar -> zusammenführen; mehrdeutig/mehrere Inserate/unaufgelöste Weiterleitung -> zurückhalten. Portalübergreifend verdächtige Dubletten vor Freigabe prüfen. Bei gemischten Mails keine gesamte Mail als eine Immobilie behandeln. Bestehendes retry-Verhalten beibehalten.
5. Erst danach eine kleine explizite Allowlist für den vorhandenen Importweg vorbereiten. Eine benötigte spätere Wiederanstoß-Funktion muss denselben Queue-/Parser-/Schreiberweg benutzen und unmittelbar vor dem Schreiben erneut Sperrliste und Zielbestand unter demselben Script-Lock prüfen. Gmail-ID allein genügt nicht. Aktuell existiert keine sichere historische Allowlist-Ausführung auf main; sie wird in diesem Auftrag nicht zusätzlich implementiert. Kein Kopieren der gesamten alten Queue und keine Übernahme alter Erfolgseinträge als pauschaler Skip im neuen Sheet.
6. Zunächst einzelne sichere Nachrichten über diesen geprüften Weg verarbeiten, Ergebnis-IDs und Zeilenanzahl abgleichen, denselben Versuch wiederholen und null zusätzliche Anzeigen erwarten. Erst dann weitere kleine Batches. Erfolg erst nach nachgewiesenem Schreiben einer stabilen ID protokollieren; Fehler behalten retry. Alle diese Ausführungsschritte stehen noch aus und benötigen einen Folgeauftrag.

## 6. Risiken und Erhalt bestehender Daten

Der Patch selbst schreibt keine Daten und verändert keine Spalten. Beim späteren Push verwendet aber schon der vorhandene Fünf-Minuten-Trigger den neuen Code; ein zusätzliches Web-App-Deployment ist dafür nicht nötig. Damit kann sich die neue Queue unmittelbar füllen und Bilder können gespeichert werden. Deshalb wurde hier trotz erlaubtem clasp push nichts übertragen.

Die vorhandene Pipeline bearbeitet Vorschaubilder/Bildanalyse und sortiert ganze Anzeigenzeilen. Ihre bereits vorhandene Verfügbarkeitsprüfung kann bei wiederholt bestätigten 404/410 aller Originalbilder sperren und Anzeigenzeilen entfernen. Dieses Verhalten wurde nicht verändert, ist aber vor einem produktiven Wiederanlauf zu berücksichtigen. Der Neuimport darf selbst keine bestehenden Zeilen überschreiben oder entfernen. Bestehende Datensätze bleiben Referenz für den Abgleich.

Weitere Grenzen: Script-Zugriff auf das neue Sheet/Drive, KI-Zugang und Kontingente sind ohne Funktionsausführung nicht vollständig geprüft. Script-Properties und Online-Quelltext wurden nicht vollständig exportiert. Der Logordner wird über WOHNUNGSAGENT_LOG_FOLDER_ID wiederverwendet; ein Sheet-Wechsel verschiebt einen schon angelegten Ordner nicht automatisch. Bestehendes Dateilogging bleibt erhalten und protokolliert die tatsächlich verwendete Spreadsheet-ID.

## 7. Tests und anschließendes manuelles Deployment

- Offline ausgeführt: `node --test tests/diagnostics.test.cjs tests/pisos-mail.test.cjs`, 35/35 erfolgreich. Darin reale Pisos-/ImmoScout-/Milanuncios-Layouts, Mehrfachangebote/retry, Sperrliste einschließlich gemischter Mails, Bildzuordnung und Dateilogging. Keine Apps-Script-Funktion wurde dafür im Google-Projekt ausgeführt.
- Sämtliche Apps-Script-JavaScriptdateien zusätzlich lokal auf Syntax prüfen. Produktionsdiff muss ausschließlich das Ziel-ID-Literal in Main.js betreffen; sämtliche anderen Apps-Script-Dateien bleiben gegenüber b1c2efc unverändert.
- Nutzer prüft Änderung und Dokumentation und entscheidet separat über Integration von PR #1. Dessen V2-Resolver kann WOHNUNGSAGENT_SPREADSHEET_ID aus Script-Properties bevorzugen; bei späterer Integration muss dieser Wert ebenfalls auf das neue Sheet zeigen. Kein altes Override ungeprüft übernehmen.
- Nutzer startet bei gewünschter Aktivierung den [manuellen Deploy-Workflow](https://github.com/ulf1986/wohnungsagent/actions/workflows/deploy-apps-script.yml) für den gewünschten Commit/Branch. Bestehender Trigger bleibt unverändert. Wegen Head-Nutzung ist clasp push bereits produktiv wirksam.
- Nach Nutzer-Deployment natürliche Triggerausführung abwarten: Log zeigt neue ID; alte Tabelle bekommt keine neuen Pipeline-Schreibvorgänge; neue Queue behält alle Überschriften/Spalten; gesperrte IDs bleiben ausgeschlossen; vorhandene Anzeigen bleiben erhalten. Ein leeres Anzeigenblatt trotz ready_for_ai ist auf reinem main weiterhin erwartbar, solange der geprüfte KI-Schreiber nicht integriert wurde.
- Historischen Neuimport erst nach separater Freigabe und den oben genannten Sicherheitsprüfungen starten. Dieser Auftrag endet bei Vorbereitung und Commit.
