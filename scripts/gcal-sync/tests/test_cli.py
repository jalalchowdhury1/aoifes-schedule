"""Marker/wiring tests for the I/O half. Google is faked; nothing hits the network."""

import datetime as dt

import pytest

from gcal_sync import cli, model


# ── a minimal fake of the discovery client ──────────────────────────────────
class _Req:
    def __init__(self, result, on_execute=None):
        self._result, self._on_execute = result, on_execute

    def execute(self):
        if self._on_execute:
            self._on_execute()
        return self._result


class FakeHttpError(Exception):
    """Stands in for googleapiclient.errors.HttpError (which needs a real resp)."""

    class _Resp:
        def __init__(self, status):
            self.status = status

    def __init__(self, status, text):
        super().__init__(text)
        self.resp = self._Resp(status)


class FakeEvents:
    def __init__(self, items, raise_on_write=None):
        self.items = list(items)
        self.inserted, self.patched, self.deleted = [], [], []
        self._raise_on_write = raise_on_write

    def list(self, **kw):
        self.last_list_kwargs = kw
        return _Req({"items": self.items})

    def _write(self, record):
        if self._raise_on_write:
            raise self._raise_on_write
        record()

    def insert(self, calendarId, body):
        return _Req(None, lambda: self._write(lambda: self.inserted.append(body)))

    def patch(self, calendarId, eventId, body):
        return _Req(None, lambda: self.patched.append((eventId, body)))

    def delete(self, calendarId, eventId):
        return _Req(None, lambda: self.deleted.append(eventId))


def shared(name="Aoife's School", role="writer", id="cal123"):
    """A calendarList entry as Google returns it for a shared calendar."""
    return {"id": id, "summary": name, "accessRole": role}


class FakeService:
    def __init__(self, calendars=(), events=(), raise_on_calendar_list=None,
                 raise_on_write=None):
        self._calendars = list(calendars)
        self._events = FakeEvents(events, raise_on_write)
        self._raise = raise_on_calendar_list

    def calendarList(self):
        service = self

        class _CL:
            def list(self, **kw):
                if service._raise:
                    raise service._raise
                return _Req({"items": service._calendars})

        return _CL()

    def events(self):
        return self._events


@pytest.fixture
def wired(monkeypatch):
    """Patch the two blob fetches + the client builder; hand back the fake."""
    state = {}

    def install(service, schedule=None, plan=None):
        state["service"] = service
        blobs = {
            f"{cli.BASE}/api/get": schedule if schedule is not None else {"events": [], "catLabels": {}},
            f"{cli.BASE}/api/plan-get": plan if plan is not None else {},
        }
        monkeypatch.setattr(cli, "fetch_blob", lambda url: blobs[url])
        monkeypatch.setattr(cli, "build_service", lambda path: service)
        monkeypatch.setattr(cli.os.path, "exists", lambda p: True)
        return service

    return install


def test_waiting_marker_when_the_calendar_is_not_shared_yet(wired, capsys):
    wired(FakeService(calendars=[{"id": "other@group.calendar.google.com", "summary": "Some Other"}]))
    assert cli.main([]) == 0                        # exit 0: the owner's step, not a failure
    out = capsys.readouterr().out
    assert "GCAL-SYNC WAITING calendar-not-shared-yet" in out
    assert "GCAL-SYNC OK" not in out and "GCAL-SYNC FAIL" not in out


def test_waiting_marker_when_the_calendar_api_is_disabled(wired, capsys):
    boom = RuntimeError('returned "Google Calendar API has not been used in project 739663142592"')
    wired(FakeService(raise_on_calendar_list=boom))
    assert cli.main([]) == 0
    assert "GCAL-SYNC WAITING calendar-api-disabled" in capsys.readouterr().out


def test_waiting_marker_on_the_accessNotConfigured_403(wired, capsys):
    """The literal shape Google returns before the API is switched on."""
    boom = FakeHttpError(403, '{"error":{"errors":[{"reason":"accessNotConfigured"}]}}')
    wired(FakeService(raise_on_calendar_list=boom))
    assert cli.main([]) == 0
    assert "GCAL-SYNC WAITING calendar-api-disabled" in capsys.readouterr().out


# ── the read-only-share gate ────────────────────────────────────────────────
@pytest.mark.parametrize("role", ["reader", "freeBusyReader", "none", None])
def test_a_read_only_share_waits_instead_of_writing(wired, capsys, role):
    """"See all event details" lists fine and 403s every write, one at a time.

    Stop at the accessRole instead: the log then names the missing step rather
    than showing a wall of identical permission errors.
    """
    svc = wired(
        FakeService(calendars=[shared(role=role)]),
        schedule={"events": [{"id": "e1", "cat": "quran", "day": 0, "start": 10, "end": 11}]},
    )
    assert cli.main([]) == 0
    out = capsys.readouterr().out
    assert "GCAL-SYNC WAITING write-permission" in out and f"'{role}'" in out
    assert "GCAL-SYNC OK" not in out and "GCAL-SYNC FAIL" not in out
    assert svc.events().inserted == [] and svc.events().deleted == []
    assert not hasattr(svc.events(), "last_list_kwargs")      # nothing was even read


@pytest.mark.parametrize("role", ["writer", "owner"])
def test_a_writable_share_syncs(wired, capsys, role):
    svc = wired(
        FakeService(calendars=[shared(role=role)]),
        schedule={"events": [{"id": "e1", "cat": "quran", "day": 0, "start": 10, "end": 11}]},
    )
    assert cli.main([]) == 0
    assert "GCAL-SYNC OK" in capsys.readouterr().out
    assert len(svc.events().inserted) == 1


def test_a_403_during_a_write_is_a_wait_not_a_fail(wired, capsys):
    """The share can be downgraded after the accessRole was read."""
    denied = FakeHttpError(403, '{"error":{"errors":[{"reason":"forbidden"}]}}')
    wired(
        FakeService(calendars=[shared()], raise_on_write=denied),
        schedule={"events": [{"id": "e1", "cat": "quran", "day": 0, "start": 10, "end": 11}]},
    )
    assert cli.main([]) == 0
    out = capsys.readouterr().out
    assert "GCAL-SYNC WAITING write-permission" in out and "GCAL-SYNC FAIL" not in out


@pytest.mark.parametrize("status,text", [
    (403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}'),
    (403, '{"error":{"errors":[{"reason":"quotaExceeded"}]}}'),
    (500, "backend error"),
])
def test_a_throttle_or_server_error_during_a_write_still_fails(wired, capsys, status, text):
    """Rate limits are real failures — hiding them behind WAITING would mean a
    sync that quietly stopped publishing and never told anyone."""
    wired(
        FakeService(calendars=[shared()], raise_on_write=FakeHttpError(status, text)),
        schedule={"events": [{"id": "e1", "cat": "quran", "day": 0, "start": 10, "end": 11}]},
    )
    assert cli.main([]) == 1
    out = capsys.readouterr().out
    assert "GCAL-SYNC FAIL" in out and "WAITING" not in out


def test_a_real_error_is_a_fail_not_a_wait(wired, capsys):
    wired(FakeService(raise_on_calendar_list=RuntimeError("network on fire")))
    assert cli.main([]) == 1
    out = capsys.readouterr().out
    assert "GCAL-SYNC FAIL" in out and "network on fire" in out
    assert "WAITING" not in out


def test_missing_service_account_fails_fast(monkeypatch, capsys):
    monkeypatch.setattr(cli.os.path, "exists", lambda p: False)
    assert cli.main(["--service-account", "/nope/sa.json"]) == 1
    out = capsys.readouterr().out
    assert "GCAL-SYNC FAIL" in out and "service-account-missing" in out


def test_ok_marker_counts_the_synced_events_and_writes_them(wired, capsys):
    svc = wired(
        FakeService(calendars=[shared()]),
        schedule={"events": [{"id": "e1", "cat": "quran", "day": 0, "start": 10, "end": 11},
                             {"id": "e999"}],           # the corrupt record must not sync
                  "catLabels": {}},
        plan={"overrides": [], "periods": []},
    )
    assert cli.main([]) == 0
    out = capsys.readouterr().out
    assert f"GCAL-SYNC OK {dt.date.today().isoformat()} 1" in out
    assert len(svc.events().inserted) == 1
    assert model.sync_key(svc.events().inserted[0]) == "tpl:e1"


def test_list_is_filtered_to_this_syncs_own_events(wired):
    svc = wired(FakeService(calendars=[shared()]))
    cli.main([])
    kw = svc.events().last_list_kwargs
    assert kw["privateExtendedProperty"] == "aoifeSync=v1"
    assert kw["singleEvents"] is False               # patch the master, not an instance
    assert kw["calendarId"] == "cal123"


def test_dry_run_writes_nothing(wired, capsys):
    svc = wired(
        FakeService(calendars=[shared()]),
        schedule={"events": [{"id": "e1", "cat": "quran", "day": 0, "start": 10, "end": 11}]},
    )
    assert cli.main(["--dry-run"]) == 0
    assert "GCAL-SYNC DRY-RUN" in capsys.readouterr().out
    assert svc.events().inserted == [] and svc.events().deleted == []


def test_stale_synced_event_is_deleted_and_a_changed_one_patched(wired, capsys):
    today = dt.date.today()
    desired = model.desired_state(
        {"events": [{"id": "e1", "cat": "quran", "day": today.weekday(), "start": 10, "end": 11}]},
        {}, today)
    moved = dict(desired["tpl:e1"])
    stale_props = {"private": dict(moved["extendedProperties"]["private"], sig="deadbeef")}
    existing = [
        {"id": "g1", "extendedProperties": stale_props},                                  # changed
        {"id": "g2", "extendedProperties": {"private": {"aoifeSync": "v1", "syncKey": "tpl:gone"}}},
    ]
    svc = wired(
        FakeService(calendars=[shared()], events=existing),
        schedule={"events": [{"id": "e1", "cat": "quran", "day": today.weekday(),
                              "start": 10, "end": 11}]},
    )
    assert cli.main([]) == 0
    assert svc.events().inserted == []
    assert [eid for eid, _ in svc.events().patched] == ["g1"]
    assert svc.events().deleted == ["g2"]
