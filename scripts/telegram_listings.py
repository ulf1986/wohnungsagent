#!/usr/bin/env python3
"""Send Telegram cards for newly suitable, fully assessed housing listings.

State is persisted in one GitHub issue to survive ephemeral Actions runners.
Existing historical listings are seeded silently at first activation, except
suitable listings received during the preceding 24 hours.
"""
import datetime as dt
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import urllib.error

from telegram_watchdog import SHEET_ID, request_json, google_token, gh_request, parse_time

STATE_TITLE = "[Wohnungsagent] Telegram-Anzeigen Versandstatus"
MAX_PER_RUN = 6
UTC = dt.timezone.utc

def cells():
    encoded = urllib.parse.quote("'Anzeigen'!A1:AO4000", safe="")
    result = request_json(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{encoded}",
        headers={"Authorization": "Bearer " + google_token()})
    rows = result.get("values", [])
    if not rows:
        return []
    headers = [str(h).strip() for h in rows[0]]
    return [dict(zip(headers, row)) for row in rows[1:]]

def text(row, name):
    return str(row.get(name, "") or "").strip()

def number(value):
    s = re.sub(r"[^0-9,.-]", "", str(value or ""))
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    elif s.count(".") == 1 and len(s.rsplit(".", 1)[1]) == 3:
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None

def eligible(row):
    if text(row, "Zu löschen").lower() in ("true", "ja", "yes", "1"):
        return False
    if text(row, "Status").lower() != "geeignet":
        return False
    if text(row, "KI-Bewertung").lower() != "abgeschlossen":
        return False
    rent, area = number(text(row, "Miete")), number(text(row, "Fläche"))
    if rent is None or area is None or not (800 <= rent <= 1200 and area >= 60):
        return False
    return bool(text(row, "Datensatz-ID") and text(row, "Anzeigenlink"))

def listing_time(row):
    return parse_time(text(row, "Eingang (UTC)"))

def source_photo(row):
    try:
        data = json.loads(text(row, "Bildanalyse JSON") or "{}")
        photos = data.get("drive_files", [])
        for p in photos:
            url = str(p.get("source_url", ""))
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme == "https" and parsed.hostname and parsed.hostname.endswith((
                    ".idealista.com", ".fotocasa.es", ".pisos.com", ".yaencontre.com")):
                return url
    except (ValueError, TypeError, AttributeError):
        pass
    return ""

def card(row):
    title = text(row, "Titel")[:140] or text(row, "Datensatz-ID")
    url = text(row, "Anzeigenlink")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https":
        raise ValueError("Inseratslink ist kein HTTPS-Link")
    # Only tracking parameters are removed; preserve URLs that need a query.
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query = [(k, v) for k, v in query if not k.startswith("utm_")]
    clean_url = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
    rent = number(text(row, "Miete"))
    area = number(text(row, "Fläche"))
    per_m2 = rent / area if rent and area else 0
    details = []
    try:
        data = json.loads(text(row, "Bildanalyse JSON") or "{}")
        fields = data.get("extracted_fields") or (data.get("ai_pipeline") or {}).get("email_fields") or {}
        rooms = fields.get("rooms")
        if rooms:
            details.append(f"{rooms} Zimmer")
    except (ValueError, TypeError, AttributeError):
        pass
    details.extend([f"{int(area)} m²", f"{int(rent)} €/Monat", f"{per_m2:.1f} €/m²"])
    score = text(row, "Wohnungsbewertung (0–100)")
    price_score = text(row, "Preisbewertung (0–100)")
    lines = ["🏠 <b>Neue passende Wohnung</b>",
             html.escape(title),
             "",
             " · ".join(details)]
    if score or price_score:
        lines.append("Bewertung: Wohnung " + html.escape(score or "?") +
                     "/100 · Preis " + html.escape(price_score or "?") + "/100")
    summary = re.sub(r"\s+", " ", text(row, "Zusammenfassung")).strip()
    if summary:
        lines.extend(["", html.escape(summary[:250]) + ("…" if len(summary) > 250 else "")])
    lines.extend(["", f'<a href="{html.escape(clean_url, quote=True)}">Inserat öffnen</a>'])
    return "\n".join(lines)[:1000]

def send(row):
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        raise RuntimeError("Telegram Secrets fehlen")
    base = f"https://api.telegram.org/bot{token}/"
    payload = {"chat_id": chat, "parse_mode": "HTML",
               "disable_notification": False}
    photo = source_photo(row)
    message = card(row)
    if photo:
        try:
            response = request_json(base + "sendPhoto", method="POST",
                                    body=dict(payload, photo=photo, caption=message),
                                    timeout=35)
            if response.get("ok"): return
        except Exception:
            print("Bild konnte nicht versendet werden; Text-Fallback.")
    response = request_json(base + "sendMessage", method="POST",
                            body=dict(payload, text=message,
                                      disable_web_page_preview=True))
    if not response.get("ok"):
        raise RuntimeError("Telegram hat die Nachricht abgelehnt")

def issue_body(ids):
    return ("Automatisch verwaltete Versandhistorie. Bitte nicht bearbeiten.\n\n"
            + "```json\n" + json.dumps({"version":1, "sent":sorted(ids)},
                                          ensure_ascii=False, separators=(",", ":"))
            + "\n```")

def load_issue():
    issues = gh_request("/issues?state=open&per_page=100")
    issue = next((x for x in issues if x.get("title") == STATE_TITLE and
                  "pull_request" not in x), None)
    if not issue:
        return None, set()
    match = re.search(r"```json\s*(\{.*?\})\s*```", issue.get("body") or "", re.S)
    if not match:
        raise RuntimeError("Versandhistorie beschädigt; Versand aus Sicherheitsgründen gestoppt")
    return issue, set(json.loads(match.group(1)).get("sent", []))

def save(issue, ids):
    body = issue_body(ids)
    if issue is None:
        return gh_request("/issues", method="POST",
                          body={"title":STATE_TITLE,"body":body})
    gh_request("/issues/" + str(issue["number"]), method="PATCH", body={"body":body})
    return issue

def main():
    now = dt.datetime.now(UTC)
    listings = cells()
    issue, seen = load_issue()
    if issue is None:
        # Do not trigger historical flood on first run.
        seen.update(text(r, "Datensatz-ID") for r in listings
                    if text(r, "Datensatz-ID") and
                    (listing_time(r) is None or
                     listing_time(r) < now - dt.timedelta(hours=24)))
        issue = save(None, seen)
        print("Versandhistorie erstmalig initialisiert.")

    pending = [r for r in listings if eligible(r) and
               text(r, "Datensatz-ID") not in seen]
    pending.sort(key=lambda r: (listing_time(r) or now, text(r, "Datensatz-ID")))
    for row in pending[:MAX_PER_RUN]:
        listing_id = text(row, "Datensatz-ID")
        send(row)
        seen.add(listing_id)
        save(issue, seen)
        print("Telegram-Nachricht gesendet für", listing_id)
    print(f"Geprüfte Anzeigen: {len(listings)}; ausstehend: {max(0,len(pending)-MAX_PER_RUN)}.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
