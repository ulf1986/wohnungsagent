# Einzeltest Idealista

Vorbereitet am 15.10.2026. Live-Einzeltest noch nicht ausgeführt.

Beispiel: Gmail-ID 1a13f8c1d9ea39ad, Eingang 15.10.2026 14:31:48 Europe/Berlin,
Inserat idealista:112701332. Die Mail wurde gelesen und mit den bestehenden
Parsern lokal geprüft. Eine eindeutige Inserats-ID; ein Wohnungsfoto und drei
App-Store-Badges wurden bisher als Bilder erkannt. Die aktuelle Sperrliste
enthielt die Inserats-ID bei der Vorbereitung nicht. Der Live-Test prüft sie erneut.

Korrektur in Idealista.js: extractIdealistaImages lässt nur Fotos des
Idealista-Bilddiensts mit id.pro.es.image.master im Pfad zu. App-Badges,
Logos und fremde Hosts werden ausgeschlossen. Andere Anbieter bleiben unverändert.

Neue Funktion testIdealistaDownloader in IdealistaDownloaderTest.js:

1. Ein einzelnes vorab ausgewähltes Mailbeispiel, höchstens 72 Stunden alt.
2. Script-Lock, genau eine Idealista-ID und aktuelle Sperrliste prüfen.
3. Vorhandene Queue-Dateireferenzen nur lesen.
4. E-Mail-Foto über saveListingImages und Galerie über downloadIdealistaGallery
   mit den bestehenden Downloadfunktionen speichern.
5. Gespeicherte Dateien aus Drive erneut lesen und MIME, Mindestgröße und
   JPEG-/PNG-/WebP-Signatur prüfen. Das ersetzt keine visuelle Motivprüfung.
6. Eigenes JSONL-Protokoll mit idealista_test_result, Status passed/incomplete/failed.
   Datei-IDs stehen in idealista_test_file. Ein blockierter oder gelöschter
   Galerie-Endpunkt wird nicht als bestandener Volltest gewertet.

Keine Anzeigen, Queue-Zeilen, Gmail-Labels oder Trigger werden verändert.
Nur Bilddateien und die Test-Logdatei können entstehen. Ein wiederholter Test
ohne gespeicherte Quellreferenzen kann zusätzliche Bildkopien erzeugen;
deshalb zunächst nur einmal ausführen. Der Test löst keinen KI-Import aus.

42 lokale Tests erfolgreich, einschließlich Sperrliste, zu altem Beispiel,
gesperrter Galerie, ungültigen Bildinhalten und App-Badge-Regression.
Diese Tests verwenden simulierte Dienste und beweisen keinen Live-Download.

Nächster Schritt: Nutzer stellt den Commit über den bestehenden manuellen
GitHub-Deploy bereit. Danach ausschließlich testIdealistaDownloader ausführen,
nicht runGmailImagePipeline. Trigger bleibt gestoppt. Anschließend das neue Log
und ein gespeichertes Originalbild visuell prüfen. Fehlschläge nach HTTP-Status
und Teststufe einordnen; noch keine pauschale Freigabe anderer Anbieter.
