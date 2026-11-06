# Monitoring des Wohnungsagenten

## Sichtbare Tabellen

- **Läufe**: Eine Zeile je abgeschlossenem `runGmailImagePipeline`-Aufruf, mit Start, Ende, Status, E-Mail-Zählern, letzter KI-Entscheidung, Fehlerhinweisen und der letzten Queue-Aktivität.
- **Entscheidungen**: Ereignisse je erkannter Immobilien-ID (Gmail-Import) und je bearbeiteter Immobilien-ID (KI-Schritt). `ready_for_ai` bezeichnet eine Übergabe, nicht eine erfolgreich übernommene Anzeige. Nur der KI-/Anzeigenstatus ist für eine vollständige Entscheidung maßgeblich.
- **Verarbeitung**: Technische Queue (H:AC), unverändert maßgeblich. Spalten A:G sind Legacy.
- **Logs** in Drive: Detaildiagnostik der einzelnen Schritte bleibt bestehen.

## Statuslogik

- `ok`: Lauf abgeschlossen ohne registrierte Pipeline-Probleme.
- `warning`: Ein Import benötigt Wiederholung oder ein isolierter KI-/Gmail-Schritt meldet einen Fehler.
- `failed`: Unbehandelter Fehler hat den Pipeline-Lauf beendet.

Ein Lauf mit null neu gefundenen E-Mails ist nicht automatisch fehlgeschlagen. Die Anwesenheit neuer Nachrichten in Gmail wird erst durch den geplanten **externen GitHub-Monitor** unabhängig gegen das Sheet geprüft.

## Diagnose

`checkWohnungsagentHealth()` in Apps Script manuell ausführen: Gibt Zeit seit letztem abgeschlossenen Lauf und zuletzt erfasste Queue-Aktivität zurück. Ab über 20 Minuten wird der Zustand `failed` gemeldet.

Monitoring ist **fail-open**: Fehler beim Schreiben der Tabellen werden in der Konsole protokolliert und unterbrechen die Wohnungssuche nicht.

## Deployment

GitHub Actions → **Apps Script – manueller Deploy** → Run workflow → Eingabe `DEPLOY`. Erst ein erfolgreicher `clasp push` aktiviert neue Monitoring-Funktionen. Beim nächsten Pipeline-Lauf entstehen die neuen Zeilen und bei Bedarf das Blatt **Entscheidungen**.

## Telegram-Watchdog (GitHub Actions)

Workflow: `.github/workflows/telegram-watchdog.yml`.

Der Watchdog läuft unabhängig von Gmail und Apps Script alle 15 Minuten. Er prüft das private Blatt `Läufe` über die Google Sheets API: letzter erfolgreicher Abschluss maximal 25 Minuten alt, keine Warnung und keine wiederholte Nullverarbeitung trotz erkannter E-Mails.

Ein offenes GitHub Issue `[Wohnungsagent] Monitoring-Störung` verhindert wiederholte Telegram-Alarme. Bei Erholung sendet der Workflow eine Entwarnung und schließt das Issue.

### Einrichtung und Test

1. GitHub Repository Secrets `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHAT_ID` hinterlegen.
2. Unter **Actions → Wohnungsagent – Telegram Watchdog → Run workflow** den Modus `test` starten. Das sendet eine Testnachricht ohne Google-Zugriff.
3. Google Cloud: Ein separates Dienstkonto anlegen, die **Google Sheets API** aktivieren und einen JSON-Schlüssel für das Dienstkonto erstellen.
4. Den JSON-Schlüssel als GitHub Repository Secret `GOOGLE_SERVICE_ACCOUNT_JSON` speichern. Niemals in GitHub-Dateien committen.
5. Das Spreadsheet `Wohnungsagent – Aktuelle Immobilien` für die E-Mail-Adresse dieses Dienstkontos als **Leser** freigeben.
6. **Run workflow** im Modus `check` ausführen und das Ergebnis prüfen.

Die bestehenden `CLASPRC_JSON`-Anmeldedaten sind für die Bereitstellung von Apps Script autorisiert, aber nicht garantiert für den Zugriff auf private Google-Sheets-Zellwerte.

**Einschränkung:** Der externe Watchdog prüft die Lauf- und Queue-Signale aus der Tabelle, aber vergleicht derzeit nicht jeden Gmail-Eingang mit der Queue. Für einen vollständigen unabhängigen Abgleich würde der GitHub-Runner zusätzlich Gmail-Leseberechtigungen brauchen.
