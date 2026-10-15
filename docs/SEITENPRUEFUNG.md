# Seitenprüfung und Tabellenanzeige

## Standard-API, ein gemeinsamer Textaufruf

E-Mail und kompakter Seitentext bleiben getrennte Eingaben eines einzigen Aufrufs.
Die Antwort enthält Mailfakten (`fields`), Seitenfakten (`page_fields`), offene
Felder und `page_check` mit Status `matched`, `unavailable` oder `unclear`,
bestätigter Inserats-ID und Begründung. Kein zusätzlicher KI-Aufruf.

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

Bei nicht verfügbaren Anzeigen bleiben Maildaten und Drive-Bilder erhalten.
Der Auftrag wird abgeschlossen, Status ist „Nicht mehr verfügbar“ und es werden
keine weiteren Bild-KI-Aufrufe für diesen Auftrag gestartet. Bilder allein beweisen
keine aktive Anzeige. Bereits früher abgeschlossene Bestandsjobs werden nicht
rückwirkend neu abgefragt oder umgeschrieben.

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
