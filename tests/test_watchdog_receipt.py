"""Test incident-to-email correlation and readable Malaga Telegram timestamps."""
import datetime as dt
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import watchdog_checks as checks
import telegram_watchdog as monitor
import telegram_rejections as rejection
import telegram_listings as listings

NOW = dt.datetime(2026, 11, 9, 0, 0, tzinfo=dt.timezone.utc)
RECEIVED = "2026-11-08T21:11:25Z"


class ArrivalTimeTests(unittest.TestCase):
    def test_gmail_missing_contains_received_timestamp(self):
        alerts = checks.inspect([], [], [], set(), NOW,
                                [{"id": "gmail-123", "received": RECEIVED}])
        self.assertEqual([a["code"] for a in alerts], ["MAIL_NOT_IMPORTED"])
        self.assertEqual(alerts[0]["mail_received"], "08.11.2026 22:11")

    def test_ai_incident_uses_mail_arrival_not_last_step(self):
        rows = [[
            "Queue Gmail-ID", "Queue Eingang UTC", "Queue Bildstatus",
            "KI Verarbeitungsstatus", "KI Fehler", "KI Aktualisiert UTC",
            "KI Datensatz-ID", "KI Versuche"
        ], [
            "gmail-123", RECEIVED, "ready_for_ai", "failed_final",
            "Auswertung endgültig gescheitert", "2026-11-08T23:50:00Z",
            "fotocasa:123", "3"
        ]]
        alerts = checks.inspect(rows, [], [], set(), NOW)
        self.assertEqual([a["code"] for a in alerts], ["AI_FAILED_FINAL"])
        self.assertEqual(alerts[0]["mail_received"], "08.11.2026 22:11")

    def test_telegram_error_message_displays_mail_received(self):
        alert = checks.problem("MAIL_NOT_IMPORTED", "gmail-123", "Nicht importiert")
        alert["mail_received"] = "08.11.2026 22:11"
        with patch.object(monitor, "open_incident", return_value=None), \
             patch.object(monitor, "gh_request"), \
             patch.object(monitor, "telegram") as telegram:
            monitor.handle_incidents([alert], NOW)
        body = telegram.call_args.args[0]
        self.assertIn("E-Mail eingegangen: 08.11.2026 22:11", body)
        self.assertIn("Prüfung: 09.11.2026 01:00", body)

    def test_gmail_alert_subject_coverage(self):
        accepted = [
            "¿Te lo perdiste? · Piso en tu búsqueda: Wohnung (Basic)",
            "⌂ Nuevo estudio para tu búsqueda en Málaga (personalizada)",
            "⌂ Se han publicado nuevos anuncios para tu búsqueda en Málaga",
            "2 Oportunidades en tu búsqueda: Wohnung (Basic)",
            "Ulf Marxen, tienes 1 novedad en alquiler en Málaga Capital",
            "Nuevo · Piso en tu búsqueda: Wohnung (Basic)",
        ]
        for subject in accepted:
            with self.subTest(subject=subject):
                self.assertTrue(monitor.is_property_search_notice(subject))
        for subject in ("Respuesta sobre el inmueble", "Aviso importante sobre un anunciante"):
            self.assertFalse(monitor.is_property_search_notice(subject))

    def test_rejection_timestamp_comes_from_queue(self):
        rows = [
            ["Queue Gmail-ID", "Queue Eingang UTC", "Queue Betreff",
             "Queue Originaltext", "Queue Inseratslinks JSON"],
            ["gmail-123", RECEIVED, "", "", "[]"]
        ]
        value = rejection.mail_received_for_id("gmail-123", rows)
        self.assertIn("08.11.2026 22:11", rejection.received_label(value))
        self.assertIn("E-Mail eingegangen: 08.11.2026 22:11",
                      rejection.message({"id": "fotocasa:123",
                                         "reason": "Ausschluss: zu klein",
                                         "mail_received": value}))

    def test_listing_card_timestamp(self):
        row = {"Anzeigenlink": "https://www.idealista.com/inmueble/123/",
               "Miete": "1000", "Fläche": "70", "Eingang (UTC)": RECEIVED}
        self.assertIn("E-Mail eingegangen: 08.11.2026 22:11",
                      listings.card(row))


if __name__ == "__main__":
    unittest.main()
