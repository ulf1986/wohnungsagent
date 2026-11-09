#!/usr/bin/env python3
"""Independent Wohnungsagent monitor: Sheets via service account, Telegram via Bot API.

No Gmail, Apps Script or mailbox sending is required. GitHub Issues store incident
state across ephemeral Actions runners. Only a minimal, non-sensitive summary is posted.
"""
import argparse
import datetime as dt
import json
import re
import os
import sys
from zoneinfo import ZoneInfo
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
               int_or_zero(field(r, 6)) == 0 and
               int_or_zero(field(r, 8)) == 0]
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

def sheet_values(name, bounds, token):
    encoded = urllib.parse.quote(f"'{name}'!{bounds}", safe="")
    response = request_json(f"{API_SHEETS}/{SHEET_ID}/values/{encoded}",
                            headers={"Authorization": "Bearer " + token})
    return response.get("values", [])


def gmail_refresh_token():
    keys = ("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN")
    if not all(os.getenv(k) for k in keys):
        return None
    payload = urllib.parse.urlencode({
        "client_id": os.environ[keys[0]], "client_secret": os.environ[keys[1]],
        "refresh_token": os.environ[keys[2]], "grant_type": "refresh_token"
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=payload,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)["access_token"]
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Gmail OAuth HTTP {error.code}") from None



def is_property_search_notice(subject):
    """Recognize actual saved-search alerts, but not replies or contact messages."""
    value = str(subject or "").strip().lower()
    return (
        value.startswith(("¡nuevo piso", "nuevo ·", "¿te lo perdiste?",
                          "⌂ nuevo", "⌂ se han publicado", "¡bajada de precio",
                          "nuevos inmuebles", "🏠 "))
        or "suchauftrag" in value
        or "nuevos pisos" in value
        or bool(re.match(r"^\\d+ oportunidades en tu búsqueda", value))
        or bool(re.match(r"^\\d+ (?:viviendas|pisos) recién publicados", value))
        or bool(re.match(r"^[^,]+, tienes \\d+ novedades? en alquiler", value))
    )


def gmail_messages():
    """OAuth read-only reconciliation, including already trashed alerts."""
    token = gmail_refresh_token()
    if token is None:
        return None
    headers = {"Authorization": "Bearer " + token}
    query = ('in:anywhere newer_than:6h '
             '{label:"Wohnungssuche/Suchaufträge" '
             'subject:"¡Nuevo piso en tu búsqueda" subject:"Nuevo · Piso"}')
    url = ("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=300&q=" +
           urllib.parse.quote(query))
    response = request_json(url, headers=headers)
    if response.get("nextPageToken"):
        raise RuntimeError("Gmail-Suchabgleich unvollständig: mehr als 300 Kandidaten")
    result = []
    for message in response.get("messages", []):
        mail_id = message["id"]
        meta = request_json(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + mail_id +
            "?format=metadata&metadataHeaders=Subject&metadataHeaders=From",
            headers=headers)
        fields = {h["name"].lower(): h["value"] for h in
                  meta.get("payload", {}).get("headers", [])}
        subject, sender = fields.get("subject", ""), fields.get("from", "").lower()
        if not any(x in sender for x in ("idealista.com", "fotocasa.es", "pisos.com",
                                         "yaencontre.com", "milanuncios.com",
                                         "immobilienscout24.de")):
            continue
        if not is_property_search_notice(subject):
            continue
        received = dt.datetime.fromtimestamp(int(meta["internalDate"]) / 1000, UTC)
        result.append({"id": mail_id, "received": received.isoformat()})
    return result


from watchdog_checks import problem


def actions_health(now):
    result = gh_request("/actions/workflows/telegram-listings.yml/runs?per_page=10")
    completed = [r for r in result.get("workflow_runs", [])
                 if r.get("status") == "completed"]
    if not completed:
        return [problem("TELEGRAM_WORKFLOW_MISSING", "sender", "Kein abgeschlossener Angebotsworkflow.")]
    latest = completed[0]
    parsed = parse_time(latest.get("updated_at"))
    age = (now - parsed).total_seconds() / 60 if parsed else 9999
    alerts = []
    # GitHub Actions scheduled runs can be delayed even when the last
    # run succeeded. Avoid declaring an outage for a 35-45 minute gap.
    if age > 65:
        alerts.append(problem("TELEGRAM_WORKFLOW_STALE", "sender",
                              f"Angebotsworkflow seit {round(age)} Min. nicht abgeschlossen.",
                              "critical" if age > 90 else "warning"))
    if latest.get("conclusion") != "success":
        alerts.append(problem("TELEGRAM_WORKFLOW_FAILED", "sender",
                              f"Angebotsworkflow {latest.get('conclusion')}; Run {latest.get('id')}."))
    return alerts


def incident_state(issue):
    if not issue:
        return {}
    match = re.search(r"\x60{3}json\s*(\{[\s\S]*?\})\s*\x60{3}",
                      issue.get("body") or "")
    if not match:
        return {}
    try:
        state = json.loads(match.group(1))
        return state.get("alerts", {}) if isinstance(state.get("alerts"), dict) else {}
    except (ValueError, TypeError):
        return {}


def incident_body(state):
    fence = chr(96) * 3
    return ("Automatisch verwaltete Monitoring-Zustände. Bitte nicht bearbeiten.\n\n" +
            fence + "json\n" + json.dumps({"version": 2, "alerts": state},
                                           ensure_ascii=False, separators=(",", ":")) +
            "\n" + fence)


def handle_incidents(alerts, now, known_mail_ids=None):
    """Telegram acknowledgement is persisted only AFTER successful delivery."""
    issue = open_incident()
    previous = incident_state(issue)
    active = {a["key"]: a for a in alerts}
    # A Gmail alert must survive its bounded Gmail search window. Clear it
    # only after the mail is actually present in the Queue/Decisions ledger.
    if known_mail_ids is not None:
        for key, old in previous.items():
            if key.startswith("MAIL_NOT_IMPORTED:") and key not in active:
                mail_id = key.partition(":")[2]
                if mail_id not in known_mail_ids:
                    active[key] = {"key": key, "code": "MAIL_NOT_IMPORTED",
                                   "severity": old.get("severity", "critical"),
                                   "detail": old.get("detail", "Mail weiterhin nicht importiert."),
                                   "mail_received": old.get("mail_received")}
    # New critical incidents go out immediately on the next watchdog run.
    # Existing incidents are summarized every four hours rather than individually.
    notifications = []
    for key, alert in active.items():
        last = parse_time(previous.get(key, {}).get("notified_at"))
        if last is None or (now - last).total_seconds() >= 240 * 60:
            notifications.append(alert)
    recovered = [key for key in previous if key not in active]
    if notifications:
        categories = {}
        for alert in notifications:
            name = alert["code"]
            bucket = categories.setdefault(name, {"critical": False, "count": 0,
                                                    "examples": []})
            bucket["count"] += 1
            bucket["critical"] |= alert["severity"] == "critical"
            if len(bucket["examples"]) < 2:
                received = alert.get("mail_received")
                example = alert["detail"]
                if received:
                    example += "\n    E-Mail eingegangen: " + received + " Uhr (Málaga)"
                bucket["examples"].append(example)
        lines = ["🚨 Wohnungsagent: " + str(len(notifications)) +
                 " neue oder weiterhin bestehende Störungen",
                 "Prüfung: " + now.astimezone(ZoneInfo("Europe/Madrid")).strftime("%d.%m.%Y %H:%M") + " Uhr (Málaga)"]
        for name, bucket in sorted(categories.items(), key=lambda item:
                                   (not item[1]["critical"], item[0])):
            lines.append(("❗ " if bucket["critical"] else "⚠️ ") +
                         name + " (" + str(bucket["count"]) + ")")
            for example in bucket["examples"]:
                lines.append("  " + example)
        if recovered:
            lines.append("✅ " + str(len(recovered)) + " Störung(en) behoben.")
        telegram("\n".join(lines)[:3900])
    elif recovered and not active:
        # Only one all-clear message; individual recoveries are recorded in the
        # issue without generating a second noisy Telegram message.
        telegram("✅ Wohnungsagent: Alle Monitoring-Störungen behoben.")
    next_state = {}
    for key, alert in active.items():
        old = previous.get(key, {})
        next_state[key] = {
            "severity": alert["severity"], "detail": alert["detail"],
            "mail_received": alert.get("mail_received") or old.get("mail_received"),
            "first_seen": old.get("first_seen") or now.isoformat(),
            "notified_at": now.isoformat() if alert in notifications else old.get("notified_at")
        }
    if next_state:
        if issue:
            gh_request("/issues/" + str(issue["number"]), "PATCH",
                       {"body": incident_body(next_state)})
        else:
            gh_request("/issues", "POST",
                       {"title": INCIDENT_TITLE, "body": incident_body(next_state)})
    elif issue:
        gh_request("/issues/" + str(issue["number"]), "PATCH",
                   {"state": "closed", "state_reason": "completed"})
    return len(active)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["check", "test"], default="check")
    args = parser.parse_args()
    if args.mode == "test":
        telegram("✅ Wohnungsagent: Telegram-Test erfolgreich. Der GitHub-Workflow kann Nachrichten senden.")
        print("Telegram-Testnachricht gesendet.")
        return 0
    from watchdog_checks import inspect
    now = dt.datetime.now(UTC)
    alerts = []
    known_mail_ids = None
    try:
        token = google_token()
        runs = sheet_values("Läufe", "A1:O3000", token)
        status, reason = evaluate(runs, now)
        if status == "critical":
            alerts.append(problem("PIPELINE_HEALTH", "pipeline", reason))
        queues = sheet_values("Verarbeitung", "H1:AC4000", token)
        listings = sheet_values("Anzeigen", "A1:AO4000", token)
        decisions = sheet_values("Entscheidungen", "A1:H10000", token)
        known_mail_ids = {str(row[0]) for row in queues[1:] if row and row[0]}
        if decisions:
            headers = [str(x) for x in decisions[0]]
            if "Gmail-ID" in headers:
                idx = headers.index("Gmail-ID")
                known_mail_ids.update(str(row[idx]) for row in decisions[1:]
                                      if len(row) > idx and row[idx])
        prior_issues = gh_request("/issues?state=open&per_page=100")
        sender = next((x for x in prior_issues if
                       x.get("title") == "[Wohnungsagent] Telegram-Anzeigen Versandstatus"), None)
        sent = set()
        if sender:
            match = re.search(r"\x60{3}json\s*(\{[\s\S]*?\})\s*\x60{3}",
                              sender.get("body") or "")
            if match:
                sent = set(json.loads(match.group(1)).get("sent", []))
        try:
            emails = gmail_messages()
            if emails is None:
                alerts.append(problem("GMAIL_MONITOR_NOT_CONFIGURED", "gmail",
                                      "Unabhängiger Gmail-Abgleich benötigt drei OAuth-Secrets.",
                                      "warning"))
        except Exception as error:
            emails = None
            alerts.append(problem("GMAIL_MONITOR_ERROR", "gmail", str(error)[:180]))
        alerts.extend(inspect(queues, listings, decisions, sent, now, emails))
    except Exception as error:
        alerts.append(problem("MONITOR_DATA_ERROR", "sheets",
                              "Monitoringdaten nicht lesbar: " + str(error)[:160]))
    try:
        alerts.extend(actions_health(now))
    except Exception as error:
        alerts.append(problem("ACTIONS_MONITOR_ERROR", "actions", str(error)[:160]))
    print("Watchdog: ", len(alerts), "aktive Probleme:",
          ", ".join(a["code"] for a in alerts[:20]))
    # Incidents are tracked and notified by handle_incidents. A detected issue
    # must not fail the GitHub workflow and generate another failure email.
    handle_incidents(alerts, now, known_mail_ids)
    return 0


if __name__ == "__main__":
    sys.exit(main())
