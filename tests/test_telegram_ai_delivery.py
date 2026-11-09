"""Regression coverage: AI-complete, inconclusive and terminal-error Telegram notifications."""
import datetime as dt
import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import telegram_listings as mod

NOW = dt.datetime(2026, 11, 9, 19, 0, tzinfo=dt.timezone.utc)
REC = (NOW - dt.timedelta(minutes=30)).isoformat()
URL1 = "https://www.yaencontre.com/alquiler/piso/inmueble-500-12345678"
URL2 = "https://www.fotocasa.es/es/alquiler/vivienda/malaga/191349647/d"


def row(listing_id, link, area="", status="Verfügbarkeit ungeklärt", rent="1100"):
    return {"Datensatz-ID": listing_id, "Anzeigenlink": link, "Miete": rent,
            "Fläche": area, "KI-Bewertung": "Abgeschlossen",
            "Status": status, "Eingang (UTC)": REC,
            "Mietprüfung": "Offen: Fläche, Zimmer, Langzeitmiete nicht bestätigt"}


class DeliveryTests(unittest.TestCase):
    def test_completed_but_missing_area_gets_manual_review(self):
        item = row("yaencontre:12345678", URL1)
        self.assertFalse(mod.eligible(item))
        self.assertTrue(mod.reviewable_completed(item))
        card = mod.review_card(item)
        self.assertIn("KI-Prüfung abgeschlossen: Manuell prüfen", card)
        self.assertIn("Fläche: unbekannt", card)
        self.assertIn("Inserat öffnen", card)

    def test_confirmed_small_or_temporary_property_is_not_notified(self):
        short = row("yaencontre:12345678", URL1, area="58")
        self.assertFalse(mod.reviewable_completed(short))
        self.assertFalse(mod.eligible(short))
        temporary = row("yaencontre:12345678", URL1, area="80",
                        status="Ausgeschlossen")
        self.assertFalse(mod.reviewable_completed(temporary))

    def test_failed_final_digest_links_are_reported_per_id(self):
        queue_headers = [
            "Queue Gmail-ID", "Queue Eingang UTC", "Queue Betreff",
            "Queue Originaltext", "Queue Inseratslinks JSON",
            "Queue Bild-URLs JSON", "Queue Drive-Dateien JSON",
            "Queue Bildstatus", "Queue Fehler", "Queue Bereit UTC",
            "KI Verarbeitungsstatus", "KI Fehler", "KI Aktualisiert UTC",
            "KI Datensatz-ID", "KI Wiederholung ab UTC", "KI Versuche",
            "KI Abgeschlossene Anzeigen JSON", "KI Aktuelle Anzeigen-ID"
        ]
        record = ["gmail-1", REC, "Neue Anzeigen", "",
                  json.dumps([URL1, URL2]), "", "", "ready_for_ai",
                  "", "", "failed_final", "Textquelle nicht gefunden",
                  REC, "yaencontre:12345678", "", "2", "[]",
                  "yaencontre:12345678"]
        sheets = {
            "'Verarbeitung'!H1:Y4000": [queue_headers, record],
            "'Entscheidungen'!A1:H10000": [
                ["Zeit (UTC)", "Lauf-ID", "Stufe", "Gmail-ID",
                 "Datensatz-ID", "Status", "Grund / Hinweis", "Haupteintrag-ID"]],
            "'Sperrliste'!A2:A4000": [], "'Duplikate'!A2:C4000": []
        }
        with patch.object(mod, "sheet_matrix", side_effect=lambda name: sheets[name]):
            items = mod.terminal_failure_candidates(NOW, set(), {})
        self.assertEqual({x["id"] for x in items},
                         {"yaencontre:12345678", "fotocasa:191349647"})
        self.assertTrue(all(x["status"] == "failed_final" for x in items))

    def test_retry_is_not_sent_before_final_failure(self):
        original = mod.sheet_matrix
        queue_headers = [
            "Queue Eingang UTC", "Queue Gmail-ID", "Queue Betreff",
            "Queue Inseratslinks JSON", "KI Verarbeitungsstatus",
            "KI Fehler", "KI Datensatz-ID", "KI Aktuelle Anzeigen-ID"]
        fake = {"'Verarbeitung'!H1:Y4000": [
            queue_headers, [REC, "gmail", "alert", json.dumps([URL1]),
                            "retry", "HTTP 429", "yaencontre:12345678", "yaencontre:12345678"]],
                "'Entscheidungen'!A1:H10000": [],
                "'Sperrliste'!A2:A4000": [], "'Duplikate'!A2:C4000": []}
        with patch.object(mod, "sheet_matrix", side_effect=lambda name: fake[name]):
            self.assertEqual(mod.terminal_failure_candidates(NOW, set(), {}), [])

    def test_main_prioritizes_completed_reviews_and_remembers_sent_id(self):
        item = row("yaencontre:12345678", URL1)
        save_calls = []
        data = {"'Sperrliste'!A2:A4000": [],
                "'Duplikate'!A2:C4000": []}
        with patch.object(mod, "cells", return_value=[item]), \
             patch.object(mod, "load_issue", return_value=({"number": 3}, set())), \
             patch.object(mod, "sheet_matrix", side_effect=lambda key: data[key]), \
             patch.object(mod, "send_review") as review, \
             patch.object(mod, "send") as suitable, \
             patch.object(mod, "terminal_failure_candidates", return_value=[]), \
             patch.object(mod, "save", side_effect=lambda issue, sent: save_calls.append(set(sent))):
            mod.main()
        review.assert_called_once_with(item)
        suitable.assert_not_called()
        self.assertEqual(save_calls[-1], {"yaencontre:12345678"})


if __name__ == "__main__":
    unittest.main()
