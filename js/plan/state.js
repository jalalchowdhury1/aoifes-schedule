// Planner store + persistence. Mirrors ../state.js philosophy.
// localStorage 'aoife_plan_v1'; KV via /api/plan-get + /api/plan-save.
import { sanitizePlan, serializePlan, currentCur, sessionsCount, todayStr, addDays, mondayOf } from './model.js';
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
  plan.data = saved ? sanitizePlan(saved) : seedPlan();
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
export function togglePaced(actId, date = todayStr()) {
  const act = getActivity(actId);
  if (!act) return;
  const i = plan.data.log.findIndex(e =>
    e.activityId === actId && e.date === date && e.status === 'done' && !e.eventId);
  if (i >= 0) {
    plan.data.log.splice(i, 1);
    const cur = [...(act.chain || [])].reverse().find(c => (c.done || 0) > 0);
    if (cur) cur.done--;
  } else {
    const cur = currentCur(act) || (act.chain || [])[0];
    plan.data.log.push({ date, activityId: actId, status: 'done',
      ...(cur ? { curriculum: cur.id, session: cur.done || 0 } : {}) });
    if (cur && ((cur.done || 0) < sessionsCount(cur) || sessionsCount(cur) === 0)) {
      cur.done = (cur.done || 0) + 1;
    }
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

export function setWeekType(monday, type, label) {
  const k = mondayOf(monday);
  if (!type || type === 'teaching') delete plan.data.weeks[k];
  else plan.data.weeks[k] = { type, ...(label ? { label } : {}) };
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

export function flipAnchor() {
  const pc = plan.data.parentCycle;
  pc.anchorMonday = addDays(pc.anchorMonday, 7);
  pc.confirmed = true;
  commit();
}

export function addOverride(o) { plan.data.overrides.push(o); commit(); }
export function removeOverride(idx) { plan.data.overrides.splice(idx, 1); commit(); }
