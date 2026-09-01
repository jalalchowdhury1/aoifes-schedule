# Out-of-order lessons: `skipped` on a chain entry

**Date:** 2026-09-01 · **Repos:** `aoifes-schedule` (planner, data owner) + `aoife-school-bot` (Telegram bot, parity port)

## Problem

A chain entry tracks progress as one counter, `done`. Every surface derives
"what's next" as `session = done` (tb-wb: lesson `floor(done/2)+1`). So when the
family reports **L8 before L7**, the bot's rows land in L7's slots (sessions 12,
13) and every "next up" (phone Singapore card, bot check-in buttons, bot
confirmation line 2, desktop Today note) keeps saying **L8** until L7 is logged.
The 2026-09-01 bot fix (commit 8f8c935) only made the *wording* honest.

## Data model (planner owns it)

One new **optional** field on a chain entry:

```
chain[i].skipped: number[]   // sorted, unique session indices still OWED below the mark
```

- `done` is **unchanged in meaning**: the COUNT of sessions completed. Every
  projection, pace chip, tally, Timeline row and parity test keeps reading it.
- `hw = done + skipped.length` — the high-water mark (first index never touched).
- **Next session** = `min(skipped)` if any, else `hw` (null when `hw >= sessionsCount`).
- **Session `s` is done** ⇔ `s < hw && !skipped.includes(s)`.
- Absent/empty `skipped` ⇒ identical behaviour to today. No migration; live data
  (Singapore dm3-c1 `done`=16, nothing owed) needs no change.

### Two primitives — ported byte-for-byte to both repos

```
markSessionDone(cur, s):
  if s in skipped:  remove s; done += 1
  elif s >= hw:     skipped += [hw .. s-1]; done += 1      // jumping ahead owes the gap
  else:             no-op (already done)                   // idempotent

unmarkSession(cur, s):                                     // undo of one logged row
  if s not done: no-op
  done -= 1
  if s < hw-1: skipped += [s] (sorted)                     // a hole below the mark
  normalize()

normalize():  while skipped non-empty and max(skipped) == done + len(skipped) - 1:
                drop max(skipped)                          // holes at the top aren't holes
              also drop any s >= sessionsCount (defensive), dedupe, sort
```

Worked example (tb-wb, next = 12): log L8 → `markSessionDone(14)`, `(15)` ⇒
`done` 12→14, `skipped=[12,13]`, next = 12 = "Lesson 7 · textbook". Log L7 ⇒
rows 12, 13, `skipped=[]`, `done`=16, next = 16 = L9. Undo L8's workbook then
textbook ⇒ `done` 12, `skipped` [] (normalize pruned 13 then 12).

## Planner changes (`js/plan/*`, `js/m.js`)

- `model.js`: `nextSession(cur)` reads the rule above; add exported
  `nextIndex(cur)`, `isSessionDone(cur, s)`, `markSessionDone`, `unmarkSession`,
  `normalizeSkipped`. `sanitizePlan` keeps `skipped` only as a clean int array.
- `mergePlanWrites` bump-replay: carried-over session rows replay through
  `markSessionDone(cur, row.session)` instead of `done + 1` (fixes the same
  race for out-of-order rows).
- `state.js`: `togglePaced`/`logSession` write `session = nextIndex(cur)` and
  call `markSessionDone`; the uncheck path and `unlogSessionsFrom` call
  `unmarkSession` per removed row. `unlogSessionsFrom`'s "everything above
  goes too" rule is kept (the card still can't express a hole by tapping).
- `mday.js` `tbWbCard`: `item(s).done = isSessionDone`, `next = s === nextIndex`,
  `needs` = label of `nextIndex` when `s` isn't done and isn't next;
  `current` lesson = `floor(nextIndex/2)+1`; rows = lessons touched today ∪
  current. So after "L8 first": L7 row (textbook = next), L8 row (both halves
  done, undoable today). `currentLabel` follows `current`.
  `today.js` / `subjects.js` "next" notes go through `nextSession` (no change
  needed beyond the helper).
- Card taps stay sequential-by-default — no lesson picker (YAGNI; the bot is
  the surface that names a lesson).

## Bot changes (`lib/ops.py`, `lib/compose.py`)

- `compose.py`: port `next_index`, `is_session_done`, `mark_session_done`,
  `unmark_session`, `normalize_skipped`; `current_cur`, `next_session_label`,
  `next_session_short`, the check-in ➕/dual buttons (`compose.py` ~926/962/1004)
  and `ops.resolve_session_intent` all read `next_index` instead of `done`.
- `ops._apply_log_progress`:
  - no `lesson` named → each step logs `next_index` (lowest owed slot first).
  - `lesson=N` named → target indices `(N-1)*2` (+1 for the workbook half /
    both for a full lesson), via `mark_session_done`; the halves validator
    applies **within that lesson** (textbook before workbook), and an already
    done half is reported, not rewritten.
  - `N` outside `1..cur.lessons` of the CURRENT chain entry → refuse with the
    chapter's name and range; never guess a chapter.
- `ops._apply_log_status` and `_rollback_chain` (undo) use the primitives.
- Confirmation wording replaces "took L7's slot…": line 1 `… — L8 ✓ (L7 still
  owed)`, line 2 `14/22 · next up: Lesson 7 · textbook`. SYSTEM_PROMPT note
  updated accordingly (a named lesson ahead of the planner's next is normal).

## Tests

- Planner `tests/plan-*.test.mjs`: primitives (jump, fill, undo top, undo
  middle, normalize, idempotence, sanitize), `tbWbCard` after L8-first, merge
  bump-replay with an out-of-order row, `unlogSessionsFrom` rollback with
  `skipped` present. Existing suites must stay green untouched (done-as-count
  invariant).
- Bot `tests/`: same primitive cases; `log_progress` lesson=8 then 7 end-to-end
  (rows at 14/15 then 12/13, final `done` 16, `skipped` []); refusal for a
  lesson outside the chapter; check-in buttons + `next_session_short` show L7
  while owed; undo of an out-of-order row. **Parity test**: a fixed set of
  chain states → identical `next` index in JS and Python (same fixture file).
- AGENTS.md changelog entry in both repos; planner stamps bumped per its release
  rules; bot deployed via git push (Vercel).

## Out of scope

Projection/date changes, Subjects progress %, a lesson picker on the phone
card, LoE book-shaped chains (the primitives are generic and work there
unchanged, but no LoE-specific UI).
