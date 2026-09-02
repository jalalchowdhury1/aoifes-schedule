# A ✓ on a class block is that lesson done — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ticking a paced on-grid class (Geography, Science) ✓ — on the site, the phone, or the Telegram bot — also logs its next lesson; unticking or changing the tick to ◐/✗ takes that day's lesson back.

**Architecture:** Two rows, two meanings. `logTimed` (site) and `_apply_log_status`'s timed branch (bot) keep writing the attendance row exactly as today, then apply one extra transition for a `type:'paced'` activity logged by `activityId`: entering `done` appends a curriculum row at `nextIndex(cur)` and `markSessionDone`s; leaving `done` removes that date's curriculum rows and `unmarkSession`s each. One reader (`subjectCards.sessionsThisWeek`) is tightened to lesson rows so a class counts once.

**Tech Stack:** Planner: vanilla ES modules, `node --test tests/*.test.mjs` (baseline **377**). Bot: Python, `uv run pytest -q` (baseline **583**), deploy `vercel --prod --yes` from the bot repo root (CLI only). Spec: `docs/superpowers/specs/2026-09-01-class-tick-advances-lesson-design.md` (planner repo).

Repo paths — ALWAYS quote the first: `"/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"` (planner, branch `main`, HEAD `8501f59`) and `~/PycharmProjects/aoife-school-bot` (bot, branch `main`, HEAD `1daa565`). Every commit message ends with:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG
```

Tasks 1 and 2 are in different repos and may run in parallel. Task 3 runs after both.

---

## File map

| Repo | File | Change |
|---|---|---|
| planner | `js/plan/state.js` | `logTimed`: lesson advance / rollback for paced on-grid activities |
| planner | `js/plan/mday.js` | `subjectCards.sessionsThisWeek` counts lesson rows only |
| planner | `tests/plan-state.test.mjs`, `tests/plan-mday.test.mjs` | tests |
| planner | `index.html`, `AGENTS.md` | stamps `2026-09-01-2` → `2026-09-01-3`; docs |
| bot | `lib/ops.py` | `_apply_log_status` timed branch: same two transitions, `· <lesson>` suffix |
| bot | `tests/test_ops.py` | tests |
| bot | `AGENTS.md` | docs |

---

### Task 1 (planner): `logTimed` advances the lesson; `sessionsThisWeek` counts lessons only

**Files:**
- Modify: `js/plan/state.js` — `export function logTimed(...)` (~line 226; the whole function body is replaced below)
- Modify: `js/plan/mday.js` — `sessionsThisWeek` inside `subjectCards` (~line 433)
- Test: `tests/plan-state.test.mjs` (append), `tests/plan-mday.test.mjs` (append)

Context the implementer needs: `js/plan/state.js` already imports `currentCur, nextIndex, markSessionDone, unmarkSession` from `./model.js` and defines `getActivity(id)` and `commit()`. Row shapes in play: attendance `{date, status, timed:true, activityId}`; lesson `{date, activityId, status:'done', curriculum, session}` (`session` is a 0-based index; `nextIndex(cur)` returns the lowest owed index, else the next fresh one, or `null` when the chain is exhausted). `tests/plan-state.test.mjs` has `initPlan`, `plan`, `logTimed`, `snap`, and `const D = '2026-09-01'` in scope; `initPlan()` loads the seed, whose `geography` activity is `status:'planned'`, `onGrid:true`, `slots:[]` — tests set the fields they need directly on `plan.data` (the `setSlot` tests at the end of the file do exactly this).

- [ ] **Step 1: Write the failing tests**

Append to `tests/plan-state.test.mjs`:

```js
// ── logTimed on a paced on-grid class: attendance ⇒ next lesson (2026-09-01) ──
function armGeography() {
  initPlan();
  const geo = plan.data.activities.find(a => a.id === 'geography');
  geo.status = 'active'; geo.onGrid = true; geo.type = 'paced';
  geo.slots = [{ day: 1, start: 11, end: 12 }];
  geo.chain = [{ id: 'geo-1', name: 'Year 1', pattern: 'simple', firstUnit: 1, lastUnit: 30, done: 0,
                 unitWord: 'Week', titles: { '1': 'Introduction to Geography' } }];
  return geo;
}
const geoRows = () => plan.data.log.filter(e => e.date === D && e.activityId === 'geography');

test('logTimed: ✓ on a paced on-grid class writes attendance AND its next lesson', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'done', D);
  assert.deepEqual(geoRows(), [
    { date: D, status: 'done', timed: true, activityId: 'geography' },
    { date: D, activityId: 'geography', status: 'done', curriculum: 'geo-1', session: 0 },
  ]);
  assert.equal(geo.chain[0].done, 1);
});

test('logTimed: tapping ✓ again (toggle off) removes the lesson and restores done', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'done', D);
  logTimed(null, 'geography', 'done', D);
  assert.deepEqual(geoRows(), []);
  assert.equal(geo.chain[0].done, 0);
});

test('logTimed: done → missed rolls the lesson back; missed → done advances again', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'done', D);
  logTimed(null, 'geography', 'missed', D);
  assert.deepEqual(geoRows(), [{ date: D, status: 'missed', timed: true, activityId: 'geography' }]);
  assert.equal(geo.chain[0].done, 0);
  logTimed(null, 'geography', 'done', D);
  assert.equal(geo.chain[0].done, 1);
  assert.equal(geoRows().length, 2);
});

test('logTimed: partial never advances; an exhausted chain writes attendance only', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'partial', D);
  assert.equal(geo.chain[0].done, 0);
  assert.equal(geoRows().length, 1);
  initPlan();
  const g2 = armGeography();
  g2.chain[0].done = 30;                                   // every session done
  logTimed(null, 'geography', 'done', D);
  assert.deepEqual(geoRows(), [{ date: D, status: 'done', timed: true, activityId: 'geography' }]);
  assert.equal(g2.chain[0].done, 30);
});

test('logTimed: untick only takes back THAT day\'s lesson, never an earlier day\'s', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'done', '2026-08-25');       // last week's class
  logTimed(null, 'geography', 'done', D);
  assert.equal(geo.chain[0].done, 2);
  logTimed(null, 'geography', 'done', D);                  // untick today
  assert.equal(geo.chain[0].done, 1);
  assert.equal(plan.data.log.filter(e => e.activityId === 'geography' && e.curriculum).length, 1);
  assert.equal(plan.data.log.find(e => e.activityId === 'geography' && e.curriculum).date, '2026-08-25');
});

test('logTimed: a template event and a target activity are untouched by the lesson rule', () => {
  armGeography();
  const jj = plan.data.activities.find(a => a.id === 'jj');
  jj.status = 'active'; jj.onGrid = true; jj.slots = [{ day: 0, start: 16, end: 17 }];
  logTimed('e1003', null, 'done', D);
  logTimed(null, 'jj', 'done', D);
  assert.deepEqual(plan.data.log.filter(e => e.date === D), [
    { date: D, status: 'done', timed: true, eventId: 'e1003' },
    { date: D, status: 'done', timed: true, activityId: 'jj' },
  ]);
});
```

Append to `tests/plan-mday.test.mjs` (read the file's existing `subjectCards` tests first and reuse their plan-building helper; if the file builds plans inline with `sanitizePlan`, do the same):

```js
test('subjectCards: sessionsThisWeek counts lesson rows, not the attendance row of the same class', () => {
  const mon = mondayOf('2026-09-01');                       // any date inside the week under test
  const p = sanitizePlan({
    year: { label: 'y', start: '2026-08-17', end: '2027-08-31' },
    parentCycle: { anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: true },
    periods: [], overrides: [],
    activities: [{ id: 'geography', name: 'Geography', type: 'paced', status: 'active', cls: 'g', onGrid: true,
      slots: [{ day: 0, start: 11, end: 12 }], rhythm: { kind: 'weekly', perWeek: 1 }, travel: { mode: 'pause' },
      chain: [{ id: 'geo-1', pattern: 'simple', firstUnit: 1, lastUnit: 30, done: 1, unitWord: 'Week', titles: {} }] }],
    log: [
      { date: mon, status: 'done', timed: true, activityId: 'geography' },
      { date: mon, activityId: 'geography', status: 'done', curriculum: 'geo-1', session: 0 },
    ],
  });
  const card = subjectCards(p, '2026-09-01').find(c => c.id === 'geography');
  assert.equal(card.sessionsThisWeek, 1);
});
```

(Import `mondayOf`, `sanitizePlan` from `'../js/plan/model.js'` and `subjectCards` from `'../js/plan/mday.js'` if that file does not already.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule" && node --test tests/plan-state.test.mjs tests/plan-mday.test.mjs 2>&1 | grep -E "^not ok" | head`
Expected: the six new `logTimed` tests that assert a lesson row / `done` change fail; the `sessionsThisWeek` test fails with `2 !== 1`. (The "template event and target" test may already pass — fine.)

- [ ] **Step 3: Implement `logTimed`**

In `js/plan/state.js`, replace the body of `export function logTimed(eventId, activityId, status, date = todayStr())` with:

```js
export function logTimed(eventId, activityId, status, date = todayStr()) {
  // Refuse an ownerless write. With neither key the pushed entry has nothing to
  // find it by, and `match`'s activityId branch would compare `undefined ===
  // undefined` against every other keyless timed entry on the date — one tap
  // would then appear to toggle an unrelated block. sanitizePlan drops such
  // rows on the next load anyway, so writing one only corrupts the session.
  if (!eventId && !activityId) return;
  const match = e => e.date === date &&
    (eventId ? e.eventId === eventId : e.activityId === activityId && e.timed);
  const i = plan.data.log.findIndex(match);
  // Read both transitions BEFORE mutating: a toggle-off splices the row out
  // from under `i`, so nothing below may look at log[i] afterwards.
  const wasDone = i >= 0 && plan.data.log[i].status === 'done';
  const nowDone = status === 'done' && !(i >= 0 && plan.data.log[i].status === status);
  if (i >= 0 && plan.data.log[i].status === status) plan.data.log.splice(i, 1);
  else if (i >= 0) plan.data.log[i].status = status;
  else plan.data.log.push({ date, status, timed: true,
    ...(eventId ? { eventId } : {}), ...(activityId ? { activityId } : {}) });
  // A ✓ on a paced on-grid class IS its next lesson (2026-09-01): the class
  // runs the curriculum in order and the parents are not in the room, so
  // attendance is the only signal there is. Two rows, two meanings — the timed
  // row above is attendance, the curriculum row below is the lesson — which is
  // exactly the "one log row = one session" invariant every reader already
  // separates on (`e.timed` vs `e.curriculum`). Template events (eventId) and
  // one-offs carry no chain; a `target` activity has none either.
  if (!eventId && activityId) {
    const act = getActivity(activityId);
    if (act && act.type === 'paced' && (act.chain || []).length) {
      if (nowDone && !wasDone) {
        const cur = currentCur(act);
        const s = cur ? nextIndex(cur) : null;
        if (cur && s != null) {
          plan.data.log.push({ date, activityId, status: 'done', curriculum: cur.id, session: s });
          markSessionDone(cur, s);
        }
      } else if (wasDone && !nowDone) {
        // Only rows dated `date` — an earlier day's lesson belongs to that day
        // (the Subjects sheet's "Oops" is where history gets taken back).
        for (let k = plan.data.log.length - 1; k >= 0; k--) {
          const e = plan.data.log[k];
          if (!e || e.date !== date || e.activityId !== activityId || e.status !== 'done') continue;
          if (e.timed || e.eventId || !e.curriculum || typeof e.session !== 'number') continue;
          const cur = (act.chain || []).find(c => c && c.id === e.curriculum);
          if (cur) unmarkSession(cur, e.session);
          plan.data.log.splice(k, 1);
        }
      }
    }
  }
  commit();
}
```

- [ ] **Step 4: Implement the `sessionsThisWeek` fix**

In `js/plan/mday.js` inside `subjectCards`, replace

```js
    const sessionsThisWeek = (Array.isArray(plan?.log) ? plan.log : []).filter(e =>
      e && e.activityId === a.id && e.status === 'done' && e.date >= weekStart && e.date <= weekEnd).length;
```

with

```js
    // Lesson rows only: an on-grid class also carries a `timed` attendance row
    // for the same date (logTimed, 2026-09-01), and that is not a second session.
    const sessionsThisWeek = (Array.isArray(plan?.log) ? plan.log : []).filter(e =>
      e && e.activityId === a.id && e.status === 'done' && !e.timed && !e.eventId &&
      e.date >= weekStart && e.date <= weekEnd).length;
```

- [ ] **Step 5: Run the suite**

Run: `node --test tests/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 384` / `pass 384` / `fail 0` (377 + 6 + 1).

- [ ] **Step 6: Commit**

```bash
git add js/plan/state.js js/plan/mday.js tests/plan-state.test.mjs tests/plan-mday.test.mjs
git commit -m "logTimed: a ✓ on a paced on-grid class logs its next lesson; untick takes it back

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG"
```

---

### Task 2 (bot): `_apply_log_status` timed branch mirrors the site

**Files:**
- Modify: `lib/ops.py` — the `if timed:` branch of `_apply_log_status` (~lines 488–505) and the function's final `return` (~line 541)
- Test: `tests/test_ops.py` (append)

Context: `compose.find_activity(plan, id)`, `compose.current_cur(act)`, `compose.next_index(cur)` (returns `None` when the chain is exhausted — verify by reading `lib/compose.py:404`), `compose.mark_session_done(cur, s)`, `compose.session_label(cur, s)` and the module-level `_rollback_chain(act, entry)` (defined below `_apply_log_status`; Python resolves it at call time) all exist. The `tests/conftest.py` `plan` fixture has `geography` = paced, active, `onGrid: True`, slot Tuesday 9:30–10:30, chain `geo-1` (firstUnit 1, lastUnit 36, done 0, unitWord "Week", titles {}); `ctx.today` is `TUESDAY` (`2026-08-18`), so `compose.expected_items(TUESDAY, …)` contains the geography timed item — confirm its `target` is `"geography"` by reading `compose.py` ~line 690 before writing the tests. `tests/test_ops.py` already imports `compose`, `ops`, `pytest`, and `MONDAY, SATURDAY, TUESDAY, WEDNESDAY` from `tests.conftest`; its existing `test_log_status_accepts_a_scheduled_event` shows a template-event target you can reuse.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_ops.py`:

```python
# ── timed ✓ on a paced on-grid class ⇒ its next lesson (parity with the site's
# logTimed, 2026-09-01). Attendance row + lesson row, two rows two meanings. ──
def _geo(plan):
    return next(a for a in plan["activities"] if a["id"] == "geography")


def _geo_rows(plan):
    return [e for e in plan["log"] if e.get("activityId") == "geography"]


def test_timed_done_on_a_paced_ongrid_class_advances_its_lesson(ctx):
    plan, message, changed = ops.apply_op(
        ctx.plan, {"op": "log_status", "target": "geography", "status": "done"}, ctx)
    assert changed
    assert _geo(plan)["chain"][0]["done"] == 1
    rows = _geo_rows(plan)
    assert {"date": TUESDAY, "status": "done", "timed": True, "activityId": "geography",
            "src": "tg"} in rows
    assert {"date": TUESDAY, "activityId": "geography", "status": "done",
            "curriculum": "geo-1", "session": 0, "src": "tg"} in rows
    assert len(rows) == 2
    assert message.startswith("Logged: Geography")
    assert message.endswith(compose.session_label(_geo(plan)["chain"][0], 0))


def test_timed_missed_after_done_rolls_the_lesson_back(ctx):
    plan, _, _ = ops.apply_op(
        ctx.plan, {"op": "log_status", "target": "geography", "status": "done"}, ctx)
    ctx2 = ops.Ctx(today=ctx.today, schedule=ctx.schedule, plan=plan)
    plan2, _, _ = ops.apply_op(
        plan, {"op": "log_status", "target": "geography", "status": "missed"}, ctx2)
    assert _geo(plan2)["chain"][0]["done"] == 0
    assert _geo_rows(plan2) == [{"date": TUESDAY, "status": "missed", "timed": True,
                                 "activityId": "geography", "src": "tg"}]


def test_timed_partial_never_advances_and_a_second_done_is_idempotent(ctx):
    plan, _, _ = ops.apply_op(
        ctx.plan, {"op": "log_status", "target": "geography", "status": "partial"}, ctx)
    assert _geo(plan)["chain"][0]["done"] == 0
    assert len(_geo_rows(plan)) == 1
    ctx2 = ops.Ctx(today=ctx.today, schedule=ctx.schedule, plan=plan)
    plan2, _, _ = ops.apply_op(
        plan, {"op": "log_status", "target": "geography", "status": "done"}, ctx2)
    ctx3 = ops.Ctx(today=ctx.today, schedule=ctx.schedule, plan=plan2)
    plan3, _, _ = ops.apply_op(
        plan2, {"op": "log_status", "target": "geography", "status": "done"}, ctx3)
    assert _geo(plan3)["chain"][0]["done"] == 1          # done → done: no second lesson
    assert len(_geo_rows(plan3)) == 2


def test_timed_done_on_a_template_event_writes_attendance_only(ctx):
    # Reuse the event target from test_log_status_accepts_a_scheduled_event.
    target = next(e["id"] for e in ctx.schedule["events"]
                  if e.get("day") == 1)                   # a Tuesday template block
    plan, _, _ = ops.apply_op(
        ctx.plan, {"op": "log_status", "target": target, "status": "done"}, ctx)
    assert plan["log"] == [{"date": TUESDAY, "status": "done", "timed": True,
                            "eventId": target, "src": "tg"}]
    assert _geo(plan)["chain"][0]["done"] == 0
```

If the schedule fixture has no `day == 1` event, pick any event id the existing scheduled-event test uses and adjust `TUESDAY` to that event's day accordingly — report the adaptation.

- [ ] **Step 2: Run to verify they fail**

Run: `cd ~/PycharmProjects/aoife-school-bot && uv run pytest -q tests/test_ops.py 2>&1 | tail -6`
Expected: the first three new tests fail (no lesson row / `done` unchanged / message lacks the suffix); the fourth passes already.

- [ ] **Step 3: Implement**

In `lib/ops.py`, `_apply_log_status`: replace the `if timed:` block (from `if timed:` through the line `entries.append(entry)` that closes its `else:`) with:

```python
    lesson_label = None
    if timed:
        def match(e):
            if is_event:
                return e.get("date") == date_str and e.get("eventId") == target
            return (e.get("date") == date_str and e.get("activityId") == target
                    and e.get("timed"))
        existing = next((e for e in entries if match(e)), None)
        was_done = bool(existing and existing.get("status") == "done")
        if existing:
            existing["status"] = status
            existing["src"] = "tg"
        else:
            entry = {"date": date_str, "status": status, "timed": True, "src": "tg"}
            entry["eventId" if is_event else "activityId"] = target
            entries.append(entry)
        # A ✓ on a paced on-grid class IS its next lesson (parity with the
        # site's logTimed, 2026-09-01): the class runs the curriculum in order
        # and the parents are not in the room, so attendance is the only
        # signal there is. Two rows, two meanings — the timed row above is
        # attendance, the curriculum row below is the lesson — the ecosystem's
        # one-row-one-session invariant. Template events carry no chain.
        act = None if is_event else compose.find_activity(plan, target)
        if act and act.get("type") == "paced" and (act.get("chain") or []):
            now_done = status == "done"
            if now_done and not was_done:
                cur = compose.current_cur(act)
                s = compose.next_index(cur) if cur else None
                if cur and s is not None:
                    entries.append({"date": date_str, "activityId": target, "status": "done",
                                    "curriculum": cur.get("id"), "session": s, "src": "tg"})
                    compose.mark_session_done(cur, s)
                    lesson_label = compose.session_label(cur, s)
            elif was_done and not now_done:
                # Only rows dated today — an earlier day's lesson belongs to that day.
                for e in [e for e in entries
                          if e.get("date") == date_str and e.get("activityId") == target
                          and e.get("status") == "done" and not e.get("timed")
                          and not e.get("eventId") and e.get("curriculum")
                          and isinstance(e.get("session"), int)
                          and not isinstance(e.get("session"), bool)]:
                    _rollback_chain(act, e)
                    entries.remove(e)
```

Then change the function's final return (currently `return plan, f"Logged: {compose.esc(name)} {icon} {status} · {label}", True`) to:

```python
    msg = f"Logged: {compose.esc(name)} {icon} {status} · {label}"
    if lesson_label:
        msg += f" · {compose.esc(lesson_label)}"
    return plan, msg, True
```

(`lesson_label` must be initialised to `None` before the `if timed:` so the daily branch's return path still sees it — the assignment above does that; if the function's structure returns earlier for the daily branch, only the timed path needs the suffix.)

- [ ] **Step 4: Run the suite**

Run: `uv run pytest -q 2>&1 | tail -2`
Expected: `587 passed` (583 + 4), 0 failed.

- [ ] **Step 5: Commit**

```bash
git add lib/ops.py tests/test_ops.py
git commit -m "log_status: a timed ✓ on a paced on-grid class logs its next lesson (site parity)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG"
```

---

### Task 3 (both repos): docs, stamps, deploy

- [ ] **Step 1: Planner docs + stamps**

```bash
cd "/Users/jalalchowdhury/PycharmProjects/Aoife's Schedule"
sed -i '' 's/?v=2026-09-01-2/?v=2026-09-01-3/g' index.html && grep -c '?v=2026-09-01-3' index.html   # 5
```

In `AGENTS.md`, add to the end of the "## Planner slots on the grid (2026-09-01)" section:

```
- **A ✓ on a paced on-grid class IS its next lesson (2026-09-01, user directive
  "attendance is the lesson — the parents aren't in the room").** `logTimed`
  keeps writing the attendance row `{date,status,timed:true,activityId}` and,
  for a `type:'paced'` activity logged by activityId (never eventId), ALSO
  appends a lesson row `{date,activityId,status:'done',curriculum,session}` at
  `nextIndex(cur)` on entering `done`, and removes THAT DAY's lesson rows
  (`unmarkSession` each) on leaving `done` (toggle-off, or → partial/missed).
  Exhausted chain ⇒ attendance only. Two rows, two meanings — readers already
  split on `e.timed` vs `e.curriculum`; `subjectCards.sessionsThisWeek` was the
  one that did not and now counts lesson rows only. Bot parity:
  aoife-school-bot `ops._apply_log_status` timed branch does the same with
  `src:'tg'` and appends `· <lesson label>` to its confirmation. Spec:
  docs/superpowers/specs/2026-09-01-class-tick-advances-lesson-design.md.
```

```bash
node --test tests/*.test.mjs 2>&1 | grep -E "^ℹ (tests|pass|fail)"      # 384 / 384 / 0
git add index.html AGENTS.md
git commit -m "release: class ✓ = lesson done (stamps 2026-09-01-3) + AGENTS.md

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG"
git push origin main
for i in $(seq 1 18); do n=$(curl -s -H 'Cache-Control: no-cache' "https://aoifes-schedule.vercel.app/?cb=$RANDOM" | grep -c '?v=2026-09-01-3'); [ "$n" = "5" ] && { echo "LIVE after ~$((i*10))s"; break; }; sleep 10; done
```

Expected: `LIVE after …`. If not live after the loop: `vercel --prod` from the planner repo root, then re-check.

- [ ] **Step 2: Bot docs + deploy**

In `~/PycharmProjects/aoife-school-bot/AGENTS.md`, find the section that documents `_apply_log_status` (grep `_apply_log_status`) and add one bullet:

```
- **Timed ✓ on a paced on-grid class ⇒ its next lesson (2026-09-01, site parity
  with `logTimed`).** In the `timed and not is_event` branch: entering `done`
  appends `{date, activityId, status:'done', curriculum, session, src:'tg'}` at
  `compose.next_index(cur)` + `mark_session_done`, and the confirmation gains
  `· <session_label>`; leaving `done` (→ partial/missed) removes that date's
  lesson rows via `_rollback_chain`. Template events and `target` activities
  are untouched. Spec lives in the planner repo:
  docs/superpowers/specs/2026-09-01-class-tick-advances-lesson-design.md.
```

```bash
cd ~/PycharmProjects/aoife-school-bot
uv run pytest -q 2>&1 | tail -1                     # 587 passed
git add AGENTS.md && git commit -m "AGENTS: timed ✓ on a paced on-grid class advances its lesson

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KP54gc9RG6WQccxBqECYCG"
git push origin main
vercel --prod --yes 2>&1 | tail -3
curl -s -o /dev/null -w '%{http_code}\n' https://aoife-school-bot.vercel.app/api/webhook   # a 4xx (no secret) proves the deploy answers; do NOT hit /api/tick — it can message the family
```

Expected: `vercel` prints a production URL and "Aliased"/"Production" line; the curl returns a 4xx status (401/403/405), not 5xx.
