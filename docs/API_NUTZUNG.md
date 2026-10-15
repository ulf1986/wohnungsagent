# Begrenzte KI-Eingaben

## Zehn Bilder insgesamt je Inserat

Die ersten höchstens zehn geeigneten Originalbilder werden in der vorhandenen
Reihenfolge ausgewählt. Erkennbare Logos, App-Badges und Trackingdateien werden
über ihre Dateinamen/Quellen ausgeschlossen; identische Datei-Inhalte werden lokal
mit SHA-256 erkannt. Das ist keine semantische Motiv- oder Ähnlichkeitserkennung.
Die bisherigen Anbieterfilter und Bildzuordnungen bleiben unverändert.

Die Auswahl liegt dauerhaft in Bildanalyse JSON unter ai_pipeline.image_selection.
Sie wird vor dem ersten Bild-API-Aufruf gespeichert und nicht durch spätere Mails,
neue Fotos oder einen Retry erweitert/ersetzt. Bereits bewertete Datei-IDs werden
nicht erneut übertragen. Auch ältere Bewertungen zählen zum Budget. Bestehende
historische Auswertungen mit mehr als zehn Bildern werden nicht gelöscht oder
nachträglich als neue Zehnerbewertung dargestellt; es werden keine weiteren Bilder
ergänzt. Das Limit gilt pro stabiler Portal-Inserats-ID und zugehöriger Anzeigenzeile.
Eine bereits gelöschte Anzeigenzeile wird hier nicht automatisch neu importiert.

Es gibt keine Verkleinerung, Neukodierung oder neue öffentliche Bildfreigabe.
Die Originalbytes werden als Base64 übertragen. Vor jedem Upload wird geprüft,
ob sie weiterhin dem gespeicherten Inhalts-Hash entsprechen. Veränderte oder
unzugängliche Dateien erzeugen retry statt einer Ersatzdatei jenseits der Auswahl.
Fünf Bilder je Aufruf und bisherige Größenlimits bleiben bestehen. Sehr große
Originale können mehr als zwei Anfragen für zehn Bilder benötigen oder bei
Überschreiten des Einzeldateilimits einen Fehler auslösen.

Die Verarbeitung endet nach Bewertung der ausgewählten Bilder, auch wenn Drive
weitere Bilder enthält. Die Tabelle kennzeichnet die Begrenzung unter Zusammenfassung
und Offene Angaben. Der Abschluss bezieht sich auf die Auswahl. Alle Drive-Dateien
bleiben erhalten. Weniger als zehn anfänglich verfügbare Bilder bleiben ebenfalls
eine feste Auswahl; eine spätere Erweiterung würde einen eigenen Auftrag benötigen.

Eine fehlgeschlagene API-Anfrage darf denselben noch nicht erfolgreich gespeicherten
Batch wiederholen. Bei einem Timeout kann die Gegenstelle die Anfrage bereits
verarbeitet haben; ohne gespeichertes Ergebnis lässt sich eine doppelte Verarbeitung
dieses Batches nicht sicher ausschließen. Es werden dabei keine weiteren Bildidentitäten
über die feste Auswahl hinaus freigegeben.

## Text und Prompts

Die drei funktionalen Aufrufe bleiben erhalten: E-Mail-Fakten, fehlende Seitenangaben,
Bildbewertung. Die KI-Extraktion wird nicht durch neue Anbieter-Parser ersetzt.
Rückgaben bleiben strukturierte JSON-Objekte mit festem Schema.

- E-Mail: bereinigter Betreff (maximal 300 Zeichen), Klartext (maximal 10.000 Zeichen),
  Inseratslink ohne Query/Fragment und angeforderte Feldnamen. Kein Seitentext und
  keine leeren Zusatzobjekte. Gespeicherte Fakten werden weiterhin wiederverwendet.
- Seite: relevante Titel-/Beschreibung-/Inseratsdaten aus JSON-LD sowie der bereinigte
  main-/article-Bereich, sofern vorhanden. Sonst bereinigter sichtbarer Text als
  Fallback. Skripte, Styles, Navigation, Header, Footer, Formulare und Seitenleisten
  werden entfernt. Kein vollständiges HTML und keine vollständigen JSON-LD-Objekte.
  Typische Abmelde-/Cookiezeilen und identische Textzeilen werden entfernt.
  Höchstens 10.000 Zeichen. Unterschiedliche Portal-Layouts können im sichtbaren
  Text dennoch Werbung enthalten; dies ist eine regelbasierte Bereinigung.
- Seitenergänzung: nur fehlende Feldnamen auch im Antwortschema, bekannte Fakten
  als kurzer Kontext, kein erneut gesendeter Mailtext oder Betreff. Null und false
  bleiben unterscheidbar. Leerer Quelltext löst keine API-Anfrage aus.
- Bilder: Originaldaten der jeweils noch unbewerteten Auswahl, Bildindizes und
  frühere textliche Bewertungen dieser Auswahl. Keine Mail-/Seitentexte. Drive-IDs
  werden nicht mehr als zusätzliche Bildbeschriftung an die API geschickt.

Die Anweisungen bleiben: nur belegte Fakten, keine erfundenen Angaben, fehlende
Werte null, keine Überschreibung vorhandener Fakten; Bilder nach Helligkeit,
Raumwirkung, Möbelzustand und Pflege bewerten. Die Zehnergrenze setzt der Code
durch, nicht nur der Prompt.

Neue Logstufen ai_text_input (Textlänge/Feldanzahl), ai_image_selection
(verfügbare/ausgewählte Dateien) und ai_image_input (Originalbytes/Dateityp) machen
die tatsächlich gesendeten Eingaben nachvollziehbar. Keine Mailtexte im Dateilog.

## Prüfung und Bereitstellung

Tests decken zehn statt zwanzig Bilder, mehrere Batches/Mails, Retry, historische
Bewertungen, identischen Inhalt unter neuer Drive-ID, bytegenaue Originalübertragung,
geänderte Dateien, HTML-/Layoutbereinigung und das Schema nur offener Felder ab.
Keine produktiven Mails oder API-Anfragen für diese Tests.

Deployment bleibt manuell. Keine Script Properties, Trigger, Labels oder bestehenden
Sheet-/Drive-Daten werden durch die Codevorbereitung verändert. Die Auswahl wird
erst bei einem später freigegebenen produktiven Lauf gespeichert.

Referenz: [OpenAI-Bildinput](https://developers.openai.com/api/docs/guides/images-vision).
