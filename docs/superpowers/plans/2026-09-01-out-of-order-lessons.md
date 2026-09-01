# Out-of-order lessons (`chain[].skipped`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the family logs Lesson 8 before Lesson 7, every "next up" surface (phone card, bot check-in buttons, bot confirmation, Today note) says L7 until L7 is logged — while `done` stays a plain count.

**Architecture:** One optional field `chain[i].skipped: number[]` (owed session indices below the high-water mark `hw = done + skipped.length`). Two primitives, `markSessionDone(cur, s)` / `unmarkSession(cur, s)`, ported byte-for-byte to the planner (`js/plan/model.js`) and the bot (`lib/compose.py`); every writer goes through them, every "next" reader goes through `nextIndex(cur)`. Spec: `docs/superpowers/specs/2026-09-01-out-of-order-lessons-design.md`.

**Tech Stack:** Planner = vanilla ES modules, `node --test` (run `node --test` from the repo root, NOT `node --test tests/`). Bot = Python 3, `uv run pytest -q` from `~/PycharmProjects/aoife-school-bot`. Planner repo path has a space and apostrophe: always quote `"$HOME/PycharmProjects/Aoife's Schedule"`.

**Ground rules (from both AGENTS.md):** read each repo's root AGENTS.md before touching it. `done` is a COUNT — never change its meaning. One log row = one session. Planner ships by `git push` (Vercel auto-deploy) and every release bumps the `?v=` stamps in `index.html` (5 URLs) and `m/index.html` (2 URLs). Bot ships by `git push`; run the full suite first.

---

## Shared semantics (copy into your head before any task)

```
hw(cur)            = done + len(skipped)
nextIndex(cur)     = min(skipped) if skipped else hw;  null/None if that >= sessionsCount(cur)
isSessionDone(cur,s) = s < hw && s not in skipped
markSessionDone(cur, s):
   if s in skipped: remove; done += 1
   elif s >= hw:    skipped += [hw..s-1]; done += 1
   else:            no-op
unmarkSession(cur, s):
   if !isSessionDone: no-op
   done -= 1
   if s < hw_before - 1: skipped += [s]
   normalizeSkipped(cur)
normalizeSkipped(cur):
   skipped = sorted unique ints, 0 <= s < sessionsCount
   while skipped and max(skipped) == done + len(skipped) - 1: pop max
   delete the key when empty (keeps blobs byte-identical to today when unused)
```

Parity fixture (identical file in both repos, see Task 1 / Task 6):
`tests/fixtures/skipped-parity.json`

```json
[
  {"name": "plain",        "cur": {"pattern":"tb-wb","lessons":10,"tests":2,"done":12},                    "next": 12, "doneSessions": [0,11]},
  {"name": "owed",         "cur": {"pattern":"tb-wb","lessons":10,"tests":2,"done":14,"skipped":[12,13]},  "next": 12, "doneSessions": [14,15]},
  {"name": "owed-filled",  "cur": {"pattern":"tb-wb","lessons":10,"tests":2,"done":16},                    "next": 16, "doneSessions": [12,15]},
  {"name": "half-owed",    "cur": {"pattern":"tb-wb","lessons":10,"tests":2,"done":15,"skipped":[13]},     "next": 13, "doneSessions": [12,14]},
  {"name": "finished",     "cur": {"pattern":"tb-wb","lessons":10,"tests":2,"done":22},                    "next": null, "doneSessions": [21]},
  {"name": "simple-owed",  "cur": {"firstUnit":101,"lastUnit":120,"done":5,"skipped":[2]},                 "next": 2,  "doneSessions": [0,5]}
]
```
(`doneSessions` = indices that must report done; the test also asserts every index in `skipped` reports NOT done. Simple-pattern `sessionsCount` = lastUnit − firstUnit + 1 in both repos already.)

---

## PLANNER — `~/PycharmProjects/Aoife's Schedule`

### Task 1: primitives in `js/plan/model.js`

**Files:** Modify `js/plan/model.js` (next to `nextSession`, line ~111); Create `tests/fixtures/skipped-parity.json` (content above); Test `tests/plan-model.test.mjs`.

- [ ] **Step 1: failing tests** — append to `tests/plan-model.test.mjs`:

```js
import { readFileSync } from 'node:fs';
import { nextIndex, nextSession, isSessionDone, markSessionDone, unmarkSession, normalizeSkipped, sessionsCount } from '../js/plan/model.js';
const parity = JSON.parse(readFileSync(new URL('./fixtures/skipped-parity.json', import.meta.url)));
const tbwb = (done, skipped) => ({ pattern: 'tb-wb', lessons: 10, tests: 2, done, ...(skipped ? { skipped } : {}) });

test('skipped parity fixture: nextIndex + isSessionDone', () => {
  for (const c of parity) {
    assert.equal(nextIndex(c.cur), c.next, c.name);
    for (const s of c.doneSessions) assert.equal(isSessionDone(c.cur, s), true, `${c.name} done ${s}`);
    for (const s of (c.cur.skipped || [])) assert.equal(isSessionDone(c.cur, s), false, `${c.name} owed ${s}`);
  }
});
test('markSessionDone: jump ahead owes the gap, filling removes it, idempotent', () => {
  const cur = tbwb(12);
  markSessionDone(cur, 14); markSessionDone(cur, 15);
  assert.deepEqual([cur.done, cur.skipped], [14, [12, 13]]);
  assert.equal(nextSession(cur).label, 'Lesson 7 · textbook');
  markSessionDone(cur, 14);                                   // already done: no-op
  assert.deepEqual([cur.done, cur.skipped], [14, [12, 13]]);
  markSessionDone(cur, 12); markSessionDone(cur, 13);
  assert.equal(cur.done, 16); assert.equal('skipped' in cur, false);
  assert.equal(nextIndex(cur), 16);
});
test('unmarkSession: top undo shrinks the mark, middle undo opens a hole, normalize prunes', () => {
  const cur = tbwb(14, [12, 13]);
  unmarkSession(cur, 15); assert.deepEqual([cur.done, cur.skipped], [13, [12, 13]]);
  unmarkSession(cur, 14); assert.deepEqual([cur.done, cur.skipped ?? null], [12, null]);
  const mid = tbwb(16);
  unmarkSession(mid, 13); assert.deepEqual([mid.done, mid.skipped], [15, [13]]);
  unmarkSession(mid, 13);                                     // not done: no-op
  assert.deepEqual([mid.done, mid.skipped], [15, [13]]);
});
test('normalizeSkipped drops junk, dupes, out-of-range and the top', () => {
  const cur = tbwb(3, [1, 1, 'x', -1, 99, 5]);               // hw would be 9; 5 is below, 99 out of range
  normalizeSkipped(cur); assert.deepEqual(cur.skipped, [1, 5]);
  const top = tbwb(2, [2, 3]); normalizeSkipped(top); assert.equal('skipped' in top, false);
});
```

- [ ] **Step 2:** `node --test 2>&1 | tail -5` → the new tests FAIL (`nextIndex` not exported).

- [ ] **Step 3: implement** — in `js/plan/model.js` replace the existing `nextSession` with:

```js
// ── Out-of-order sessions: `skipped` (spec 2026-09-01) ──────────────
// `done` stays a COUNT. `skipped` = owed session indices below the high-water
// mark hw = done + skipped.length. Absent/empty ⇒ exactly the old behaviour.
// Ported byte-for-byte in aoife-school-bot/lib/compose.py — change both.
const skippedOf = cur => (Array.isArray(cur?.skipped) ? cur.skipped : []);
export const highWater = cur => (cur?.done || 0) + skippedOf(cur).length;
export function normalizeSkipped(cur) {
  if (!cur) return cur;
  const n = sessionsCount(cur), done = cur.done || 0;
  let s = [...new Set(skippedOf(cur).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x < n))]
    .sort((a, b) => a - b);
  while (s.length && s[s.length - 1] === done + s.length - 1) s.pop();
  if (s.length) cur.skipped = s; else delete cur.skipped;
  return cur;
}
export const nextIndex = cur => {
  const sk = skippedOf(cur), hw = highWater(cur);
  const i = sk.length ? Math.min(...sk) : hw;
  return i >= sessionsCount(cur) ? null : i;
};
export const isSessionDone = (cur, s) => s < highWater(cur) && !skippedOf(cur).includes(s);
export function markSessionDone(cur, s) {
  const sk = skippedOf(cur), hw = highWater(cur);
  if (sk.includes(s)) { cur.skipped = sk.filter(x => x !== s); cur.done = (cur.done || 0) + 1; }
  else if (s >= hw) {
    const gap = []; for (let i = hw; i < s; i++) gap.push(i);
    cur.skipped = [...sk, ...gap]; cur.done = (cur.done || 0) + 1;
  }
  return normalizeSkipped(cur);
}
export function unmarkSession(cur, s) {
  if (!isSessionDone(cur, s)) return cur;
  const hw = highWater(cur);
  cur.done = Math.max(0, (cur.done || 0) - 1);
  if (s < hw - 1) cur.skipped = [...skippedOf(cur), s];
  return normalizeSkipped(cur);
}
export const nextSession = cur => {
  const i = nextIndex(cur);
  return i == null ? null : { index: i, label: sessionLabel(cur, i) };
};
```

Also in `sanitizePlan` (find where chain entries are cleaned — grep `chain` in the sanitize function): call `normalizeSkipped(c)` on every chain entry so a junk `skipped` never survives a load.

- [ ] **Step 4:** `node --test 2>&1 | tail -5` → all green (existing tests untouched).
- [ ] **Step 5: commit** — `git add js/plan/model.js tests/plan-model.test.mjs tests/fixtures/skipped-parity.json && git commit -m "model: skipped sessions — nextIndex/markSessionDone/unmarkSession primitives"`

### Task 2: `mergePlanWrites` bump-replay through the primitive

**Files:** Modify `js/plan/model.js` (`mergePlanWrites`, the `bumps` loop); Test `tests/plan-merge.test.mjs`.

- [ ] **Step 1: failing test** (append; mirror the existing fixture style in that file):

```js
test('merge replays a carried-over OUT-OF-ORDER session row through markSessionDone', () => {
  const act = { id: 'singapore', chain: [{ id: 'c1', pattern: 'tb-wb', lessons: 10, tests: 2, done: 12 }] };
  const stored = { activities: [{ ...act, chain: [{ ...act.chain[0], done: 13, skipped: [12] }] }],
    log: [{ date: '2026-09-01', activityId: 'singapore', status: 'done', curriculum: 'c1', session: 13 }], overrides: [] };
  const incoming = { activities: [act], log: [], overrides: [] };
  const out = mergePlanWrites(stored, incoming);
  assert.deepEqual(out.activities[0].chain[0].done, 13);
  assert.deepEqual(out.activities[0].chain[0].skipped, [12]);
});
```

- [ ] **Step 2:** run → FAIL (`skipped` undefined, done 13 by +1 but no gap).
- [ ] **Step 3:** in the `bumps` loop replace `{ ...c, done: (c.done || 0) + 1 }` with `markSessionDone({ ...c, skipped: [...(c.skipped || [])] }, row.session)` (never mutate `incoming`; `row.session` is always a number for `sessKey` rows — guard `typeof row.session === 'number'`, else fall back to the old `+1`).
- [ ] **Step 4:** `node --test` green. **Step 5:** commit `"merge: bump-replay via markSessionDone (out-of-order rows keep their gap)"`.

### Task 3: writers in `js/plan/state.js`

**Files:** Modify `js/plan/state.js` (`togglePaced` ~131, `logSession` ~166, `unlogSessionsFrom` ~190); Test `tests/plan-state.test.mjs`.

- [ ] **Step 1: failing tests** (use that file's existing plan-seeding helper; chain `tb-wb`, lessons 10, tests 2, `done: 14, skipped: [12, 13]`):

```js
test('logSession writes the lowest OWED slot first', () => {
  // seed act 'singapore' with chain done 14, skipped [12,13]
  const e = logSession('singapore', '2026-09-01');
  assert.equal(e.session, 12);
  const cur = plan.data.activities.find(a => a.id === 'singapore').chain[0];
  assert.deepEqual([cur.done, cur.skipped], [15, [13]]);
});
test('unlogSessionsFrom rolls back through unmarkSession', () => {
  // seed: done 14, skipped [12,13]; rows today: session 14, 15
  const removed = unlogSessionsFrom('singapore', 'c1', 14, '2026-09-01');
  assert.deepEqual(removed.map(r => r.session), [14, 15]);
  const cur = /* chain[0] */;
  assert.deepEqual([cur.done, cur.skipped ?? null], [12, null]);
});
test('togglePaced uncheck unmarks the exact session of the removed row', () => { /* row session 15 on a chain done 14 skipped [12,13] → after: done 13, skipped [12,13] */ });
```
Fill the seeding from the file's existing patterns — no new helpers.

- [ ] **Step 2:** run → FAIL. **Step 3:** implement: import `nextIndex, markSessionDone, unmarkSession` from `./model.js`; in `togglePaced` uncheck branch: `if (cur) unmarkSession(cur, entry.session)` (fallback to the old `done--` only when `typeof entry.session !== 'number'`); in the check branch and in `logSession`: `const s = nextIndex(cur); … session: s … markSessionDone(cur, s)` (keep `currentCur` as the chain picker — it already uses `done < sessionsCount`, which stays correct because `hw <= sessionsCount`); in `unlogSessionsFrom`: replace the `cur.done = Math.max(0, …-1)` loop with `unmarkSession(cur, e.session)`.
- [ ] **Step 4:** `node --test` green. **Step 5:** commit `"state: paced writers go through nextIndex/markSessionDone/unmarkSession"`.

### Task 4: `tbWbCard` honesty in `js/plan/mday.js`

**Files:** Modify `js/plan/mday.js` (`tbWbCard` ~160-205, `sessionsToday`/`latestLesson` helper ~120-130 only if it reads `done`); Test `tests/plan-mday.test.mjs`.

- [ ] **Step 1: failing test:**

```js
test('tbWbCard after L8-before-L7: L7 row is next, L8 row is done+undoable', () => {
  const act = { id: 'singapore', name: 'Singapore Math' };
  const cur = { id: 'c1', name: '3A Ch 4 · Fractions', pattern: 'tb-wb', lessons: 11, tests: 0, done: 14, skipped: [12, 13] };
  const log = [14, 15].map(s => ({ date: '2026-09-01', activityId: 'singapore', status: 'done', curriculum: 'c1', session: s }));
  const card = tbWbCard(act, cur, log, '2026-09-01');
  assert.equal(card.currentLabel, 'L7');
  assert.deepEqual(card.lessons.map(l => l.lesson), [7, 8]);
  const [l7, l8] = card.lessons;
  assert.equal(l7.halves[0].next, true);  assert.equal(l7.halves[0].done, false);
  assert.equal(l7.halves[1].needs, 'Textbook');
  assert.equal(l8.halves[0].done, true);  assert.equal(l8.halves[1].undoable, true);
  assert.equal(l8.halves[0].next, false);
  assert.equal(card.doneSessions, 14);
  assert.equal(card.addLesson, null);
});
```

- [ ] **Step 2:** FAIL. **Step 3:** implement: import `nextIndex, isSessionDone, highWater`; `const ni = nextIndex(cur);` `item(s)`: `done: isSessionDone(cur, s)`, `next: s === ni`, `needs: (!isSessionDone(cur, s) && s !== ni && ni != null) ? halfLabel(cur, ni) : null`; the review branch condition becomes `ni == null || ni >= paired` (use `ni ?? total`); `current = Math.floor((ni ?? paired) / 2) + 1`; `inProgress = ni != null && ni % 2 === 1`; `currentLabel: ni == null ? null : (ni < paired ? \`L${current}\` : sessionLabel(cur, ni))`. `doneSessions` stays `done` (the count).
- [ ] **Step 4:** `node --test` green; also `grep -n "dataset.needs\|b.dataset.next" js/m.js` — the tap handler already keys off `data-next`/`data-needs`/`data-done`, so no `m.js` change is expected; confirm by reading lines ~605-640.
- [ ] **Step 5:** commit `"mday: tbWbCard shows the owed lesson as next after an out-of-order log"`.

### Task 5: planner release

**Files:** Modify `index.html` (5 `?v=` URLs → `2026-09-01-2`), `m/index.html` (2 URLs → `2026-09-01-2`), `AGENTS.md` (changelog entry at the top of the changelog section in the repo's existing style; mention `skipped`, the primitives, the parity fixture and that `done` is still a count).

- [ ] **Step 1:** `node --test 2>&1 | tail -3` green. **Step 2:** stamps + AGENTS.md. **Step 3:** `git add -A && git commit -m "planner: out-of-order lessons — chain[].skipped, stamps 2026-09-01-2" && git push`. **Step 4:** verify deploy: `curl -s https://aoifes-schedule.vercel.app/m/ | grep -o 'v=2026-09-01-2' | head -1` (retry after ~60s if empty).

---

## BOT — `~/PycharmProjects/aoife-school-bot`

### Task 6: primitives + readers in `lib/compose.py`

**Files:** Modify `lib/compose.py` (`current_cur` ~367, `next_session_label`, `next_session_short`, and the three `done = int(cur.get("done") or 0)` readers at ~926/962/1004 that pick the NEXT session — read each; ones that compute counts stay); Create `tests/fixtures/skipped-parity.json` (identical to the planner's); Test `tests/test_compose.py`.

- [ ] **Step 1: failing tests:**

```python
import json, pathlib
from lib import compose
PARITY = json.loads((pathlib.Path(__file__).parent / "fixtures" / "skipped-parity.json").read_text())

def test_skipped_parity_fixture():
    for c in PARITY:
        assert compose.next_index(c["cur"]) == c["next"], c["name"]
        for s in c["doneSessions"]:
            assert compose.is_session_done(c["cur"], s), (c["name"], s)
        for s in c["cur"].get("skipped", []):
            assert not compose.is_session_done(c["cur"], s), (c["name"], s)

def _tbwb(done, skipped=None):
    cur = {"pattern": "tb-wb", "lessons": 10, "tests": 2, "done": done}
    if skipped is not None: cur["skipped"] = skipped
    return cur

def test_mark_session_done_jump_fill_idempotent():
    cur = _tbwb(12)
    compose.mark_session_done(cur, 14); compose.mark_session_done(cur, 15)
    assert (cur["done"], cur["skipped"]) == (14, [12, 13])
    compose.mark_session_done(cur, 14)
    assert (cur["done"], cur["skipped"]) == (14, [12, 13])
    compose.mark_session_done(cur, 12); compose.mark_session_done(cur, 13)
    assert cur["done"] == 16 and "skipped" not in cur

def test_unmark_session_top_middle_normalize():
    cur = _tbwb(14, [12, 13])
    compose.unmark_session(cur, 15); assert (cur["done"], cur["skipped"]) == (13, [12, 13])
    compose.unmark_session(cur, 14); assert cur["done"] == 12 and "skipped" not in cur
    mid = _tbwb(16); compose.unmark_session(mid, 13); assert (mid["done"], mid["skipped"]) == (15, [13])

def test_next_session_short_reads_owed_slot_first():
    act = {"id": "singapore", "chain": [_tbwb(14, [12, 13])]}
    assert compose.next_session_short(act) == "Lesson 7 · textbook"
```

- [ ] **Step 2:** `uv run pytest -q tests/test_compose.py -k "skipped or mark_session or unmark or owed_slot"` → FAIL.
- [ ] **Step 3: implement** (place right after `session_label`):

```python
# ── Out-of-order sessions: `skipped` (planner spec 2026-09-01) ──
# `done` stays a COUNT. `skipped` = owed session indices below the high-water
# mark hw = done + len(skipped). Byte-for-byte port of js/plan/model.js.
def _skipped_of(cur) -> list[int]:
    s = cur.get("skipped") if isinstance(cur, dict) else None
    return list(s) if isinstance(s, list) else []

def high_water(cur) -> int:
    return int(cur.get("done") or 0) + len(_skipped_of(cur))

def normalize_skipped(cur):
    n, done = sessions_count(cur), int(cur.get("done") or 0)
    s = sorted({int(x) for x in _skipped_of(cur)
                if isinstance(x, (int, float)) and int(x) == x and 0 <= int(x) < n})
    while s and s[-1] == done + len(s) - 1:
        s.pop()
    if s: cur["skipped"] = s
    else: cur.pop("skipped", None)
    return cur

def next_index(cur):
    sk, hw = _skipped_of(cur), high_water(cur)
    i = min(sk) if sk else hw
    return None if i >= sessions_count(cur) else i

def is_session_done(cur, s: int) -> bool:
    return s < high_water(cur) and s not in _skipped_of(cur)

def mark_session_done(cur, s: int):
    sk, hw = _skipped_of(cur), high_water(cur)
    if s in sk:
        cur["skipped"] = [x for x in sk if x != s]; cur["done"] = int(cur.get("done") or 0) + 1
    elif s >= hw:
        cur["skipped"] = sk + list(range(hw, s)); cur["done"] = int(cur.get("done") or 0) + 1
    return normalize_skipped(cur)

def unmark_session(cur, s: int):
    if not is_session_done(cur, s):
        return cur
    hw = high_water(cur)
    cur["done"] = max(0, int(cur.get("done") or 0) - 1)
    if s < hw - 1:
        cur["skipped"] = _skipped_of(cur) + [s]
    return normalize_skipped(cur)
```

Then: `next_session_label`/`next_session_short` use `next_index(cur)` (return "" when None). `current_cur` is unchanged (`done < sessions_count` ⇔ something still owed, since `hw <= n`). For the readers at ~926/962/1004: any that derive the NEXT session/lesson/half from `done` switch to `next_index(cur)`; any that report the COUNT keep `done`. Document each decision in a one-line comment.

- [ ] **Step 4:** `uv run pytest -q` all green. **Step 5:** commit `"compose: skipped-session primitives + next_index readers (parity with planner)"`.

### Task 7: `lib/ops.py` — write the real slot, name a lesson, undo

**Files:** Modify `lib/ops.py` (`_half_sequence` ~367, `_check_halves` ~386, `_apply_log_status` ~435-490, `_rollback_chain` ~502, `_apply_log_progress` ~624-760 incl. the confirmation text; SYSTEM_PROMPT lines in `lib/brain.py` that describe "took L7's slot"); Test `tests/test_ops.py`.

- [ ] **Step 1: failing tests** (use the file's existing plan/ctx fixtures; chain `tb-wb` lessons 11, tests 0, id `dm3-c4`, name `3A Ch 4 · Fractions`, done 12):

```python
def test_log_progress_named_lesson_ahead_writes_real_slots_and_owes_gap(plan_tbwb, ctx):
    op = {"op": "log_progress", "target": "singapore", "textbooks": 1, "workbooks": 1, "lesson": 8}
    assert ops.validate_op(plan_tbwb, op, ctx) == []
    new, text, changed = ops.apply_op(plan_tbwb, op, ctx)
    cur = new["activities"][0]["chain"][0]
    rows = [e for e in new["log"] if e.get("curriculum") == "dm3-c4"]
    assert sorted(e["session"] for e in rows) == [14, 15]
    assert (cur["done"], cur["skipped"]) == (14, [12, 13])
    assert "L8 ✓" in text and "L7 still owed" in text and "next up: Lesson 7 · textbook" in text
    assert "took" not in text

def test_log_progress_then_owed_lesson_fills_gap(plan_tbwb, ctx):
    first = {"op": "log_progress", "target": "singapore", "textbooks": 1, "workbooks": 1, "lesson": 8}
    p1, _, _ = ops.apply_op(plan_tbwb, first, ctx)
    second = {"op": "log_progress", "target": "singapore", "textbooks": 1, "workbooks": 1, "lesson": 7}
    assert ops.validate_op(p1, second, ctx) == []
    p2, text, _ = ops.apply_op(p1, second, ctx)
    cur = p2["activities"][0]["chain"][0]
    assert cur["done"] == 16 and "skipped" not in cur
    assert sorted(e["session"] for e in p2["log"] if e.get("curriculum") == "dm3-c4") == [12, 13, 14, 15]
    assert "L7 ✓" in text and "next up: Lesson 9 · textbook" in text

def test_log_progress_unnamed_fills_lowest_owed_first(plan_tbwb, ctx):
    p1, _, _ = ops.apply_op(plan_tbwb, {"op": "log_progress", "target": "singapore", "textbooks": 1, "workbooks": 1, "lesson": 8}, ctx)
    p2, text, _ = ops.apply_op(p1, {"op": "log_progress", "target": "singapore", "textbooks": 1, "workbooks": 0}, ctx)
    assert [e["session"] for e in p2["log"] if e.get("curriculum") == "dm3-c4"][-1] == 12
    assert "L7 textbook ✓" in text

def test_log_progress_named_lesson_outside_chapter_refused(plan_tbwb, ctx):
    errs = ops.validate_op(plan_tbwb, {"op": "log_progress", "target": "singapore", "textbooks": 1, "workbooks": 1, "lesson": 12}, ctx)
    assert errs and "Ch 4" in errs[0] and "1-11" in errs[0]

def test_log_progress_named_half_already_done_is_reported_not_rewritten(plan_tbwb, ctx):
    p1, _, _ = ops.apply_op(plan_tbwb, {"op": "log_progress", "target": "singapore", "textbooks": 1, "workbooks": 1, "lesson": 8}, ctx)
    errs = ops.validate_op(p1, {"op": "log_progress", "target": "singapore", "textbooks": 1, "workbooks": 0, "lesson": 8}, ctx)
    assert errs and "already" in errs[0].lower()

def test_undo_out_of_order_row_reopens_the_hole(plan_tbwb, ctx):
    # apply L8, then undo its rows via the existing undo path (see how test_ops exercises _rollback_chain / undo today)
    ...  # assert final done 12 and no 'skipped'
```

- [ ] **Step 2:** FAIL. **Step 3: implement:**
  - `_half_sequence(cur, n, start=None)`: iterate from `start if start is not None else compose.next_index(cur)` — but only contiguous from that index (the halves rule is "these n halves in order from here").
  - `_check_halves(act, tb, wb, lesson=None)`: when `lesson` is given and `cur["pattern"] == "tb-wb"`: `lessons = int(cur.get("lessons") or 0)`; if not `1 <= lesson <= lessons` → `[f"log_progress: {chapter} has lessons 1-{lessons} — L{lesson} isn't in it; say which chapter or just \"she did a lesson\""]` (`chapter = compose._chain_short_name(cur)`); `start = (lesson-1)*2`; if `tb` and `is_session_done(cur, start)` (or `wb` and done `start+1`) → `[f"log_progress: L{lesson} {half} is already logged — nothing to add"]`; workbook-only while its textbook isn't done → the existing "doesn't line up" text. Otherwise sequence from `start` must equal the requested (tb, wb).
  - Call site in `_validate_log_progress`: pass `op.get("lesson")`.
  - `_apply_log_progress`: `log_one(session=None)` → `s = session if session is not None else compose.next_index(cur)`; row `"session": s`; `compose.mark_session_done(cur, s)`. Halves with a named lesson: sessions `[(L-1)*2]` for tb, `[(L-1)*2+1]` for wb. `lessons`/`complete_chapter` units: unchanged loops but `log_one()` (now next-owed).
  - `_apply_log_status` (~486): `s = compose.next_index(cur)`; row `session: s`; `mark_session_done`. `_rollback_chain(act, entry)`: `compose.unmark_session(cur, entry["session"])` when the row has a numeric `session`, else the old `-1`.
  - Confirmation: delete the `slot_owed`/`shift` machinery. `touched` is now built from the REAL sessions (`s // 2 + 1`), so "L8 ✓" comes for free. After it, if `cur.get("skipped")`: append `f" (L{min(skipped)//2+1} still owed)"`. Line 2: `f"{done}/{total} · next up: {compose.next_session_short(act)}"` always (drop the "that's where … goes" branch).
  - `lib/brain.py` SYSTEM_PROMPT: replace the "took L7's slot" sentence with: a named lesson ahead of the planner's next is normal — pass `lesson`, the planner records it in its own slot and keeps the earlier one owed.
- [ ] **Step 4:** `uv run pytest -q` green (fix any test that pinned the old "took … slot" wording — update assertions, don't weaken them). **Step 5:** commit `"ops: named lessons land in their real slot; skipped gap owed; honest next up"`.

### Task 8: check-in buttons + `resolve_session_intent`

**Files:** Modify `lib/ops.py` (`resolve_session_intent` ~992-1060: `done = …` → `ni = compose.next_index(cur)`; the "which half is next" and idempotent-retap logic read `is_session_done`), `lib/compose.py` check-in composer (the ➕ / dual-button builders found in Task 6); Test `tests/test_compose.py`, `tests/test_ops.py`.

- [ ] **Step 1: failing tests:** check-in message for a chain `done 14, skipped [12,13]` shows `L7` with the textbook button next (mirror `test_checkin_message_tb_wb_still_open_shows_chapter_and_lesson_with_dual_buttons`); `resolve_session_intent(..., "textbook", ...)` on that chain resolves to session 12; a re-tap on an already-done session (14) is idempotent exactly as today.
- [ ] **Step 2:** FAIL. **Step 3:** implement per above. **Step 4:** `uv run pytest -q` green. **Step 5:** commit `"checkin: buttons + tap intents follow next_index"`.

### Task 9: bot release + docs + notify

- [ ] **Step 1:** `uv run pytest -q` → note the count. **Step 2:** `AGENTS.md`: add `**FIX 2026-09-01 — out-of-order lessons, for real (chain[].skipped).**` entry right above the existing `FIX 2026-09-01` entry, in the same style (what/why/how, the primitives, parity fixture, test count); update the test-count badge line (grep `pytest tests`). **Step 3:** `git add -A && git commit -m "Out-of-order lessons for real: chain[].skipped, real slots, honest next up (parity with planner)" && git push`. **Step 4:** confirm Vercel deploy (`vercel ls aoife-school-bot 2>/dev/null | head -3` or the Vercel MCP `list_deployments`), then the existing smoke: `uv run pytest -q tests/test_endpoints.py`.
- [ ] **Step 5:** live-data sanity: `GET` the plan via `lib/plan_client.py`'s helper (see AGENTS.md "plan-get") and assert Singapore's open chain has no `skipped` and `done` unchanged (16) — this release must not touch data.
- [ ] **Step 6:** update `~/.claude/projects/-Users-jalalchowdhury/memory/project_aoife_school_bot.md` and `project_aoife_schedule.md` (one paragraph each: `skipped` semantics, both commits, "done is still a count"). **Step 7:** Telegram ping to 📡 chat 7956935476 via @TweetSyn_bot (token in `~/PycharmProjects/financial-telegram-bot/.env`): one short ELI5 line — L8-before-L7 now shows L7 as next on the phone and in the bot.

---

## Self-review (done at write time)
- Spec coverage: data model → T1; merge → T2; writers → T3; card → T4; planner release → T5; bot readers/primitives → T6; ops write/validate/undo/wording/prompt → T7; buttons/intents → T8; docs/deploy/notify → T9. Parity fixture in T1+T6. LoE/simple chains covered by fixture case `simple-owed`.
- Names used consistently: `nextIndex`/`next_index`, `isSessionDone`/`is_session_done`, `markSessionDone`/`mark_session_done`, `unmarkSession`/`unmark_session`, `normalizeSkipped`/`normalize_skipped`, `highWater`/`high_water`.
