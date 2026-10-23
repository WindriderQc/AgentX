#!/usr/bin/env python3
"""Bounded Calendar transport. Reuse the host's native gog account/keyring.

Google owns events, recurrence and reminders. Stable caller-supplied event IDs
and a private payload fingerprint reconcile inserts without a second store.
"""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys


class CalendarError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def native_settings():
    path = Path(os.environ.get("OPENCLAW_CONFIG_PATH") or Path.home() / ".openclaw/openclaw.json")
    try:
        return json.loads(path.read_text()).get("plugins", {}).get("entries", {}).get("gmail-secretary", {}).get("config", {})
    except (OSError, ValueError):
        return {}


def gog_call(method, params, body=None):
    if method not in {"calendarList.list", "events.list", "events.get", "events.insert"}:
        raise CalendarError("PERSONAL_CALENDAR_INVALID", "Unsupported Calendar operation.")
    settings = native_settings()
    env = os.environ.copy()
    password_file = Path(os.environ.get("GOOGLE_KEYRING_PASSWORD_FILE") or settings.get("keyringPasswordFile") or Path.home() / ".config/gogcli/keyring-password")
    env["GOG_KEYRING_BACKEND"] = "file"
    env["GOG_KEYRING_PASSWORD"] = password_file.read_text().strip()
    args = [os.environ.get("GOOGLE_GOG_PATH") or settings.get("gogPath") or "gog",
            "--json", "--no-input", "--gmail-no-send", "--enable-commands-exact=api.call,api.calendar." + method.lower(),
            "--account=" + (os.environ.get("GOOGLE_ACCOUNT") or settings.get("account") or "auto")]
    if body is None:
        args.append("--readonly")
    args += ["api", "call", "calendar", "v3", method, "--scope=https://www.googleapis.com/auth/calendar", "--params=" + json.dumps(params)]
    if body is not None:
        args += ["--allow-write", "--force", "--body=@/dev/stdin"]
    try:
        result = subprocess.run(args, input=json.dumps(body) if body is not None else None,
                                env=env, capture_output=True, text=True, timeout=25)
    except subprocess.TimeoutExpired:
        raise CalendarError("PERSONAL_CALENDAR_UNCERTAIN", "Google did not return a terminal result; retain the same requestId.") from None
    if result.returncode:
        detail = result.stderr or ""
        if re.search(r"\b404\b|notFound|not.found", detail, re.I):
            code = "PERSONAL_CALENDAR_NOT_FOUND"
        elif re.search(r"\b409\b|duplicate|already.exists", detail, re.I):
            code = "PERSONAL_CALENDAR_EXISTS"
        elif re.search(r"\b(?:401|403)\b|invalid_grant|insufficient|scope|unauthorized", detail, re.I):
            code = "PERSONAL_CALENDAR_AUTHORIZATION"
        else:
            code = "PERSONAL_CALENDAR_UNCERTAIN" if body else "PERSONAL_CALENDAR_UNAVAILABLE"
        raise CalendarError(code, "Google Calendar request failed; no provider details disclosed.")
    try:
        data = json.loads(result.stdout)
        # gog generic calls return the native resource (some releases wrap it).
        return data.get("response", data) if isinstance(data, dict) else data
    except (ValueError, AttributeError):
        raise CalendarError("PERSONAL_CALENDAR_UNCERTAIN", "Invalid Google Calendar response; retain the same requestId.") from None


EVENT_FIELDS = ("id", "status", "summary", "description", "location", "start", "end", "recurrence",
                "recurringEventId", "originalStartTime", "reminders", "htmlLink", "updated", "transparency")


def project(event):
    return {key: event[key] for key in EVENT_FIELDS if key in event}


def operate(request, call=gog_call):
    action = request.get("action")
    calendar = request.get("calendarId", "primary")
    if action == "calendars":
        result = call("calendarList.list", {"maxResults": min(int(request.get("limit", 50)), 50),
                                             **({"pageToken": request["pageToken"]} if request.get("pageToken") else {})})
        return {"calendars": [{k: item[k] for k in ("id", "summary", "primary", "accessRole", "timeZone") if k in item}
                              for item in result.get("items", [])], "nextPageToken": result.get("nextPageToken")}
    if action == "list":
        params = {"calendarId": calendar, "timeMin": request["timeMin"], "timeMax": request["timeMax"],
                  "maxResults": min(int(request.get("limit", 20)), 50), "singleEvents": True, "orderBy": "startTime"}
        for source, target in (("query", "q"), ("pageToken", "pageToken")):
            if request.get(source):
                params[target] = request[source]
        result = call("events.list", params)
        return {"events": [project(item) for item in result.get("items", [])], "nextPageToken": result.get("nextPageToken")}
    if action not in {"get", "create"}:
        raise CalendarError("PERSONAL_CALENDAR_INVALID", "Unsupported Calendar operation.")
    event_id = request.get("eventId", "")
    if not re.fullmatch(r"[a-zA-Z0-9_@.-]{1,1024}", event_id):
        raise CalendarError("PERSONAL_CALENDAR_INVALID", "Invalid event identity.")
    params = {"calendarId": calendar, "eventId": event_id}
    replay = True
    try:
        event = call("events.get", params)
    except CalendarError as exc:
        if action != "create" or exc.code != "PERSONAL_CALENDAR_NOT_FOUND":
            raise
        body = {**request["body"], "id": event_id}
        replay = False
        try:
            event = call("events.insert", {"calendarId": calendar, "sendUpdates": "none"}, body)
        except CalendarError as insert_error:
            if insert_error.code != "PERSONAL_CALENDAR_EXISTS":
                raise
            event = call("events.get", params)
            replay = True
    if action == "create":
        if event.get("extendedProperties", {}).get("private", {}).get("agentxRequest") != request.get("fingerprint"):
            raise CalendarError("PERSONAL_CALENDAR_ID_CONFLICT", "This requestId already belongs to different event details.")
        if event.get("status") == "cancelled":
            raise CalendarError("PERSONAL_CALENDAR_CANCELLED", "The original event was cancelled; it has not been recreated.")
    return {"event": project(event), **({"replayed": replay} if action == "create" else {})}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or len(sys.argv[1]) > 40000:
            raise CalendarError("PERSONAL_CALENDAR_INVALID", "Invalid Calendar payload.")
        payload = json.loads(base64.b64decode(sys.argv[1], validate=True))
        print(json.dumps({"ok": True, "data": operate(payload)}))
    except CalendarError as error:
        print(json.dumps({"ok": False, "code": error.code, "message": error.message}))
    except Exception:
        print(json.dumps({"ok": False, "code": "PERSONAL_CALENDAR_UNAVAILABLE", "message": "Calendar host integration unavailable."}))
