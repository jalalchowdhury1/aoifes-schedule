"""Pure-logic tests for the Google Calendar sync. No network, no Google client.

Everything here runs against `gcal_sync.model`, which takes its date as an
argument — so these assertions are stable forever, not "true this week".
"""

import datetime as dt
import json

import pytest

from gcal_sync import model

# 2026-08-19 is a Wednesday; its week's Monday is 2026-08-17.
TODAY = dt.date(2026, 8, 19)
MONDAY = dt.date(2026, 8, 17)


def schedule(events=None, cat_labels=None):
    return {"events": events or [], "altSun": False, "catLabels": cat_labels or {}}


def ev(id="e1", cat="quran", day=0, start=10, end=11, name=""):
    return {"id": id, "cat": cat, "day": day, "start": start, "end": end, "note": "", "name": name}


# ── blob plumbing ───────────────────────────────────────────────────────────
def test_unwrap_handles_double_stringified_blobs():
    inner = {"events": [], "altSun": False}
    assert model.unwrap(inner) == inner
    assert model.unwrap(json.dumps(inner)) == inner
    assert model.unwrap(json.dumps(json.dumps(inner))) == inner


def test_sanitize_drops_the_corrupt_e999_record():
    events = [{"id": "e999"}, ev(id="e1001"), {"cat": "quran", "day": 0, "start": 9, "end": 10}]
    kept = model.sanitize_events(events)
    assert [e["id"] for e in kept] == ["e1001"]


def test_sanitize_rejects_non_numeric_and_boolean_fields():
    assert model.sanitize_events([ev(day="0")]) == []
    assert model.sanitize_events([ev(start=True)]) == []
    assert model.sanitize_events([{"cat": "quran", "day": 0, "start": 9, "end": 10}]) == []


def test_hhmmss_handles_half_hours():
    assert model.hhmmss(9) == "09:00:00"
    assert model.hhmmss(15.5) == "15:30:00"
    assert model.hhmmss(16.5) == "16:30:00"
    assert model.hhmmss(17) == "17:00:00"


@pytest.mark.parametrize("day,expected", list(enumerate(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])))
def test_weekday_conversion_is_monday_first(day, expected):
    """Mon=0 in the storage contract; RFC5545 wants MO..SU."""
    out = model.template_events(schedule([ev(day=day)]), TODAY)
    body = out["tpl:e1"]
    assert body["recurrence"] == [f"RRULE:FREQ=WEEKLY;BYDAY={expected}"]
    # DTSTART must land on that weekday in the CURRENT week.
    date = dt.date.fromisoformat(body["start"]["dateTime"][:10])
    assert date == MONDAY + dt.timedelta(days=day)
    assert date.weekday() == day


def test_week_monday_is_identity_on_a_monday():
    assert model.week_monday(MONDAY) == MONDAY
    assert model.week_monday(dt.date(2026, 8, 23)) == MONDAY      # Sunday -> same week


# ── template -> recurring ───────────────────────────────────────────────────
def test_template_event_body():
    out = model.template_events(schedule([ev(id="e1001", day=2, start=10, end=11.5, name="Quran")]), TODAY)
    body = out["tpl:e1001"]
    assert body["summary"] == "Quran"
    assert body["description"] == model.DESCRIPTION
    assert body["start"] == {"dateTime": "2026-08-19T10:00:00", "timeZone": "America/New_York"}
    assert body["end"] == {"dateTime": "2026-08-19T11:30:00", "timeZone": "America/New_York"}
    assert body["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=WE"]
    priv = body["extendedProperties"]["private"]
    assert priv["aoifeSync"] == "v1" and priv["syncKey"] == "tpl:e1001"


def test_recurrence_has_no_until_so_the_series_never_ends():
    body = model.template_events(schedule([ev()]), TODAY)["tpl:e1"]
    assert "UNTIL" not in body["recurrence"][0]
    assert "COUNT" not in body["recurrence"][0]


def test_names_fall_back_name_then_catlabels_then_default():
    s = schedule(
        [ev(id="a", cat="art"), ev(id="b", cat="ruhamah"), ev(id="c", cat="art", name="Ayra 1:1")],
        {"art": "Art Class with Arya", "barakot": "Mama Classes"},
    )
    out = model.template_events(s, TODAY)
    assert out["tpl:a"]["summary"] == "Art Class with Arya"      # catLabels rename wins
    assert out["tpl:b"]["summary"] == "Ruhama — ELA/Math"        # CATS default
    assert out["tpl:c"]["summary"] == "Ayra 1:1"                 # per-event name wins


def test_unknown_category_without_name_gets_a_safe_title():
    out = model.template_events(schedule([ev(id="z", cat="mystery")]), TODAY)
    assert out["tpl:z"]["summary"] == "Event"


def test_template_skips_impossible_days_and_zero_length_blocks():
    s = schedule([ev(id="bad-day", day=9), ev(id="zero", start=10, end=10), ev(id="rev", start=12, end=11)])
    assert model.template_events(s, TODAY) == {}


def test_altsun_is_ignored_in_v1():
    """The regular-week shape is synced; altSun changes nothing (documented)."""
    a = model.template_events({**schedule([ev()]), "altSun": True}, TODAY)
    b = model.template_events({**schedule([ev()]), "altSun": False}, TODAY)
    assert a == b


# ── planner activity slots ──────────────────────────────────────────────────
def activity(id="jj", name="Jiu Jitsu", status="active", on_grid=True, slots=None):
    return {"id": id, "name": name, "status": status, "onGrid": on_grid,
            "slots": [{"day": 0, "start": 16, "end": 17}] if slots is None else slots}


def test_activity_slot_becomes_a_weekly_event():
    """The live jj example: Mondays 4-5pm, America/New_York."""
    out = model.activity_slot_events({"activities": [activity()]}, TODAY)
    body = out["act:jj:0"]
    assert body["summary"] == "Jiu Jitsu"
    assert body["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
    assert body["start"] == {"dateTime": "2026-08-17T16:00:00", "timeZone": "America/New_York"}
    assert body["end"] == {"dateTime": "2026-08-17T17:00:00", "timeZone": "America/New_York"}
    priv = body["extendedProperties"]["private"]
    assert priv["aoifeSync"] == "v1" and priv["syncKey"] == "act:jj:0"


def test_activity_slot_included_in_desired_state():
    plan = {"activities": [activity()]}
    keys = set(model.desired_state(schedule(), plan, TODAY))
    assert keys == {"act:jj:0"}


def test_activity_slot_name_falls_back_to_id():
    out = model.activity_slot_events({"activities": [activity(name="")]}, TODAY)
    assert out["act:jj:0"]["summary"] == "jj"


def test_inactive_or_off_grid_or_empty_slot_activities_produce_nothing():
    acts = [
        activity(id="parked", status="parked"),          # a parked activity: nothing
        activity(id="planned", status="planned"),
        activity(id="off-grid", on_grid=False),
        activity(id="no-slots", slots=[]),
        {**activity(id="null-slots"), "slots": None},     # malformed: not a list
        {**activity(id="no-id"), "id": None},
    ]
    assert model.activity_slot_events({"activities": acts}, TODAY) == {}


def test_activity_slot_skips_impossible_days_and_zero_length_blocks():
    acts = [
        activity(id="a1", slots=[{"day": 9, "start": 10, "end": 11}]),
        activity(id="a2", slots=[{"day": 0, "start": 10, "end": 10}]),
        activity(id="a3", slots=[{"day": 0, "start": 12, "end": 11}]),
    ]
    assert model.activity_slot_events({"activities": acts}, TODAY) == {}


def test_multiple_slots_key_by_index():
    acts = [activity(id="two", slots=[{"day": 0, "start": 9, "end": 10}, {"day": 2, "start": 14, "end": 15}])]
    out = model.activity_slot_events({"activities": acts}, TODAY)
    assert set(out) == {"act:two:0", "act:two:1"}
    assert out["act:two:0"]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
    assert out["act:two:1"]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=WE"]


def test_activity_slot_removed_yields_a_delete():
    """Same reconciler path as a deleted template event."""
    before = model.desired_state(schedule(), {"activities": [activity()]}, TODAY)
    existing = [gcal_row("g1", before["act:jj:0"])]
    after_slot_gone = model.desired_state(schedule(), {"activities": [activity(slots=[])]}, TODAY)
    plan = model.reconcile(after_slot_gone, existing)
    assert plan.deletes == ["g1"] and not plan.inserts and not plan.patches


def test_activity_status_no_longer_active_yields_a_delete():
    before = model.desired_state(schedule(), {"activities": [activity()]}, TODAY)
    existing = [gcal_row("g1", before["act:jj:0"])]
    after = model.desired_state(schedule(), {"activities": [activity(status="parked")]}, TODAY)
    plan = model.reconcile(after, existing)
    assert plan.deletes == ["g1"] and not plan.inserts and not plan.patches


# ── skip overrides -> EXDATE ────────────────────────────────────────────────
def skip(eventId=None, activityId=None, date="2026-08-24"):
    o = {"date": date, "action": "skip"}
    if eventId is not None:
        o["eventId"] = eventId
    if activityId is not None:
        o["activityId"] = activityId
    return o


def test_slot_skip_on_the_right_weekday_adds_an_exdate_line():
    """activity() is Mondays 4-5pm; 2026-08-24 is the next Monday on/after DTSTART (08-17)."""
    plan = {"activities": [activity()], "overrides": [skip(activityId="jj", date="2026-08-24")]}
    body = model.activity_slot_events(plan, TODAY)["act:jj:0"]
    assert body["recurrence"] == [
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=America/New_York:20260824T160000",
    ]


def test_two_slot_skips_produce_two_sorted_exdate_lines():
    plan = {
        "activities": [activity()],
        "overrides": [
            skip(activityId="jj", date="2026-09-07"),
            skip(activityId="jj", date="2026-08-31"),
        ],
    }
    body = model.activity_slot_events(plan, TODAY)["act:jj:0"]
    assert body["recurrence"] == [
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=America/New_York:20260831T160000",
        "EXDATE;TZID=America/New_York:20260907T160000",
    ]


def test_slot_skip_on_a_different_weekday_is_ignored():
    plan = {"activities": [activity()], "overrides": [skip(activityId="jj", date="2026-08-25")]}  # Tuesday
    body = model.activity_slot_events(plan, TODAY)["act:jj:0"]
    assert body["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


def test_slot_skip_before_dtstart_is_ignored():
    plan = {"activities": [activity()], "overrides": [skip(activityId="jj", date="2026-08-10")]}  # before 08-17
    body = model.activity_slot_events(plan, TODAY)["act:jj:0"]
    assert body["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


def test_template_eventid_skip_and_slot_activityid_skip_do_not_cross_apply():
    """A tpl: eventId skip and an act: activityId skip in the SAME overrides list
    each land on their own event only, even when the ids happen to line up."""
    overrides = [
        skip(eventId="e1", date="2026-08-24"),
        skip(activityId="jj", date="2026-08-24"),
    ]
    tpl_body = model.template_events(schedule([ev(id="e1", day=0, start=10, end=11)]), TODAY, overrides)["tpl:e1"]
    act_body = model.activity_slot_events({"activities": [activity(id="jj")], "overrides": overrides}, TODAY)["act:jj:0"]
    assert tpl_body["recurrence"] == [
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=America/New_York:20260824T100000",
    ]
    assert act_body["recurrence"] == [
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=America/New_York:20260824T160000",
    ]
    # An eventId-only row must not leak onto the activity, and vice versa.
    act_only = model.activity_slot_events(
        {"activities": [activity(id="jj")], "overrides": [skip(eventId="jj", date="2026-08-24")]}, TODAY
    )["act:jj:0"]
    assert act_only["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
    tpl_only = model.template_events(
        schedule([ev(id="e1", day=0, start=10, end=11)]), TODAY, [skip(activityId="e1", date="2026-08-24")]
    )["tpl:e1"]
    assert tpl_only["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


def test_garbage_skip_rows_are_ignored():
    overrides = [
        "junk",
        None,
        {"action": "skip", "activityId": "jj"},                      # no date
        {"action": "skip", "activityId": "jj", "date": "not-a-date"},  # non-ISO
        {"activityId": "jj", "date": "2026-08-24"},                    # no action
        {"action": "add", "activityId": "jj", "date": "2026-08-24"},   # wrong action
    ]
    plan = {"activities": [activity()], "overrides": overrides}
    body = model.activity_slot_events(plan, TODAY)["act:jj:0"]
    assert body["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


def test_no_skips_leaves_recurrence_byte_identical():
    s = schedule([ev()])
    plain = model.template_events(s, TODAY)
    assert model.template_events(s, TODAY, None) == plain
    assert model.template_events(s, TODAY, []) == plain
    assert plain["tpl:e1"]["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]


def test_skip_changes_the_signature_so_the_reconciler_will_patch():
    without = model.activity_slot_events({"activities": [activity()]}, TODAY)["act:jj:0"]
    plan = {"activities": [activity()], "overrides": [skip(activityId="jj", date="2026-08-24")]}
    with_skip = model.activity_slot_events(plan, TODAY)["act:jj:0"]
    assert model.signature(without) != model.signature(with_skip)


def test_desired_state_passes_overrides_into_template_events():
    s = schedule([ev(id="e1", day=0, start=10, end=11)])
    plan = {"overrides": [skip(eventId="e1", date="2026-08-24")]}
    out = model.desired_state(s, plan, TODAY)
    assert out["tpl:e1"]["recurrence"] == [
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=America/New_York:20260824T100000",
    ]


# ── overrides ───────────────────────────────────────────────────────────────
def override(id="x1", date="2026-08-19", action="add", start=15.5, end=16.5, name="Arya art"):
    return {"id": id, "date": date, "action": action, "start": start, "end": end, "name": name}


def test_override_add_becomes_a_single_timed_event():
    out = model.override_events({"overrides": [override()]}, TODAY)
    body = out["ov:x1"]
    assert body["summary"] == "Arya art"
    assert body["start"] == {"dateTime": "2026-08-19T15:30:00", "timeZone": "America/New_York"}
    assert body["end"] == {"dateTime": "2026-08-19T16:30:00", "timeZone": "America/New_York"}
    assert "recurrence" not in body
    assert body["description"] == model.DESCRIPTION


def test_override_window_is_past_7_days_to_future_365():
    rows = [
        override(id="old", date=(TODAY - dt.timedelta(days=8)).isoformat()),
        override(id="edge-past", date=(TODAY - dt.timedelta(days=7)).isoformat()),
        override(id="edge-future", date=(TODAY + dt.timedelta(days=365)).isoformat()),
        override(id="far", date=(TODAY + dt.timedelta(days=366)).isoformat()),
    ]
    keys = set(model.override_events({"overrides": rows}, TODAY))
    assert keys == {"ov:edge-past", "ov:edge-future"}


def test_skip_overrides_are_not_reflected_in_v1():
    """Documented limitation: no EXDATE handling yet."""
    rows = [override(id="s1", action="skip", start=None, end=None), override(id="a1")]
    assert set(model.override_events({"overrides": rows}, TODAY)) == {"ov:a1"}


def test_timeless_and_malformed_overrides_are_skipped():
    rows = [
        override(id="no-times", start=None, end=None),
        override(id="rev", start=12, end=11),
        override(id="bad-date", date="not-a-date"),
        "junk",
    ]
    assert model.override_events({"overrides": rows}, TODAY) == {}


def test_override_title_falls_back_to_activity_name_then_extra():
    plan = {
        "overrides": [
            {"id": "n1", "date": "2026-08-19", "action": "add", "start": 9, "end": 10,
             "activityId": "core-hala"},
            {"id": "n2", "date": "2026-08-19", "action": "add", "start": 10, "end": 11},
        ],
        "activities": [{"id": "core-hala", "name": "Miss Hala"}],
    }
    out = model.override_events(plan, TODAY)
    assert out["ov:n1"]["summary"] == "Miss Hala"
    assert out["ov:n2"]["summary"] == "Extra"


def test_id_less_override_gets_a_stable_fingerprint_key():
    row = {"date": "2026-08-19", "action": "add", "start": 9, "end": 10, "name": "Makeup"}
    first = model.override_events({"overrides": [row]}, TODAY)
    again = model.override_events({"overrides": [dict(row)]}, TODAY)
    assert list(first) == list(again) == ["ov:2026-08-19|9.0|10.0|Makeup"]


# ── periods ─────────────────────────────────────────────────────────────────
def test_period_becomes_an_all_day_span_with_exclusive_end():
    plan = {"periods": [{"id": "p1", "start": "2026-09-01", "end": "2026-09-05",
                         "type": "travel", "label": "Dhaka"}]}
    body = model.period_events(plan)["pd:p1"]
    assert body["summary"] == "✈️ Dhaka"
    assert body["start"] == {"date": "2026-09-01"}
    assert body["end"] == {"date": "2026-09-06"}          # GCal end.date is exclusive
    assert "recurrence" not in body


def test_single_day_period_still_spans_one_day():
    plan = {"periods": [{"id": "p2", "start": "2026-09-01", "end": "2026-09-01",
                         "type": "off", "label": "Eid"}]}
    body = model.period_events(plan)["pd:p2"]
    assert body["summary"] == "⏸ Eid"
    assert (body["start"]["date"], body["end"]["date"]) == ("2026-09-01", "2026-09-02")


def test_period_label_falls_back_to_its_type():
    plan = {"periods": [{"id": "p3", "start": "2026-09-01", "end": "2026-09-02", "type": "travel"},
                        {"id": "p4", "start": "2026-09-03", "end": "2026-09-04", "type": "off"}]}
    out = model.period_events(plan)
    assert out["pd:p3"]["summary"] == "✈️ Travel"
    assert out["pd:p4"]["summary"] == "⏸ Time off"


def test_malformed_periods_are_skipped():
    plan = {"periods": [
        {"id": "b1", "start": "2026-09-05", "end": "2026-09-01", "type": "travel"},   # reversed
        {"id": "b2", "start": "2026-09-01", "end": "2026-09-02", "type": "light"},    # dead type
        {"start": "2026-09-01", "end": "2026-09-02", "type": "off"},                  # no id
        None,
    ]}
    assert model.period_events(plan) == {}


# ── desired state ───────────────────────────────────────────────────────────
def test_desired_state_merges_all_three_sources_without_key_collisions():
    s = schedule([ev(id="p1")])
    plan = {
        "overrides": [override(id="p1")],
        "periods": [{"id": "p1", "start": "2026-09-01", "end": "2026-09-02", "type": "off"}],
    }
    keys = set(model.desired_state(s, plan, TODAY))
    assert keys == {"tpl:p1", "ov:p1", "pd:p1"}           # same id, three namespaces


def test_every_desired_event_carries_the_sync_property_and_do_not_edit_note():
    s = schedule([ev()])
    plan = {"overrides": [override()],
            "periods": [{"id": "p1", "start": "2026-09-01", "end": "2026-09-02", "type": "off"}]}
    for key, body in model.desired_state(s, plan, TODAY).items():
        priv = body["extendedProperties"]["private"]
        assert priv["aoifeSync"] == "v1"
        assert priv["syncKey"] == key
        assert priv["sig"] == model.signature(body)
        assert body["description"] == model.DESCRIPTION


def test_signature_changes_with_content_and_is_stable_otherwise():
    a = model.template_events(schedule([ev(name="Quran")]), TODAY)["tpl:e1"]
    b = model.template_events(schedule([ev(name="Quran")]), TODAY)["tpl:e1"]
    c = model.template_events(schedule([ev(name="Quran", start=10.5)]), TODAY)["tpl:e1"]
    assert model.sig_of(a) == model.sig_of(b) != model.sig_of(c)


# ── the DTSTART anchor (a weekly series must not drift) ─────────────────────
def test_a_recurring_signature_ignores_which_week_it_was_built_in():
    """Otherwise every Monday looks like a change and re-patches the world."""
    this_week = model.template_events(schedule([ev()]), TODAY)["tpl:e1"]
    next_week = model.template_events(schedule([ev()]), TODAY + dt.timedelta(days=7))["tpl:e1"]
    later = model.template_events(schedule([ev()]), TODAY + dt.timedelta(days=200))["tpl:e1"]
    assert model.sig_of(this_week) == model.sig_of(next_week) == model.sig_of(later)
    assert this_week["start"]["dateTime"] != next_week["start"]["dateTime"]   # dates DO differ


def test_a_one_off_signature_does_depend_on_its_date():
    mon = model.override_events({"overrides": [override(date="2026-08-19")]}, TODAY)["ov:x1"]
    tue = model.override_events({"overrides": [override(date="2026-08-20")]}, TODAY)["ov:x1"]
    assert model.sig_of(mon) != model.sig_of(tue)


def test_a_week_passing_produces_no_patches_at_all():
    s = schedule([ev(id="e1"), ev(id="e2", day=4, cat="hala")])
    existing = [gcal_row(f"g{i}", b) for i, b in enumerate(model.desired_state(s, {}, TODAY).values())]
    later = model.desired_state(s, {}, TODAY + dt.timedelta(days=21))
    plan = model.reconcile(later, existing)
    assert plan.touched == 0 and plan.unchanged == 2


def test_patching_a_time_change_keeps_the_original_start_date():
    before = model.template_events(schedule([ev(start=10, end=11)]), TODAY)["tpl:e1"]
    row = gcal_row("g1", before)
    row["start"] = {"dateTime": "2026-06-01T10:00:00", "timeZone": model.TZ}   # anchored in June
    after = model.template_events(schedule([ev(start=10.5, end=11)]), TODAY)
    (_, body), = model.reconcile(after, [row]).patches
    assert body["start"]["dateTime"] == "2026-06-01T10:30:00"                  # anchor kept
    assert body["end"]["dateTime"] == "2026-06-01T11:00:00"
    assert body["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
    assert model.sig_of(body) == model.sig_of(after["tpl:e1"])                 # anchor is not content


def test_patching_a_weekday_change_re_anchors_to_this_week():
    before = model.template_events(schedule([ev(day=0)]), TODAY)["tpl:e1"]
    row = gcal_row("g1", before)
    row["start"] = {"dateTime": "2026-06-01T10:00:00", "timeZone": model.TZ}   # a Monday
    after = model.template_events(schedule([ev(day=3)]), TODAY)                # moved to Thursday
    (_, body), = model.reconcile(after, [row]).patches
    assert body["start"]["dateTime"].startswith("2026-08-20")                  # this week's Thu
    assert body["recurrence"] == ["RRULE:FREQ=WEEKLY;BYDAY=TH"]


def test_keep_anchor_leaves_one_offs_and_all_day_periods_alone():
    one_off = model.override_events({"overrides": [override()]}, TODAY)["ov:x1"]
    period = model.period_events(
        {"periods": [{"id": "p1", "start": "2026-09-01", "end": "2026-09-02", "type": "off"}]})["pd:p1"]
    stale = {"start": {"dateTime": "2020-01-01T09:00:00"}}
    assert model.keep_anchor(one_off, stale) == one_off
    assert model.keep_anchor(period, stale) == period


# ── reconcile ───────────────────────────────────────────────────────────────
def gcal_row(event_id, body=None, key=None):
    """A fake Google event resource, as events.list would return it."""
    if body is not None:
        return {"id": event_id, "extendedProperties": body["extendedProperties"]}
    return {"id": event_id, "extendedProperties": {"private": {"aoifeSync": "v1", "syncKey": key}}}


def test_reconcile_inserts_everything_into_an_empty_calendar():
    desired = model.desired_state(schedule([ev(id="e1"), ev(id="e2", day=1)]), {}, TODAY)
    plan = model.reconcile(desired, [])
    assert len(plan.inserts) == 2 and not plan.patches and not plan.deletes
    assert plan.unchanged == 0


def test_reconcile_leaves_unchanged_events_alone():
    desired = model.desired_state(schedule([ev(id="e1")]), {}, TODAY)
    existing = [gcal_row("g1", desired["tpl:e1"])]
    plan = model.reconcile(desired, existing)
    assert plan.touched == 0 and plan.unchanged == 1


def test_reconcile_patches_an_event_whose_content_moved():
    before = model.desired_state(schedule([ev(id="e1", start=10, end=11)]), {}, TODAY)
    after = model.desired_state(schedule([ev(id="e1", start=11, end=12)]), {}, TODAY)
    plan = model.reconcile(after, [gcal_row("g1", before["tpl:e1"])])
    assert plan.patches == [("g1", after["tpl:e1"])]
    assert not plan.inserts and not plan.deletes


def test_reconcile_deletes_orphans_whose_source_row_is_gone():
    desired = model.desired_state(schedule([ev(id="e1")]), {}, TODAY)
    existing = [gcal_row("g1", desired["tpl:e1"]), gcal_row("g2", key="tpl:e-deleted")]
    plan = model.reconcile(desired, existing)
    assert plan.deletes == ["g2"] and plan.unchanged == 1


def test_reconcile_deletes_rows_with_the_marker_but_no_synckey():
    plan = model.reconcile({}, [{"id": "g9", "extendedProperties": {"private": {"aoifeSync": "v1"}}}])
    assert plan.deletes == ["g9"]


def test_reconcile_collapses_duplicates_of_one_key():
    desired = model.desired_state(schedule([ev(id="e1")]), {}, TODAY)
    body = desired["tpl:e1"]
    plan = model.reconcile(desired, [gcal_row("g2", body), gcal_row("g1", body), gcal_row("g3", body)])
    assert plan.deletes == ["g2", "g3"]                    # lowest id kept, stable across runs
    assert plan.unchanged == 1


def test_reconcile_never_sees_the_familys_own_events():
    """The API filter does the protecting; this pins the contract it relies on.

    events.list is called with privateExtendedProperty=aoifeSync=v1, so a hand
    -added event never reaches `existing` — and reconcile only ever emits ids it
    read from `existing`.
    """
    desired = model.desired_state(schedule([ev(id="e1")]), {}, TODAY)
    plan = model.reconcile(desired, [])
    assert plan.deletes == []


def test_full_round_trip_is_idempotent():
    s = schedule([ev(id="e1"), ev(id="e2", day=3, cat="hala")], {"hala": "Miss Hala"})
    plan_blob = {
        "overrides": [override()],
        "periods": [{"id": "p1", "start": "2026-09-01", "end": "2026-09-05", "type": "travel"}],
    }
    desired = model.desired_state(s, plan_blob, TODAY)
    existing = [gcal_row(f"g{i}", body) for i, body in enumerate(desired.values())]
    plan = model.reconcile(desired, existing)
    assert plan.touched == 0 and plan.unchanged == len(desired) == 4
