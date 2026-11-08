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

def sheet_matrix(range_a1):
    """Small read-only sheet lookup. Never fetch email bodies just to send links."""
    encoded = urllib.parse.quote(range_a1, safe="")
    return request_json(
        f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{encoded}",
        headers={"Authorization": "Bearer " + google_token()}).get("values", [])


def preliminary_listing_id(url):
    """IDs are always portal-qualified. Never equate numeric IDs across sites."""
    parsed = urllib.parse.urlsplit(str(url or ""))
    if parsed.scheme != "https":
        return ""
    host = (parsed.hostname or "").lower()
    path = parsed.path
    patterns = (
        ("idealista", r"(^|\.)idealista\.com$", r"/inmueble/(\d+)"),
        ("yaencontre", r"(^|\.)yaencontre\.com$", r"/inmueble-\d+-(\d+)"),
        ("fotocasa", r"(^|\.)fotocasa\.es$", r"/(\d+)(?:/d)?/?$"),
        ("pisos", r"(^|\.)pisos\.com$", r"-(\d{6,})_"),
        ("milanuncios", r"(^|\.)milanuncios\.com$", r"(\d{6,})\.htm"),
    )
    for provider, host_pat, path_pat in patterns:
        if re.search(host_pat, host) and (match := re.search(path_pat, path)):
            return f"{provider}:{match.group(1) if provider == 'idealista' else match.group(1)}"
    return ""


def screened_facts(row):
    """Use sheet fields first, then strictly validated existing extraction data."""
    if not row:
        return {"rent": None, "area": None, "rooms": None}
    rent, area, rooms = number(text(row, "Miete")), number(text(row, "Fläche")), None
    try:
        data = json.loads(text(row, "Bildanalyse JSON") or "{}")
        extracted = data.get("extracted_fields") or {}
        email = (data.get("ai_pipeline") or {}).get("email_fields") or {}
        if rent is None:
            rent = number(extracted.get("rent_eur", email.get("rent_eur")))
        if area is None:
            area = number(extracted.get("area_m2", email.get("area_m2")))
        rooms = number(extracted.get("rooms", email.get("rooms")))
    except (TypeError, ValueError, AttributeError):
        pass
    return {"rent": rent, "area": area, "rooms": rooms}


def hard_excluded(row):
    """Reject on explicit evidence; unresolved numbers must never be invented."""
    if not row:
        return False
    if text(row, "Zu löschen").lower() in ("true", "ja", "yes", "1"):
        return True
    if text(row, "Status").lower() in ("ausgeschlossen", "nicht verfügbar"):
        return True
    facts = screened_facts(row)
    rent, area, rooms = facts["rent"], facts["area"], facts["rooms"]
    if rent is not None and not 800 <= rent <= 1200:
        return True
    if area is not None and area < 60:
        return True
    if rooms is not None and rooms < 2:
        return True
    return False

def first_attempt_finished(queue, row, listing_id):
    """A link alone, or ready_for_ai, is NOT evidence of a screening attempt."""
    if row:
        try:
            data = json.loads(text(row, "Bildanalyse JSON") or "{}")
            pipe = data.get("ai_pipeline") or {}
            operation = pipe.get("api_operation") or {}
            if pipe.get("email_fields") and operation.get("status") == "stored":
                return True
            if pipe.get("email_fields") and pipe.get("stage") in ("images", "completed"):
                return True
        except (TypeError, ValueError, AttributeError):
            pass
    ai_state = str(queue.get("ai_status") or "").lower()
    attempts = number(queue.get("ai_attempts"))
    owner = queue.get("active_id") or queue.get("last_id")
    return (owner == listing_id and
            ai_state in ("retry", "failed_final", "needs_review", "expired") and
            ((attempts is not None and attempts >= 1) or
             bool(queue.get("ai_error"))))


def early_candidates(now, seen, current):
    """Send a fallback only AFTER one screening attempt, never on raw link receipt.

    Hard exclusions, blocklist, confirmed/candidate duplicates and already-sent
    IDs all win over the fallback path. Unknown sizes remain labelled unverified.
    """
    headers = sheet_matrix("'Verarbeitung'!H1:J2000")
    link_col = sheet_matrix("'Verarbeitung'!L1:L2000")
    import_states = sheet_matrix("'Verarbeitung'!O1:Y2000")
    blocked = sheet_matrix("'Sperrliste'!A2:A2000")
    registry = sheet_matrix("'Duplikate'!A2:C2000")
    decisions = sheet_matrix("'Entscheidungen'!A1:H10000")
    forbidden = {str(row[0]).strip().lower() for row in blocked if row and row[0]}
    duplicate_states = {
        str(r[0]).strip().lower(): (str(r[1]).strip().lower() if len(r) > 1 else "",
                                   str(r[2]).strip().lower() if len(r) > 2 else "")
        for r in registry if r and r[0]
    }
    # A past final decision must not be undone by an outdated queue entry.
    final_decisions = {}
    for d in decisions[1:]:
        if len(d) > 5 and d[4]:
            final_decisions[str(d[4]).lower()] = str(d[5]).lower()
    excluded_decisions = {"blocked", "duplicate", "unavailable", "excluded"}
    candidates = {}
    for index, row in enumerate(headers[1:], 1):
        if len(row) < 2 or index >= len(link_col):
            continue
        received = parse_time(str(row[1]))
        if not received:
            continue
        age = (now - received).total_seconds()
        if not 0 <= age <= 3 * 3600:
            continue
        try:
            links = json.loads(link_col[index][0]) if link_col[index] else []
        except (ValueError, TypeError):
            continue
        if not isinstance(links, list):
            continue
        # O:Y maps mail status, AI status R, attempts W and active ID Y.
        state = import_states[index] if index < len(import_states) else []
        queue = {
            "mail_status": str(state[0]).lower() if state else "",
            "mail_error": str(state[1]) if len(state) > 1 else "",
            "ai_status": str(state[3]).lower() if len(state) > 3 else "",
            "ai_error": str(state[4]) if len(state) > 4 else "",
            "ai_attempts": state[8] if len(state) > 8 else "",
            "last_id": str(state[6]) if len(state) > 6 else "",
            "active_id": str(state[10]) if len(state) > 10 else "",
        }
        subject = str(row[2])[:150] if len(row) > 2 else ""
        for url in links:
            listing_id = preliminary_listing_id(url)
            if not listing_id or listing_id in seen or listing_id.lower() in forbidden:
                continue
            record = duplicate_states.get(listing_id.lower())
            if record and (record[1] in ("blocked", "duplicate", "candidate") or
                           record[0] in seen):
                continue
            if final_decisions.get(listing_id.lower()) in excluded_decisions:
                continue
            listing = current.get(listing_id)
            if hard_excluded(listing):
                continue
            # A fully assessed and eligible listing uses the regular, richer card.
            if listing and eligible(listing):
                continue
            if listing and text(listing, "KI-Bewertung").lower() == "abgeschlossen":
                continue
            # Do not bypass the minimum-area filter just because image import
            # failed. A recorded per-listing AI screening attempt is required.
            # A broken import remains visible to the separate watchdog.
            if not first_attempt_finished(queue, listing, listing_id):
                continue
            if listing_id not in candidates or received > candidates[listing_id]["received"]:
                candidates[listing_id] = {
                    "id": listing_id, "url": str(url),
                    "subject": subject, "received": received,
                    "rent": screened_facts(listing)["rent"],
                    "area": screened_facts(listing)["area"],
                }
    return sorted(candidates.values(), key=lambda item: item["received"], reverse=True)

def send_early(candidate):
    """Link only. No OpenAI, no image fetch, no unverified quality claims."""
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        raise RuntimeError("Telegram Secrets fehlen")
    url = candidate["url"]
    parsed = urllib.parse.urlsplit(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
             if not k.startswith("utm_")]
    clean = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
    msg = "\n".join([
        "🔎 <b>Wohnungsanzeige: Manuell prüfen</b>",
        html.escape(candidate["id"]),
        html.escape(candidate["subject"][:100]),
        "",
        "Die automatische Prüfung war beim ersten Versuch unvollständig.",
        ("Fläche: " + str(int(candidate["area"])) + " m²" if candidate.get("area") is not None else "Fläche: noch unbekannt"),
        ("Miete: " + str(int(candidate["rent"])) + " €/Monat" if candidate.get("rent") is not None else "Miete: noch unbekannt"),
        "Bitte vor Kontaktaufnahme selbst prüfen.",
        f'<a href="{html.escape(clean, quote=True)}">Inserat jetzt öffnen</a>'
    ])
    result = request_json(f"https://api.telegram.org/bot{token}/sendMessage",
                          method="POST",
                          body={"chat_id": chat, "parse_mode": "HTML",
                                "disable_notification": False,
                                "disable_web_page_preview": True, "text": msg})
    if not result.get("ok"):
        raise RuntimeError("Telegram hat die frühe Link-Nachricht abgelehnt")


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
    if text(row, "Status").lower() not in ("geeignet", "prüfung erforderlich"):
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
    """Compact text-only listing card; existing thumbnail stays untouched."""
    url = text(row, "Anzeigenlink")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https":
        raise ValueError("Inseratslink ist kein HTTPS-Link")
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
             if not k.startswith("utm_")]
    clean_url = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
    rent = number(text(row, "Miete"))
    area = number(text(row, "Fläche"))
    if not rent or not area:
        raise ValueError("Miete oder Fläche fehlt")
    lines = ["🏠 <b>Wohnungsangebot</b>",
             f"{area:g} m² · {rent:g} €/Monat · {rent / area:.2f} €/m²"]
    restrictions = text(row, "Einschränkungen")
    conditions = text(row, "Mietprüfung")
    if restrictions:
        lines.append("Konditionen: " + html.escape(restrictions[:260]))
    if conditions and conditions != "Langzeitmiete bestätigt; Pflichtangaben vorhanden":
        lines.append(html.escape(conditions[:260]))
    lines.extend(["", f'<a href="{html.escape(clean_url, quote=True)}">Inserat öffnen</a>'])
    return "\\n".join(lines)[:1000]

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

    current = {text(r, "Datensatz-ID"): r for r in listings if text(r, "Datensatz-ID")}
    delivered = 0
    preliminary = early_candidates(now, seen, current)
    for item in preliminary[:MAX_PER_RUN]:
        send_early(item)
        seen.add(item["id"])
        save(issue, seen)
        delivered += 1
        print("Telegram-Sofortlink gesendet für", item["id"])

    pending = [r for r in listings if eligible(r) and
               text(r, "Datensatz-ID") not in seen]
    pending.sort(key=lambda r: (listing_time(r) or now, text(r, "Datensatz-ID")))
    for row in pending[:max(0, MAX_PER_RUN - delivered)]:
        listing_id = text(row, "Datensatz-ID")
        send(row)
        seen.add(listing_id)
        save(issue, seen)
        delivered += 1
        print("Telegram-Nachricht gesendet für", listing_id)
    print(f"Geprüfte Anzeigen: {len(listings)}; Sofortlinks: {len(preliminary)}; "
          f"offene vollständige Bewertungen: {len(pending)}; gesendet: {delivered}.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
