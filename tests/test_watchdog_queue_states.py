import datetime as dt
import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import watchdog_checks as checks
import telegram_watchdog as monitor

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 11, 8, 8, 0, tzinfo=UTC)


def ago(minutes):
    return (NOW - dt.timedelta(minutes=minutes)).isoformat()


QUEUE_HEADERS = [
    "Queue Gmail-ID", "Queue Eingang UTC", "Queue Bildstatus",
    "KI Verarbeitungsstatus", "KI Fehler", "KI Aktualisiert UTC",
    "KI Wiederholung ab UTC", "KI Versuche",
    "KI Aktuelle Anzeigen-ID", "KI Datensatz-ID",
    "KI Abgeschlossene Anzeigen JSON", "Queue Inseratslinks JSON",
    "Queue Fehler"
]
LISTING_HEADERS = ["Datensatz-ID", "Eingang (UTC)", "Status", "KI-Bewertung",
                   "Bildanalyse JSON", "Fläche", "Miete", "Anzeigenlink"]
DECISION_HEADERS = ["Zeit (UTC)", "Datensatz-ID", "Status"]


def queue(mail_id="mail1", age=180, state="pending", updated="", attempts="0"):
    return [mail_id, ago(age), "ready_for_ai", state, "", updated, "",
            attempts, "", "", "[]", "[]", ""]


def listing(listing_id, ai="Nicht bewertet", stage="no_images",
            received=240, updated=240, drive_files=True):
    data = {"ai_analysis_status": stage,
            "drive_files": [{"file_id": "x"}] if drive_files else [],
            "analyzed_file_ids": [],
            "ai_pipeline": {"updated_at": ago(updated)}}
    return [listing_id, ago(received), "Prüfung erforderlich", ai,
            json.dumps(data), "88", "1200", "https://example.org/listing"]


class QueueMonitoringTests(unittest.TestCase):
    def inspect(self, queues, listings=None, decisions=None):
        return checks.inspect([QUEUE_HEADERS] + queues,
                              [LISTING_HEADERS] + (listings or []),
                              [DECISION_HEADERS] + (decisions or []),
                              set(), NOW)

    def test_unstarted_queue_is_backlog_not_failed_job(self):
        alerts = self.inspect([queue(age=250)])
        self.assertNotIn("AI_QUEUE_STALLED", [a["code"] for a in alerts])

    def test_recently_active_queue_is_not_stalled(self):
        alerts = self.inspect([queue(age=240, updated=ago(10))])
        self.assertNotIn("AI_QUEUE_STALLED", [a["code"] for a in alerts])

    def test_genuinely_idle_queue_still_alerts(self):
        alerts = self.inspect([queue(age=300, updated=ago(200))])
        self.assertIn("AI_QUEUE_STALLED", [a["code"] for a in alerts])

    def test_terminal_states_are_not_stalled(self):
        for state in ("expired", "completed", "blocked", "failed_final"):
            with self.subTest(state=state):
                alerts = self.inspect([queue(age=3000, state=state)])
                self.assertNotIn("AI_QUEUE_STALLED", [a["code"] for a in alerts])
                self.assertNotIn("AI_EXPIRED", [a["code"] for a in alerts])

    def test_failed_final_is_one_actionable_incident(self):
        items = self.inspect([queue(age=120, state="failed_final")])
        self.assertEqual([a["code"] for a in items], ["AI_FAILED_FINAL"])

    def test_no_images_is_terminal_even_if_drive_files_exist(self):
        items = self.inspect([], listings=[listing("pisos:123456", stage="no_images")])
        self.assertNotIn("IMAGE_ANALYSIS_STALLED", [a["code"] for a in items])

    def test_image_analysis_started_then_stuck_warns(self):
        items = self.inspect([], listings=[listing("pisos:123456", stage="processing",
                                                  updated=240)])
        self.assertIn("IMAGE_ANALYSIS_STALLED", [a["code"] for a in items])

    def test_completed_decision_counts_as_terminal_without_listing(self):
        headers = QUEUE_HEADERS
        row = queue(age=120, state="completed")
        row[10] = '["idealista:113010705"]'
        row[11] = '["https://www.idealista.com/inmueble/113010705/"]'
        items = self.inspect([row], decisions=[[ago(40), "idealista:113010705", "completed"]])
        self.assertNotIn("LISTING_MISSING", [a["code"] for a in items])


class TelegramDigestTests(unittest.TestCase):
    def test_new_alert_sent_immediately_once(self):
        a = checks.problem("AI_AUTH", "mail1", "Wrong key")
        now = NOW
        previous = {"AI_AUTH:mail1": {
            "severity": "critical", "detail": "Wrong key", "first_seen": ago(50),
            "notified_at": ago(30)}}
        issue = {"number": 5, "body": monitor.incident_body(previous)}
        with patch.object(monitor, "open_incident", return_value=issue), \
             patch.object(monitor, "gh_request") as gh, \
             patch.object(monitor, "telegram") as send:
            monitor.handle_incidents([a], now)
            send.assert_not_called()
            gh.assert_called_once()

    def test_reminder_after_four_hours_and_grouped(self):
        alerts = [checks.problem("AI_QUEUE_STALLED", "mail1", "Job 1", "warning"),
                  checks.problem("AI_QUEUE_STALLED", "mail2", "Job 2", "warning")]
        state = {x["key"]: {"severity": x["severity"], "detail": x["detail"],
                             "first_seen": ago(300), "notified_at": ago(245)}
                 for x in alerts}
        issue = {"number": 5, "body": monitor.incident_body(state)}
        with patch.object(monitor, "open_incident", return_value=issue), \
             patch.object(monitor, "gh_request"), \
             patch.object(monitor, "telegram") as send:
            monitor.handle_incidents(alerts, NOW)
            send.assert_called_once()
            body = send.call_args.args[0]
            self.assertIn("AI_QUEUE_STALLED (2)", body)
            self.assertIn("Job 1", body)
            self.assertIn("Job 2", body)

    def test_new_critical_alert_is_not_delayed_by_warning(self):
        prior = checks.problem("AI_QUEUE_STALLED", "one", "still waiting", "warning")
        new = checks.problem("AI_AUTH", "two", "new fatal error")
        old = {prior["key"]: {"severity": "warning", "detail": "still waiting",
                               "first_seen": ago(80), "notified_at": ago(30)}}
        issue = {"number": 5, "body": monitor.incident_body(old)}
        with patch.object(monitor, "open_incident", return_value=issue), \
             patch.object(monitor, "gh_request"), \
             patch.object(monitor, "telegram") as send:
            monitor.handle_incidents([prior, new], NOW)
            send.assert_called_once()
            self.assertIn("AI_AUTH (1)", send.call_args.args[0])
            self.assertNotIn("AI_QUEUE_STALLED", send.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
