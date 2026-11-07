import datetime as dt
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import telegram_rejections as mod

NOW = dt.datetime(2026, 11, 7, 12, 0, tzinfo=dt.timezone.utc)
HEADER = ["Zeit (UTC)", "Lauf-ID", "Stufe", "Gmail-ID", "Datensatz-ID",
          "Status", "Grund / Hinweis", "Haupteintrag-ID"]


class RejectionTests(unittest.TestCase):
    def test_only_factual_ai_rejections(self):
        rows = [HEADER,
                ["2026-11-07T11:00:00Z", "", "KI", "gmail1",
                 "pisos:12345678", "blocked", "Ausschluss: Fläche unter 60 m²", ""],
                ["2026-11-07T11:01:00Z", "", "Gmail", "gmail2",
                 "pisos:12345679", "blocked", "Sperrliste", ""],
                ["2026-11-07T11:02:00Z", "", "KI", "gmail3",
                 "pisos:12345680", "duplicate", "Haupteintrag", ""],
                ["2026-11-07T11:03:00Z", "", "KI", "gmail4",
                 "pisos:12345681", "blocked", "Datensatz-ID steht in der Sperrliste", ""]]
        got = mod.rejected_decisions(rows, NOW)
        self.assertEqual([x["id"] for x in got], ["pisos:12345678"])

    def test_deduplicates_replayed_decisions_by_listing_id(self):
        rows = [HEADER,
                ["2026-11-07T11:00:00Z", "", "KI", "gmail1",
                 "pisos:12345678", "blocked", "Ausschluss: Fläche unter 60 m²", ""],
                ["2026-11-07T11:05:00Z", "", "KI", "gmail2",
                 "pisos:12345678", "blocked", "Ausschluss: Fläche unter 60 m²", ""]]
        self.assertEqual(len(mod.rejected_decisions(rows, NOW)), 1)

    def test_escapes_telegram_html(self):
        msg = mod.message({"id": "pisos:12345678", "mail_id": "abc",
                           "reason": "Ausschluss: <60 m² & viel zu klein"})
        self.assertIn("&lt;60 m² &amp;", msg)
        self.assertIn("#all/abc", msg)
        self.assertIn("<b>Wohnung ausgeschlossen</b>", msg)

    def test_first_activation_does_not_send_old_rejections(self):
        rows = [HEADER,
                ["2026-11-07T11:00:00Z", "", "KI", "gmail1",
                 "pisos:12345678", "blocked", "Ausschluss: Weniger als 2 Zimmer", ""]]
        with patch.object(mod, "sheet_values", return_value=rows), \
             patch.object(mod, "google_token", return_value="token"), \
             patch.object(mod, "load_state", return_value=(None, set())), \
             patch.object(mod, "save_state", return_value={"number": 123}) as save, \
             patch.object(mod, "send") as send:
            self.assertEqual(mod.main(), 0)
            send.assert_not_called()
            self.assertEqual(save.call_args.args[1], {"pisos:12345678"})

    def test_failed_send_does_not_mark_as_sent(self):
        rows = [HEADER,
                ["2026-11-07T11:00:00Z", "", "KI", "gmail1",
                 "pisos:12345678", "blocked", "Ausschluss: Fläche unter 60 m²", ""]]
        with patch.object(mod, "sheet_values", return_value=rows), \
             patch.object(mod, "google_token", return_value="token"), \
             patch.object(mod, "load_state", return_value=({"number": 123}, set())), \
             patch.object(mod, "save_state") as save, \
             patch.object(mod, "send", side_effect=RuntimeError("Telegram offline")):
            with self.assertRaisesRegex(RuntimeError, "Telegram offline"):
                mod.main()
            save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
