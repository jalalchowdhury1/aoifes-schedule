"""PURE desired-state + reconcile logic for the Google Calendar sync.

No network, no Google client, no `datetime.now()` — every entry point takes the
date it should reason from, so the whole file is unit-testable offline.

The two source blobs are the ones documented in the repo's AGENTS.md:
  * `aoifes_schedule` — {events, altSun, catLabels}: the RECURRING week template.
  * `aoife_plan`      — {overrides, periods, activities, ...}: dated exceptions.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json

# ── constants ───────────────────────────────────────────────────────────────
TZ = "America/New_York"
CALENDAR_NAME = "Aoife's School"

DESCRIPTION = (
    "Synced from aoifes-schedule.vercel.app — do not edit here; "
    "edits will be overwritten nightly."
)

# Every event this sync owns carries BOTH of these private properties. The
# reconciler only ever lists/patches/deletes events matching aoifeSync=v1, so an
# event the family adds to the same calendar by hand is invisible to it.
SYNC_PROP = "aoifeSync"
SYNC_VERSION = "v1"

# Mon-first day index (the v1 storage contract) -> RFC5545 weekday.
BYDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

# Mirrors js/model.js CATS — the DEFAULT display label per category. The site
# renders `name || catLabels[cat] || CATS[cat].label`, and so does this sync, so
# a legend rename in the app reaches the calendar on the next run.
CAT_LABELS = {
    "quran": "Quran",
    "ruhamah": "Ruhama — ELA/Math",
    "hala": "Miss Hala — Arabic/Islamic Studies",
    "barakot": "Barrington trip",
    "art": "Art Class with Ayra",
    "other": "Other",
}

# Dated one-offs are only synced inside this window; the recurring template has
# no end and periods are a short curated list, so neither is windowed.
PAST_DAYS = 7
FUTURE_DAYS = 365

PERIOD_TYPES = ("travel", "off")
PERIOD_MARK = {"travel": "✈️", "off": "⏸"}
PERIOD_FALLBACK_LABEL = {"travel": "Travel", "off": "Time off"}


# ── blob helpers ────────────────────────────────────────────────────────────
def unwrap(raw):
    """Undo the double/triple JSON-stringification the KV blobs can carry.

    Same defensive while-typeof-string loop as api/get.js (commit 434f884): the
    stored value has historically been a JSON *string* of a JSON string.
    """
    value = raw
    seen = 0
    while isinstance(value, str) and seen < 5:
        value = json.loads(value)
        seen += 1
    return value


def _num(x):
    """A real JS-style number, or None. Booleans are NOT numbers here."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    return float(x)


def is_valid_event(e) -> bool:
    """Port of js/model.js `isValidEvent`.

    Load-bearing: the live blob still contains the corrupt stray {"id":"e999"}
    record, and a template event with no cat/day/times would otherwise become a
    garbage calendar entry.
    """
    return (
        isinstance(e, dict)
        and "id" in e
        and "cat" in e
        and _num(e.get("day")) is not None
        and _num(e.get("start")) is not None
        and _num(e.get("end")) is not None
    )


def sanitize_events(events) -> list:
    return [e for e in events if is_valid_event(e)] if isinstance(events, list) else []


def display_name(ev: dict, cat_labels: dict) -> str:
    """`name || catLabels[cat] || CATS[cat].label` — exactly what the site shows."""
    cat = ev.get("cat")
    return (
        (ev.get("name") or "").strip()
        or (cat_labels.get(cat) if isinstance(cat_labels, dict) else None)
        or CAT_LABELS.get(cat)
        or "Event"
    )


def hhmmss(hour: float) -> str:
    """Decimal hour (half-hour steps) -> 'HH:MM:SS'."""
    total = int(round(float(hour) * 60))
    return f"{total // 60:02d}:{total % 60:02d}:00"


def week_monday(today: dt.date) -> dt.date:
    """The Monday of the week containing `today` (weeks are Mon-first here)."""
    return today - dt.timedelta(days=today.weekday())


def parse_iso(s):
    try:
        return dt.date.fromisoformat(s)
    except (TypeError, ValueError):
        return None


# ── event bodies ────────────────────────────────────────────────────────────
def _timed(date: dt.date, start: float, end: float) -> tuple[dict, dict]:
    return (
        {"dateTime": f"{date.isoformat()}T{hhmmss(start)}", "timeZone": TZ},
        {"dateTime": f"{date.isoformat()}T{hhmmss(end)}", "timeZone": TZ},
    )


def _sig_part(part: dict, recurring: bool):
    """Normalise one end of an event for hashing.

    For a RECURRING series the absolute DTSTART date is an ANCHOR, not content:
    the builder always proposes this week's instance, so hashing the date would
    make every series look "changed" every Monday and re-patch all of them —
    dragging each series' start forward a week, every week, and taking the
    family's past instances with it. What actually identifies a weekly slot is
    its weekday + time of day, so that is what the hash sees. A one-off keeps
    its real date: moving a makeup lesson to another day IS a change.
    """
    if recurring and "dateTime" in part:
        date = dt.date.fromisoformat(part["dateTime"][:10])
        return {"byday": BYDAY[date.weekday()], "time": part["dateTime"][11:],
                "timeZone": part.get("timeZone")}
    return part


def signature(body: dict) -> str:
    """Content hash of everything this sync owns on an event.

    Comparing our own hash beats comparing fields Google normalises on the way
    back (offsets, expanded RRULEs, dropped empty keys) — a patch fires when WE
    changed something, never because the API echoed a value differently.
    """
    recurring = bool(body.get("recurrence"))
    payload = json.dumps(
        {
            "summary": body.get("summary"),
            "description": body.get("description"),
            "start": _sig_part(body.get("start") or {}, recurring),
            "end": _sig_part(body.get("end") or {}, recurring),
            "recurrence": body.get("recurrence"),
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:16]


def keep_anchor(body: dict, existing: dict) -> dict:
    """Re-point a patch at the series' EXISTING DTSTART date where valid.

    A weekly series that only changed title or time keeps the start date it was
    created with — patching DTSTART forward would silently drop every instance
    before the new anchor. If the WEEKDAY genuinely changed the anchor is stale,
    so the freshly built one (this week) is used instead. Not applicable to
    one-offs and all-day periods, whose date is the content.
    """
    if not body.get("recurrence"):
        return body
    current = ((existing or {}).get("start") or {}).get("dateTime")
    if not current:
        return body
    try:
        anchor = dt.date.fromisoformat(current[:10])
        wanted = dt.date.fromisoformat(body["start"]["dateTime"][:10])
    except (KeyError, TypeError, ValueError):
        return body
    if anchor.weekday() != wanted.weekday():
        return body                                    # the day of week moved: re-anchor
    out = dict(body)
    for side in ("start", "end"):
        out[side] = dict(body[side], dateTime=f"{anchor.isoformat()}T{body[side]['dateTime'][11:]}")
    return out


def _event(key: str, summary: str, start: dict, end: dict, recurrence=None) -> dict:
    body = {
        "summary": summary,
        "description": DESCRIPTION,
        "start": start,
        "end": end,
    }
    if recurrence:
        body["recurrence"] = recurrence
    body["extendedProperties"] = {
        "private": {SYNC_PROP: SYNC_VERSION, "syncKey": key, "sig": signature(body)}
    }
    return body


def sync_key(body: dict) -> str | None:
    return (body.get("extendedProperties", {}).get("private", {}) or {}).get("syncKey")


def sig_of(body: dict) -> str | None:
    return (body.get("extendedProperties", {}).get("private", {}) or {}).get("sig")


# ── builders ────────────────────────────────────────────────────────────────
def template_events(schedule: dict, today: dt.date) -> dict:
    """Week template -> open-ended weekly recurring events, keyed `tpl:<ev.id>`.

    DTSTART lands on this week's instance of the event's weekday, so a freshly
    created calendar starts at the current week and runs forever (no UNTIL).
    altSun is deliberately ignored in v1 — the regular-week shape is synced.
    """
    schedule = schedule if isinstance(schedule, dict) else {}
    cat_labels = schedule.get("catLabels") if isinstance(schedule.get("catLabels"), dict) else {}
    monday = week_monday(today)
    out = {}
    for ev in sanitize_events(schedule.get("events")):
        day = int(_num(ev["day"]))
        start, end = _num(ev["start"]), _num(ev["end"])
        if not 0 <= day <= 6 or end <= start:
            continue
        date = monday + dt.timedelta(days=day)
        s, e = _timed(date, start, end)
        key = f"tpl:{ev['id']}"
        out[key] = _event(
            key,
            display_name(ev, cat_labels),
            s,
            e,
            [f"RRULE:FREQ=WEEKLY;BYDAY={BYDAY[day]}"],
        )
    return out


def activity_slot_events(plan: dict, today: dt.date) -> dict:
    """Planner ACTIVITY SLOTS -> weekly recurring events, keyed `act:<a.id>:<slot index>`.

    Same shape and same weekly-anchor rules as `template_events` — an on-grid
    activity slot IS a template event in every way that matters to the
    calendar, it just lives in the `aoife_plan` blob instead of
    `aoifes_schedule`. Only synced when `status === 'active'` AND `onGrid` is
    truthy (the exact filter js/plan/mday.js `buildTimed` uses for the
    Today/mobile-day timed blocks) — a planned/parked/done/cancelled activity,
    or one not on the grid, contributes nothing. An empty `slots` list
    naturally contributes nothing too (nothing to loop over).

    The slot's position in the array IS its identity (`slotIndex`), so
    removing a slot — or flipping status off 'active' — simply stops that key
    from appearing here, and the normal reconcile diff deletes the calendar
    event on the next run, exactly like a deleted template event. Reordering
    the slots array (not just adding/removing at the end) is therefore a
    delete+insert pair rather than a no-op patch — accepted, since the array
    index is the documented key.

    `action:'skip'` overrides are NOT reflected here either, for the same
    reason `override_events`/AGENTS.md documents for template events: no
    EXDATE handling in v1.
    """
    plan = plan if isinstance(plan, dict) else {}
    monday = week_monday(today)
    out = {}
    for a in plan.get("activities", []) or []:
        if not isinstance(a, dict) or a.get("status") != "active" or not a.get("onGrid"):
            continue
        aid = a.get("id")
        slots = a.get("slots")
        if aid is None or not isinstance(slots, list):
            continue
        name = (a.get("name") or "").strip() or str(aid)
        for i, s in enumerate(slots):
            if not isinstance(s, dict):
                continue
            day = _num(s.get("day"))
            start, end = _num(s.get("start")), _num(s.get("end"))
            if day is None or start is None or end is None:
                continue
            day = int(day)
            if not 0 <= day <= 6 or end <= start:
                continue
            date = monday + dt.timedelta(days=day)
            st, en = _timed(date, start, end)
            key = f"act:{aid}:{i}"
            out[key] = _event(
                key,
                name,
                st,
                en,
                [f"RRULE:FREQ=WEEKLY;BYDAY={BYDAY[day]}"],
            )
    return out


def override_events(plan: dict, today: dt.date) -> dict:
    """`action:'add'` overrides -> single timed events, keyed `ov:<o.id>`.

    Only rows with numeric start/end are positionable (the same rule
    js/plan/overlay.js uses); a timeless override is a Today-list item and has
    no calendar shape. `action:'skip'` is NOT reflected — see AGENTS.md.
    """
    plan = plan if isinstance(plan, dict) else {}
    lo, hi = today - dt.timedelta(days=PAST_DAYS), today + dt.timedelta(days=FUTURE_DAYS)
    acts = {a.get("id"): a for a in plan.get("activities", []) if isinstance(a, dict)}
    out = {}
    for o in plan.get("overrides", []) or []:
        if not isinstance(o, dict) or o.get("action") != "add":
            continue
        date = parse_iso(o.get("date"))
        if date is None or not lo <= date <= hi:
            continue
        start, end = _num(o.get("start")), _num(o.get("end"))
        if start is None or end is None or end <= start:
            continue
        # An id-less override (hand-written, pre-bot) still deserves a stable
        # key: fall back to the same fingerprint api/plan-save.js merges on.
        ident = o.get("id") or f"{o.get('date')}|{start}|{end}|{o.get('name') or ''}"
        act = acts.get(o.get("activityId")) or {}
        summary = (o.get("name") or "").strip() or (act.get("name") or "").strip() or "Extra"
        s, e = _timed(date, start, end)
        key = f"ov:{ident}"
        out[key] = _event(key, summary, s, e)
    return out


def period_events(plan: dict) -> dict:
    """Time-away periods -> all-day events, keyed `pd:<p.id>`.

    GCal's all-day `end.date` is EXCLUSIVE, so an inclusive start..end range
    ends on end+1. Periods are a short curated list (and a past trip is deleted
    from the plan, not left to rot), so they are not windowed.
    """
    plan = plan if isinstance(plan, dict) else {}
    out = {}
    for p in plan.get("periods", []) or []:
        if not isinstance(p, dict) or p.get("type") not in PERIOD_TYPES:
            continue
        pid = "" if p.get("id") is None else str(p["id"])
        start, end = parse_iso(p.get("start")), parse_iso(p.get("end"))
        if not pid or start is None or end is None or start > end:
            continue
        label = (p.get("label") or "").strip() or PERIOD_FALLBACK_LABEL[p["type"]]
        key = f"pd:{pid}"
        out[key] = _event(
            key,
            f"{PERIOD_MARK[p['type']]} {label}",
            {"date": start.isoformat()},
            {"date": (end + dt.timedelta(days=1)).isoformat()},
        )
    return out


def desired_state(schedule: dict, plan: dict, today: dt.date) -> dict:
    """Everything the calendar should hold, keyed by syncKey.

    Key prefixes (`tpl:`/`act:`/`ov:`/`pd:`) keep the four id namespaces from
    ever colliding — a period `p1` and an override `p1` are different events.
    """
    out = {}
    out.update(template_events(schedule, today))
    out.update(activity_slot_events(plan, today))
    out.update(override_events(plan, today))
    out.update(period_events(plan))
    return out


# ── reconcile ───────────────────────────────────────────────────────────────
class SyncPlan:
    """inserts: bodies · patches: (event_id, body) · deletes: event_ids."""

    def __init__(self, inserts=None, patches=None, deletes=None, unchanged=0):
        self.inserts = inserts or []
        self.patches = patches or []
        self.deletes = deletes or []
        self.unchanged = unchanged

    @property
    def touched(self) -> int:
        return len(self.inserts) + len(self.patches) + len(self.deletes)

    def __repr__(self):  # pragma: no cover - debugging aid
        return (f"SyncPlan(+{len(self.inserts)} ~{len(self.patches)} "
                f"-{len(self.deletes)} ={self.unchanged})")


def reconcile(desired: dict, existing: list) -> SyncPlan:
    """Diff desired state against the events already carrying aoifeSync=v1.

    `existing` rows are Google event resources; only their id and private
    properties are read. Rows with no/unknown syncKey are orphans (deleted), as
    are duplicates of a key — the lowest event id wins so a re-run is stable.
    """
    by_key: dict[str, list] = {}
    orphans = []
    for ev in existing:
        key = sync_key(ev)
        if key:
            by_key.setdefault(key, []).append(ev)
        else:
            orphans.append(ev["id"])

    plan = SyncPlan()
    for key, body in desired.items():
        rows = sorted(by_key.pop(key, []), key=lambda r: r.get("id", ""))
        if not rows:
            plan.inserts.append(body)
            continue
        keep, dupes = rows[0], rows[1:]
        plan.deletes.extend(r["id"] for r in dupes)
        if sig_of(keep) == sig_of(body):
            plan.unchanged += 1
        else:
            plan.patches.append((keep["id"], keep_anchor(body, keep)))

    for rows in by_key.values():          # keys we no longer want at all
        plan.deletes.extend(r["id"] for r in rows)
    plan.deletes.extend(orphans)
    plan.deletes.sort()
    return plan
