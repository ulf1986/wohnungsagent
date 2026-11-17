# Wohnungsagent 2.0: Entwicklung, Sicherheit und Migration

**Status:** Feature-Branch, nicht produktiv. Keine der neuen Funktionen hat
einen automatischen Aktivierungsmechanismus. Die bestehende V1 läuft unverändert.

## Ziel

Eingehende Immobilien-Suchmails erkennen, Anzeigen mit Portal-ID deduplizieren,
mit vorhandener OpenAI-Textanbindung monatliche Miete und Quadratmeter verifizieren,
nur ab 60 m² an Telegram senden. Keine Preisgrenze, Bildanalyse, Bewertung oder
Google-Sheets-Abhängigkeit zur Laufzeit.

## Module

- V2_Config.js: Konfiguration und Script Properties.
- V2_Main.js: orchestriert den vollständigen Ablauf und die Wiederaufnahme.
- V2_Gmail.js: sparsame Gmail-Suche alle fünfzehn Minuten, 30-Minuten-Overlap;
  zwei begrenzte Queries je Suchlauf mit sicherer Pagination,
  einmalige Volltextladung pro Kandidat.
- V2_Portals.js: Portal-IDs, URL-Kanonisierung, Extrakte aus Sammelmails,
  Milanuncios-Redirects ohne Bilddownloads.
- V2_Page.js: begrenzter Webseiten-Fallback mit Domain- und Identitätsprüfung.
- V2_AI.js: OpenAI Responses API, strukturiertes Textschema, Belegprüfung.
- V2_Registry.js: private Drive-JSON-Dateien, Locks, Status und tägliche Backups.
- V2_Telegram.js: Textnachricht, bestätigtes Senden, unklare Zustellung.
- V2_Monitoring.js: minimaler Watchdog ohne Gmail-Abfragen.
- V2_Migration.js: einmaliger Import aus dem Alt-Sheet und GitHub-Sendehistorie.
- V2_Triggers.js: manuelle Aktivierung, Status und Abschaltung.

## Statusmodell

pending -> ready -> sending -> sent (bzw. manual_review bei fehlender Fläche).
pending/retry -> excluded, wenn Fläche < 60 m² ist.
Bei KI-Fehler retry, mit begrenztem Backoff, nach fünf Fehlversuchen failed_final.
Bei Telegram-Ablehnung notify_retry; bei unbekanntem API-Ergebnis
unknown_delivery. Ein vor dem Speichern unterbrochener Sendeschritt wird nicht
automatisch wiederholt, um doppelte Telegram-Meldungen zu vermeiden.

Die Portal-ID ist immer qualifiziert, z. B. idealista:12345678. Eine identische
Ziffernfolge verschiedener Portale führt nicht zu einer Dublette.

Nicht zuordenbare Suchmails werden in state.json als unparsedMails gemerkt.
Mit wa2RetryUnparsedMail(gmailId) können sie nach einer Parserkorrektur erneut
angestoßen oder mit wa2AcknowledgeUnparsedMail(gmailId) manuell quittiert werden.

## Quotas

Zielintervall fünfzehn Minuten; zwei GmailApp.search-Suchmuster je Intervall;
höchstens 50 Threads pro Query, 20 neue Mail-IDs und acht zu bearbeitende
Mails pro Lauf. Es gibt keinen zweiten Gmail-Scan durch Monitoring. Bei einem
Quota-Fehler pausiert die neue Suche 60 Minuten, ohne den Checkpoint zu
verlieren. Werte sind Konfigurationsziele und **keine garantierte Quota-Freigabe**.
Zur Aktivierung zuerst Nutzungszahlen und Triggerverhalten prüfen. Ein kürzeres Suchintervall wird erst nach realen Kontingentmessungen aktiviert.

## Secrets

Apps Script Script Properties, niemals im Repository:
OPENAI_API_KEY, OPENAI_MODEL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
GitHub's vorhandene Secrets werden nicht gelöscht und reichen alleine für den
Apps-Script-Direktversand nicht aus. Bestehende Properties bleiben beim
Deploy des bestehenden Apps-Script-Projekts normalerweise erhalten; vor
Aktivierung mit wa2Preflight() prüfen.

Drive-Dateien sind privat und nicht Teil des öffentlichen Repositories.
Gmail-Inhalte und API-Tokens gehören nicht in Log-Ausgaben.

## Tests

Lokal bzw. in GitHub CI:
  node --test tests/v2/*.test.cjs
  for file in apps-script/V2_*.js; do node --check "$file"; done

Die Tests nutzen Mock-APIs und senden keine Nachrichten, lesen kein echtes Gmail,
erzeugen keine kostenpflichtigen OpenAI-Aufrufe und ändern keinen Google Drive.

Pflichtfälle: Einzelmail, Sammelmail, alle fünf Anbieter-IDs, Quellennachweise,
59/60 m², Mietpreis ohne Obergrenze, bereits versendete IDs, OpenAI-Fehler,
Telegram-Fehler, fehlerhaftes Speicher-JSON und Wiederaufnahme.

Die Laufzeitmetrik state.metrics enthält Anzahl, Summe und Maximum der
Gmail-Eingang-bis-Telegram-Minuten; Mittelwert = totalLatencyMinutes/sampleCount.

## Noch ausstehende produktive Abnahme

1. Auf dem Feature-Branch Tests erfolgreich abschließen und PR prüfen.
2. Vor dem Deploy V1-Archivbranch und bisherige Secrets bestätigen.
3. V2-Script-Code manuell mit bestehendem clasp-Skript bereitstellen.
4. wa2Preflight() ausführen. V2 ist standardmäßig deaktiviert.
5. wa2MigrateHistory() einmalig ausführen. Diese Funktion liest ausnahmsweise
   das Alt-Sheet und GitHub-Issue #3, um bereits versendete IDs zu übernehmen.
   Die reguläre V2-Pipeline liest NIE Google Sheets.
6. Bestehende GitHub-Telegram-Workflows (telegram-listings.yml und
   telegram-watchdog.yml) zuerst deaktivieren. Alte Apps-Script-Trigger werden
   beim Aktivierungsschritt abgeschaltet.
7. Nach verifizierter Abschaltung in Script Properties manuell
   WA2_LEGACY_GITHUB_DISABLED=true setzen.
8. wa2InstallTriggers() manuell ausführen. V2 wird jetzt aktiviert.
9. Mit einer konkreten neuen Suchmail die Ende-zu-Ende-Verarbeitung und
   Telegram-Zustellung überprüfen; keine Doppelmeldung, keine Datenverluste.
10. Nach mehrtägiger Beobachtung Altcode aus dem aktiven Projekt bereinigen.
    Für Rollback wa2RollbackToV1() ausführen, danach die GitHub-
    Telegram-Workflows separat wieder aktivieren.

**Wichtig:** Weder ein PR noch dessen Merge führt einen Apps-Script-Deploy aus.
Die bestehende deploy-apps-script.yml ist manuell. Die V2-Test-Workflow-Datei
enthält bewusst keine schedule- oder Deploy-Schritte.

## Bekannte Grenzen

- Ein Netzwerkabbruch unmittelbar nach Telegram-sendMessage lässt eine sichere
  Zustellungsentscheidung ohne Rückkanal nicht zu. Status unknown_delivery muss
  manuell geprüft werden, um Doppelversand zu vermeiden.
- Die Portale verändern E-Mail-Layouts und können Webseitenabrufe blockieren.
  Unklar zugeordnete Angaben werden als unbekannt behandelt.
- GitHub Actions und Gmail-Zeittrigger sind nicht sekundenexakt.
- Eine dauerhafte JSON-Datei ist einfacher als Sheets, bei sehr großer
  Datenmenge später gegebenenfalls auf einen geeigneteren Store migrieren.

## Erststart und Backlog-Monitoring

Die erste Gmail-Erfassung berücksichtigt bis zu 48 Stunden rückwirkend. Weil
pro Lauf höchstens acht Mails verarbeitet werden, kann der Erststart mehrere
Zeittrigger benötigen. Alte Suchmails allein sind deshalb kein Störungsnachweis.

Der Watchdog beobachtet die Fortschrittszeit der Warteschlange. Sobald eine
wartende Mail erfolgreich verarbeitet wurde, beginnt eine neue Beobachtungsfrist.
Nur wenn ältere Nachrichten weiterhin warten und für **über 60 Minuten**
keine solche Verarbeitung stattgefunden hat, wird `MAIL_BACKLOG` gemeldet.
Andere Fehler (`GMAIL_STALE`, `PROCESSING_FAILED` usw.) werden unabhängig
davon gemeldet. Die Statusdaten liegen in der privaten `state.json`.
