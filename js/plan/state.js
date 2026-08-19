// Planner store + persistence. Mirrors ../state.js philosophy.
// localStorage 'aoife_plan_v1'; KV via /api/plan-get + /api/plan-save.
import { sanitizePlan, serializePlan, currentCur, todayStr, sortPeriods,
         PERIOD_TYPES, ISO } from './model.js';
import { seedPlan } from './seed.js';

const PK = 'aoife_plan_v1';

export const plan = { data: null };

// ── Live re-sync bookkeeping (planner-v2.5) ──────────────────
// `dirty` used to latch true on the first local save and then blocked EVERY
// later remote application for the life of the tab — which is exactly how the
// bot's first write ended up invisible on an open family tab. Replaced by an
// in-flight counter plus the timestamp of our own last write.
let pendingSaves = 0;         // POSTs in flight (decremented in a finally)
let lastLocalSaveAt = null;   // the `savedAt` we stamped on our most recent save
// When this tab last heard back from KV — the Today caption's "· synced HH:MM".
// It answers "is what I'm looking at stale?", so it advances on every round that
// REACHED the server, whether or not the blob turned out to be new.
export const syncInfo = { at: null };

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
// A missing/garbled remote savedAt counts as OLDER once we have written: the
// only writers that strip it are not the app, and losing a tap is worse than
// waiting for the next round. Identical blobs are dropped before planNotify(),
// so a poll never re-renders under the family's scroll or open sheet.
export async function syncPlan() {
  let data;
  try {
    const res = await fetch('/api/plan-get');
    data = await res.json();
  } catch (e) { return false; }         // offline is normal: never clobber
  syncInfo.at = new Date().toISOString();
  if (data && data.error === 'empty') {
    // First run only: publish the seed. Never after a local save — a wiped KV
    // must not be re-seeded over whatever this tab has since written.
    if (!pendingSaves && !lastLocalSaveAt) savePlan();
    return false;
  }
  if (!data || data.error) return false;
  if (pendingSaves) return false;                       // our own write is in flight
  if (lastLocalSaveAt &&
      !(typeof data.savedAt === 'string' && data.savedAt >= lastLocalSaveAt)) return false;
  const next = sanitizePlan(data);
  if (plan.data && serializePlan(next) === serializePlan(plan.data)) return false;
  plan.data = next;
  planNotify();
  return true;
}

export function savePlan() {
  const at = new Date().toISOString();
  plan.data.savedAt = at;
  lastLocalSaveAt = at;               // stamped at write time, not at completion:
                                      // a save that never lands leaves remote
                                      // older than us, which blocks application.
  const str = serializePlan(plan.data);
  try { localStorage.setItem(PK, str); } catch (e) {}
  pendingSaves++;
  fetch('/api/plan-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: str }),
  }).catch(() => {}).finally(() => { pendingSaves--; });   // never latches
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
  const i = plan.data.log.findIndex(e =>
    e.activityId === actId && e.date === date && e.status === 'done' && !e.eventId);
  if (i >= 0) {
    const entry = plan.data.log[i];
    plan.data.log.splice(i, 1);
    if (entry.curriculum) {
      const cur = (act.chain || []).find(c => c.id === entry.curriculum);
      if (cur && (cur.done || 0) > 0) cur.done--;
    }
  } else {
    const cur = currentCur(act);
    plan.data.log.push({ date, activityId: actId, status: 'done',
      ...(cur ? { curriculum: cur.id, session: cur.done || 0 } : {}) });
    if (cur) cur.done = (cur.done || 0) + 1;
  }
  commit();
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
  if (i >= 0 && plan.data.log[i].status === status) plan.data.log.splice(i, 1);
  else if (i >= 0) plan.data.log[i].status = status;
  else plan.data.log.push({ date, status, timed: true,
    ...(eventId ? { eventId } : {}), ...(activityId ? { activityId } : {}) });
  commit();
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

export function addOverride(o) { plan.data.overrides.push(o); commit(); }
export function removeOverride(idx) { plan.data.overrides.splice(idx, 1); commit(); }
