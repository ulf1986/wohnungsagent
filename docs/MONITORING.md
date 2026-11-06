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

## Noch nicht umgesetzt

Externer Watchdog via GitHub Actions, Gmail-gegen-Sheets-Abgleich und Telegram-Push. Diese Bausteine folgen im zweiten Umsetzungsschritt; ein interner Lauf kann einen ausgefallenen eigenen Trigger nicht melden.
