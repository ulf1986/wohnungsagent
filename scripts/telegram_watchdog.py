#!/usr/bin/env python3
"""Independent Wohnungsagent monitor: Sheets via service account, Telegram via Bot API.

No Gmail, Apps Script or mailbox sending is required. GitHub Issues store incident
state across ephemeral Actions runners. Only a minimal, non-sensitive summary is posted.
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

SHEET_ID = "1_X-jdVIKwbqDABIssOOCjLC41qRqpb01paV1RtruMwg"
INCIDENT_TITLE = "[Wohnungsagent] Monitoring-Störung"
API_GITHUB = "https://api.github.com"
API_SHEETS = "https://sheets.googleapis.com/v4/spreadsheets"
UTC = dt.timezone.utc

def request_json(url, method="GET", body=None, headers=None, timeout=25):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    head = {"Accept": "application/json", "User-Agent": "wohnungsagent-monitor"}
    if body is not None:
        head["Content-Type"] = "application/json"
    head.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=head, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Do not echo request URLs: Telegram bot token is part of its API URL.
        raise RuntimeError(f"HTTP {error.code} from {urllib.parse.urlsplit(url).hostname}") from None

def telegram(message):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat:
        raise RuntimeError("TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID fehlt")
    request_json(f"https://api.telegram.org/bot{token}/sendMessage",
                 method="POST", body={"chat_id": chat, "text": message,
                                      "disable_web_page_preview": True})

def google_token():
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON fehlt")
    from google.oauth2 import service_account
    from google.auth.transport.requests import Request
    credentials = service_account.Credentials.from_service_account_info(
        json.loads(raw), scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    credentials.refresh(Request())
    return credentials.token

def sheet_rows():
    access = google_token()
    range_name = urllib.parse.quote("'Läufe'!A1:O3000", safe="")
    url = f"{API_SHEETS}/{SHEET_ID}/values/{range_name}"
    result = request_json(url, headers={"Authorization": "Bearer " + access})
    return result.get("values", [])

def parse_time(value):
    if not value:
        return None
    try:
        x = dt.datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        if x.tzinfo is None:
            x = x.replace(tzinfo=UTC)
        return x.astimezone(UTC)
    except ValueError:
        return None

def field(row, index):
    return str(row[index]).strip() if len(row) > index else ""

def evaluate(rows, now):
    if len(rows) < 2:
        return "critical", "Das Blatt Läufe enthält keine abgeschlossenen Läufe."
    valid = [(parse_time(field(r, 2)), r) for r in rows[1:]]
    valid = [(ts, r) for ts, r in valid if ts is not None]
    if not valid:
        return "critical", "Kein gültiger Abschlusszeitpunkt in Läufe."
    valid.sort(key=lambda item: item[0])
    last, row = valid[-1]
    age = (now - last).total_seconds() / 60
    if age > 25:
        return "critical", f"Letzter abgeschlossener Lauf vor {round(age)} Minuten."
    if field(row, 4).lower() in ("failed", "error"):
        return "critical", "Letzter Lauf meldet einen Fehler: " + field(row, 12)[:180]
    if field(row, 4).lower() in ("warning", "warn"):
        return "critical", "Letzter Lauf meldet eine Warnung: " + field(row, 12)[:180]

    # Detect a persistent backlog without requiring new messages to arrive.
    recent = [(ts, r) for ts, r in valid if (now - ts).total_seconds() <= 45 * 60]
    stalled = [r for _, r in recent if int_or_zero(field(r, 5)) > 0 and
               int_or_zero(field(r, 6)) == 0]
    if len(stalled) >= 2 and len(stalled) == len(recent):
        return "critical", f"Letzte {len(stalled)} Läufe fanden Mails, importierten aber keine."
    if len(stalled) >= 3:
        return "critical", f"{len(stalled)} Läufe in 45 Minuten ohne Gmail-Import trotz Kandidaten."
    return "ok", "Letzter Pipeline-Lauf abgeschlossen; keine anhaltende Störung erkannt."

def int_or_zero(text):
    try:
        return int(float(text))
    except ValueError:
        return 0

def gh_request(path, method="GET", body=None):
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo:
        raise RuntimeError("GitHub Repository oder Token fehlt")
    return request_json(API_GITHUB + "/repos/" + repo + path, method, body,
                        headers={"Authorization": "Bearer " + token,
                                 "X-GitHub-Api-Version": "2022-11-28",
                                 "Accept": "application/vnd.github+json"})

def open_incident():
    issues = gh_request("/issues?state=open&per_page=100")
    return next((i for i in issues if i.get("title") == INCIDENT_TITLE and
                 "pull_request" not in i), None)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["check", "test"], default="check")
    args = parser.parse_args()
    if args.mode == "test":
        telegram("✅ Wohnungsagent: Telegram-Test erfolgreich. Der GitHub-Workflow kann Nachrichten senden.")
        print("Telegram-Testnachricht gesendet.")
        return 0

    try:
        status, reason = evaluate(sheet_rows(), dt.datetime.now(UTC))
    except Exception as error:
        status, reason = "critical", "Monitoring kann Google Sheets nicht lesen: " + str(error)[:180]

    print("Prüfergebnis:", status, reason)
    incident = open_incident()
    if status == "critical":
        if incident:
            print("Störung bereits gemeldet; kein erneuter Push.")
            return 1
        # Create issue first to suppress duplicate alerts on the next run.
        issue = gh_request("/issues", method="POST",
                           body={"title": INCIDENT_TITLE,
                                 "body": "Automatischer Monitor-Alarm (UTC): " +
                                 dt.datetime.now(UTC).isoformat() +
                                 "\n\n" + reason +
                                 "\n\nQuelle: Google Sheets > Läufe."})
        try:
            telegram("🚨 Wohnungsagent: Störung erkannt\n" + reason +
                     "\nDetails: " + issue.get("html_url", "GitHub Issues"))
        except Exception as error:
            print("Telegram-Alarm fehlgeschlagen:", error, file=sys.stderr)
            return 2
        return 1

    if incident:
        telegram("✅ Wohnungsagent: Entwarnung\n" + reason)
        gh_request("/issues/" + str(incident["number"]), method="PATCH",
                   body={"state": "closed", "state_reason": "completed"})
    return 0

if __name__ == "__main__":
    sys.exit(main())
