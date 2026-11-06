"""Regression tests for failure transitions and incident delivery, no external APIs."""
import datetime as dt
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import watchdog_checks as checks
import telegram_watchdog as monitor

NOW = dt.datetime(2026, 11, 6, 22, 0, tzinfo=dt.timezone.utc)


def iso(minutes_ago):
    return (NOW - dt.timedelta(minutes=minutes_ago)).isoformat()


def table(*rows):
    return [list(rows[0])] + [list(row) for row in rows[1:]]


QCOLS = ["Queue Gmail-ID", "Queue Eingang UTC", "Queue Bildstatus",
         "Queue Fehler", "KI Verarbeitungsstatus", "KI Fehler",
         "KI Aktualisiert UTC", "KI Datensatz-ID", "KI Wiederholung ab UTC",
         "KI Versuche", "KI Abgeschlossene Anzeigen JSON", "Queue Inseratslinks JSON"]

LCOLS = ["Datensatz-ID", "Eingang (UTC)", "Status", "KI-Bewertung",
         "Miete", "Fläche", "Anzeigenlink", "Bildanalyse JSON", "Zu löschen"]

DCOLS = ["Zeit (UTC)", "Gmail-ID", "Datensatz-ID", "Status", "Haupteintrag-ID"]


def queue(mail_id="mail1", age=60, mail_status="ready_for_ai",
          ai_status="retry", error="", attempts=0, retry_age=-30,
          listing_id="idealista:123", done="[]"):
    values = [mail_id, iso(age), mail_status, "", ai_status, error,
              iso(age), listing_id, iso(retry_age), attempts, done,
              '["https://www.idealista.com/inmueble/123/"]']
    return [QCOLS, values]


def listing(id="idealista:123", age=40, status="Geeignet",
            ai="Abgeschlossen", rent="1100", area="70", updated_age=30):
    data = json.dumps({"ai_pipeline": {"updated_at": iso(updated_age)}})
    return [LCOLS, [id, iso(age), status, ai, rent, area,
                    "https://www.idealista.com/inmueble/123/", data, "FALSE"]]


def codes(issues):
    return {x["code"] for x in issues}


class HealthRules(unittest.TestCase):
    def test_missing_gmail_even_when_trashed(self):
        messages = [{"id": "not-imported", "received": iso(25)}]
        found = checks.inspect([QCOLS], [LCOLS], [DCOLS], set(), NOW, messages)
        self.assertIn("MAIL_NOT_IMPORTED", codes(found))

    def test_recent_gmail_within_grace(self):
        found = checks.inspect([QCOLS], [LCOLS], [DCOLS], set(), NOW,
                               [{"id": "new", "received": iso(5)}])
        self.assertEqual(found, [])

    def test_api_429_scheduled_retry(self):
        rows = queue(error="OpenAI HTTP 429", attempts=2, age=65,
                     retry_age=-30)
        found = checks.inspect(rows, [LCOLS], [DCOLS], set(), NOW)
        self.assertIn("AI_HTTP_429", codes(found))
        self.assertNotIn("AI_QUEUE_STALLED", codes(found))

    def test_overdue_retry(self):
        rows = queue(error="OpenAI HTTP 500", attempts=3, age=95, retry_age=20)
        found = checks.inspect(rows, [LCOLS], [DCOLS], set(), NOW)
        self.assertIn("AI_API_RETRIES", codes(found))
        self.assertIn("AI_QUEUE_STALLED", codes(found))

    def test_needs_review_immediate(self):
        rows = queue(age=5, ai_status="needs_review",
                     error="KI-API-Ergebnis ungeklärt")
        self.assertIn("AI_NEEDS_REVIEW",
                      codes(checks.inspect(rows, [LCOLS], [DCOLS], set(), NOW)))

    def test_blocked_mail_is_not_incident(self):
        rows = queue(age=80, mail_status="blocked", ai_status="blocked")
        self.assertEqual(checks.inspect(rows, [LCOLS], [DCOLS], set(), NOW), [])

    def test_eligible_unsent_notification(self):
        found = checks.inspect([QCOLS], listing(), [DCOLS], set(), NOW)
        self.assertIn("TELEGRAM_NOT_SENT", codes(found))

    def test_sent_is_healthy(self):
        found = checks.inspect([QCOLS], listing(), [DCOLS], {"idealista:123"}, NOW)
        self.assertEqual(found, [])

    def test_excluded_does_not_send(self):
        found = checks.inspect([QCOLS], listing(status="Ausgeschlossen"),
                               [DCOLS], set(), NOW)
        self.assertNotIn("TELEGRAM_NOT_SENT", codes(found))

    def test_missing_verified_fields(self):
        found = checks.inspect([QCOLS], listing(rent=""), [DCOLS], set(), NOW)
        self.assertIn("LISTING_FIELDS_MISSING", codes(found))

    def test_48h_ai_expiry(self):
        rows = queue(age=49 * 60, ai_status="retry", retry_age=10)
        found = checks.inspect(rows, [LCOLS], [DCOLS], set(), NOW)
        self.assertIn("AI_EXPIRED", codes(found))

    def test_multi_listing_digest_incomplete(self):
        rows = queue(ai_status="completed", done='["idealista:123"]', age=40)
        rows[1][-1] = json.dumps(["https://www.idealista.com/inmueble/123/",
                                   "https://www.idealista.com/inmueble/456/"])
        found = checks.inspect(rows, listing(status="Ausgeschlossen"),
                               [DCOLS], set(), NOW)
        self.assertIn("DIGEST_INCOMPLETE", codes(found))

    def test_duplicate_without_canonical(self):
        decisions = [DCOLS, [iso(10), "m", "idealista:456", "duplicate", ""]]
        found = checks.inspect([QCOLS], [LCOLS], decisions, set(), NOW)
        self.assertIn("DUPLICATE_MAPPING", codes(found))


class AlertDelivery(unittest.TestCase):
    def test_failed_telegram_is_not_acknowledged(self):
        issue = None
        critical = checks.problem("AI_HTTP_429", "idealista:123", "429")
        with mock.patch.object(monitor, "open_incident", return_value=issue), \
             mock.patch.object(monitor, "telegram", side_effect=RuntimeError("offline")), \
             mock.patch.object(monitor, "gh_request") as github:
            with self.assertRaises(RuntimeError):
                monitor.handle_incidents([critical], NOW)
            github.assert_not_called()

    def test_success_persists_after_telegram(self):
        critical = checks.problem("MAIL_NOT_IMPORTED", "mail1", "missing")
        calls = []
        with mock.patch.object(monitor, "open_incident", return_value=None), \
             mock.patch.object(monitor, "telegram",
                               side_effect=lambda *_: calls.append("telegram")), \
             mock.patch.object(monitor, "gh_request",
                               side_effect=lambda *_: calls.append("github")):
            monitor.handle_incidents([critical], NOW)
        self.assertEqual(calls, ["telegram", "github"])

    def test_repeat_is_suppressed_until_reminder(self):
        key = "AI_HTTP_429:123"
        issue = {"number": 10, "body": monitor.incident_body({
            key: {"notified_at": iso(1), "first_seen": iso(10), "detail": "429"}
        })}
        with mock.patch.object(monitor, "open_incident", return_value=issue), \
             mock.patch.object(monitor, "telegram") as telegram, \
             mock.patch.object(monitor, "gh_request"):
            monitor.handle_incidents([checks.problem("AI_HTTP_429", "123", "429")], NOW)
            telegram.assert_not_called()


if __name__ == "__main__":
    unittest.main()
