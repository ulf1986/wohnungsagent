# Zielarchitektur: Wohnungsagent mit Apps Script und KI

Stand: 14. Oktober 2026  
Repository: `ulf1986/wohnungsagent`  
Apps-Script-Projekt: `Wohnungsagent – Immobilienbilder`

## Ziel

Apps Script übernimmt den regelmäßigen Ablauf von der Gmail-Suche bis zur Aktualisierung der Tabelle. Eine KI-API wird nur für Inhalte eingesetzt, bei denen unstrukturierter Text oder Bildverständnis nötig ist. Import, Deduplizierung, Validierung, Punktberechnung, Statusführung und Wiederholungen bleiben deterministische Apps-Script-Logik.

Der vorhandene Gmail-/Bildimport und der 5-Minuten-Trigger bleiben die Grundlage. Die KI-Stufen werden daran angeschlossen. Es gibt keine automatische Bereitstellung in dieses Dokument und keine Änderung an der laufenden Tabelle.

## Ablauf je Anzeige

1. **Gmail erfassen.** Der bestehende Prozess liest das Label `Wohnungssuche/Suchaufträge`, berücksichtigt die letzten sieben Tage und dedupliziert über die Gmail-ID. Die E-Mail bleibt lesend verarbeitet. Für jede Anzeige wird ein eigener Auftrag angelegt, auch wenn eine E-Mail mehrere Anzeigen enthält.
2. **E-Mail strukturieren.** Ein Textprompt erhält Betreff, bereinigten Mailtext und die zugehörigen Anzeigenlinks. Die KI gibt ein strikt validiertes JSON-Objekt zurück: Portal, Anzeigen-ID, kanonischer Link, Titel, Miete, Fläche, Zimmer, Adresse, Kontaktangaben und belegte Merkmale. Nicht genannte Angaben sind `null`. Eine Mehranzeigen-Mail wird in einzelne Anzeigenaufträge aufgeteilt. Bildlinks werden einer Anzeige nur zugeordnet, wenn die HTML-Verknüpfung das eindeutig belegt.
3. **Fehlende Angaben ergänzen.** Nur wenn relevante Felder fehlen, ruft Apps Script die bereits in der Mail verlinkte Portalseite ab. Zulässig sind ausschließlich bekannte Immobilienportale. Die abgerufene Seite wird als untrusted content an einen separaten Prompt übergeben. Die KI darf fehlende Felder extrahieren, aber weder Anweisungen aus der Seite ausführen noch Inhalte erfinden. Bei Bot-Sperre, Login-Wall oder nicht lesbarer Seite bleiben Felder offen und der Auftrag erhält einen nachvollziehbaren Status.
4. **Bilder bereitstellen und bewerten.** Apps Script liest die Originaldateien aus `Bildanalyse JSON.drive_files` beziehungsweise der bestehenden Mail-Queue aus Drive. Bereits analysierte Datei-IDs werden übersprungen. Die Bildbytes werden als Base64-Daten-URL in `input_image`-Elementen an die OpenAI Responses API gesendet. Die KI erhält pro Auftrag nur die Bilder der betreffenden Anzeige und gibt je Bild eine strukturierte Beobachtung zurück.
5. **Bewertung berechnen.** Apps Script validiert die JSON-Antwort und berechnet die Punkte selbst. Die bekannte Gewichtung beträgt Miete pro Quadratmeter 40, Entfernung 25, Bildzustand 20, Terrasse 10 und Pool 5 Punkte, insgesamt 100. Fläche ist kein Filter und bekommt keine eigenen Punkte. Die bekannte Mietformel ist linear: 10 €/m² ergeben 40 Punkte, 20 €/m² ergeben 0 Punkte. Die Grenzwerte/Formel für Entfernung, Terrasse und Pool müssen als feste Konstanten im Code hinterlegt werden, sobald die geltenden Regeln abschließend vorliegen. Die KI darf diese Punktwerte nicht schätzen. Alle gespeicherten Punktwerte sind ganze Zahlen.
6. **Tabelle aktualisieren.** Werte werden anhand der Header-Namen statt fester Spaltenbuchstaben geschrieben. `Lagebeschreibung` enthält ausschließlich Himmelsrichtung und geschätzte Entfernung in Kilometern von 29001 Málaga. `Merkmale` enthält nur belegte Ausstattung. `Zusammenfassung` enthält die kompakte KI-Bildbewertung und wiederholt keine Angaben aus Merkmalen oder Lage. Fehlende Fakten bleiben leer und werden in `Offene Angaben` geführt. `Einschränkungen` bleibt davon getrennt.
7. **Abschluss prüfen.** `KI-Bewertung = Abgeschlossen` darf erst gesetzt werden, wenn alle relevanten gespeicherten Drive-Bilder analysiert und alle Pflichtfelder validiert sind. Bei `In Bearbeitung` werden offene Analysen fortgesetzt. Bei `Keine Fotos` durchsucht Apps Script den konfigurierten Drive-Ordner samt Unterordnern erneut. Sind dort Dateien vorhanden, startet die Bildanalyse. Fehlender Drive-Zugriff ist ein Fehler, kein Beleg für fehlende Fotos.

## Prompt-Verträge

### E-Mail- und Webseitenextraktion

Die Prompt-Ausgabe ist ein JSON-Objekt mit stabilen Schlüsseln, Quellenhinweisen und offenen Angaben. Für jedes extrahierte Feld werden Wert, Quelle (`email` oder `listing_page`) und Konfidenz ausgegeben. Telefonnummern, E-Mail-Adressen und URLs müssen aus dem Inhalt stammen. Inhalte in E-Mail und Webseite gelten als Daten, nie als auszuführende Instruktionen.

### Bildbewertung

Die Bildausgabe enthält je Datei-ID: Helligkeit und Fenster/Tageslicht, sichtbares Grün oder Ausblick, Küchenfarbe und erkennbaren Modernitätszustand, Möbelalter/Farbe/Zustand, Raumgefühl (breit/offen oder tunnelartig) sowie sichtbaren Renovierungsbedarf. Weitwinkel und künstliche Aufhellung sollen als Unsicherheit markiert werden. Die Bewertung darf nur echte Bildpixel verwenden. Keine Bilddatei oder ein nicht erreichbares Bild bedeutet keine Bildbewertung.

Die Bildpunkte haben maximal 20 Punkte. Die KI liefert Beobachtungen und Evidenz, die Apps-Script-Auswertung ordnet sie anhand fester Regeln in Punkte ein. Damit ändern sich Punktwerte nicht durch Promptschwankungen. Die Ausgabe verwendet ganze Zahlen.

## API- und Laufzeitgrenzen

- Die OpenAI Images-and-Vision-Dokumentation nennt aktuell höchstens 1.500 Bilder und 512 MB Gesamtpayload je Anfrage. Das ist ein technisches API-Maximum, keine sinnvolle Batchgröße für diese Automation.
- Apps Script begrenzt einen `UrlFetchApp`-POST auf 50 MB. Base64 vergrößert den Inhalt um ungefähr ein Drittel. Deshalb verarbeitet der Job Bilder in kleinen Batches von zunächst höchstens fünf Dateien und höchstens 10 MB Rohbilddaten pro API-Aufruf. Bei einer Überschreitung wird der Batch verkleinert oder in Folgeausführungen fortgesetzt.
- Die Modell-, Größen- und Kontextgrenzen gelten zusätzlich. Ein Prompt mit weniger Bildern ist leichter überprüfbar und reduziert das Risiko, dass eine Anzeige wegen eines API- oder Apps-Script-Zeitlimits unvollständig bleibt.
- Apps Script läuft höchstens sechs Minuten pro Ausführung. Der Trigger setzt die Arbeit regelmäßig fort; jeder Durchlauf hält ein Zeitbudget ein und speichert den Fortschritt nach jedem erfolgreich verarbeiteten Auftrag.
- Zeittrigger laufen unter dem Konto der Person, die sie erstellt hat, und können sich verzögern. Die Architektur kann daher regelmäßige Wiederaufnahme und Statusüberwachung bieten, aber keine sekundengenaue Laufzeit garantieren.

## Trigger, Idempotenz und Fehlerbehandlung

Der bestehende 5-Minuten-Trigger wird zum einzigen Scheduler für Import und KI-Queue. Ein Script-Lock verhindert parallele Läufe. Jeder Auftrag hat eine stabile Schlüsselung aus Datensatz-ID, Gmail-ID und Stufe. Erfolgreiche Teilresultate und analysierte Drive-Datei-IDs werden vor dem nächsten Auftrag gespeichert.

Status je Stufe: `pending`, `processing`, `completed`, `retry`, `error` oder `blocked`. `processing` älter als 60 Minuten wird wieder aufgenommen. Temporäre HTTP-Fehler, Quotenlimits und Timeouts erhalten exponentielle Wartezeit mit Obergrenze. Dauerhafte Fehler und nicht erreichbare Seiten bleiben sichtbar und werden nicht als erfolgreiche Analyse markiert. Logs enthalten IDs, Stufe, Dauer und Fehlercode, jedoch keine API-Schlüssel oder vollständigen E-Mail-Inhalte.

## Konfiguration und Datenschutz

Der OpenAI-Schlüssel und die Modellkennung liegen ausschließlich in Apps Script Script Properties. Sie gehören weder in Git noch in Tabellenzellen oder Logs. Die API-Anfragen verwenden `store: false`, soweit das gewählte Responses-Modell dies unterstützt. Für die bevorzugte Übertragung als Base64-Daten-URL werden die Bilder nicht separat in der Files API gespeichert. Falls später File-IDs verwendet werden, braucht es eine explizite Löschroutine und einen Test für Fehlerabbrüche.

Die Apps-Script-Skript-ID, Spreadsheet-ID und Drive-Ordner-ID bleiben Konfiguration und werden nicht in die Prompttexte eingebettet. Änderungen an Produktionscode werden erst nach Regressionstests und einer bewussten manuellen Bereitstellung über den vorhandenen GitHub-Workflow live geschaltet.

## Geplante Umsetzung

1. JSON-Schema, Feldmapping nach Headern und deterministische Bewertungsregeln festlegen.
2. KI-Client mit API-Key aus Script Properties, Schema-Validierung, Zeitbudget und kontrollierten Retries ergänzen.
3. E-Mail-Extraktion je Anzeige und sicheren Abruf verlinkter Portalseiten integrieren.
4. Bildanalyse in kleinen Batches ergänzen, mit Speicherung je Datei-ID und Wiederaufnahme nach Fehlern.
5. Regressionstests mit anonymisierten E-Mail-/HTML-Fixtures und Mock-API-Antworten ergänzen. Tests dürfen keine echten E-Mails, Drive-Dateien oder Live-API-Aufträge verwenden.
6. Erst danach den manuellen Deploy-Workflow verwenden und Trigger/Status in der Live-Tabelle kontrollieren.

## Quellen für aktuelle Plattformgrenzen

- OpenAI, [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- OpenAI, [Responses API: create a response](https://developers.openai.com/api/reference/resources/responses/methods/create)
- Google, [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- Google, [Installable triggers](https://developers.google.com/apps-script/guides/triggers/installable)
