// Planner store + persistence. Mirrors ../state.js philosophy.
// localStorage 'aoife_plan_v1'; KV via /api/plan-get + /api/plan-save.
import { sanitizePlan, serializePlan, currentCur, todayStr, sortPeriods,
         PERIOD_TYPES, ISO, chainTimeline, nextIndex, markSessionDone, unmarkSession } from './model.js';
import { seedPlan } from './seed.js';
import { onHold, markSynced } from '../sync.js';

const PK = 'aoife_plan_v1';

export const plan = { data: null };

// ── Live re-sync bookkeeping (planner-v2.5) ──────────────────
// `dirty` used to latch true on the first local save and then blocked EVERY
// later remote application for the life of the tab — which is exactly how the
// bot's first write ended up invisible on an open family tab. Replaced by an
// in-flight counter plus the timestamp of our own last write.
let pendingSaves = 0;         // POSTs in flight (decremented in a finally)
let lastLocalSaveAt = null;   // the `savedAt` we stamped on our most recent save
let saveFailed = false;       // that write never landed: retry before reading
let lastAttempt = null;       // {str, base} of the last POST, replayed on retry

const listeners = new Set();
export const onPlanChange = fn => listeners.add(fn);
export const planNotify = () => listeners.forEach(fn => fn());

export function initPlan() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PK)); } catch (e) {}
  // The seed goes through sanitize too: every load path then holds a v2 plan
  // (periods, dutyStart) with the same invariants, whatever it came from.
  plan.data = sanitizePlan(saved || seedPlan());
}

// Pull the shared blob and apply it if it is safe to do so. Called at boot and
// then on every visibility/focus/poll round (js/plan/tabs.js). Returns true only
// when a genuinely different blob was applied.
//
// The blob is written from outside this browser (the Telegram bot), so a tab
// that never re-reads is silently wrong. It is also written by US, so a fetched
// blob is applied only when BOTH hold:
//   * pendingSaves === 0 — with a POST in flight the read may still return the
//     pre-write blob, and applying it would undo the family's own tap.
//   * no local save yet, OR remote.savedAt >= the savedAt we stamped on our last
//     save — anything older is our own write echoing back late (or a failed
//     save's pre-image) and must never overwrite what we hold.
// A missing/unparseable remote savedAt counts as OLDER once we have written:
// the only writers that strip it are not the app, and losing a tap is worse
// than waiting for the next round. Identical blobs are dropped before
// planNotify(), so a poll never re-renders under the family's scroll or sheet.
export async function syncPlan() {
  if (pendingSaves || onHold()) return false;           // our write / their edit
  if (saveFailed && lastAttempt) {
    // The tap that failed offline is not discarded: replay it, then let the
    // NEXT round read. Same self-healing retry as the template store.
    await postPlan(lastAttempt.str, lastAttempt.base);
    if (!saveFailed) markSynced('plan');
    return false;
  }
  let data;
  try {
    const res = await fetch('/api/plan-get');
    data = await res.json();
  } catch (e) { return false; }         // offline is normal: never clobber
  markSynced('plan');
  if (data && data.error === 'empty') {
    // First run only: publish the seed. Never after a local save — a wiped KV
    // must not be re-seeded over whatever this tab has since written.
    if (!lastLocalSaveAt) savePlan();
    return false;
  }
  if (!data || data.error) return false;
  if (pendingSaves || onHold()) return false;           // started during the fetch
  if (lastLocalSaveAt && !isAtLeast(data.savedAt, lastLocalSaveAt)) return false;
  const next = sanitizePlan(data);
  if (plan.data && serializePlan(next) === serializePlan(plan.data)) return false;
  plan.data = next;
  planNotify();
  return true;
}

// Timestamps are compared as EPOCHS, never as strings: this browser stamps
// milliseconds ('…12.345Z') while the Telegram bot's Python writes microseconds
// ('…12.345678Z'), and lexically '…12.345678Z' > '…12.345Z' even when it is the
// older write by half a second. Date.parse handles both and truncates to ms.
export function isAtLeast(remote, mine) {
  const r = Date.parse(remote), m = Date.parse(mine);
  return Number.isFinite(r) && Number.isFinite(m) && r >= m;
}

function postPlan(str, base) {
  pendingSaves++;
  return fetch('/api/plan-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `base` is the savedAt of the blob this snapshot was edited on top of.
    // api/plan-save merges when KV has moved on since (see AGENTS.md).
    body: JSON.stringify({ data: str, ...(base ? { base } : {}) }),
  }).then(res => { saveFailed = !!res && res.ok === false; },
          () => { saveFailed = true; })
    .finally(() => { pendingSaves--; });                   // never latches
}

export function savePlan() {
  const base = plan.data.savedAt || null;   // what we were editing on top of
  const at = new Date().toISOString();
  plan.data.savedAt = at;
  lastLocalSaveAt = at;               // stamped at write time, not at completion:
                                      // a save that never lands leaves remote
                                      // older than us, so local wins on screen
                                      // until syncPlan's retry pushes it through.
  const str = serializePlan(plan.data);
  try { localStorage.setItem(PK, str); } catch (e) {}
  lastAttempt = { str, base };
  postPlan(str, base);
  try { document.dispatchEvent(new CustomEvent('aoife:saved')); } catch (e) {}
}

const commit = () => { planNotify(); savePlan(); };

export const getActivity = id => plan.data.activities.find(a => a.id === id);

// Toggle a paced activity's "did it today" check. Checking advances the chain;
// unchecking the same day rolls it back (mis-tap fix).
// INVARIANT: check → uncheck is the identity in every state, including an
// exhausted chain. That holds because the log entry records WHICH curriculum
// was advanced, and the uncheck decrements exactly that one — never "the last
// curriculum with progress". currentCur() only returns a curriculum that can
// still advance (done < sessionsCount, and sessionsCount > 0), so when it is
// null nothing advances and the entry is written without a `curriculum` field,
// making the uncheck a pure log splice.
export function togglePaced(actId, date = todayStr()) {
  const act = getActivity(actId);
  if (!act) return;
  // `!e.timed`: an on-grid class carries an attendance row beside its lesson
  // row (logTimed, 2026-09-01); the toggle must find the LESSON, or the
  // phone's "Oops" would splice the attendance and leave `done` unrolled.
  const i = plan.data.log.findIndex(e =>
    e.activityId === actId && e.date === date && e.status === 'done' && !e.eventId && !e.timed);
  if (i >= 0) {
    const entry = plan.data.log[i];
    plan.data.log.splice(i, 1);
    if (entry.curriculum) {
      const cur = (act.chain || []).find(c => c.id === entry.curriculum);
      if (cur) {
        if (typeof entry.session === 'number') unmarkSession(cur, entry.session);
        else if ((cur.done || 0) > 0) cur.done--;
      }
    }
  } else {
    const cur = currentCur(act);
    const s = cur ? nextIndex(cur) : null;
    plan.data.log.push({ date, activityId: actId, status: 'done',
      ...(cur && s != null ? { curriculum: cur.id, session: s } : {}) });
    if (cur && s != null) markSessionDone(cur, s);
  }
  commit();
}

// ── Multi-session days: the tb-wb halves and extra lessons ──
// `togglePaced` above is a TOGGLE keyed on (activity, date) — the second call
// of a day FINDS THE FIRST ONE'S ROW AND REMOVES IT. That is exactly right for
// a one-check-a-day daily, and exactly wrong for a Singapore-style tb-wb
// lesson, where the textbook and workbook halves are two SEPARATE sessions on
// the same date (and a double-lesson day is four). Reported from a real phone
// screen 2026-08-31: tapping "✓ Textbook" then "✓ Workbook" left the day EMPTY,
// because both buttons called togglePaced and the second tap undid the first.
//
// These two are the append / append-inverse pair the phone's dual card writes
// through instead. Row shape is byte-identical to what togglePaced and the
// Telegram bot's `_apply_log_progress` write — ONE LOG ROW = ONE SESSION, the
// ecosystem-wide invariant (site actualFinishes, the merge's bump-replay and
// every tally rely on it; never a `count` field on one row).

// Append ONE session to whatever the activity's chain says is next. Never
// removes anything: call it twice and two sessions are logged.
export function logSession(actId, date = todayStr()) {
  const act = getActivity(actId);
  if (!act) return null;
  const cur = currentCur(act);
  if (!cur) return null;                    // chain exhausted: nothing to advance
  const s = nextIndex(cur);                 // lowest OWED slot if any, else the next fresh one
  const entry = { date, activityId: actId, status: 'done',
                  curriculum: cur.id, session: s };
  plan.data.log.push(entry);
  markSessionDone(cur, s);
  commit();
  return entry;
}

// Remove the session rows written ON `date` that sit at or after
// (curId, fromSession) in TEACHING order, and roll each chain's `done` back by
// exactly the rows removed. Two rules make this safe:
//   * only rows dated `date` are ever touched — a half logged on an earlier day
//     belongs to that day (the Subjects sheet's "Oops" row is where a past
//     session gets taken back), so unticking today can never rewrite history;
//   * everything ABOVE the tapped session goes with it, because `done` is a
//     COUNT, not a set: removing the textbook half of a lesson while its
//     workbook half stayed logged would leave a gap the counter cannot hold.
// Returns the removed rows in teaching order so the caller's Undo can replay
// them through logSession, or [] when nothing matched (no commit, no re-render).
export function unlogSessionsFrom(actId, curId, fromSession, date = todayStr()) {
  const act = getActivity(actId);
  if (!act) return [];
  const chain = act.chain || [];
  const rank = id => chain.findIndex(c => c && c.id === id);
  const fromRank = rank(curId);
  if (fromRank < 0) return [];              // unknown chapter: never guess a range
  const removed = [];
  for (let i = plan.data.log.length - 1; i >= 0; i--) {
    const e = plan.data.log[i];
    if (!e || e.date !== date || e.activityId !== actId || e.status !== 'done') continue;
    if (e.timed || e.eventId || !e.curriculum || typeof e.session !== 'number') continue;
    const r = rank(e.curriculum);
    if (r < 0 || r < fromRank || (r === fromRank && e.session < fromSession)) continue;
    removed.push(e);
    plan.data.log.splice(i, 1);
  }
  if (!removed.length) return [];
  for (const e of removed) {
    const cur = chain.find(c => c && c.id === e.curriculum);
    if (cur) unmarkSession(cur, e.session);
  }
  commit();
  return removed.reverse();                 // walked backwards: hand them back in order
}

// Log a timed block (template event or planner slot) for a date: done|partial|missed.
// Tapping the same status again clears it.
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
      // A lesson row for THIS day, from ANY writer (logSession, togglePaced, the
      // API, the bot) — provenance doesn't matter here, only whether the class
      // is already counted (red-team H1: a second ✓ must never double-log it).
      const isLesson = e => e && e.date === date && e.activityId === activityId &&
        !e.timed && !e.eventId && e.curriculum && typeof e.session === 'number';
      if (nowDone && !wasDone) {
        if (!plan.data.log.some(isLesson)) {
          const cur = currentCur(act);
          const s = cur ? nextIndex(cur) : null;
          if (cur && s != null) {
            plan.data.log.push({ date, activityId, status: 'done', curriculum: cur.id, session: s, viaTimed: true });
            markSessionDone(cur, s);
          }
        }
      } else if (wasDone && !nowDone) {
        // Only rows THIS tick wrote (`viaTimed`) — a lesson logged some other
        // way (Subjects sheet, bot log_progress) is never touched by an untick,
        // and only rows dated `date` — an earlier day's lesson belongs to that
        // day (the Subjects sheet's "Oops" is where history gets taken back).
        for (let k = plan.data.log.length - 1; k >= 0; k--) {
          const e = plan.data.log[k];
          if (!e || !e.viaTimed || !isLesson(e)) continue;
          const cur = (act.chain || []).find(c => c && c.id === e.curriculum);
          if (cur) unmarkSession(cur, e.session);
          plan.data.log.splice(k, 1);
        }
      }
    }
  }
  commit();
}

// Mark a no-slot daily as an outright miss for a date (the phone's
// long-press menu, planner-v2.9 polish round item D). The desktop Today view
// has no daily-missed control at all — its `.drow` tap only ever calls
// togglePaced, which can only ADVANCE the chain — so this is a genuinely new
// write path, not a wrapper around an existing one. Writes EXACTLY the
// Telegram bot's own marker shape (`callback_data(it.target, "missed", …)` in
// aoife-school-bot/lib/compose.py): `{date, activityId, status}`, no
// `curriculum`/`session`/`timed`/`eventId` — so mday.js's `dailyStatus`
// (whose marker-priority read doesn't care which writer produced the row)
// treats a phone-written and a bot-written miss identically. Idempotent like
// togglePaced/logTimed: tapping the same status again on the same day clears
// the mark instead of stacking a second one. The lookup excludes any row
// carrying a `curriculum` — a real logged session must never be mistaken for
// (or clobbered by) a bare status marker.
//
// GUARD (review 2, mirrors the bot's `guard_missed_tap` in lib/ops.py):
// creating or overwriting a marker is refused whenever a real curriculum-
// bearing `done` row already exists for this activity/date — a marker must
// never COEXIST with logged work. The bot only enforces this at the write
// layer for tb-wb chains (its UI never even offers the button for a simple
// daily once answered, so the write layer never sees the collision there);
// this port generalizes the guard to every daily pattern, since /m's own UI
// doesn't yet gate the option the same way and a blocked write is always
// safe, while a collision would let `dailyStatus`'s marker-priority read
// silently report "missed" for a day that was actually done, with the
// chain's `done` counter never rolled back to match. Returns `false` when
// refused (no commit — chain/log untouched), `true` on a normal write.
// Toggling an EXISTING marker off (tapping the same status again) is exempt:
// removing a marker can only resolve a collision, never create one.
export function logDailyStatus(actId, status, date = todayStr()) {
  const act = getActivity(actId);
  if (!act) return;
  const match = e => e.activityId === actId && e.date === date &&
    !e.timed && !e.eventId && !e.curriculum;
  const i = plan.data.log.findIndex(match);
  const togglingOff = i >= 0 && plan.data.log[i].status === status;
  if (!togglingOff) {
    const hasWork = plan.data.log.some(e => e.activityId === actId && e.date === date &&
      e.status === 'done' && !e.timed && !e.eventId);
    if (hasWork) return false;
  }
  if (togglingOff) plan.data.log.splice(i, 1);
  else if (i >= 0) plan.data.log[i].status = status;
  else plan.data.log.push({ date, activityId: actId, status });
  commit();
  return true;
}

// ── Time away (day-precise periods) ─────────────────────────
const isISO = s => typeof s === 'string' && ISO.test(s);
const okType = t => (PERIOD_TYPES.includes(t) ? t : 'travel');
const periods = () => (plan.data.periods ||= []);
// ids are identity (updatePeriod/deletePeriod find rows by them), so mint from
// the max existing `p<n>` rather than the length — deleting must not collide.
const nextPeriodId = () => `p${periods().reduce((m, p) => {
  const x = /^p(\d+)$/.exec(p.id);
  return x ? Math.max(m, Number(x[1])) : m;
}, 0) + 1}`;

export function addPeriod({ start, end, type, label } = {}) {
  // Last-resort guard, not the user-facing check: year.js validates both dates
  // and end >= start inline (.form-err) before it ever calls this. Returning
  // early skips commit(), so nothing notifies and nothing re-renders — a caller
  // that reaches this line has already shown its own message or is a bad script.
  if (!isISO(start) || !isISO(end) || start > end) return null;
  const per = { id: nextPeriodId(), start, end, type: okType(type),
    ...(label ? { label: String(label) } : {}) };
  periods().push(per);
  sortPeriods(periods());
  commit();
  return per;
}

export function updatePeriod(id, patch = {}) {
  const per = periods().find(p => p.id === id);
  if (!per) return null;          // deleted underneath us: no commit, no re-render
  const start = isISO(patch.start) ? patch.start : per.start;
  const end = isISO(patch.end) ? patch.end : per.end;
  // Reversed/garbage dates keep the stored range rather than corrupting it; the
  // sheet already rejects them inline, so this branch is unreachable from the UI.
  if (start <= end) { per.start = start; per.end = end; }
  if (PERIOD_TYPES.includes(patch.type)) per.type = patch.type;
  if ('label' in patch) {
    const l = String(patch.label ?? '').trim();
    if (l) per.label = l; else delete per.label;
  }
  sortPeriods(periods());
  commit();
  return per;
}

export function deletePeriod(id) {
  const i = periods().findIndex(p => p.id === id);
  if (i < 0) return;              // already gone: no commit, so no notify/re-render
  periods().splice(i, 1);
  commit();
}

export function setActivityStatus(id, status) {
  const act = getActivity(id);
  if (act) { act.status = status; commit(); }
}

export function setTravelMode(id, mode) {
  const act = getActivity(id);
  if (act) { act.travel = mode === 'reduced' ? { mode, factor: 0.5 } : { mode }; commit(); }
}

// Move/resize one on-grid slot (js/grid.js drag → drop). `idx` is the slot's
// identity (data-slot, gcal `act:<id>:<idx>`), so this assigns in place and
// never splices. Only numeric fields are applied; the drag guarantees them.
export function setSlot(actId, idx, { day, start, end } = {}) {
  const act = getActivity(actId);
  const s = act && Array.isArray(act.slots) ? act.slots[idx] : null;
  if (!s) return false;
  if (typeof day === 'number') s.day = day;
  if (typeof start === 'number') s.start = start;
  if (typeof end === 'number') s.end = end;
  commit();
  return true;
}

// Freeze today's projected per-row finish dates as "the plan" (Subjects 📅
// Timeline). Overwrites any previous baseline — the UI arms two-tap when one
// exists. Complete rows and horizon-exhausted rows store nothing: history
// lives in the log, and a dash is honest for the unprojectable.
export function setBaseline(actId, date = todayStr()) {
  const act = getActivity(actId);
  if (!act) return;
  const rows = {};
  for (const r of chainTimeline(act, date, plan.data))
    if (!r.complete && r.finish) rows[r.key] = r.finish;
  act.baseline = { setOn: date, rows };
  commit();
}

export function addOverride(o) { plan.data.overrides.push(o); commit(); }
export function removeOverride(idx) { plan.data.overrides.splice(idx, 1); commit(); }
