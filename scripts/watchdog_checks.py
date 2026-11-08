"""Pure, independently testable end-to-end monitoring rules for Wohnungsagent.

No network access or writes. All timestamps are UTC and all checks are bounded to
recent arrivals, so historical backlog does not suddenly flood Telegram.
"""
import datetime as dt
import json
import re

UTC = dt.timezone.utc
TERMINAL_MAIL = {"blocked", "duplicate", "completed"}
TERMINAL_AI = {"completed", "duplicate", "blocked", "unavailable", "failed_final", "expired"}
MONITORING_START = dt.datetime(2026, 11, 6, tzinfo=UTC)
# No expiry for unresolved work created after monitoring activation.


def timestamp(value):
    if isinstance(value, dt.datetime):
        return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)
    try:
        return dt.datetime.fromisoformat(str(value).strip().replace("Z", "+00:00")).astimezone(UTC)
    except (ValueError, TypeError):
        return None


def minutes(now, value):
    parsed = timestamp(value)
    return (now - parsed).total_seconds() / 60 if parsed else None


def as_records(matrix):
    if not matrix:
        return []
    headers = [str(x).strip() for x in matrix[0]]
    return [dict(zip(headers, row)) for row in matrix[1:] if any(str(v).strip() for v in row)]


def string(row, name):
    return str(row.get(name, "") or "").strip()


def json_value(raw, default):
    try:
        result = json.loads(raw or "")
        return result if isinstance(result, type(default)) else default
    except (ValueError, TypeError):
        return default


def number(raw):
    s = re.sub(r"[^0-9,.-]", "", str(raw or ""))
    if not s:
        return None
    if "." in s and "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    elif s.count(".") == 1 and len(s.rsplit(".", 1)[1]) == 3:
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def problem(code, identity, detail, severity="critical"):
    return {"key": f"{code}:{identity}", "code": code, "severity": severity,
            "detail": detail[:240]}


def eligible_listing(row):
    rent, area = number(string(row, "Miete")), number(string(row, "Fläche"))
    return (string(row, "Status").lower() == "geeignet" and
            string(row, "KI-Bewertung").lower() == "abgeschlossen" and
            string(row, "Zu löschen").lower() not in ("true", "ja", "yes", "1") and
            rent is not None and area is not None and 800 <= rent <= 1200 and area >= 60 and
            bool(string(row, "Anzeigenlink")))


def inspect(queues, listings, decisions, sent_ids, now, gmail_messages=None):
    """Return stable, independently actionable incidents. gmail_messages=None = not configured."""
    now = timestamp(now)
    alerts = []
    rows = as_records(queues)
    homes = {string(r, "Datensatz-ID"): r for r in as_records(listings)
             if string(r, "Datensatz-ID")}
    events = as_records(decisions)
    known_mail = {string(r, "Queue Gmail-ID") for r in rows}
    known_mail.update(string(r, "Gmail-ID") for r in events)
    sent_ids = set(sent_ids)

    if gmail_messages is not None:
        for message in gmail_messages:
            mail_id = str(message.get("id", ""))
            age = minutes(now, message.get("received"))
            if mail_id and age is not None and age > 20 and mail_id not in known_mail:
                alerts.append(problem("MAIL_NOT_IMPORTED", mail_id,
                                      f"Gmail-ID {mail_id}: seit {round(age)} Min. nicht in Queue/Entscheidungen."))

    for row in rows:
        mail_id = string(row, "Queue Gmail-ID")
        if not mail_id:
            continue
        age = minutes(now, row.get("Queue Eingang UTC"))
        if age is None or age < 0 or timestamp(row.get('Queue Eingang UTC')) < MONITORING_START:
            continue
        mail_status = string(row, "Queue Bildstatus").lower()
        ai_status = string(row, "KI Verarbeitungsstatus").lower()
        error = string(row, "KI Fehler")
        last_step = minutes(now, row.get("KI Aktualisiert UTC"))
        retry_age = minutes(now, row.get("KI Wiederholung ab UTC"))
        attempts = int(number(row.get("KI Versuche")) or 0)
        mail_error = string(row, "Queue Fehler")
        identity = string(row, "KI Aktuelle Anzeigen-ID") or string(row, "KI Datensatz-ID") or mail_id

        if mail_status in ("processing", "retry", "pending", "gallery_unavailable", "no_images"):
            if age > 45 and (mail_status != "retry" or age > 90):
                alerts.append(problem("MAIL_QUEUE_STALLED", mail_id,
                                      f"Gmail-ID {mail_id}: Import {mail_status} seit {round(age)} Min.; {mail_error[:90]}"))
        if mail_status != "ready_for_ai":
            continue
        if ai_status == "needs_review":
            alerts.append(problem("AI_NEEDS_REVIEW", identity,
                                  f"{identity}: ungeklärte KI-Operation; {error[:120]}"))
            continue
        if ai_status in TERMINAL_AI:
            # These are durable end states. Report final failures as one incident,
            # not as an endlessly stalled retry.
            if ai_status == "failed_final" and last_step is not None and last_step < 24 * 60:
                alerts.append(problem("AI_FAILED_FINAL", identity,
                                      f"{identity}: {error[:130]}", "warning"))
            continue
        if "429" in error and (attempts >= 2 or age > 60):
            alerts.append(problem("AI_HTTP_429", identity,
                                  f"{identity}: OpenAI 429, {attempts} Versuche; nächster Retry: {string(row, 'KI Wiederholung ab UTC') or 'unbekannt'}.",
                                  "warning"))
        if error and re.search(r"HTTP (?:401|403)\b|API.?KEY|Berechtigung", error, re.I):
            alerts.append(problem("AI_AUTH", identity, f"{identity}: KI-Zugriff verweigert; {error[:110]}"))
        elif error and re.search(r"HTTP 5\d\d|timeout|timed out", error, re.I) and attempts >= 3:
            alerts.append(problem("AI_API_RETRIES", identity,
                                  f"{identity}: KI-API dauerhaft gestört ({attempts} Versuche): {error[:110]}"))
        # During an explicit retry wait the item is not stalled. The first
        # stalled alert follows when retryAt is overdue or progress has stopped.
        # A queue which has never started is backlog, not a failed API call.
        # Alert only after substantial inactivity; active retries respect retryAt.
        overdue_retry = (ai_status == "retry" and retry_age is not None and
                         retry_age > 15 and (last_step is None or last_step > 60))
        idle_worker = (age > 180 and last_step is not None and last_step > 120 and
                       (ai_status != "retry" or retry_age is None or retry_age > 30))
        if overdue_retry or idle_worker:
            alerts.append(problem("AI_QUEUE_STALLED", identity,
                                  f"{identity}: KI-Status {ai_status or 'pending'}, "
                                  f"letzter Schritt vor {round(last_step) if last_step is not None else '?'} Min.",
                                  "warning"))
        if age >= 48 * 60:
            alerts.append(problem("AI_EXPIRED", identity,
                                  f"{identity}: 48-Stunden-Frist überschritten; Queue-Status noch {ai_status or 'pending'}.",
                                  "warning"))
        # A completed AI queue must not lose its individual listing(s).
        done = json_value(string(row, "KI Abgeschlossene Anzeigen JSON"), [])
        if done and ai_status != "completed":
            continue

    for listing_id, row in homes.items():
        age = minutes(now, row.get("Eingang (UTC)"))
        if age is None or age < 0 or timestamp(row.get('Eingang (UTC)')) < MONITORING_START:
            continue
        ai = string(row, "KI-Bewertung").lower()
        status = string(row, "Status").lower()
        data = json_value(string(row, "Bildanalyse JSON"), {})
        pipe = data.get("ai_pipeline") if isinstance(data.get("ai_pipeline"), dict) else {}
        updated_age = minutes(now, pipe.get("updated_at"))
        completed_age = updated_age if updated_age is not None else age
        if ai == "abgeschlossen" and status == "geeignet":
            rent, area = number(string(row, "Miete")), number(string(row, "Fläche"))
            if rent is None or area is None:
                alerts.append(problem("LISTING_FIELDS_MISSING", listing_id,
                                      f"{listing_id}: als geeignet markiert, Miete/Fläche fehlt."))
            elif eligible_listing(row) and listing_id not in sent_ids and completed_age > 15:
                alerts.append(problem("TELEGRAM_NOT_SENT", listing_id,
                                      f"{listing_id}: geeignet, aber seit {round(completed_age)} Min. nicht per Telegram versendet."))
        operation = pipe.get("api_operation") if isinstance(pipe.get("api_operation"), dict) else {}
        if operation.get("status") == "started" and minutes(now, operation.get("started_at")) is not None:
            if minutes(now, operation.get("started_at")) > 20:
                alerts.append(problem("AI_UNCERTAIN_OPERATION", listing_id,
                                      f"{listing_id}: KI-Anfrage gestartet, aber kein Ergebnis gespeichert."))
        analysis_status = str(data.get("ai_analysis_status") or "").lower()
        # no_images is a deliberate terminal outcome. An existing Drive attachment
        # may be a mail thumbnail that was not safely attributed to the listing.
        # Image analysis is intentionally disabled. Old photo states are not incidents.
        if analysis_status in ("no_images", "completed"):
            continue
        # Pending listings are expected while earlier jobs use the single AI worker.
        # Only flag listings with a started, genuinely idle processing step.
        if ai in ("ausstehend", "in bearbeitung") and completed_age > 180 and (
                updated_age is not None and not any(
                    a["key"].endswith(":" + listing_id) and a["code"].startswith("AI_")
                    for a in alerts)):
            alerts.append(problem("LISTING_AI_STALLED", listing_id,
                                  f"{listing_id}: KI-Bewertung seit {round(completed_age)} Min. ohne Fortschritt.",
                                  "warning"))
        # No IMAGE_ANALYSIS_STALLED alerts in thumbnail-only mode.

    # Queue metadata can refer to several separate listing IDs in one digest.
    for row in rows:
        age = minutes(now, row.get("Queue Eingang UTC"))
        if age is None or age <= 20 or timestamp(row.get('Queue Eingang UTC')) < MONITORING_START:
            continue
        if string(row, "Queue Bildstatus") != "ready_for_ai":
            continue
        if string(row, "KI Verarbeitungsstatus").lower() in ("failed_final", "expired"):
            continue
        ids = json_value(string(row, "Queue Inseratslinks JSON"), [])
        if not ids:
            alerts.append(problem("MAIL_LINKS_MISSING", string(row, "Queue Gmail-ID"),
                                  f"Gmail-ID {string(row, 'Queue Gmail-ID')}: KI freigegeben, aber keine Inseratslinks."))
            continue
        # The format is stable across supported portals; monitoring accepts only
        # actual portal IDs, not tracking links.
        listing_ids = set()
        for link in ids:
            m = re.search(r"idealista\.com/inmueble/(\d+)", str(link))
            if m:
                listing_ids.add("idealista:" + m.group(1))
            m = re.search(r"fotocasa\.es/[^?\s]*/(\d+)(?:[/?#]|$)", str(link))
            if m:
                listing_ids.add("fotocasa:" + m.group(1))
        done = set(json_value(string(row, "KI Abgeschlossene Anzeigen JSON"), []))
        if string(row, "KI Verarbeitungsstatus").lower() == "completed":
            for listing_id in listing_ids - done:
                alerts.append(problem("DIGEST_INCOMPLETE", listing_id,
                                      f"{listing_id}: KI-Queue abgeschlossen, Inserat jedoch nicht in Abschlussliste."))
            for listing_id in done:
                if listing_id not in homes and listing_id in listing_ids:
                    # Excluded/duplicate/unavailable listings may legitimately
                    # have no Anzeigen row; require a terminal decision instead.
                    terminal = any(string(e, "Datensatz-ID") == listing_id and
                                   string(e, "Status").lower() in
                                   {"blocked", "duplicate", "unavailable", "excluded", "completed", "no_images"}
                                   for e in events)
                    if not terminal:
                        alerts.append(problem("LISTING_MISSING", listing_id,
                                              f"{listing_id}: Queue abgeschlossen, keine Anzeige/Endentscheidung."))

    for event in events:
        if string(event, "Status").lower() == "duplicate" and not string(event, "Haupteintrag-ID"):
            event_age = minutes(now, event.get("Zeit (UTC)"))
            if event_age is not None and 0 <= event_age < 120:
                alerts.append(problem("DUPLICATE_MAPPING", string(event, "Datensatz-ID") or "unknown",
                                      "Duplikat ohne Haupteintrag-ID dokumentiert.", "warning"))

    return list({a["key"]: a for a in alerts}.values())
