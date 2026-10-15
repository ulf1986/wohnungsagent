# Fehleranalyse des Bildimports

Die Pipeline schreibt drei getrennte Ausgaben:

1. **Strukturierte Konsolenlogs** unter Apps Script > Ausführungen.
   Jedes Ereignis enthält UTC-Zeit, Lauf-ID, Stufe, Ebene, Gmail-ID,
   Datensatz-ID, Status, Dauer und begrenzte Details.
2. **Tabellenblatt Diagnose** im vorhandenen Wohnungsagent-Sheet.
   Es wird beim ersten abgeschlossenen Lauf angelegt. Pro Lauf werden maximal
   250 Ereignisse gespeichert; das Ende des Laufs enthält die Zahl ausgelassener
   Ereignisse. Nur die neuesten 5.000 Diagnosezeilen bleiben erhalten.
   Vollständige Ereignisfolgen stehen in den Konsolenlogs.
3. **GitHub-Testbericht** bei Änderungen am Skript oder den Tests.
   Der Workflow Mail importer regression tests prüft Syntax und Regressionen
   und speichert einen JUnit-Bericht für sieben Tage. Er führt keinen Deploy aus.

## Was die Stufen zeigen

| Stufe | Aussage |
| --- | --- |
| mail_scan / mail_start | Kandidaten, ausgewählte Mails, Start einer Mail |
| milanuncios_resolve | Status der erlaubten Foto-Link-Weiterleitung |
| mail_extract / mail_images | erkannte Inserats-IDs, Links, Fotos und vorhandene Dateien |
| image_http / image_content / image_download | HTTP-Code, Dateityp, Größe, Wiederverwendung, Speicherung oder Fehler |
| queue_status | Ergebnis: ready_for_ai, retry, blocked; mit Grund |
| identity_audit | abweichende Quell-E-Mail, fremde Bildzuordnung, doppelte ID, ungültiges JSON, unvollständiger completed-Status |
| listing_import / availability / previews / sort | Start, Ende, Dauer oder Fehler der Nachbearbeitung |
| listing_write | geprüfte Anzeigen-ID und Zielzeile, verworfener Schreibversuch oder Quell-E-Mail-Abweichung |
| availability_result | Zustand der geprüften Original-Bildquellen |
| run_end | Laufzeit, Fehler, Warnungen und ausgelassene Diagnoseereignisse |

Nach Lauf-ID filtern, dann Gmail-ID bzw. Datensatz-ID vergleichen. Als Einstieg
WARN/ERROR und queue_status=retry ansehen. source_key verbindet Ereignisse
derselben vollständigen Bild-URL, ohne ihre Query-Parameter zu speichern.

Mailtexte, Betreffzeilen und unbekannte Detailfelder werden nicht protokolliert.
URL-Querys und Fragmente werden entfernt. Das Diagnoseblatt bleibt in der
bestehenden privaten Tabelle. Fehler beim Protokollieren brechen den Import
nicht ab; sie erscheinen in der Konsole.

## Lesender Bestandscheck

Im Apps-Script-Editor die Funktion **runImageDiagnostics** ausführen.
Sie liest Anzeigen, prüft Referenzen und schreibt ausschließlich Diagnoseausgaben.
Sie lädt keine Bilder, sortiert keine Anzeigen und repariert keine Zuordnung.
Eine abweichende source_email_id ist ein Warnsignal, allein kein Beweis
für ein fremdes Foto: dieselbe Anzeige kann in mehreren E-Mails vorkommen.

Die schon festgestellten Bestandsfehler werden durch diese Änderung nicht
repariert. Die neuen Ausgaben sollen den verursachenden Schreibschritt eingrenzen.

## Milanuncios

Die Original-Suchmail 1a13b58f7993b3f6 enthält ein Immobilienfoto und opaque
Tracking-Links. Der Foto-Link wurde mit HTTP 302 auf
https://www.milanuncios.com/ads/malaga-capital-619803957.htm aufgelöst.

Die Pipeline löst nur Links unmittelbar um echte images-re.milanuncios.com
Immobilienfotos auf: maximal acht eindeutige Karten und drei Redirects je Karte.
Sie folgt nicht automatisch allen Mail-Links. Such-, Änderungs- und
Abmeldebuttons werden nicht aufgerufen. Fremde oder unklare Redirectziele bleiben
retry; es gibt dann keine KI-Freigabe. Eine einzelne erkannte Anzeige mit
gespeichertem Foto wird ready_for_ai; Mehrfachangebote bleiben retry.

Datensatz-IDs haben die Form milanuncios:619803957. Die Sperrliste wird nach
Linkauflösung und vor dem Bilddownload geprüft. Der bestehende Import wird auch
für Milanuncios registriert. Es werden E-Mail-Fotos importiert, keine komplette
Inseratsgalerie. Der echte Ziel-Link und HTML-Aufbau sind geprüft; automatisierte
Download- und Fehlerfalltests verwenden simulierte Google-/HTTP-Dienste.
