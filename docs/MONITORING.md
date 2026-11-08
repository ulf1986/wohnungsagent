# Monitoring des Wohnungsagenten

## End-to-End-Watchdog

Workflow: .github/workflows/telegram-watchdog.yml, alle 15 Minuten, read-only für Gmail und Google Sheets. Die Python-Regeln sind in scripts/watchdog_checks.py, die Übertragung und GitHub-Issue-Zustände in scripts/telegram_watchdog.py. Jeder Fehler hat eine stabile Kennung aus Fehlercode und Gmail-/Inserats-ID. Offene Fehler werden unabhängig voneinander gespeichert. Fortbestehende Störungen werden frühestens nach vier Stunden in einer nach Fehlercode gebündelten Telegram-Nachricht erneut gemeldet. Neue kritische Störungen werden beim nächsten 15-Minuten-Prüflauf sofort gemeldet; bei vollständiger Erholung folgt eine Sammel-Entwarnung.

| Stufe | Datenquelle | Alarm |
|---|---|---|
| Gmail-Erkennung | Gmail API, inklusive Papierkorb | Suchmail nach 20 Min. ohne Queue-Eintrag oder protokollierte Entscheidung |
| Gmail-Import | Verarbeitung H:Q | retry/processing länger als 45–90 Min., keine Links in freigegebener Queue |
| KI-Queue | Verarbeitung R:AC | needs_review sofort; 429 ab zwei Versuchen oder 60 Min.; überfälliger Retry; nach drei Fehlversuchen failed_final; nach 48 Stunden expired |
| KI-Ergebnis | Anzeigen, Bildanalyse JSON | laufende KI-Operation ohne gespeichertes Ergebnis; tatsächlicher Bearbeitungsstillstand über 180 Min.; keine Bild-Störmeldung für bewusst abgeschlossene no_images-Ergebnisse |
| Vollständigkeit | Anzeigen, Entscheidungen | vermeintlich geeignete Anzeige ohne Mietpreis/Fläche; Sammelmail nicht vollständig abgeschlossen; Duplikat ohne Haupteintrag |
| Telegram-Angebote | Anzeigen + GitHub-Versandhistorie | geeignete, abgeschlossene Anzeige nach 15 Min. nicht versendet |
| GitHub Actions | Actions-API | Angebotsworkflow fehlgeschlagen oder länger als 35 Min. nicht abgeschlossen |
| Hauptpipeline | Läufe | kein aktueller Abschluss, letzter Lauf mit Warnung/Fehler, wiederholter Importstillstand |

Ein regulärer Ausschluss (Sperrliste, Dublette, nicht mehr verfügbar, fachlich ausgeschlossen) ist kein Incident. Der Watchdog sieht einzelne Mail- und Inserats-IDs, nicht nur die gesamte Pipeline. Er überwacht offene Datensätze ab dem Monitoring-Aktivierungsdatum 6. November 2026. KI-Aufträge außerhalb der 48-Stunden-Frist erhalten den dauerhaften Status expired. Ungeklärte kostenpflichtige KI-Operationen mit needs_review bleiben als Ausnahme für eine manuelle Prüfung erhalten. Die Gmail-Suche erfasst die vergangenen sechs Stunden einschließlich Trash. Ein einmal gemeldeter fehlender Gmail-Import bleibt auch nach diesem Suchfenster offen, bis die Gmail-ID in der Queue oder in Entscheidungen nachgewiesen ist. Mehr als 300 Suchkandidaten führen zu einer Fehlermeldung, statt den Abgleich stillschweigend als vollständig zu behandeln.

### Status- und Wiederholungsregeln

- `retry`: Automatischer KI-Wiederholungsversuch mit exponentieller Wartezeit, zunächst 30, dann 60 Minuten.
- `failed_final`: Dritter eindeutiger Fehler. Der Auftrag wird nicht nochmals automatisch verarbeitet. Ein Warnhinweis zum endgültigen Fehler kann höchstens 24 Stunden lang im Monitoring erscheinen.
- `expired`: E-Mail älter als 48 Stunden, während KI-Arbeit noch offen war. Der Auftrag bleibt zu Diagnosezwecken im Blatt Verarbeitung und wird nicht erneut verarbeitet.
- `needs_review`: KI-API-Antwort möglicherweise bereits kostenpflichtig berechnet, Ergebnis nicht eindeutig gespeichert. Kein automatischer Retry; manueller Abgleich nötig.
- `completed`, `no_images`, `blocked`, `duplicate`: Für die jeweilige Verarbeitungsstufe abgeschlossene oder bewusst ausgeschlossene Ergebnisse; kein allgemeiner Queue-Stau.
- Der Telegram-Watchdog läuft alle 15 Minuten, erinnert bei fortbestehenden Störungen frühestens alle vier Stunden und fasst gleiche Fehlertypen zusammen.

### Wichtige Sicherheitsregeln

- Ein GitHub-Issue mit Titel [Wohnungsagent] Monitoring-Störung speichert ein JSON-Objekt pro Fehler, inklusive first_seen und notified_at. Die Telegram-Nachricht wird **vor** dem Speichern einer Versandbestätigung gesendet. Schlägt Telegram fehl, bleibt der Fehler unbestätigt und der nächste Lauf versucht es erneut. Ein fehlgeschlagener Versand beendet den GitHub-Job mit Fehlerstatus.
- Für unbekannte, möglicherweise bereits abgeschlossene OpenAI-Operationen bleibt die bestehende Sperre needs_review erhalten. Keine blinde Wiederholung kostenpflichtiger API-Anfragen.
- AIProcessing.js zählt automatische KI-Retries pro Queue-Eintrag. Maximal drei Fehlversuche, danach failed_final mit Fehlergrund ohne weitere automatische API-Aufrufe. Überfällige aktive Aufträge werden vor der nächsten Auswahl in begrenzten Chargen (maximal acht pro Lauf) als expired gespeichert. Abgeschlossene, blockierte und needs_review-Aufträge sind davon ausgenommen. Der Watchdog bewertet diese Statuswerte als terminal bzw. explizit manuell zu prüfen.
- Apps Script verschiebt E-Mails schon bei ready_for_ai in den Papierkorb. Das ist weiterhin der vorhandene Produktivpfad. Der externe Gmail-Abgleich umfasst darum ausdrücklich in:anywhere. Eine spätere Änderung der Löschstrategie muss mit der 48-Stunden-Bereinigung abgestimmt werden.
- Der Gmail-Abgleich ist unabhängig von Apps Script, aber er erfordert ein separates Nutzer-OAuth-Token. **Ein Google-Dienstkonto mit Sheets-Lesezugriff gewährt keinen Zugriff auf private Gmail-Nachrichten.**

### Einmalige Einrichtung der unabhängigen Gmail-Prüfung

Erforderliche GitHub-Secrets für den Watchdog: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GOOGLE_SERVICE_ACCOUNT_JSON sowie zusätzlich GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET und GMAIL_REFRESH_TOKEN. Letztere müssen aus einer Google-OAuth-Autorisierung des relevanten Gmail-Kontos mit dem Scope https://www.googleapis.com/auth/gmail.readonly stammen. Diese Secrets nie in Code, Logs oder Issues schreiben. Der Refresh-Token muss Offlinezugriff unterstützen und darf nicht widerrufen sein.

Solange eines der Gmail-Secrets fehlt, führt der Bot die Sheet- und GitHub-Überwachung weiter aus, meldet jedoch GMAIL_MONITOR_NOT_CONFIGURED. Ein abgelaufenes oder ungültiges Token erzeugt GMAIL_MONITOR_ERROR. Der Zugang wird ausschließlich zum Lesen benutzt, einschließlich bereits in den Papierkorb verschobener Suchmails.

### Testen und Freigeben

1. Auf dem Feature-Branch Python 3.12 verwenden: python -m py_compile scripts/telegram_watchdog.py scripts/watchdog_checks.py scripts/telegram_listings.py
2. Regressionstests ausführen: python -m unittest discover -s tests -p 'test_watchdog*.py' -v
3. Pull Request prüfen. Die Push-/PR-CI muss grün sein, bevor der Branch gemergt wird.
4. Nach Merge den Workflow Wohnungsagent – Telegram Watchdog manuell mit mode=test starten. Die Telegram-Testnachricht muss erscheinen.
5. Danach mode=check starten und GitHub-Log, Issue-Status und echte Telegram-Alarme prüfen. Fehlende Gmail-Secrets führen erwartungsgemäß zu einem Abdeckungsalarm.
6. Bei Bedarf kontrolliert eine Testmail mit bekanntem Gmail-Label den vollständigen Importabgleich. Ein produktiver Test darf keine echte Wohnungsanzeige dauerhaft blockieren.

**Kein Apps-Script-Deploy erforderlich**, da in diesem Änderungspaket nur Python, GitHub-Workflows, Tests und Dokumentation angepasst sind. Der Code wird erst mit dem Merge in main durch die regulären GitHub-Actions-Zeitpläne produktiv. Der Branch bzw. ein PR allein verändert die produktiven Zeitpläne nicht.

## Bestehende Tabellen

- Läufe: Abschlusszeiten, Laufstatus, Zähler und Fehlerhinweise.
- Entscheidungen: protokollierte Zuordnung von E-Mail zu Anzeigen-ID sowie terminale Entscheidungen.
- Verarbeitung: Gmail-Queue in H:Q, KI-Queue in R:AC.
- Anzeigen: Inserats-ID, Preis, Fläche, finale fachliche Bewertung und Bildanalyse JSON.
- Drive-Logs: Detaildiagnostik und zeitliche Schrittfolge.

## Telegram-Angebotsversand

Workflow: .github/workflows/telegram-listings.yml, alle zehn Minuten. Geeignete Anzeigen mit Status Geeignet, KI-Bewertung Abgeschlossen, mindestens 60 m² und 800–1200 Euro Kaltmiete gehen mit Foto-Fallback an Telegram. Die Versandhistorie ist im GitHub-Issue [Wohnungsagent] Telegram-Anzeigen Versandstatus hinterlegt. Der Watchdog gleicht dieses Issue unabhängig mit den vollständig bewerteten Anzeigen ab.

