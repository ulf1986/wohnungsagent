# Direkter Telegram-Versand und KI-Queue

## Änderungen (16.11.2026)

- Der Apps-Script-KI-Worker priorisiert unverarbeitete Anzeigen. Nach vier neuen Verarbeitungsschritten erhält ein fälliger Retry einen fairen Slot. Noch nicht fällige Retries werden nicht vorzeitig ausgeführt. `needs_review` wird weiterhin nicht blind wiederholt.
- Nach dem dauerhaften Abschluss einer KI-Prüfung kann der Worker das passende Inserat direkt an Telegram übermitteln. Technische Versandfehler werden abgefangen und verändern weder den KI-Status noch die bereits berechnete Bewertung.
- Der Direktversand markiert erfolgreiche Zustellungen im Blatt `Anzeigen`, Spalte `Telegram Versand UTC`. Der bisherige GitHub-Versand respektiert diese Markierung. Der GitHub-Versand und die Benachrichtigungen über fachliche Ausschlüsse bleiben als Rückfallweg aktiv.
- Das neue Blatt `E2E-Laufzeiten` protokolliert je erfolgreichem Direktversand Inserats-ID, ursprünglichen Maileingang, Versandzeit, Ende-zu-Ende-Minuten und Ergebnisstatus. Beim bisherigen GitHub-Versand ist dieser neue Messwert noch nicht verfügbar.

## Einmalige Aktivierung des Direktversands

**Wichtig:** Der Deploy des Apps-Script-Quellcodes überträgt keine GitHub Secrets in Google Script Properties. Der direkte Versand ist daher absichtlich standardmäßig deaktiviert. Erst nach sicherer Einrichtung wird er aktiv.

1. Apps Script-Projekt des Wohnungsagenten öffnen, Projekteinstellungen > Skripteigenschaften.
2. `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHAT_ID` mit den Werten des bestehenden GitHub-Telegram-Bots anlegen. Secrets niemals in Repository-Dateien, Logs oder Arbeitsblätter kopieren.
3. Einmal die Apps-Script-Funktion `activateDirectTelegram` ausführen und nötige Berechtigungen bestätigen.
4. Bei der nächsten neu abgeschlossenen, zulässigen KI-Auswertung erscheint die Nachricht direkt. Bereits abgeschlossene Anzeigen werden dadurch nicht erneut massenhaft versandt.
5. In `Anzeigen` die Spalte `Telegram Versand UTC` und im neuen Blatt `E2E-Laufzeiten` die Minuten prüfen.

Der GitHub-Workflow `telegram-listings.yml` bleibt bewusst weiter aktiv. Den alten Workflow erst nach mehreren erfolgreich verifizierten Direktzustellungen reduzieren oder entfernen. Er meldet weiterhin ungeklärte KI-Endfehler manuell. Die separate Ablehnungsroutine sendet weiterhin fachlich ausgeschlossene Wohnungen.

## Verhalten bei Problemen

- Keine Zugangsdaten / nicht aktiviert: Direktversand wird übersprungen und der bisherige Sender arbeitet unverändert weiter.
- Telegram-Fehler: Keine Versandbestätigung; der GitHub-Fallback kann die Anzeige später senden. Eine bereits zugestellte, aber vor dem Speichern der Bestätigung abgebrochene Verbindung kann bei Wiederholung theoretisch zu einer Dublette führen. Telegram bietet kein deduplizierendes SendMessage-Token.
- Fehlende Fakten: Abgeschlossene, nicht eindeutig ausgeschlossene Inserate erhalten einen Hinweis zur manuellen Prüfung. Gesichert ungeeignete Größen und Mieten werden nicht versandt.
- Bezahlte KI-Anfragen mit `needs_review` bleiben gesperrt, bis sie manuell geklärt sind.

## Prüfung

`node --test tests/direct-telegram.test.cjs tests/ai-worker.test.cjs`

Die tatsächliche Latenz von Gmail bis zu Telegram soll im Blatt `E2E-Laufzeiten` überwacht werden. Median und 95. Perzentil können auf Basis dieser Rohdaten später im Monitoring aggregiert werden.
