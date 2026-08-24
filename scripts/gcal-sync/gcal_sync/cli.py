"""I/O half of the sync: fetch the two blobs, talk to Google, print a marker.

Markers (the fleet probe greps these out of ~/Library/Logs/aoife-gcal-sync.log):
  GCAL-SYNC OK <date> <n_events>              — synced, n = events now desired
  GCAL-SYNC WAITING calendar-api-disabled     — exit 0, an owner step is pending
  GCAL-SYNC WAITING calendar-not-shared-yet   — exit 0, an owner step is pending
  GCAL-SYNC WAITING write-permission          — exit 0, an owner step is pending
  GCAL-SYNC FAIL <date> <reason>              — exit 1

The three WAITING states are the three setup steps, in the order they clear:
enable the API → share the calendar → grant "Make changes to events". Each is
exit 0 on purpose: a step only the Google account owner can perform is not a
broken job, and paging at 5 AM for it would be noise. Every one of them heals by
itself on the next nightly run, so there is nothing to re-trigger by hand. It is
not a way to hide forever either — the fleet probe greps `GCAL-SYNC OK {date}`,
so once its `live_since` grace date passes, a calendar still stuck in any
WAITING state is reported.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

from . import model

BASE = "https://aoifes-schedule.vercel.app"
DEFAULT_SA = "~/.config/mcp-google-sheets/service-account.json"
DEFAULT_STATE = "~/.local/state/aoife-gcal-sync.hash"
SCOPES = ["https://www.googleapis.com/auth/calendar"]
TIMEOUT = 60


def fetch_blob(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "aoife-gcal-sync/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        raw = r.read().decode("utf-8")
    data = model.unwrap(json.loads(raw))
    if not isinstance(data, dict):
        raise ValueError(f"{url} did not return an object")
    return data


def build_service(sa_path: str):
    from google.oauth2 import service_account            # imported late: tests stay offline
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(sa_path, scopes=SCOPES)
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


WRITE_ROLES = ("owner", "writer")


def _status(exc):
    return getattr(getattr(exc, "resp", None), "status", None)


def api_disabled(exc) -> bool:
    """True when Google says the Calendar API is off for this cloud project.

    The service account cannot switch it on itself (verified 2026-08-18:
    serviceusage enable -> 403 'Permission denied to enable service'), so this
    is an owner step exactly like sharing the calendar — and gets the same
    exit-0 WAITING treatment rather than a nightly FAIL. Google's own error text
    warns that enabling takes a few minutes to propagate, so a 403 right after
    the owner clicks the button is expected, not terminal: the next nightly run
    (or the next poll) clears it with no intervention.
    """
    text = str(exc)
    return ("accessNotConfigured" in text or "SERVICE_DISABLED" in text
            or "has not been used in project" in text)


def write_denied(exc) -> bool:
    """A 403 that means 'this calendar is shared read-only', not 'slow down'.

    Rate-limit and quota 403s are REAL failures — they must stay FAIL so the
    fleet sees them; only a permission 403 is an owner setup step.
    """
    text = str(exc)
    if _status(exc) != 403:
        return False
    if "rateLimit" in text or "quotaExceeded" in text or "userRateLimit" in text:
        return False
    return True


def find_calendar(service, name: str):
    """The shared calendar's calendarList entry, or None if it is not there yet.

    Returns the whole entry, not just the id: `accessRole` is what tells us
    whether the owner shared it as "See all event details" (reader — we must not
    attempt writes) or "Make changes to events" (writer).
    """
    token = None
    while True:
        page = service.calendarList().list(pageToken=token, maxResults=250).execute()
        for cal in page.get("items", []):
            if (cal.get("summary") or "").strip() == name:
                return cal
        token = page.get("nextPageToken")
        if not token:
            return None


def list_synced(service, cal_id: str) -> list:
    """Every event carrying aoifeSync=v1 — masters, not expanded instances.

    singleEvents=False keeps a weekly template as ONE row (the thing we patch),
    and the privateExtendedProperty filter is the guarantee that nothing the
    family added by hand is ever read, patched or deleted.
    """
    out, token = [], None
    while True:
        page = (
            service.events()
            .list(
                calendarId=cal_id,
                privateExtendedProperty=f"{model.SYNC_PROP}={model.SYNC_VERSION}",
                singleEvents=False,
                showDeleted=False,
                maxResults=2500,
                pageToken=token,
            )
            .execute()
        )
        out.extend(page.get("items", []))
        token = page.get("nextPageToken")
        if not token:
            return out


def apply_plan(service, cal_id: str, plan: model.SyncPlan) -> None:
    from googleapiclient.errors import HttpError

    for body in plan.inserts:
        service.events().insert(calendarId=cal_id, body=body).execute()
    for event_id, body in plan.patches:
        service.events().patch(calendarId=cal_id, eventId=event_id, body=body).execute()
    for event_id in plan.deletes:
        try:
            service.events().delete(calendarId=cal_id, eventId=event_id).execute()
        except HttpError as e:                            # already gone is success
            if getattr(getattr(e, "resp", None), "status", None) not in (404, 410):
                raise


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Sync Aoife's planner into Google Calendar")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, write nothing")
    ap.add_argument("--service-account", default=os.environ.get("AOIFE_GCAL_SA", DEFAULT_SA))
    ap.add_argument("--calendar", default=model.CALENDAR_NAME)
    ap.add_argument("--if-changed", action="store_true",
                    help="skip Google entirely when the desired-event hash matches the state file "
                         "(the daytime tick's cheap mode; the nightly full run omits this)")
    ap.add_argument("--state-file", default=DEFAULT_STATE,
                    help="where the last successfully synced desired-state hash lives")
    args = ap.parse_args(argv)

    today = dt.date.today()
    stamp = today.isoformat()
    try:
        sa_path = os.path.expanduser(args.service_account)
        if not os.path.exists(sa_path):
            print(f"GCAL-SYNC FAIL {stamp} service-account-missing")
            return 1

        schedule = fetch_blob(f"{BASE}/api/get")
        plan_blob = fetch_blob(f"{BASE}/api/plan-get")
        desired = model.desired_state(schedule, plan_blob, today)

        # The tick's cheap mode: identical desired state -> zero Google traffic.
        # The hash is only ever written after a successful sync, so WAITING/FAIL
        # runs leave it stale and the change is retried on the next tick. A
        # hand-deleted calendar event is invisible to the hash by design — the
        # nightly full run (no flag) is the reconciler of record for that.
        state_path = os.path.expanduser(args.state_file)
        digest = hashlib.sha256(
            json.dumps(desired, sort_keys=True, default=str).encode()
        ).hexdigest()
        if args.if_changed:
            try:
                if os.path.exists(state_path) and open(state_path).read().strip() == digest:
                    print(f"GCAL-SYNC SKIP {stamp} unchanged")
                    return 0
            except OSError:
                pass                                      # unreadable state = just sync

        service = build_service(sa_path)
        try:
            cal = find_calendar(service, args.calendar)
        except Exception as e:
            if not api_disabled(e):
                raise
            print("GCAL-SYNC WAITING calendar-api-disabled "
                  "(enable 'Google Calendar API' in cloud project hoa-tracker-494016; "
                  "Google needs a few minutes to propagate after the click)")
            return 0
        if cal is None:
            print(f"GCAL-SYNC WAITING calendar-not-shared-yet "
                  f"(share '{args.calendar}' with the service account)")
            return 0

        # Read-only share: reading and diffing would succeed and every write
        # would 403 one at a time. Stop before touching anything.
        role = cal.get("accessRole")
        if role not in WRITE_ROLES:
            print(f"GCAL-SYNC WAITING write-permission "
                  f"(calendar shared as '{role}'; needs 'Make changes to events')")
            return 0

        cal_id = cal["id"]
        existing = list_synced(service, cal_id)
        sync_plan = model.reconcile(desired, existing)
        print(f"[{stamp}] desired={len(desired)} existing={len(existing)} "
              f"insert={len(sync_plan.inserts)} patch={len(sync_plan.patches)} "
              f"delete={len(sync_plan.deletes)} unchanged={sync_plan.unchanged}")
        if args.dry_run:
            for body in sync_plan.inserts:
                print(f"  + {model.sync_key(body)}  {body['summary']}")
            for _, body in sync_plan.patches:
                print(f"  ~ {model.sync_key(body)}  {body['summary']}")
            for event_id in sync_plan.deletes:
                print(f"  - {event_id}")
            print(f"GCAL-SYNC DRY-RUN {stamp} {len(desired)}")
            return 0

        try:
            apply_plan(service, cal_id, sync_plan)
        except Exception as e:
            # Belt and braces behind the accessRole gate: the share can be
            # downgraded between the list call and the writes, and accessRole
            # is a cached calendarList field.
            if not write_denied(e):
                raise
            print("GCAL-SYNC WAITING write-permission "
                  "(write rejected 403; calendar needs 'Make changes to events')")
            return 0
        try:                                          # best-effort; never breaks the sync
            os.makedirs(os.path.dirname(state_path), exist_ok=True)
            with open(state_path, "w") as f:
                f.write(digest + "\n")
        except OSError:
            pass
        print(f"GCAL-SYNC OK {stamp} {len(desired)}")
        return 0
    except Exception as e:                                # one line, never a traceback wall
        reason = f"{type(e).__name__}: {e}".replace("\n", " ")[:300]
        print(f"GCAL-SYNC FAIL {stamp} {reason}")
        return 1


if __name__ == "__main__":                                # pragma: no cover
    sys.exit(main())
