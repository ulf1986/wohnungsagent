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

    def test_sends_only_recent_nonblocked_nonexcluded_unsent_ids(self):
        recent = (NOW - dt.timedelta(minutes=10)).isoformat()
        old = (NOW - dt.timedelta(hours=5)).isoformat()
        matrices = {
            "'Verarbeitung'!H1:J2000": [
                ["Queue Gmail-ID", "Queue Eingang UTC", "Queue Betreff"],
                ["one", recent, "Neue Angebote"],
                ["old", old, "Alte Angebote"]],
            "'Verarbeitung'!L1:L2000": [
                ["Queue Inseratslinks JSON"],
                ['["https://www.idealista.com/inmueble/1/",'
                 '"https://www.yaencontre.com/alquiler/piso/inmueble-9-2",'
                 '"https://www.pisos.com/alquilar/piso-centro-12345678_100/"]'],
                ['["https://www.idealista.com/inmueble/4/"]']],
            "'Sperrliste'!A2:A2000": [["yaencontre:2"]],
        }
        with patch.object(listings, "sheet_matrix", side_effect=lambda r: matrices[r]):
            result = listings.early_candidates(NOW, {"pisos:12345678"}, {})
        self.assertEqual([x["id"] for x in result], ["idealista:1"])

    def test_provisional_message_needs_no_ai_or_photos(self):
        sent = []
        with patch.dict(os.environ, {"TELEGRAM_BOT_TOKEN": "test", "TELEGRAM_CHAT_ID": "123"}), \
             patch.object(listings, "request_json",
                          side_effect=lambda *a, **k: sent.append(k["body"]) or {"ok": True}):
            listings.send_early({"id": "idealista:1",
                                 "url": "https://www.idealista.com/inmueble/1/?utm_source=mail",
                                 "subject": "Neue Wohnung"})
        self.assertEqual(len(sent), 1)
        self.assertIn("noch nicht geprüft", sent[0]["text"])
        self.assertIn("Inserat jetzt öffnen", sent[0]["text"])
        self.assertNotIn("utm_source", sent[0]["text"])


if __name__ == "__main__":
    unittest.main()
