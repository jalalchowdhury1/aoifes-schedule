// Planner pure model — no DOM, no storage. Companion to ../model.js.
// All dates are local 'YYYY-MM-DD' strings. Week walks are keyed by their
// Monday; time away is day-precise and lives in `plan.periods` (v2).

import { S, E } from '../model.js';

export const d2s = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const s2d = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const todayStr = () => d2s(new Date());
export const addDays = (s, n) => { const d = s2d(s); d.setDate(d.getDate() + n); return d2s(d); };
export const dayIdx = s => (s2d(s).getDay() + 6) % 7;           // Mon=0 … Sun=6
export const mondayOf = s => addDays(s, -dayIdx(s));
export const weeksBetween = (a, b) =>
  Math.round((s2d(mondayOf(b)) - s2d(mondayOf(a))) / 604800000);
// Round, don't floor: a DST boundary makes a "day" 23 or 25 hours long.
export const daysBetween = (a, b) => Math.round((s2d(b) - s2d(a)) / 86400000);

// Monday parity of the 2-week parent cycle (which weeks are "work weeks").
export const isOnWeek = (cycle, dateStr) =>
  ((weeksBetween(cycle.anchorMonday, dateStr) % 2) + 2) % 2 === 0;

// Day-precise duty: a Charlton work stretch runs Tue → Mon (7 days on, 7 off)
// from `dutyStart`. Dates before dutyStart must keep the same parity, hence the
// double modulo.
export const DEFAULT_DUTY_START = '2026-08-11';
export const isWorkDay = (cycle, dateStr) =>
  ((daysBetween(cycle?.dutyStart || DEFAULT_DUTY_START, dateStr) % 14) + 14) % 14 < 7;

// ── Time-away periods (day-precise; replaces the week map) ──
export const PERIOD_TYPES = ['travel', 'off'];
const asPeriods = x => (Array.isArray(x) ? x : []);           // guard: non-array/missing -> none
export const byPeriodStart = (a, b) =>
  a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export const sortPeriods = list => list.sort(byPeriodStart);

// The period covering this day, or null.
// OVERLAPS: `off` WINS over `travel` — an off day pauses everything, so it is
// the stronger claim and the safer default when two periods collide (the family
// would rather see a day off they meant to keep than schoolwork they cancelled).
// Among periods of the SAME type the first in sort order wins; the list is kept
// sorted by start (sanitizePlan + every state.js mutation), so that is the
// earliest start. Nothing here mutates or re-sorts `periods`.
export const dayAway = (periods, dateStr) => {
  let hit = null;
  for (const p of asPeriods(periods)) {
    if (p.start > dateStr || dateStr > p.end) continue;
    if (!hit) { hit = p; }
    else if (hit.type !== 'off' && p.type === 'off') hit = p;
    if (hit.type === 'off') break;                            // nothing can outrank an off day
  }
  return hit;
};

export function dayStatus(periods, dateStr) {
  const p = dayAway(periods, dateStr);
  if (!p) return { away: false };
  return {
    away: true, id: p.id, type: p.type, label: p.label || '',
    dayN: daysBetween(p.start, dateStr) + 1,
    total: daysBetween(p.start, p.end) + 1,
  };
}

export const awayDaysInWeek = (periods, weekStart) => {
  let n = 0;
  for (let i = 0; i < 7; i++) if (dayAway(periods, addDays(weekStart, i))) n++;
  return n;
};

// What ONE calendar day is worth to this activity: a plain day is 1, an `off`
// day 0, a travel day whatever the activity's travel mode says. This is the
// per-day half of effectiveDaysInWeek, pulled out (2026-08-31) so
// expectedSessions can price a single day without smearing a whole week's
// average across it — over a 4-day span that all falls inside a trip, the
// week-average said the plan expected 6.6 sessions where the trip's own half
// speed expects 4.
export function dayWeight(act, dateStr, periods) {
  const away = dayAway(periods, dateStr);
  if (!away) return 1;
  if (away.type === 'off') return 0;                          // everything pauses
  const t = act?.travel || { mode: 'pause' };
  if (t.mode === 'continue') return 1;
  if (t.mode === 'reduced') return (t.factor ?? 0.5);
  return 0;                                                   // pause
}

// School-days-worth of this week for one activity. Unchanged behaviour — the
// loop body is now dayWeight, so the bot's port of this stays valid.
export function effectiveDaysInWeek(act, weekStart, periods) {
  let n = 0;
  for (let i = 0; i < 7; i++) n += dayWeight(act, addDays(weekStart, i), periods);
  return n;
}

// ── Curricula & sessions ────────────────────────────────────
export function sessionsCount(cur) {
  if (cur.pattern === 'tb-wb') return (cur.lessons || 0) * 2 + (cur.tests || 0);
  if (cur.lastUnit == null || cur.firstUnit == null) return 0;
  return Math.max(0, cur.lastUnit - cur.firstUnit + 1);
}

export function sessionLabel(cur, i) {              // i = 0-based session index
  if (cur.pattern === 'tb-wb') {
    const L = (cur.lessons || 0) * 2;
    if (i < L) return `Lesson ${Math.floor(i / 2) + 1} · ${i % 2 ? 'workbook' : 'textbook'}`;
    return `Test ${i - L + 1}`;
  }
  const u = cur.firstUnit + i;
  return (cur.titles || {})[u] || `${cur.unitWord || 'Lesson'} ${u}`;
}

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

// ── Category class tokens ───────────────────────────────────
// `cls` is interpolated RAW into class="…" attributes by every view, so it is
// whitelisted rather than escaped. Lives here (pure) so no view imports another.
const CLS = new Set(['q', 'r', 'h', 'b', 'a', 'ot', 'g', 's', 'j']);
export const okCls = x => (CLS.has(x) ? x : 'ot');

// ── Subjects tab order (planner-v2.8, family feedback 2026-08-19) ──
// Fixed order: the top three (Singapore, LoE, Geography) are what Nabila
// needs day to day, then the core categories, then the rest. An id not in
// this list (a future activity) sorts after every known one, stable among
// THEMSELVES by the OLD status order (active/planned/parked/done/cancelled)
// — the rule this list replaces for everything it names.
export const SUBJECT_ORDER = ['singapore', 'loe', 'geography', 'core-ruhamah',
  'core-hala', 'core-quran', 'core-art', 'science', 'jj', 'history', 'core-mama'];
const SUBJECT_STATUS_ORDER = { active: 0, planned: 1, parked: 2, done: 3, cancelled: 4 };
export function compareSubjects(a, b) {
  const ia = SUBJECT_ORDER.indexOf(a?.id), ib = SUBJECT_ORDER.indexOf(b?.id);
  const ka = ia === -1 ? SUBJECT_ORDER.length : ia;
  const kb = ib === -1 ? SUBJECT_ORDER.length : ib;
  if (ka !== kb) return ka - kb;
  if (ia !== -1) return 0;    // both known: ids are unique, nothing left to break the tie
  return (SUBJECT_STATUS_ORDER[a?.status] ?? 9) - (SUBJECT_STATUS_ORDER[b?.status] ?? 9);
}

export const currentCur = act => (act.chain || []).find(c => (c.done || 0) < sessionsCount(c)) || null;
export const actTotal = act => (act.chain || []).reduce((s, c) => s + sessionsCount(c), 0);
export const actDone = act => (act.chain || []).reduce((s, c) => s + Math.min(c.done || 0, sessionsCount(c)), 0);
export const actRemaining = act => Math.max(0, actTotal(act) - actDone(act));

// ── Planner slots on the week grid (2026-09-01) ─────────────
// An active on-grid activity's `slots[]` are recurring weekly blocks, the
// planner-side twin of `aoifes_schedule.events`. `(actId, idx)` IS a slot's
// identity everywhere — the grid's data-slot attribute, the gcal sync key
// `act:<id>:<idx>` — so the index must never be re-packed here: a malformed
// slot is skipped, not spliced. Same drawing rules as the one-off ghosts: a
// slot wholly outside 9–17 is dropped, an overhanging one is clamped to the
// band (`top`/`bottom`) while the label keeps its real `start`/`end`.
export function gridSlots(activities) {
  const out = [];
  for (const a of Array.isArray(activities) ? activities : []) {
    if (!a || a.status !== 'active' || !a.onGrid || !Array.isArray(a.slots)) continue;
    const cur = a.type === 'paced' ? currentCur(a) : null;
    const ns = cur ? nextSession(cur) : null;
    const note = ns ? ns.label : '';
    a.slots.forEach((s, idx) => {
      if (!s || !Number.isInteger(s.day) || s.day < 0 || s.day > 6) return;
      if (typeof s.start !== 'number' || typeof s.end !== 'number') return;
      if (s.end <= s.start || s.end <= S || s.start >= E) return;
      out.push({
        actId: a.id, idx, day: s.day, start: s.start, end: s.end,
        top: Math.max(S, s.start), bottom: Math.min(E, s.end),
        name: a.name || a.id, cls: okCls(a.cls), note,
      });
    });
  }
  return out;
}

// ── Lesson-based totals (Subjects header: "2/60 lessons") ───
// A session count and a LESSON count differ for tb-wb chains: two sessions
// (textbook + workbook) make one lesson, and a chapter's Review sessions
// (`tests`) are teaching-order bookkeeping, not lessons — they are EXCLUDED
// from both numbers entirely, the same way a chapter test doesn't move a
// "lessons done" counter in real life. A simple chain (LoE) has no such split:
// each unit already IS a lesson, so it counts 1:1, same as actTotal/actDone.
export function lessonTotals(act) {
  let done = 0, total = 0;
  for (const c of act?.chain || []) {
    if (!c || typeof c !== 'object') continue;
    if (c.pattern === 'tb-wb') {
      const lessons = Math.max(0, c.lessons || 0);
      const lessonSessions = lessons * 2;
      // Clamp to the lesson sessions BEFORE halving: review/test sessions
      // logged past lessons*2 must contribute 0, not a phantom half-lesson.
      const d = Math.min(Math.max(0, c.done || 0), lessonSessions);
      total += lessons;
      done += Math.min(Math.floor(d / 2) + (d % 2 ? 0.5 : 0), lessons);
    } else if (c.pattern === 'simple') {
      if (c.firstUnit == null || c.lastUnit == null) continue;
      const units = Math.max(0, c.lastUnit - c.firstUnit + 1);
      total += units;
      done += Math.min(Math.max(0, c.done || 0), units);
    }
  }
  return { done, total };
}

// ── Chapter timeline (Subjects 📅 Timeline) ─────────────────
// Row descriptors for a paced activity's chain, in teaching order.
// tb-wb chains (Singapore chapters) are one row each; simple chains (LoE books)
// split into BAND_SIZE-unit display bands so a 40-lesson book reads as
// milestones. Bands are DISPLAY ONLY — nothing stored changes shape, so band
// size can change later without any data migration.
export const BAND_SIZE = 10;
export function timelineRows(act) {
  const rows = [];
  // WALK_CAP is declared later in this file; fine at call time (module-scope
  // const, this function only runs post-evaluation). Same belt-and-braces
  // reasoning as WALK_CAP's own comment: a fat-fingered lastUnit (or a huge
  // hand-built chain) must never build 500k row objects and hang a tab.
  // Beyond the cap, per-row dates are computed from the visible rows only —
  // the projectFinish agreement holds for real curricula (≤~30 rows), not
  // for pathological spans.
  for (const c of act?.chain || []) {
    if (rows.length >= WALK_CAP) break;
    const total = sessionsCount(c);
    const done = Math.min(Math.max(0, c.done || 0), total);
    if (c.pattern === 'tb-wb') {
      rows.push({ key: c.id, chainId: c.id, label: c.name || c.id, sessions: total, done });
    } else {
      if (c.firstUnit == null || c.lastUnit == null) continue;
      const word = c.unitWord || 'Lesson';
      // Per-chain display band size (LoE ships 5-lesson bands while Singapore's
      // simple chains, if any, keep the default) — DISPLAY ONLY, same as
      // BAND_SIZE itself: nothing stored changes shape.
      const bandSize = Number.isInteger(c.bandSize) && c.bandSize > 0 ? c.bandSize : BAND_SIZE;
      let left = done;
      for (let a = c.firstUnit; a <= c.lastUnit && rows.length < WALK_CAP; a += bandSize) {
        const b = Math.min(a + bandSize - 1, c.lastUnit);
        const n = b - a + 1;
        const d = Math.min(left, n);
        left -= d;
        rows.push({ key: `${c.id}:${a}-${b}`, chainId: c.id,
          label: a === b ? `${word} ${a}` : `${word}s ${a}–${b}`, sessions: n, done: d });
      }
    }
  }
  return rows;
}

// Per-row projected finish dates from the SAME week-walk as projectFinish.
// INVARIANT (precise): the last unfinished row WITH SESSIONS DEFINED
// (sessions > 0) lands on exactly projectFinish's date (unit-pinned) — the
// breakdown can never contradict the card's headline. 0-session placeholder
// rows (a chapter waiting for its counts) pass through with finish null and
// are EXCLUDED from that contract, so a consumer must scan with
// `reverse().find(r => !r.complete && r.sessions > 0)`, never a bare
// `!r.complete` — the bare form can land on a trailing placeholder instead
// of the real last row. A row's finish (when set) is the Sunday of the week
// its cumulative remaining sessions are covered.
export function chainTimeline(act, fromDate, plan, horizon = 300) {
  const rows = timelineRows(act).map(r =>
    ({ ...r, complete: r.sessions > 0 && r.done >= r.sessions, finish: null }));
  const targets = [];                 // cumulative remaining sessions per row
  let cum = 0;
  for (const r of rows) { cum += Math.max(0, r.sessions - r.done); targets.push(cum); }
  if (!cum) return rows;              // nothing left anywhere
  let acc = 0, w = mondayOf(fromDate), i = 0;
  for (let wk = 0; wk < horizon && i < rows.length; wk++) {
    acc += weekCapacity(act, w, plan.periods, plan.parentCycle);
    // A zero-session row (a chapter waiting for its counts, a first-class
    // state in this app) contributes nothing to `targets`, so it shares its
    // target with whichever row precedes it and would otherwise be popped
    // and stamped with THAT row's date. Pass it through untouched instead —
    // finish stays null, the UI shows "—".
    while (i < rows.length && (rows[i].complete || rows[i].sessions === 0 || acc >= targets[i])) {
      if (!rows[i].complete && rows[i].sessions > 0) rows[i].finish = addDays(w, 6);
      i++;
    }
    w = addDays(w, 7);
  }
  return rows;
}

// Actual finish dates recovered from the log: dated 'done' entries per chain,
// replayed in date order — the entry that crosses a row's cumulative session
// boundary dates that row. Rows advanced without log rows (bulk `done` bumps
// from a Claude session) have no entry here; the view shows a bare ✓.
export function actualFinishes(act, log) {
  const out = {};
  const byChain = new Map();
  for (const r of timelineRows(act)) {
    if (!byChain.has(r.chainId)) byChain.set(r.chainId, []);
    byChain.get(r.chainId).push(r);
  }
  for (const [chainId, rows] of byChain) {
    const dates = (Array.isArray(log) ? log : [])
      .filter(e => e && e.status === 'done' && e.curriculum === chainId &&
        typeof e.date === 'string' && ISO.test(e.date))
      .map(e => e.date).sort();
    let upto = 0;
    for (const r of rows) {
      upto += r.sessions;
      if (dates.length >= upto) out[r.key] = dates[upto - 1];
    }
  }
  return out;
}

// A plan-vs-now date delta, ± days between a live projected finish and a
// frozen baseline date: within a week either way reads as "on plan" (dates
// wobble by a session or two without meaning anything), otherwise ▲/▼ by the
// week. Shared by the Subjects 📅 Timeline row chip AND the computed pace
// note (planner-v2.8) so a whole-book "ahead/behind" line can never disagree
// with its own per-chapter breakdown — one rule, two renderings. null when
// either date is missing (no baseline set yet, or an unprojectable row).
// ── Pace vs plan: the HONEST ahead/behind ───────────────────
// "Is she keeping up?" must NOT be answered by differencing two projected
// finish dates. `projectFinish`/`chainTimeline` walk in WHOLE WEEKS anchored
// on `mondayOf(fromDate)` and return the SUNDAY of the finishing week, so a
// projection carries up to 7 days of pure quantisation, and a baseline frozen
// on one weekday compared against a walk run on another moves in 7-day steps
// for no reason at all.
//
// That is not theoretical. Live on 2026-08-31: Singapore's baseline was frozen
// Fri 2026-08-28 (anchor Monday Aug 24, 251 sessions, 17.93 weeks charged as
// 18) giving Dec 27. Three days later the walk ran on Mon Aug 31 (anchor
// Monday Aug 31, 239 sessions, 17.07 weeks ALSO charged as 18) giving Jan 3.
// The finish date moved a week LATER while she did 12 sessions in 4 days
// against a planned 8 — the phone said "7 lessons behind" for a child who was
// 2 lessons AHEAD. The user caught it: "she's done more textbooks and
// workbooks already so there's no way she can be behind."
//
// So measure the thing itself: sessions actually logged since the baseline was
// frozen, against sessions that baseline's own pace expected over the same
// days. Day-precise, no anchors, no rounding.

// Sessions this activity's planned pace delivers across [fromDate, toDate]
// INCLUSIVE, charged a day at a time (weekCapacity already prices away-days
// and the parent cycle, so a day is worth its week's capacity / 7). Bounded by
// WALK_CAP weeks like every other walk in this file.
export function expectedSessions(act, fromDate, toDate, plan) {
  if (!isISO(fromDate) || !isISO(toDate) || fromDate > toDate) return 0;
  const r = act?.rhythm || {};
  const perDay = Number(r.sessionsPerDay);
  const mult = Number.isFinite(perDay) && perDay > 0 ? perDay : 1;
  let n = 0, d = fromDate;
  for (let i = 0; i < WALK_CAP * 7 && d <= toDate; i++) {
    // A DAILY rhythm is pinned to actual days, so an away day is priced on the
    // day itself. A weekly/cycle rhythm is not tied to any particular weekday,
    // so its week's capacity is spread evenly across that week instead.
    n += r.kind === 'daily'
      ? mult * dayWeight(act, d, plan?.periods)
      : weekCapacity(act, mondayOf(d), plan?.periods, plan?.parentCycle) / 7;
    d = addDays(d, 1);
  }
  return n;
}

// How far ahead of (+) or behind (-) its own frozen plan an activity really
// is, in SESSIONS, plus the two numbers it came from so a view can show its
// working. null when there is no baseline to measure against (nothing frozen
// yet, or a baseline dated in the future), which every caller renders as "no
// plan yet" rather than as zero.
//
// Only curriculum-bearing `done` rows count: a bare ✗/◐ marker is not work,
// and a `done` bump written with no curriculum advanced no chain.
export function paceGap(act, plan, today) {
  const setOn = act?.baseline?.setOn;
  if (!act || !isISO(setOn) || !isISO(today) || setOn > today) return null;
  const log = Array.isArray(plan?.log) ? plan.log : [];
  const done = log.filter(e => e && e.activityId === act.id && e.status === 'done' &&
    !e.timed && !e.eventId && e.curriculum && e.date >= setOn && e.date <= today).length;
  // The freeze day counts as a WHOLE expected day even though the freeze
  // happened partway through it: over-stating what the plan wanted biases the
  // answer toward "less ahead", the safe direction for a progress claim.
  const expected = expectedSessions(act, setOn, today, plan);
  return { sessions: done - expected, done, expected, since: setOn };
}

// The same gap in LESSONS, the unit the family speaks in: a tb-wb chapter
// spends TWO sessions per lesson, every other pattern one.
export function paceGapLessons(act, plan, today) {
  const gap = paceGap(act, plan, today);
  if (!gap) return null;
  const cur = currentCur(act);
  const per = cur?.pattern === 'tb-wb' ? 2 : 1;
  return { ...gap, lessons: gap.sessions / per, perLesson: per };
}

// The plan gap in SIGNED DAYS, with one convention for the whole app:
// POSITIVE = AHEAD of plan (the live projection lands EARLIER than the frozen
// baseline), negative = behind, null when either date is missing.
//
// This exists because it kept being got backwards. `daysBetween(a, b)` is
// `b - a`, so `daysBetween(finish, baseline)` is "how many days EARLIER than
// planned" — positive is good. Two /m surfaces each rolled their own copy of
// that comparison and BOTH read the sign as "+ = later = behind" (see the
// wrong comments they carried), so the phone told the family "▲ 7 lessons
// ahead" on a subject that was 7 days BEHIND its own frozen plan — the exact
// number a parent would use to decide whether to push harder. Caught
// 2026-08-31 reviewing /m at 390px before handing it to a second user.
// Anything comparing a projection to a baseline calls THIS, never daysBetween.
export const planGapDays = (finishDate, baselineDate) =>
  (finishDate && baselineDate) ? daysBetween(finishDate, baselineDate) : null;

export function planDeltaChip(finishDate, baselineDate) {
  if (!finishDate || !baselineDate) return null;
  const dd = planGapDays(finishDate, baselineDate);        // + = ahead of plan
  const weeks = Math.round(Math.abs(dd) / 7);
  if (Math.abs(dd) <= 7) return { state: 'on', weeks: 0 };
  return { state: dd > 0 ? 'ahead' : 'behind', weeks };
}

// ── Sanitize (mirror of sanitizeEvents philosophy) ──────────
// Every date that a week-walk loop compares against MUST be a real ISO date,
// or `while (w <= badDate)` never terminates. Guard them all here.
export const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isISO = s => typeof s === 'string' && ISO.test(s);

// One period, or null if it can't be trusted. `id` is identity: updatePeriod /
// deletePeriod find rows by it, so an id-less row would be uneditable.
const cleanPeriod = p => {
  if (!p || typeof p !== 'object') return null;
  const id = p.id == null ? '' : String(p.id);
  if (!id || !isISO(p.start) || !isISO(p.end) || p.start > p.end) return null;
  if (!PERIOD_TYPES.includes(p.type)) return null;
  return { id, start: p.start, end: p.end, type: p.type,
    ...(p.label ? { label: String(p.label) } : {}) };
};

// v1 → v2: every marked week becomes a 7-day period (Mon..Sun). `light` is gone
// from the model, so those weeks are dropped; `teaching` was never a marking.
const migrateWeeks = weeks => {
  const out = [];
  if (weeks && typeof weeks === 'object')
    for (const [k, v] of Object.entries(weeks))
      if (isISO(k) && v && PERIOD_TYPES.includes(v.type))
        out.push({ id: `w-${k}`, start: k, end: addDays(k, 6), type: v.type,
          ...(v.label ? { label: String(v.label) } : {}) });
  return out;
};

export function sanitizePlan(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...r };
  out.version = typeof r.version === 'number' ? r.version : 1;
  out.year = r.year && isISO(r.year.start) && isISO(r.year.end)
    ? r.year : { label: '2026-27', start: '2026-08-17', end: '2027-08-31' };
  const pc = r.parentCycle && isISO(r.parentCycle.anchorMonday)
    ? { ...r.parentCycle } : { pattern: '7on7off', anchorMonday: '2026-08-17', confirmed: false };
  if (!isISO(pc.dutyStart)) pc.dutyStart = DEFAULT_DUTY_START;
  out.parentCycle = pc;
  const seen = new Set();
  const periods = [];
  for (const p of [...(Array.isArray(r.periods) ? r.periods : []).map(cleanPeriod).filter(Boolean),
                   ...migrateWeeks(r.weeks)])
    if (!seen.has(p.id)) { seen.add(p.id); periods.push(p); }   // id is identity: no duplicates
  out.periods = sortPeriods(periods);
  delete out.weeks;
  out.activities = (Array.isArray(r.activities) ? r.activities : [])
    .filter(a => a && typeof a === 'object' && a.id && a.type)
    .map(a => {
      // `id` is required: togglePaced records it in the log and finds the
      // curriculum by it on uncheck. An id-less entry would break that identity.
      const o = { ...a, chain: Array.isArray(a.chain)
          ? a.chain.filter(c => c && c.pattern && c.id).map(c => {
              const cc = { ...c, done: Math.max(0, c.done || 0) };
              // bandSize is a DISPLAY knob for timelineRows: a non-positive or
              // non-integer value would either loop forever or misdraw bands,
              // so an invalid one is dropped rather than carried through —
              // timelineRows then falls back to BAND_SIZE, same as if it were
              // never set.
              if ('bandSize' in cc && !(Number.isInteger(cc.bandSize) && cc.bandSize > 0))
                delete cc.bandSize;
              return normalizeSkipped(cc);
            })
          : [] };
      if (o.goal && !isISO(o.goal.finishBy)) delete o.goal;
      // Baseline (Subjects 📅 Timeline): rebuild to exactly {setOn, rows} or
      // drop it — a corrupt baseline must degrade to "no plan yet", never
      // corrupt the activity or crash a date compare.
      if ('baseline' in o) {
        const b = o.baseline, rows = b && typeof b === 'object' ? b.rows : null;
        const ok = b && isISO(b.setOn) && rows && typeof rows === 'object' &&
          !Array.isArray(rows) && Object.values(rows).every(isISO);
        if (ok) o.baseline = { setOn: b.setOn, rows: { ...rows } };
        else delete o.baseline;
      }
      return o;
    });
  out.log = (Array.isArray(r.log) ? r.log : [])
    .filter(e => e && isISO(e.date) && e.status && (e.activityId || e.eventId));
  out.overrides = (Array.isArray(r.overrides) ? r.overrides : [])
    .filter(o => o && isISO(o.date) && o.action);
  return out;
}

export const serializePlan = p => JSON.stringify(p);

// ── Concurrent-write merge (server side) ────────────────────
// Two writers share one blob: this browser and the Telegram bot. A save carries
// the `savedAt` of the blob it was edited on top of (`base`); when KV has moved
// on since, api/plan-save calls this instead of blind last-write-wins.
//
// It is an APPEND union, deliberately narrow: rows present in `current` but
// absent from `incoming` are carried over, because in practice both writers
// only ever ADD — a tap logs a row, the bot writes a one-off. Nothing else is
// reconciled: `incoming` wins outright on activities, periods, parentCycle and
// every other field, since those are edited in one place at a time.
//
// KNOWN LIMIT — deletion resurrection: an untick (log splice) or a deleted
// override that races another writer's save comes back, because "absent from
// incoming" cannot tell "they deleted it" from "they never saw it". The family
// re-taps; nothing is lost, something is restored. That trade is deliberate:
// losing a logged session is silent, an unexpected ✓ is visible. See AGENTS.md.
export function mergePlanWrites(current, incoming) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  if (!current || typeof current !== 'object') return incoming;

  // An override written by the bot has an id; one hand-written by a script may
  // not, so fall back to the shape of the row itself.
  const ovKey = o => (o && o.id != null && o.id !== ''
    ? `id:${o.id}`
    : `fp:${o?.date}|${o?.action}|${o?.start}|${o?.end}|${o?.name}`);
  // One STATUS per thing per day is the log's own invariant (logTimed replaces
  // in place), so (date, owner) is a marker's or a timed row's identity.
  const logKey = e => `${e?.date}|${e?.eventId || e?.activityId || ''}`;
  // A SESSION row is different: a tb-wb lesson is two rows on one date
  // (textbook + workbook) and a double-lesson day is four, so which session it
  // is has to be part of its identity. Keyed on (date, owner) alone, every row
  // after the first collapsed into the first — a phone logging the textbook
  // half while the bot logged the workbook half kept one of them and left the
  // chapter counter a session short (2026-08-31).
  const sessKey = e => (e && e.curriculum && typeof e.session === 'number'
    ? `${logKey(e)}|${e.curriculum}#${e.session}` : null);

  const inOv = Array.isArray(incoming.overrides) ? incoming.overrides : [];
  const curOv = Array.isArray(current.overrides) ? current.overrides : [];
  const inLog = Array.isArray(incoming.log) ? incoming.log : [];
  const curLog = Array.isArray(current.log) ? current.log : [];

  const haveOv = new Set(inOv.map(ovKey));
  const haveLog = new Set(inLog.map(logKey));
  const haveSess = new Set(inLog.map(sessKey).filter(Boolean));
  const addOv = curOv.filter(o => !haveOv.has(ovKey(o)));
  // A session row is carried when THAT session is missing from the incoming
  // blob; a marker or timed row is still carried only when the incoming blob
  // has nothing at all for that owner/day — so an incoming session row keeps
  // suppressing a stale ✗ marker exactly the way it did before.
  const addLog = curLog.filter(e => {
    const sk = sessKey(e);
    return sk ? !haveSess.has(sk) : !haveLog.has(logKey(e));
  });
  if (!addOv.length && !addLog.length) return incoming;    // nothing to carry over

  const out = { ...incoming, overrides: [...inOv, ...addOv], log: [...inLog, ...addLog] };

  // A paced check advances a curriculum's `done` in the same write that logs
  // it. Re-attaching the row alone would leave the chain one session behind, so
  // each carried-over row replays its own increment. Never mutates `incoming`.
  const bumps = addLog.filter(e => e && e.curriculum);
  if (bumps.length) {
    out.activities = (Array.isArray(incoming.activities) ? incoming.activities : []).map(a => ({ ...a }));
    for (const row of bumps) {
      const act = out.activities.find(a => (row.activityId
        ? a.id === row.activityId
        : Array.isArray(a.chain) && a.chain.some(c => c && c.id === row.curriculum)));
      if (!act || !Array.isArray(act.chain)) continue;
      if (!act.chain.some(c => c && c.id === row.curriculum)) continue;
      act.chain = act.chain.map(c =>
        (c && c.id === row.curriculum
          ? (typeof row.session === 'number'
              ? markSessionDone({ ...c, skipped: [...(c.skipped || [])] }, row.session)
              : { ...c, done: (c.done || 0) + 1 })
          : c));
    }
  }
  return out;
}

// ── Weekly capacity: how many sessions this activity expects in a week ──
// `periods` is the day-precise time-away list — always an array (sanitizePlan
// guarantees it on both load paths); every caller in the app passes plan.periods.
export function weekCapacity(act, weekStart, periods, cycle) {
  const r = act.rhythm || {};
  let base = 0;
  if (r.kind === 'daily') base = 7;
  else if (r.kind === 'weekly') base = r.perWeek || 1;
  else if (r.kind === 'cycle') base = isOnWeek(cycle, weekStart) ? (r.perOnWeek ?? 1) : (r.perOffWeek ?? 2.5);
  if (!base) return 0;
  // Sessions per teaching day (default 1). Singapore Math is a tb-wb chain
  // where ONE lesson = TWO sessions (textbook + workbook) and the family does
  // both halves the same day, so its rhythm carries `sessionsPerDay: 2` —
  // without it the walk silently assumed textbook one day, workbook the next
  // and projected the finish ~4 months late (2026-08-30 user report). A
  // non-positive/non-finite value reads as 1, never 0 (a typo must not make a
  // subject unprojectable). Mirrored in aoife-school-bot/lib/compose.py.
  const perDay = Number(r.sessionsPerDay);
  const mult = Number.isFinite(perDay) && perDay > 0 ? perDay : 1;
  return base * mult * effectiveDaysInWeek(act, weekStart, periods) / 7;
}

// Walk weeks forward until remaining sessions are covered. null = can't project.
export function projectFinish(act, fromDate, plan, horizon = 300) {
  const remaining = actRemaining(act);
  if (actTotal(act) === 0) return null;              // unknown counts (waiting for books)
  if (remaining === 0) return { date: fromDate, weeks: 0, done: true };
  let acc = 0, w = mondayOf(fromDate);
  for (let i = 0; i < horizon; i++) {
    acc += weekCapacity(act, w, plan.periods, plan.parentCycle);
    if (acc >= remaining) return { date: addDays(w, 6), weeks: i + 1 };
    w = addDays(w, 7);
  }
  return null;
}

// Hard stop for every week-walk loop (~11.5 years). Belt-and-braces alongside
// sanitizePlan's ISO guards: an unsanitized/hand-built plan must never hang the UI.
export const WALK_CAP = 600;

// Minimum sessions per 2-week cycle to hit the goal (counting non-blocked weeks).
export function requiredPerCycle(act, fromDate, plan) {
  if (!act.goal?.finishBy) return null;
  const remaining = actRemaining(act);
  let usable = 0, w = mondayOf(fromDate), n = 0;
  while (w <= act.goal.finishBy) {
    if (n++ >= WALK_CAP) break;                      // behave as if the walk ended
    if (weekCapacity(act, w, plan.periods, plan.parentCycle) > 0) usable++;
    w = addDays(w, 7);
  }
  if (!usable) return null;
  return remaining / (usable / 2);
}

// ── Trip impact: finish dates before vs after a drafted period ──
// `draft` may carry the id of the period being edited, in which case it
// REPLACES that period instead of stacking on top of it. Never mutates `plan`.
export function tripImpact(plan, draft, fromDate = todayStr()) {
  const base = asPeriods(plan.periods);
  const raw = { ...draft };                          // a new trip has no id yet
  const d = cleanPeriod({ ...raw, id: raw.id || '__draft__',
    type: PERIOD_TYPES.includes(raw.type) ? raw.type : 'travel' });
  const after = d ? sortPeriods([...base.filter(p => p.id !== d.id), d]) : base;
  const fin = (act, periods) => projectFinish(act, fromDate, { ...plan, periods })?.date ?? null;
  return (Array.isArray(plan.activities) ? plan.activities : [])
    .filter(a => a.type === 'paced' && a.status === 'active' && actTotal(a) > 0)
    .map(a => ({ id: a.id, name: a.name || a.id, before: fin(a, base), after: fin(a, after) }));
}

// ── Cycle stats (7-on/7-off activities) ─────────────────────
export function cycleBounds(cycle, dateStr) {
  const k = Math.floor(weeksBetween(cycle.anchorMonday, dateStr) / 2);
  const start = addDays(cycle.anchorMonday, k * 14);
  return { start, end: addDays(start, 13) };
}

const countDone = (log, actId, from, to) =>
  log.filter(e => e.activityId === actId && e.status === 'done' && e.date >= from && e.date <= to).length;

export function cycleStats(act, dateStr, cycle, log) {
  const { start, end } = cycleBounds(cycle, dateStr);
  const r = act.rhythm || {};
  const targetMin = Number(r.perOnWeek ?? 1) + Math.floor(Number(r.perOffWeek ?? 2.5));
  const targetMax = Number(r.perOnWeek ?? 1) + Math.ceil(Number(r.perOffWeek ?? 2.5));
  const done = countDone(log, act.id, start, end);
  const prev = cycleBounds(cycle, addDays(start, -1));
  const prevDone = countDone(log, act.id, prev.start, prev.end);
  return {
    start, end, done, targetMin, targetMax,
    behind: dateStr >= end && done < targetMin,
    prevBehind: prevDone < targetMin && weeksBetween(cycle.anchorMonday, dateStr) >= 2,
  };
}

// ── Target-count stats (Jiu Jitsu) ──────────────────────────
export function targetStats(act, plan, log, dateStr) {
  const { start, end } = plan.year;
  let total = 0, elapsed = 0, w = mondayOf(start), n = 0;
  while (w <= end) {
    if (n++ >= WALK_CAP) break;                      // behave as if the walk ended
    if (awayDaysInWeek(plan.periods, w) <= 3) {      // a teaching week = 4+ plain school days
      total++;
      if (w <= dateStr) elapsed++;
    }
    w = addDays(w, 7);
  }
  const done = log.filter(e => e.activityId === act.id && e.status === 'done').length;
  const expected = total ? Math.floor((act.target || 0) * (elapsed / total)) : 0;
  return { done, target: act.target || 0, expected, behind: Math.max(0, expected - done) };
}

// ── "This week" helpers (the Today card) ────────────────────
// Teaching-week counter, 1-based from year.start. Same definition of a teaching
// week as targetStats: 4+ plain school days, i.e. awayDaysInWeek <= 3. A
// majority-away week is skipped and does NOT advance the count, so the number
// answers "how many real school weeks in", not "how many weeks on the calendar".
// null = the week of `dateStr` is itself majority-away, or sits before the year
// started (the card then omits the line rather than printing something false).
export function teachingWeekNumber(plan, dateStr) {
  const start = plan?.year?.start, end = plan?.year?.end;
  if (!isISO(start) || !isISO(dateStr)) return null;
  if (isISO(end) && dateStr > end) return null;   // past the school year: no number
  const target = mondayOf(dateStr);
  let w = mondayOf(start), n = 0, guard = 0;
  if (target < w) return null;
  while (w <= target) {
    if (guard++ >= WALK_CAP) return null;         // malformed year: no number at all
    const teaching = awayDaysInWeek(plan?.periods, w) <= 3;
    if (teaching) n++;
    if (w === target) return teaching ? n : null;
    w = addDays(w, 7);
  }
  return null;
}

// Consecutive-day run of `done` entries for one activity, ending at `today` —
// or at YESTERDAY when today isn't ticked yet, so a morning before the day's
// work never reads as a broken streak.
// An away day with no entry BRIDGES the run instead of ending it: on travel
// Singapore Math drops to every other day by design, and a rhythm the plan
// itself prescribes must not cost Aoife her streak. A plain (not-away) missed
// day ends it outright.
// The bridge is BOUNDED at MAX_BRIDGE consecutive missed away days — one
// every-other-day gap plus a day of slack. Unbounded, a 5-week Dhaka trip with
// nothing logged would still be advertising a streak earned before the flight,
// which is a lie the fire emoji makes worse. Any `done` day resets the count.
export const MAX_BRIDGE = 2;
export function dailyStreak(log, actId, periods, today) {
  const done = new Set();
  for (const e of Array.isArray(log) ? log : [])
    if (e && e.activityId === actId && e.status === 'done' && isISO(e.date)) done.add(e.date);
  if (!done.size || !isISO(today)) return 0;
  let d = today, n = 0, bridged = 0;
  for (let i = 0; i < WALK_CAP * 7; i++) {        // same belt-and-braces cap as the week walks
    if (done.has(d)) { n++; bridged = 0; }
    else if (dayAway(periods, d)) {
      if (bridged >= MAX_BRIDGE) break;           // the trip has swallowed the run
      bridged++;                                  // an away today spends bridge like any other
    }
    else if (d !== today) break;                  // a plain missed day ends the run
    // else: today itself, still unticked this morning — no cost, no credit
    d = addDays(d, -1);
  }
  return n;
}

// ── Core attendance: template sessions expected vs logged done ──
// The Year view's core rows answer "how much of this subject's regular week
// actually happened". Both halves are counted from primary data — the template
// and the log — never from a denormalized counter:
//   expected = the category's template events whose weekday falls on a day of
//              this week that is NOT away and NOT cancelled by a `skip`
//              override. A fully-away week therefore expects nothing, which is
//              what stops a trip from reading as a wall of missed sessions.
//   done     = log rows dated Mon..Sun with status 'done' whose eventId is one
//              of those template events. A dated one-off (`action:'add'`) logs
//              against its OWN id, so it can never inflate a template's count.
// `done` is deliberately NOT filtered by away day: work the family did anyway
// on a travel day is work, and the kinder failure mode is to credit it (same
// reasoning as dailyStreak's away-day bridge). The cost is that `done` can
// exceed `expected`, which the Year view reads as a full week — correct — and
// that a WHOLLY away week with sessions logged still shows expected 0. That
// last case is unreachable from the app (the Today view shows no timed blocks
// on an away day, so there is nothing to tap) and is accepted.
// `plan` is the whole blob rather than three arguments: periods, overrides and
// log are always read together here, and splitting them only invited a caller
// to forget one (an omitted `overrides` silently over-counts `expected`).
export function weekAttendance(events, plan, weekStart, cat) {
  // A null category must match NOTHING. `e.cat === cat` would otherwise let
  // `undefined === undefined` pair a category-less caller with the corrupt
  // {id:'e999'} record the live blob still carries — the same trap that made
  // today.js's statusOf tick unrelated blocks (see its `it.activityId != null`).
  if (cat == null) return { expected: 0, done: 0 };
  const evs = (Array.isArray(events) ? events : []).filter(e =>
    e && e.cat === cat && Number.isInteger(e.day) && e.day >= 0 && e.day <= 6);
  const overrides = Array.isArray(plan?.overrides) ? plan.overrides : [];
  const log = Array.isArray(plan?.log) ? plan.log : [];
  const ids = new Set(evs.map(e => e.id));
  let expected = 0;
  for (const e of evs) {
    const date = addDays(weekStart, e.day);
    if (dayAway(plan?.periods, date)) continue;
    if (overrides.some(o => o && o.action === 'skip' && o.date === date && o.eventId === e.id)) continue;
    expected++;
  }
  const end = addDays(weekStart, 6);
  const done = log.filter(x => x && x.status === 'done' && x.eventId != null &&
    ids.has(x.eventId) && x.date >= weekStart && x.date <= end).length;
  return { expected, done };
}

// ── Clash detection over template events ────────────────────
export const findClashes = (events, slot) =>
  events.filter(e => e.day === slot.day && e.start < slot.end && e.end > slot.start);

export function freeSlots(events, day, dur, count = 3) {
  const out = [];
  for (let s = 9; s <= 17 - dur && out.length < count; s += 0.5)
    if (!findClashes(events, { day, start: s, end: s + dur }).length) out.push(s);
  return out;
}

export const doneOn = (log, actId, dateStr) =>
  log.some(e => e.activityId === actId && e.date === dateStr && e.status === 'done');
