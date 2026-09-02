# A ✓ on a class block is that lesson done — design

**Date:** 2026-09-01 · **Status:** approved by Jalal ("yes, you can add the counter — leave it to your better decision")

## Problem

Geography and Science are *paced* subjects (a chain of numbered lessons with
titles) that also sit on the week grid as timed blocks. Ticking such a block ✓
— on the desktop Today view, the phone `/m`, or the Telegram bot's check-in —
writes an **attendance** row (`{date, status, timed:true, activityId}` via
`logTimed` / the bot's `_apply_log_status` timed branch) and nothing else. The
chain's `done` counter only moves through `togglePaced`/`logSession`, which no
surface offers for an on-grid subject (Today's daily rows, `/m`'s dailies and
the bot's check-in dailies all exclude `onGrid` activities). So "0/30 lessons"
never advances from a tap; only a Claude/API edit moves it.

Jalal's framing: the parents are not in the lesson — the class runs the
curriculum in order, so **attending = the next lesson done**.

## Behaviour

For an activity that is `type:'paced'`, has a chain, and is logged **by
`activityId` with no `eventId`** (i.e. a planner slot, not a template event or a
one-off):

- **Entering `done`** — a new timed row with status `done`, or an existing timed
  row whose status changes to `done` — also appends ONE curriculum row for the
  same date, `{date, activityId, status:'done', curriculum: cur.id, session: s}`
  with `s = nextIndex(cur)` (the lowest owed slot, else the next fresh one), and
  `markSessionDone(cur, s)`. If the chain is exhausted (`currentCur` is null),
  only the attendance row is written.
- **Leaving `done`** — the timed row is toggled off (same status tapped again)
  or its status changes to `partial`/`missed` — removes EVERY curriculum-bearing
  `done` row for that `(activityId, date)` (`!timed && !eventId && curriculum
  && typeof session === 'number'`) and `unmarkSession`s each. Rule reused from
  `unlogSessionsFrom`: only rows dated that day are ever touched; an earlier
  day's lesson is never rewritten by today's untick.
- `partial` and `missed` never advance the chain.
- Template events (`eventId`) and one-offs are untouched. Non-paced activities
  (Jiu Jitsu, `type:'target'`) are untouched — their timed row is all they have.
- One commit per tap (the existing `commit()` at the end of `logTimed`).
- **Invariant kept: ONE LOG ROW = ONE SESSION.** The attendance row and the
  lesson row are two rows with two meanings; every existing reader already
  separates them (`!e.timed && !e.eventId && e.curriculum` for lessons,
  `e.timed` for attendance). The one reader that does not — `subjectCards`'s
  `sessionsThisWeek` in `js/plan/mday.js` — is tightened to lessons only, or a
  single class would count as 2.

## Bot parity (aoife-school-bot)

`lib/ops.py::_apply_log_status` timed branch (`timed and not is_event`): after
the attendance row is set, apply the same two transitions with the bot's own
row shape (`src:'tg'`, `session` from `compose.next_index`, advance via
`compose.mark_session_done`, roll back via the existing `_rollback_chain`).
The confirmation gains ` · <session label>` (e.g. `· Lesson 2`) when a lesson
was advanced, mirroring the daily path's "what was logged" suffix. Message
prefix unchanged so existing `startswith` assertions hold.

## Not in scope

- Advancing on `partial`. A Timeline/baseline for Science. Any change to
  `togglePaced`, `logSession`, the Subjects sheet, or the gcal sync.

## Testing

- `tests/plan-state.test.mjs`: paced on-grid ✓ writes attendance + lesson rows
  and bumps `done`; toggle-off removes the lesson row and restores `done`;
  `done → missed` rolls back; `missed → done` advances; a second ✓ after an
  Oops-removed lesson uses `nextIndex` (owed slot); exhausted chain writes only
  attendance; template `eventId` and a `target` activity are unaffected.
- `tests/plan-mday.test.mjs`: `sessionsThisWeek` counts lesson rows only.
- Bot `tests/test_ops.py`: geography timed `done` writes both rows (exact
  shapes, `src:'tg'`), `done` bumps `geo-1.done` to 1 and the message ends with
  `· Week 1`; `done → missed` rolls back to 0 and removes the lesson row;
  `jj` (target) timed done writes only the attendance row; a template event
  timed done writes nothing extra.
- Release: planner stamps → `2026-09-01-3`, AGENTS.md notes in both repos,
  bot `uv run pytest -q` green then `vercel --prod --yes`.
