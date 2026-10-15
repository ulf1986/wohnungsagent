# Seitenprüfung und Tabellenanzeige

## Standard-API, ein gemeinsamer Textaufruf

E-Mail und kompakter Seitentext bleiben getrennte Eingaben eines einzigen Aufrufs.
Die API-Antwort enthält pro Feld eine Kandidatenliste mit Wert (`value`), Quelle
(`source`: email/listing_page) und kurzem wörtlichem Beleg (`quote`), offene Felder
und `page_check` mit Status `matched`, `unavailable` oder `unclear`, bestätigter
Inserats-ID und Begründung. Kein zusätzlicher KI-Aufruf.

Der Code prüft Typ, erlaubte Quelle und ob das Belegzitat nach Normalisierung von
Leerzeichen, Unicode und Groß-/Kleinschreibung tatsächlich in genau dem übertragenen
Quelltext vorkommt. Unbelegte, falsch zugeordnete oder innerhalb einer Quelle
widersprüchliche Kandidaten werden verworfen. Erst danach baut der Code getrennte
Mailfakten (`email_fields`) und Seitenfakten (`page_fields`) auf. Nicht die KI
entscheidet, welcher Speicherbereich einen Kandidaten erhält. Widersprüche zwischen
beiden bestätigten Quellen bleiben unter `source_conflicts` nachvollziehbar; die
Mailangabe hat Vorrang. Im Sheet erscheint ein Konflikthinweis. Nachweise liegen
unter `field_provenance`, verworfene Kandidaten unter `rejected_facts`.

Die Zitatprüfung bestätigt das Vorkommen und die Herkunft des Belegs, nicht dessen
semantisch korrekte Interpretation durch die KI. Der Prompt verlangt weiterhin,
dass das Zitat den Wert tatsächlich belegt. Bereits früher gespeicherte Ergebnisse
werden nicht automatisch neu extrahiert oder nachträglich als belegt markiert.

Seitenfakten dürfen nur bei übereinstimmender ID aus canonical/og:url und bestätigter
KI-Zuordnung übernommen werden. Die angefragte URL oder ein generischer Titel allein
reichen nicht. Bei fehlenden/abweichenden Seitenmetadaten bleibt die Prüfung bewusst
unklar; nicht jeder Anbieter liefert über den Serverabruf vollständige Inhalte.
Die KI prüft zusätzlich, ob Objektdaten zusammenpassen, und ignoriert Suchergebnisse,
Empfehlungen und fremde Anweisungen. Belegte Mailangaben haben Vorrang bei Konflikten.
Die Mail- und Seitenfakten bleiben im internen JSON getrennt nachvollziehbar.

Der Abruf folgt Weiterleitungen begrenzt und nur innerhalb derselben freigegebenen
Portal-Domain. HTTP 404/410, propertyNotFound und eindeutige Löschmeldungen in
Seitentitel/Überschriften bedeuten nicht verfügbar. Zugriffssperren, CAPTCHA,
unbekannte Weiterleitungen und leere Inhalte bleiben ungeklärt. Die Regeln sind
konservativ und erheben keinen Anspruch auf vollständige Erkennung aller Portale.

Bei eindeutig nicht verfügbaren Anzeigen wird zuerst die vorhandene Sperrliste
(Datensatz-ID, Original-URL, Grund) ergänzt und durch Kontrolllesen bestätigt.
Erst danach wird eine eventuell bestehende Anzeigenzeile inhaltlich geleert;
Formatierung und Checkbox-Regeln bleiben erhalten. Neue Inserate mit technischem
Löschhinweis werden vor Zeilenanlage und vor jedem KI-Aufruf gesperrt. Stammt die
Erkennung aus dem gemeinsamen Textaufruf, wird die vorläufige Zeile anschließend
entfernt. Fehler beim Sperrlistenschreiben führen zu Retry, nicht zur Löschung.
Ein bereits gespeicherter Sperreintrag wird nicht dupliziert. Zugriffssperren und
unklare Antworten führen nicht zu dieser Sperrung.

Der Auftrag wird abgeschlossen, ohne weitere Bild-KI-Aufrufe. Mail-Rohdaten in
Verarbeitung und Drive-Bilder bleiben erhalten. Bilder allein beweisen keine aktive
Anzeige. Abgeschlossene Bestandsjobs werden nicht automatisch neu geprüft.
Der bekannte entfernte Testeintrag fotocasa:191053627 wurde am 16.10.2026 nach
bestätigtem Eintrag in die Sperrliste aus Anzeigen entfernt.

Alle frei formulierten Text- und Bildergebnisse sollen laut Prompt Deutsch sein.
Eigennamen, Adressen, Kontaktdaten und wörtliche quote-Belege bleiben im Original.
JSON-Feldnamen und technische Status-/Quellenwerte bleiben unverändert, damit die
Auswertung und die Quellenprüfung funktionieren. Dies ist eine Promptvorgabe,
keine zusätzliche KI-Übersetzungsanfrage.

## Lesbare Tabelle

Der Titel verwendet belegte Zimmerzahl und Adresse/Stadtviertel, mit anklickbarem
Original-Inseratslink ohne Trackingparameter. Ohne diese Fakten bleibt der bekannte
Titel erhalten. „Offene Angaben“ nutzt deutsche Bezeichnungen, Zeilenumbrüche und
Textumbruch. Fehlende Angaben werden nicht erfunden. Die interne Spalte
„KI-Bewertung“ bleibt für den Ablauf erhalten und wird ausgeblendet.

## Lage

Referenz: **Alameda Principal 3, 29001, Málaga, España** (`AI_PIPELINE.referenceAddress`).
Der eingebaute Google Apps Script Maps Geocoder verortet Referenz und belegte
Inseratsadresse; dafür wird die Adresse an Google übergeben. Keine OpenAI-Anfrage.
Mehrdeutige, nur stadtweite oder partielle Ergebnisse werden verworfen. Der
Referenzpunkt muss eine genaue Adresse in Málaga/Spanien mit PLZ 29001 sein.
Eine eindeutig erkannte Straße wird nur als Näherung akzeptiert und ausdrücklich
als „Lage nur auf Straßenebene bestimmt“ gekennzeichnet. Unbekannte Lage bleibt offen.

Luftlinie und achtteilige Himmelsrichtung werden mathematisch vom Referenzpunkt
zum Inserat berechnet. Koordinaten, Quelle, Genauigkeit und Ergebnis werden im
Inserats-JSON gespeichert und bei gleichem Bezug wiederverwendet. KI-Schätzungen
für Entfernung/Himmelsrichtung werden nicht übernommen. Die vorhandenen Spalten
und Distanz-Punkteberechnung bleiben erhalten. Google-Dienst und Tageskontingent
müssen verfügbar sein; Fehler unterbrechen die übrige Verarbeitung nicht.

## Vorbereitung des erneuten Tests, 16.10.2026

Nur Anzeigen!A2:AN2 für fotocasa:191053627 wurde inhaltlich geleert; Formatierung,
Checkbox-Regeln und weitere Inserate bleiben bestehen. Verarbeitung!R15:Y15 wurde
für dessen Mail 1a12bec355db3b73 auf pending zurückgesetzt. Gmail-Labels, Rohdaten
der Mailqueue, Drive-Fotos, Trigger und Sperrliste blieben erhalten.
Lokale Sicherung: working-backups/test-reset-191053627-2026-10-16.json (nicht im Repo).

Nach manuellem Deployment: verfügbare Anzeige, entfernte Anzeige und blockierte
Seite testen. Bei verfügbarem Inserat auch Rich-Text-Link, deutsche offene Angaben,
Maps-Berechtigung/Verortung und Berechnungsrichtung prüfen. Noch kein echter
KI-/Geocoding-Lauf mit diesem Änderungsstand ausgeführt.
