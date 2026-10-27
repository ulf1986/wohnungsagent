# KI-Verarbeitung in der bestehenden Pipeline

Stand: Integration nach ce822d5, basierend auf AIProcessing.js aus PR #1,
Head b26a2af878d73b0b7a1446603521b41097cfa604. Gezielte Übernahme statt
vollständigem Merge des älteren Branches: aktuelle Anbieter-Parser, Idealista-Fix,
Ziel-Sheet, Clasp-Projekt, Drive-Ordner und Schema-3-Logging bleiben erhalten.
PR #1 wird durch diesen Commit nicht als Ganzes gemergt oder geschlossen.
Die frühere Bestandsaufnahme ZIELSHEET_NEUIMPORT_PRUEFUNG.md beschreibt den
historischen Ausgangszustand vor dieser Integration.

## Verhalten nach dem manuellen Deployment

runGmailImagePipeline ruft nun eine KI-Stufe für eine ready_for_ai-Mail auf,
sofern seit Laufbeginn weniger als drei Minuten verstrichen sind. Bei langen
Bilddownloads bleibt die KI-Arbeit für einen späteren Lauf liegen. Es werden
keine zusätzlichen Trigger eingerichtet. Der gestoppte Trigger bleibt gestoppt.

Für einen kontrollierten Start gibt es runAiProcessing: Diese Funktion verarbeitet
nur eine KI-Stufe der schon vorhandenen Bildqueue, aktualisiert danach Vorschauen
und sortiert Anzeigen. Sie scannt keine neuen Mails und lädt keine neuen Portalbilder.
Sie verwendet dieselbe processNextAiListing-Funktion und denselben Script-Lock,
also keinen zweiten Importweg. Aufruf später ausdrücklich manuell; in diesem
Integrationsauftrag wurde keine Apps-Script-Funktion ausgeführt.

1. Eine stabile Anzeigenzeile unter Anzeigen anlegen, die Inseratsseite abrufen und
   E-Mail plus bereinigten Seitentext in einem gemeinsamen Standard-API-Aufruf
   auswerten. Eine gelöschte oder blockierte Seite verhindert die Mailauswertung
   nicht; fehlende Angaben bleiben offen. Status nach Erfolg: text_extracted.
   Begonnene Bestandsjobs mit gespeicherten E-Mail-Fakten setzen ihren bisherigen
   Seitenergänzungsschritt fort, ohne die E-Mail nochmals auszuwerten.
2. Pro weiterem Aufruf höchstens fünf gespeicherte Fotos bewerten. Insgesamt die
   ersten maximal zehn geeigneten Originalbilder je Inserat, dauerhaft ausgewählt.
   Ergebnisse und bearbeitete Datei-IDs werden gespeichert. Abschluss nach dieser
   Auswahl; weitere Drive-Bilder bleiben erhalten. Details: API_NUTZUNG.md.

Bereits nach der ersten erfolgreichen Faktenstufe ist die Anzeigenzeile sichtbar.
Ein einzelner Aufruf liefert noch nicht zwingend eine fertige Bewertung.
Wenn eine API-Anfrage nach Anlage der Zeile fehlschlägt, bleibt sie vorläufig und
der Job geht mit Fehlermeldung und Wartezeit in retry; sie ist kein Erfolgsnachweis.

## Voraussetzungen

Script Properties: OPENAI_API_KEY und OPENAI_MODEL müssen vorhanden sein.
Das konfigurierte Modell muss Bildinput und Structured Outputs über die Responses
API unterstützen. Keine Schlüssel im Code, GitHub oder Chat hinterlegen.
API-Zugang, Modellberechtigung und Kontingent sind noch nicht live bestätigt.
Die Integration verändert keine vorhandenen Script Properties.

CONFIG.spreadsheetId bleibt die zentrale Zielkonfiguration. Eine vorhandene
WOHNUNGSAGENT_SPREADSHEET_ID darf nur denselben Wert enthalten; andernfalls
bricht die KI-Verarbeitung mit einer verständlichen Meldung ab, statt ein zweites
Sheet zu verwenden. Erwartetes Ziel: 1_X-jdVIKwbqDABIssOOCjLC41qRqpb01paV1RtruMwg.
Bild- und Logordner werden weiterhin über ihre bisherigen Properties geladen.

Verarbeitung erhält KI-Statusspalten R:Y. Bereits anderweitig belegte Überschriften
werden nicht überschrieben; der Lauf meldet den Konflikt. A:G und H:Q bleiben
in ihrer vorhandenen Bedeutung erhalten. Anzeigen behält die bestehenden 40 Spalten;
vorformatierte leere Checkboxzeilen werden zuerst genutzt. Es werden keine
Bestandsdaten geleert, kopiert oder historisch zurückgesetzt.

## Korrekturen bei der Übernahme

- Fehlende Miete, Zimmerzahl oder Distanz werden nicht zu null/0 umgedeutet.
- Abschluss ohne Fotos verursacht keinen Zugriff auf ein fehlendes Bewertungsobjekt.
- Portalangaben ergänzen fehlende Mailfakten und überschreiben sie nicht.
- Mehrfachangebote bleiben zurückgestellt; mehrere Linkvarianten derselben ID
  gelten als ein Inserat. Fremd zugeordnete Fotos werden auch dann ausgeschlossen.
- Vor Anlage wird nach stabiler ID und ID aus dem Inseratslink gesucht. Widersprüche
  oder doppelte Bestandszeilen führen zu einem Fehler statt einem weiteren Eintrag.
- Erfolgshistorie einer erneut eingegangenen Mail führt nicht zu einer zweiten Zeile
  oder einer unnötigen Wiederholung bereits gespeicherter Faktenauswertung.
- Sperrliste verwendet dieselbe vorhandene Prüfung wie der Bildimport. Ein fehlendes
  Sperrlistenblatt wird nicht als leere Sperrliste behandelt.
- ai_queue, ai_result und ai_error landen mit Anbieterzuordnung in derselben Laufdatei.
  Die globalen nachfolgenden Stufen erhalten keinen veralteten Mail-Kontext.

Die bestehenden Bewertungsregeln aus PR #1 bleiben erhalten: Miete/m² bis 40,
Distanz bis 25, Bildkriterien bis 20, Terrasse bis 10 und Pool bis 5 Punkte;
unbekannte Angaben reduzieren die Abdeckung. Dies ist eine Auswertung der eigenen
Suchkriterien. Kein portalübergreifender semantischer/visueller Dublettennachweis;
gleiche Wohnungen mit verschiedenen Portal-IDs benötigen weiterhin einen Abgleich.

## Sofortige Benachrichtigung bei neuen Anzeigen

Neue Anzeigen lösen direkt nach dem Speichern ihrer Tabellenzeile eine E-Mail
an **ulf-marxen@gmx.de** aus. Der Versand erfolgt vor dem ersten KI-Aufruf und
wartet weder auf die Text- noch auf die Bildauswertung. Die Mail enthält den
ursprünglichen E-Mail-Betreff, Portal, Eingangszeit, Inseratslink und Datensatz-ID
sowie den Hinweis **„Auswertung folgt“**. Unbekannte Bewertungen werden nicht als
fertige Ergebnisse ausgegeben. Eine fehlende OpenAI-Konfiguration verhindert
diese Benachrichtigung nicht; die anschließende Auswertung meldet ihren Fehler.

Die bereits vorhandenen Sperrlisten-, Dubletten- und technischen
Verfügbarkeitsprüfungen vor der Aufnahme bleiben erhalten. Eine erst später
erkannte Nichteignung kann daher nach der Sofortbenachrichtigung festgestellt
werden. Die Mail weist ausdrücklich auf die noch ausstehende Prüfung hin.

Das Ende der KI-Auswertung verschickt keine zweite Mail. Vor dem Senden wird
`notification_state=attempted` gespeichert; danach `sent` oder `failed`.
Wiederholungen und andere Mails zur gleichen bestehenden Anzeige führen damit
nicht erneut zum Versand. Bestandszeilen werden nicht nachträglich gemeldet.
Versandfehler stoppen die KI-Pipeline nicht. Die vorhandene manuelle Funktion
`authorizeAndRetryWohnungsagentNotifications()` kann Berechtigungsfehler gezielt
nachholen; sie sendet bei jedem manuellen Aufruf zunächst eine Testmail.

Der Versand beginnt beim Anlegen der Zeile im bestehenden Importablauf, nicht
bereits beim Gmail-Eingang. Wartezeiten durch Triggerintervall, Queue und
vorgelagerte Prüfungen bleiben möglich. Es wird kein zusätzlicher Trigger
angelegt. Die Änderung muss manuell deployt werden.

## Prüfung und nächster Schritt

Lokale Tests prüfen die vollständige Folge bis zur Anzeigenzeile und Bildbewertung
mit simulierten Google-/OpenAI-Diensten, Offline-Portalseite, wiederholtem Aufruf,
fehlenden Fotos, Sperrliste, API-429, fehlendem Schlüssel, falscher Ziel-ID und
Ergänzung der Portalangaben. Bestehende Downloader-/Loggingtests bleiben aktiv.
Der GitHub-Testworkflow führt automatisch alle tests/*.test.cjs aus.

Der Nutzer deployed manuell. Anschließend zunächst runAiProcessing ausführen und
Log sowie eine Anzeigenzeile prüfen, dann die nötigen Folgestufen einzeln fortsetzen.
Das sendet Mailtext bzw. zugeordnete Fotos an die konfigurierte OpenAI-API und
verbraucht deren Kontingent. Es startet keinen historischen Neuimport. Automatik
erst nach gesonderter Entscheidung wieder einschalten.

Die allgemeine Pipeline enthält weiterhin ihre bestehende Verfügbarkeitsprüfung,
die bei wiederholt bestätigten toten Originalbildern sperren und Zeilen entfernen
kann. runAiProcessing ruft diese Prüfung nicht auf. Das Verhalten wurde hier nicht
umgestaltet. Insbesondere wird kein massenhafter Neuimport oder Löschen ausgelöst.

API-Referenz: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).
Anfragen nutzen text.format mit JSON Schema, echte Bilddaten und store:false;
unvollständige Antworten werden nicht als erfolgreiche Bewertung behandelt.

