// Planner store + persistence. Mirrors ../state.js philosophy.
// localStorage 'aoife_plan_v1'; KV via /api/plan-get + /api/plan-save.
import { sanitizePlan, serializePlan, currentCur, todayStr, sortPeriods,
         PERIOD_TYPES, ISO } from './model.js';
import { seedPlan } from './seed.js';

const PK = 'aoife_plan_v1';

export const plan = { data: null };

let dirty = false;
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

export async function fetchPlanRemote() {
  try {
    const res = await fetch('/api/plan-get');
    const data = await res.json();
    if (!dirty && data && !data.error) {
      plan.data = sanitizePlan(data);
      planNotify();
    } else if (!dirty && data && data.error === 'empty') {
      savePlan();                    // first run: publish the seed to KV
    }
  } catch (e) {}
}

export function savePlan() {
  dirty = true;
  plan.data.savedAt = new Date().toISOString();
  const str = serializePlan(plan.data);
  try { localStorage.setItem(PK, str); } catch (e) {}
  fetch('/api/plan-save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: str }),
  }).catch(() => {});
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
  if (!per) return null;
  const start = isISO(patch.start) ? patch.start : per.start;
  const end = isISO(patch.end) ? patch.end : per.end;
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
  if (i < 0) return;
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
