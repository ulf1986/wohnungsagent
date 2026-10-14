# Apps-Script-Automation für den Wohnungsagenten

Stand: 14. Oktober 2026  
Repository: `ulf1986/wohnungsagent`  
Apps-Script-Projekt: `Wohnungsagent – Immobilienbilder`

## Zweck

Apps Script führt die regelmäßige Automation aus: Gmail lesen, Anzeigenlinks und Bilder importieren, Anzeigeinformationen strukturieren, fehlende Angaben von der Portalseite ergänzen, Bilder durch ein Vision-Modell bewerten und die Ergebnisse in die Tabelle schreiben.

KI wird nur für unstrukturierten Inhalt und Bildverständnis verwendet. Download, Zuordnung, Validierung, Punkteberechnung, Duplikat- und Sperrlistenprüfung, Status und Wiederholungen bleiben nachvollziehbare Programmlogik.

## Ablauf je E-Mail und Anzeige

1. **E-Mail finden.** Der bestehende Gmail-Import liest das Label `Wohnungssuche/Suchaufträge`, begrenzt die Suche auf die letzten sieben Tage und dedupliziert über die Gmail-ID. E-Mails werden nur gelesen.
2. **Links und Bilder importieren.** Der Mailtext und die Inseratslinks werden in der Queue abgelegt. Die vorhandene Bilderkennung lädt bekannte Vorschaubilder und Galerie-Bilder in Drive. Die Dateien werden anhand von Anzeigen-ID, Portal-Link oder einem eindeutigen Dateinamen zugeordnet. Bei mehreren Inseraten wird ein Link pro Triggerlauf bearbeitet; unzugeordnete Mailbilder werden nicht willkürlich einem Inserat zugewiesen.
3. **Mailtext mit KI auswerten.** Ein Prompt erhält Betreff, Text und genau einen Inseratslink. Die Responses API muss ein strukturiertes JSON gemäß Schema liefern. Nur ausdrücklich belegte Werte werden übernommen; Unbekanntes bleibt `null`.
4. **Portalseite ergänzen.** Wenn wichtige Angaben noch fehlen, ruft Apps Script die verlinkte Seite über den passenden Portaladapter ab. Die Adapter liegen in `Fotocasa.js`, `Idealista.js`, `Yaencontre.js`, `Pisos.js` und `ImmoScout.js`. Titel, Metadaten, JSON-LD und sichtbarer Seitentext werden gekürzt an einen eigenen Extraktionsprompt übergeben. Die KI behandelt Seiteninhalt als Daten, nicht als Anweisungen. Bei Login-Schranke, Bot-Schutz oder HTTP-Fehler bleibt die Information offen und wird als solche ausgewiesen.
5. **Bilder durch KI bewerten.** Erst nach dem vorhandenen Download liest Apps Script die Drive-Dateien des betreffenden Inserats. Es sendet bis zu fünf Bilder pro Anfrage als Base64-Bildinput. Bewertet werden Helligkeit/Tageslicht, Raumgefühl, Möbelzustand und Pflege/Renovierung; die KI liefert außerdem kurze Beobachtungen zu Fenstern, Grün/Ausblick, Küche, Raumform und Unsicherheiten durch Weitwinkel oder künstliche Aufhellung. Abgeschlossene Datei-IDs werden gespeichert, damit Folge-Trigger nur noch nicht geprüfte Bilder senden.
6. **Felder und Punkte schreiben.** Das Programm validiert die KI-Antwort, ergänzt belegte Felder und berechnet Punkte selbst. Geschrieben wird anhand der Tabellen-Header, nicht über feste Spaltenpositionen. `Zusammenfassung` enthält nur die knappe Bildbewertung; `Merkmale` enthält belegte Ausstattungsmerkmale und Zimmer; `Lage zu 29001` enthält nur Himmelsrichtung und geschätzte Entfernung.
7. **Queue fortsetzen.** Der vorhandene fünfminütige Trigger verarbeitet pro Aufruf einen KI-Schritt bzw. Bildbatch und setzt später fort. Ein Script-Lock verhindert parallele Läufe. Fehler werden mit exponentieller Wartezeit wiederholt.

## Aufteilung der Skripte

| Datei | Aufgabe |
| --- | --- |
| `Main.js` | Konfiguration, Tabellenzugriff und vorhandene Anzeigen-/Bildlogik |
| `GmailImport.js` | Gmail-Suche, Mailqueue, Bildimport, Aufruf der KI-Verarbeitung im bestehenden Triggerlauf |
| `AIProcessing.js` | KI-Prompts, strukturierte JSON-Antworten, Portaltext, Bildbatches, Feldmapping, Punkte, Status und Retry |
| `Drive.js` | Bilder in Drive speichern und Dateireferenzen verwalten |
| `Fotocasa.js`, `Idealista.js`, `Yaencontre.js`, `Pisos.js`, `ImmoScout.js` | Portalspezifische Bildextraktion und sicherer Seitenabruf |
| `IdealistaGalerie.js` | Zusätzliche Idealista-Galeriebilder laden |
| `BildVerfuegbarkeit.js` | Vorhandene Bildquellen auf Verfügbarkeit prüfen |
| `Vorschaubilder.js` | Zellvorschaubilder und sichtbare KI-Statuswerte pflegen |
| `Trigger.js` | Fünf-Minuten-Zeittrigger einrichten |
| `tests/` | Deterministische Bewertungs- und Importtests ohne echte KI- oder Mailaufrufe |

Die Queue nutzt die bestehenden Spalten H:Q; die KI-Verarbeitung ergänzt R:Y. Darin stehen Verarbeitungsschritt, Fehler, Zeitpunkt, Anzeigen-ID, Retry, Versuche, abgeschlossene Anzeigen und aktuell aktive Anzeigen-ID.

## Bewertungsregeln

- Miete pro Quadratmeter: höchstens 10 €/m² ergibt 40 Punkte, ab 20 €/m² 0 Punkte, dazwischen linear.
- Entfernung von 29001: bis 1 km 25 Punkte, ab 8 km 0 Punkte, dazwischen linear.
- Bildbewertung: maximal 20 Punkte aus vier ganzzahligen Teilwerten von 0 bis 5.
- Terrasse: belegtes Ja = 10, belegtes Nein = 0. Pool: belegtes Ja = 5, belegtes Nein = 0. Unbekannt bleibt offen und verringert die Bewertungsabdeckung.
- Fläche selbst ist kein Filter und erhält keine eigenen Punkte.
- Miete unter 800 €, nur für Studierende, Saison-/Kurzzeitmiete oder ausdrücklich fehlende Langzeitmiete lösen den Ausschlussstatus aus. Fehlende Informationen werden nicht als Verstoß erfunden.
- `KI-Bewertung = Abgeschlossen` erst nach Analyse aller zugeordneten Bilddateien. Wenn keine Bilddatei verfügbar ist, kann das Inserat mit `Keine Fotos` markiert werden; die vorhandenen Fakten werden trotzdem ausgewertet. Unzugängliche Dateien erzeugen einen Fehlerstatus.

Die Punkte sind ganze Zahlen. Die KI liefert Fakten und Bildbeobachtungen, aber keine Punktwerte.

## OpenAI- und Apps-Script-Grenzen

Die OpenAI-Dokumentation erlaubt Bildinput als URL, Base64-Daten-URL oder File-ID und nennt als technisches Maximum 1.500 Bilder und 512 MB je Anfrage. Praktisch begrenzen wir den Request deutlich kleiner: höchstens fünf Bilder und 10 MB Rohbilddaten je Batch. Eine einzelne Bilddatei über 35 MB wird mit sichtbarem Fehler abgebrochen, damit die Base64-Anfrage unter dem 50-MB-POST-Limit von Apps Script bleibt. Apps Script darf höchstens sechs Minuten pro Ausführung laufen; der bestehende Trigger setzt die Queue anschließend fort.

Die Bilder werden als Base64 direkt an die Responses API gesendet, nicht zusätzlich über die Files API hochgeladen. Requests verwenden `store: false`. Der API-Schlüssel und das Modell liegen in Script Properties `OPENAI_API_KEY` und `OPENAI_MODEL`.

Für ein neues, sauberes Google Sheet kann die Tabellenstruktur kopiert und die veralteten Datenzeilen vor dem Start entfernt werden. Die Automation unterstützt dafür die Script Property `WOHNUNGSAGENT_SPREADSHEET_ID`; wenn sie fehlt, wird die bestehende Tabellen-ID verwendet. Die alte Tabelle bleibt unangetastet. Für den Start muss die neue Tabellen-ID als Script Property gesetzt werden.

## Validierung und Bereitstellung

Die Unit-Tests prüfen Miet- und Distanzpunkte, Ausschlussregeln, Bildantworten und die Trennung von Bildern bei mehreren Anzeigen. GitHub Actions prüft zusätzlich die JavaScript-Syntax aller Apps-Script-Dateien. Tests verwenden keine echten Gmail-Nachrichten, Drive-Dateien oder OpenAI-Aufrufe.

Ein Deploy ist davon getrennt und bleibt ein bewusster manueller Schritt über den vorhandenen GitHub-Workflow. Vor dem ersten Lauf im neuen Sheet müssen `OPENAI_API_KEY`, `OPENAI_MODEL` und `WOHNUNGSAGENT_SPREADSHEET_ID` in den Script Properties gesetzt sowie Gmail-, Drive- und Tabellenberechtigungen erteilt sein.

## Quellen

- OpenAI, [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- OpenAI, [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- Google, [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- Google, [Installable triggers](https://developers.google.com/apps-script/guides/triggers/installable)
