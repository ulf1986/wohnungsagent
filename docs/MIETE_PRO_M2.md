# Miete pro Quadratmeter

Nach dem manuellen Deploy legt der bestehende Pipeline-Schritt
`ensureListingRatingSchema_` einmalig die Spalte **Miete pro m²** direkt rechts
neben **Preisbewertung (0–100)** an. Das Eingangsdatum und alle folgenden
Spalten werden mit ihren Daten verschoben und weiter anhand ihrer Überschriften
angesprochen. Bereits vorhandene Anzeigen werden ohne KI-Aufruf nachberechnet.

Berechnung: angebotene Monatsmiete in Euro geteilt durch Wohnfläche in m².
Beispiel: 1.200 € / 80 m² = **15,00 €/m²**. Der Zellwert bleibt numerisch und
behält seine volle Rechengenauigkeit; nur die Anzeige wird auf zwei
Nachkommastellen begrenzt. Ob Nebenkosten in der Portal-Miete enthalten sind,
wird durch diese Division nicht zusätzlich geklärt.

Fehlende, nicht numerische, negative oder nullwertige Mieten/Flächen ergeben
eine leere Zelle. Neue extrahierte Angaben aktualisieren den Wert sofort;
manuelle Korrekturen werden beim nächsten Pipeline-Lauf berücksichtigt.
Die Preisbewertung bleibt eine eigene Spalte mit ihrer bisherigen Berechnung.

Die Hintergrundfarbe von **Miete pro m²** entspricht zeilenweise exakt der
angezeigten Farbe der Preisbewertung. Eine versehentlich auf den €/m²-Wert
angewendete 0–100-Farbskala wird nur aus dieser Spalte entfernt; ihre übrigen
Bereiche bleiben erhalten. Die Farbe wird bei Pipeline-Läufen und neuen
Bewertungen synchronisiert. Der numerische Quadratmeterpreis und sein Format
werden dabei nicht verändert.

Die Spalte darf erst mit dem passenden Code eingefügt werden: Die vorherige
Schema-Prüfung erwartet an vierter Position noch das Eingangsdatum. Es werden
keine Trigger geändert, keine E-Mails nachgesendet und keine KI-Aufrufe für die
Nachberechnung benötigt.
