import datetime as dt
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import telegram_listings as listings

NOW = dt.datetime(2026, 11, 8, 14, 0, tzinfo=dt.timezone.utc)


class PreliminaryLinkTests(unittest.TestCase):
    def test_ids_are_scoped_to_portals_and_links_must_be_https(self):
        cases = (
            ("https://www.yaencontre.com/alquiler/piso/inmueble-50511-112889801", "yaencontre:112889801"),
            ("https://www.idealista.com/inmueble/112889801/", "idealista:112889801"),
            ("https://www.fotocasa.es/es/alquiler/vivienda/malaga/191330803/d", "fotocasa:191330803"),
            ("https://www.pisos.com/alquilar/piso-centro-69177109404_990695/", "pisos:69177109404"),
        )
        for url, expected in cases:
            with self.subTest(url=url):
                self.assertEqual(listings.preliminary_listing_id(url), expected)
        self.assertEqual(listings.preliminary_listing_id(
            "https://www.idealista.com.evil.test/inmueble/112889801"), "")
        self.assertEqual(listings.preliminary_listing_id(
            "http://www.idealista.com/inmueble/112889801"), "")
        self.assertEqual(listings.preliminary_listing_id(
            "https://www.immobilienscout24.de/expose/112889801"), "")

    def test_screen_before_fallback_and_reject_hard_limits_duplicates(self):
        recent = (NOW - dt.timedelta(minutes=10)).isoformat()
        old = (NOW - dt.timedelta(hours=5)).isoformat()
        urls = [
            "https://www.idealista.com/inmueble/1/",
            "https://www.idealista.com/inmueble/2/",
            "https://www.idealista.com/inmueble/3/",
            "https://www.idealista.com/inmueble/4/",
            "https://www.idealista.com/inmueble/5/",
            "https://www.idealista.com/inmueble/6/",
            "https://www.idealista.com/inmueble/7/",
        ]
        matrices = {
            "'Verarbeitung'!H1:J2000": [
                ["Queue Gmail-ID", "Queue Eingang UTC", "Queue Betreff"],
                ["one", recent, "Neue Angebote"],
                ["old", old, "Alte Angebote"]],
            "'Verarbeitung'!L1:L2000": [
                ["Queue Inseratslinks JSON"], [__import__("json").dumps(urls)],
                ['["https://www.idealista.com/inmueble/8/"]']],
            "'Verarbeitung'!O1:Y2000": [
                ["Queue Bildstatus", "Queue Fehler", "Queue Bereit UTC",
                 "KI Verarbeitungsstatus", "KI Fehler", "KI Aktualisiert UTC",
                 "KI Datensatz-ID", "KI Wiederholung ab UTC", "KI Versuche",
                 "KI Abgeschlossene Anzeigen JSON", "KI Aktuelle Anzeigen-ID"],
                ["ready_for_ai", "", "", "retry", "OpenAI HTTP 429",
                 "idealista:1", "", "1", "[]", "idealista:1"],
                ["ready_for_ai", "", "", "retry", "HTTP 429", "", "idealista:8", "", "1", "[]", "idealista:8"]],
            "'Sperrliste'!A2:A2000": [["idealista:2"]],
            "'Duplikate'!A2:C2000": [
                ["idealista:3", "idealista:9", "duplicate"],
                ["idealista:4", "idealista:4", "candidate"]],
            "'Entscheidungen'!A1:H10000": [
                ["Zeit (UTC)", "Lauf-ID", "Stufe", "Gmail-ID",
                 "Datensatz-ID", "Status", "Grund", "Haupteintrag-ID"]],
        }
        current = {
            "idealista:5": {"Miete": "950 €", "Fläche": "53", "KI-Bewertung": "Ausstehend"},
            "idealista:6": {"Miete": "990 €", "Fläche": "70", "KI-Bewertung": "Abgeschlossen",
                            "Status": "Geeignet", "Anzeigenlink": urls[5], "Datensatz-ID": "idealista:6"},
            "idealista:7": {"Miete": "1100 €", "Fläche": "", "KI-Bewertung": "Ausstehend",
                            "Bildanalyse JSON": '{"ai_pipeline":{"email_fields":{"title":"Wohnung"},"api_operation":{"status":"stored"}}}'},
        }
        with patch.object(listings, "sheet_matrix", side_effect=lambda r: matrices[r]):
            result = listings.early_candidates(NOW, set(), current)
        self.assertEqual([x["id"] for x in result], ["idealista:1", "idealista:7"])

    def test_no_fallback_before_first_attempt(self):
        recent = (NOW - dt.timedelta(minutes=12)).isoformat()
        url = "https://www.idealista.com/inmueble/1/"
        matrices = {
            "'Verarbeitung'!H1:J2000": [
                ["Queue Gmail-ID", "Queue Eingang UTC", "Queue Betreff"], ["one", recent, "Neu"]],
            "'Verarbeitung'!L1:L2000": [
                ["Queue Inseratslinks JSON"], ['["' + url + '"]']],
            "'Verarbeitung'!O1:Y2000": [
                ["Queue Bildstatus", "Queue Fehler", "Queue Bereit UTC",
                 "KI Verarbeitungsstatus", "KI Fehler", "KI Aktualisiert UTC",
                 "KI Datensatz-ID", "KI Wiederholung ab UTC", "KI Versuche",
                 "KI Abgeschlossene Anzeigen JSON", "KI Aktuelle Anzeigen-ID"],
                ["ready_for_ai", "", "", "pending", "", "", "", "", "0", "[]", ""]],
            "'Sperrliste'!A2:A2000": [],
            "'Duplikate'!A2:C2000": [],
            "'Entscheidungen'!A1:H10000": [],
        }
        with patch.object(listings, "sheet_matrix", side_effect=lambda r: matrices[r]):
            self.assertEqual(listings.early_candidates(NOW, set(), {}), [])
        # A failed photo import alone must not trigger an unfiltered link.
        matrices["'Verarbeitung'!O1:Y2000"][1][0] = "retry"
        matrices["'Verarbeitung'!O1:Y2000"][1][1] = "Bilddownload HTTP 403"
        with patch.object(listings, "sheet_matrix", side_effect=lambda r: matrices[r]):
            self.assertEqual(listings.early_candidates(NOW, set(), {}), [])
        # A definite first AI attempt for this exact listing may trigger fallback.
        matrices["'Verarbeitung'!O1:Y2000"][1][3] = "retry"
        matrices["'Verarbeitung'!O1:Y2000"][1][4] = "OpenAI HTTP 429"
        matrices["'Verarbeitung'!O1:Y2000"][1][6] = "idealista:1"
        matrices["'Verarbeitung'!O1:Y2000"][1][8] = "1"
        matrices["'Verarbeitung'!O1:Y2000"][1][10] = "idealista:1"
        with patch.object(listings, "sheet_matrix", side_effect=lambda r: matrices[r]):
            self.assertEqual([x["id"] for x in listings.early_candidates(NOW, set(), {})],
                             ["idealista:1"])


    def test_provisional_message_needs_no_ai_or_photos(self):
        sent = []
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "test", "TELEGRAM_CHAT_ID": "123"}), \
             patch.object(listings, "request_json",
                          side_effect=lambda *a, **k: sent.append(k["body"]) or {"ok": True}):
            listings.send_early({"id": "idealista:1",
                                 "url": "https://www.idealista.com/inmueble/1/?utm_source=mail",
                                 "subject": "Neue Wohnung"})
        self.assertEqual(len(sent), 1)
        self.assertIn("unvollständig", sent[0]["text"])
        self.assertIn("Inserat jetzt öffnen", sent[0]["text"])
        self.assertNotIn("utm_source", sent[0]["text"])


if __name__ == "__main__":
    unittest.main()
