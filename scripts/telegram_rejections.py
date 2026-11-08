#!/usr/bin/env python3
"""Telegram notices for newly rejected listings based on persisted KI decisions.

Uses the existing Telegram sender and a separate GitHub issue as durable
deduplication state. Existing decisions are seeded silently on first startup.
"""
import datetime as dt
import html
import json
import os
import re
import sys

from telegram_watchdog import gh_request, google_token, request_json, sheet_values, parse_time
from urllib.parse import urlsplit, urlunsplit

UTC = dt.timezone.utc
STATE_TITLE = "[Wohnungsagent] Telegram-Ablehnungen Versandstatus"
MAX_PER_RUN = 8
LOOKBACK_HOURS = 48


def rejected_decisions(rows, now):
    if not rows:
        return []
    header = {str(v).strip(): i for i, v in enumerate(rows[0])}
    needed = ["Zeit (UTC)", "Stufe", "Gmail-ID", "Datensatz-ID", "Status", "Grund / Hinweis"]
    if not all(key in header for key in needed):
        raise RuntimeError("Entscheidungen: Pflichtspalten für Ablehnungen fehlen")

    def field(row, name):
        index = header[name]
        return str(row[index] or "").strip() if index < len(row) else ""

    result = []
    for row in rows[1:]:
        if field(row, "Stufe").lower() != "ki":
            continue
        if field(row, "Status").lower() != "blocked":
            continue
        reason = field(row, "Grund / Hinweis")
        if not reason.lower().startswith("ausschluss:"):
            # Intentionally ignore blacklist hits, duplicates and technical failures.
            continue
        listing_id = field(row, "Datensatz-ID")
        mail_id = field(row, "Gmail-ID")
        when = parse_time(field(row, "Zeit (UTC)"))
        if not listing_id or not mail_id or when is None or when > now:
            continue
        result.append({"id": listing_id, "mail_id": mail_id,
                       "reason": reason, "timestamp": when})
    # Earliest decisive rejection per listing; replay must not notify twice.
    result.sort(key=lambda item: (item["timestamp"], item["id"]))
    unique = {}
    for item in result:
        unique.setdefault(item["id"], item)
    return list(unique.values())



def find_listing_url(listing_id, mail_id, queue_rows):
    """Locate the actual property URL in the original imported mail, never a Gmail deep link."""
    if ":" not in listing_id or not queue_rows:
        return ""
    provider, number = listing_id.split(":", 1)
    allowed = {
        "yaencontre": "yaencontre.com",
        "idealista": "idealista.com",
        "fotocasa": "fotocasa.es",
        "pisos": "pisos.com",
        "milanuncios": "milanuncios.com",
        "immoscout": "is24.de",
    }
    domain = allowed.get(provider.lower())
    if not domain or not number.isdigit():
        return ""
    header = {str(value).strip(): i for i, value in enumerate(queue_rows[0])}
    mail_index = header.get("Queue Gmail-ID")
    links_index = header.get("Queue Inseratslinks JSON")
    if mail_index is None or links_index is None:
        return ""
    for row in queue_rows[1:]:
        if mail_index >= len(row) or str(row[mail_index]).strip() != mail_id:
            continue
        if links_index >= len(row):
            continue
        try:
            links = json.loads(row[links_index])
        except (ValueError, TypeError):
            continue
        if not isinstance(links, list):
            continue
        for link in links:
            if not isinstance(link, str):
                continue
            parsed = urlsplit(link)
            hostname = (parsed.hostname or "").lower()
            if parsed.scheme != "https" or not (hostname == domain or hostname.endswith("." + domain)):
                continue
            # ID must appear in the property path, not merely in tracking parameters.
            if re.search(r"(?<!\\d)" + re.escape(number) + r"(?!\\d)", parsed.path):
                return urlunsplit(("https", parsed.netloc, parsed.path, "", ""))
    return ""


def message(item):
    provider = item["id"].split(":", 1)[0].capitalize()
    reason = re.sub(r"\s+", " ", item["reason"]).strip()
    listing_url = item.get("listing_url", "")
    return ("❌ <b>Wohnung ausgeschlossen</b>\n"
            + "Portal: " + html.escape(provider) + "\n"
            + "Inserat: <code>" + html.escape(item["id"]) + "</code>\n"
            + "Grund: " + html.escape(reason[:650]) + "\n"
            + ('<a href="' + html.escape(listing_url, quote=True) + '">Inserat öffnen</a>'\n               if listing_url else "Inserat-Link nicht verfügbar"))


def send(item):
    token, chat = os.getenv("TELEGRAM_BOT_TOKEN"), os.getenv("TELEGRAM_CHAT_ID")
    if not token or not chat:
        raise RuntimeError("Telegram Secrets fehlen")
    response = request_json("https://api.telegram.org/bot" + token + "/sendMessage",
                            method="POST", body={
                                "chat_id": chat, "parse_mode": "HTML",
                                "text": message(item),
                                "disable_web_page_preview": True,
                                "disable_notification": True
                            })
    if not response.get("ok"):
        raise RuntimeError("Telegram hat die Ablehnungsmeldung abgelehnt")


def load_state():
    issues = gh_request("/issues?state=open&per_page=100")
    issue = next((i for i in issues if i.get("title") == STATE_TITLE
                  and "pull_request" not in i), None)
    if issue is None:
        return None, set()
    match = re.search(r"```json\s*(\{.*?\})\s*```", issue.get("body") or "", re.S)
    if not match:
        raise RuntimeError("Ablehnungs-Versandhistorie beschädigt; Versand gestoppt")
    state = json.loads(match.group(1))
    if state.get("version") != 1 or not isinstance(state.get("sent"), list):
        raise RuntimeError("Ablehnungs-Versandhistorie hat ein unbekanntes Format")
    return issue, set(state["sent"])


def save_state(issue, sent):
    body = ("Automatisch verwaltete Telegram-Ablehnungen. Nicht bearbeiten.\n\n"
            + "```json\n" + json.dumps({"version": 1, "sent": sorted(sent)},
                                            separators=(",", ":"), ensure_ascii=False)
            + "\n```")
    if issue is None:
        return gh_request("/issues", method="POST",
                          body={"title": STATE_TITLE, "body": body})
    gh_request("/issues/" + str(issue["number"]), method="PATCH",
               body={"body": body})
    return issue


def main():
    now = dt.datetime.now(UTC)
    decisions = sheet_values("Entscheidungen", "A1:H4000", google_token())
    events = rejected_decisions(decisions, now)
    queue = sheet_values("Verarbeitung", "H1:L1500", google_token())
    for event in events:
        event["listing_url"] = find_listing_url(event["id"], event["mail_id"], queue)
    issue, sent = load_state()
    if issue is None:
        # First enablement must not spam historical/replayed decisions.
        sent.update(event["id"] for event in events)
        issue = save_state(None, sent)
        print("Ablehnungen: bestehende " + str(len(sent)) + " Inserate still vorgemerkt.")
        return 0
    cutoff = now - dt.timedelta(hours=LOOKBACK_HOURS)
    pending = [event for event in events
               if event["timestamp"] >= cutoff and event["id"] not in sent]
    for event in pending[:MAX_PER_RUN]:
        send(event)
        sent.add(event["id"])
        save_state(issue, sent)
        print("Telegram Ablehnung gesendet:", event["id"])
    print("Ablehnungen: " + str(len(pending)) + " neu, "
          + str(max(0, len(pending) - MAX_PER_RUN)) + " offen.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
