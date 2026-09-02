// Today view: date header, away-day banner, timed blocks for the real date
// (template + planner slots + overrides), one-tap statuses, daily no-slot
// checklist, tomorrow strip.
import { DAYS, fmt, esc } from '../model.js';
import { store, catLabel, evLabel } from '../state.js';
import {
  todayStr, addDays, dayIdx, isWorkDay, dayStatus, dayAway, daysBetween, nextSession,
  currentCur, cycleStats, doneOn, actTotal, teachingWeekNumber, dailyStreak,
  weekCapacity, sessionLabel,
} from './model.js';
import { plan, togglePaced, logTimed } from './state.js';
import { syncedAt } from '../sync.js';
import { buildTimed, statusOfTimed, dailyVisible } from './mday.js';

const ST = [['done', '✓ Done'], ['partial', '◐ Didn’t finish'], ['missed', '✗ Missed']];
const AWAY_ICON = { travel: '✈', off: '⏸' };

// The icon is drawn from the period's TYPE, so strip any the family typed
// into the label themselves ("Dhaka ✈" renders as "✈ Dhaka", not doubled)
// — mirrors year.js's perName.
const awayLabel = st => {
  const l = String(st.label || '').replace(/[✈⏸]/g, '').trim();
  return l || (st.type === 'off' ? 'Off' : 'Time away');
};

// "in 5 days" under two weeks out, "in 3 wks" beyond. Pure so it's testable
// without a DOM.
export function fmtUntil(days) {
  if (days < 14) return `in ${days} day${days === 1 ? '' : 's'}`;
  const wks = Math.round(days / 7);
  return `in ${wks} wk${wks === 1 ? '' : 's'}`;
}

// ── Freshness caption ────────────────────────────────────────
// "· synced 3:42pm" under the date. The bot writes this plan from outside the
// browser, so a tab that has not re-read in an hour is showing yesterday's
// truth — the caption makes that visible at a glance instead of silently wrong.
// It reports the OLDER of the two blobs' last rounds (syncedAt), because this
// page renders both: a fresh planner half over an hour-old template is still an
// hour-old page. Empty until BOTH have been heard from — an offline tab, or one
// whose template sync is held by an open form, claims nothing at all. Reuses
// the app's own fmt() so the time reads like every other time on the page.
export function syncedCaption(at) {
  if (!at) return '';
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `· synced ${fmt(d.getHours() + d.getMinutes() / 60)}`;
}

// A sync round that changes nothing still refreshes the caption — that IS the
// news ("the tab is current"). Patching the one node avoids re-rendering the
// whole view every 120s just to move a clock.
export function paintSynced() {
  const el = document.getElementById('psync');
  if (el) el.textContent = syncedCaption(syncedAt());    // textContent: never HTML
}

// dailyVisible/timedFor/statusOf are the ONE-engine refactor (js/plan/mday.js,
// the /m PWA + Scriptable widget's pure model): mday.js owns the canonical
// implementation now, and this view is a thin wrapper around it so the
// desktop Today view and the phone app can never silently disagree about
// what "today" looks like. Behaviour is byte-identical to the pre-refactor
// code (tests/plan-today.test.mjs, unchanged, still pins it) — `dailyVisible`
// is re-exported here since that test (and possibly others) import it
// straight from today.js.
export { dailyVisible };

// nameForEvent (mday.js's buildTimed takes a resolver) reproduces the
// original `evLabel(ev) || catLabel(ev.cat)` exactly — evLabel already falls
// back to catLabel internally, so this is just evLabel with the same
// catLabels-aware renames the rest of the app honors.
const timedFor = dateStr => buildTimed(dateStr, store.events, plan.data, evLabel);

const statusOf = (dateStr, it) => statusOfTimed(plan.data, dateStr, it);

function chips(dateStr) {
  const p = plan.data;
  const c = [];
  if (p.activities.some(a => a.status === 'active' && a.rhythm?.kind === 'cycle'))
    c.push(`<span class="pchip">${isWorkDay(p.parentCycle, dateStr) ? 'Mama: work day' : 'Mama: home day'}</span>`);
  // periods are kept sorted by start, so the first future one is the nearest.
  // Skip any whose own start day resolves to a DIFFERENT period (dayAway lets
  // `off` outrank `travel`): a shadowed period never renders as itself on the
  // Today/Year pages, so advertising it here would name a trip that never arrives.
  const next = p.periods.find(pd =>
    pd.start > dateStr && dayAway(p.periods, pd.start)?.id === pd.id);
  if (next) c.push(`<span class="pchip">${AWAY_ICON[next.type] || '✈'} ${esc(awayLabel(next))} ${
    fmtUntil(daysBetween(dateStr, next.start))}</span>`);
  return c.join('');
}

// ── "This week" card ────────────────────────────────────────
// The weekly view of the same data the rest of the page shows day by day:
// which teaching week this is, where each cycle activity stands against its
// 2-week target, and any daily streak worth protecting. Deliberately NOT
// suppressed on away days — a streak matters most while travelling, which is
// exactly what dailyStreak's away-day bridging is for.
const MIN_STREAK = 3;              // below this a "streak" is just two good days
const LAST_DAYS = 3;               // warn only inside the cycle's last 3 days

// The chip is measured against what the cycle could ACTUALLY hold, not the
// nominal target: a fortnight spent on a trip or an off block has less room,
// and a cycle with no room at all reads "paused" and can never say "behind" —
// the plan itself cancelled that work, so scolding the family for it is a bug.
// Above zero the target scales with the surviving capacity; done >= it is "on
// pace", otherwise stay neutral until the cycle is nearly over, because being
// 1 of 3 on day two says nothing yet.
function paceChip(act, cs, dateStr) {
  const p = plan.data;
  const cap = ps => weekCapacity(act, cs.start, ps, p.parentCycle)
                  + weekCapacity(act, addDays(cs.start, 7), ps, p.parentCycle);
  const cycleCap = cap(p.periods), fullCap = cap([]);
  if (cycleCap <= 0) return `<span class="pchip">paused</span>`;
  const target = fullCap > 0
    ? Math.max(1, Math.round(cs.targetMin * cycleCap / fullCap)) : cs.targetMin;
  if (cs.done >= target) return `<span class="pchip ok">on pace</span>`;
  return dateStr >= addDays(cs.end, -(LAST_DAYS - 1)) ? `<span class="pchip warn">behind</span>` : '';
}

// ── "Yesterday" receipt ─────────────────────────────────────
// A short read-only recap of what actually got logged the day before, so a
// missed status is visible without digging into Year/Subjects. Reuses the
// name-resolution the timed blocks already do (timedFor) rather than a
// second lookup table, so a renamed activity or event shows its CURRENT
// name, matching everywhere else on this page.
// Returns {name, idx} or null to skip the entry silently. `idx` is the
// entry's position in timedItems (today's start-time-sorted schedule), so
// the receipt can render chronologically; entries that never lived in that
// schedule (dailies, or an event/activity moved/deleted since) get the
// sentinel `timedItems.length`, sorting after every real slot.
function receiptEntry(e, timedItems) {
  const last = timedItems.length;
  if (e.eventId) {
    const idx = timedItems.findIndex(it => it.eventId === e.eventId);
    if (idx >= 0) return { name: timedItems[idx].name, idx };
    const ev = store.events.find(x => x.id === e.eventId);
    return ev ? { name: evLabel(ev), idx: last } : null;   // deleted entirely -> skip silently
  }
  if (e.activityId) {                       // covers both timed onGrid slots and daily/paced checks
    const idx = timedItems.findIndex(it => it.activityId === e.activityId);
    if (idx >= 0) return { name: timedItems[idx].name, idx };
    const a = plan.data.activities.find(x => x.id === e.activityId);
    return a ? { name: a.name || catLabel(a.cat), idx: last } : null;
  }
  return null;
}

export function yesterdayHtml(dateStr) {
  const p = plan.data;
  const status = dayStatus(p.periods, dateStr);
  if (status.away)
    return `<div class="tmwrow">Yesterday: ${AWAY_ICON[status.type] || '✈'} ${esc(awayLabel(status))}</div>`;
  const timedItems = timedFor(dateStr);
  const dayLog = p.log.filter(x => x.date === dateStr);
  // A ✓ on a paced on-grid class writes an attendance row AND a lesson row for
  // the same day (2026-09-01) — fold them into one line (red-team H3): drop
  // the attendance half when its lesson sibling is present, then dedupe by
  // owner so a tb-wb day's two session rows also read once.
  const hasLesson = actId => dayLog.some(x =>
    x.activityId === actId && !x.timed && !x.eventId && x.curriculum);
  const seen = new Set();
  const entries = [];
  for (const e of dayLog) {
    if (e.timed && e.activityId && !e.eventId && hasLesson(e.activityId)) continue;
    const key = e.eventId ?? `${e.activityId}|${e.timed ? 't' : 'l'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = receiptEntry(e, timedItems);
    if (!r) continue;
    const icon = e.status === 'done' ? '✓' : e.status === 'partial' ? '◐' : '✗';
    entries.push({ idx: r.idx, html: `${icon} ${esc(r.name)}` });
  }
  if (!entries.length) return '';           // nothing logged and not away -> no empty line
  entries.sort((a, b) => a.idx - b.idx);    // schedule order; unknowns/dailies last, stable
  return `<div class="tmwrow">Yesterday: ${entries.map(x => x.html).join(' · ')}</div>`;
}

export function thisWeekHtml(dateStr) {
  const p = plan.data;
  const lines = [];
  const tw = teachingWeekNumber(p, dateStr);
  if (tw != null) lines.push(`<div class="twk">Teaching week ${tw}</div>`);

  for (const a of p.activities.filter(a => a.status === 'active' && a.rhythm?.kind === 'cycle')) {
    const cs = cycleStats(a, dateStr, p.parentCycle, p.log);
    const target = `${cs.targetMin}${cs.targetMax > cs.targetMin ? `–${cs.targetMax}` : ''}`;
    lines.push(`<div class="twline"><span><b>${esc(a.name || a.id)}</b> — ${cs.done} of ${
      target} this cycle</span>${paceChip(a, cs, dateStr)}</div>`);
  }

  for (const a of p.activities.filter(a => a.status === 'active' && a.rhythm?.kind === 'daily')) {
    const n = dailyStreak(p.log, a.id, p.periods, dateStr);
    if (n >= MIN_STREAK)
      lines.push(`<div class="twline"><span><b>${esc(a.name || a.id)}</b> — 🔥 ${n}-day streak</span></div>`);
  }

  if (!lines.length) return '';    // nothing to say -> no empty card
  return `<div class="psec">This week</div><div class="pcard">${lines.join('')}</div>`;
}

// A paced daily row's label used to be next-session based even AFTER the
// family ticked it — checking LoE flipped "Lesson 102" straight to "Lesson
// 103", as if she'd already done tomorrow's lesson too. When TODAY carries a
// `done` log row for this activity (the exact row togglePaced writes/finds),
// the row shows the label of the session that WAS completed instead: the
// row's own `label` field when present (the migration stamps pre-tracking
// rows with one so history is never mislabeled), else sessionLabel() replayed
// against the chain + session index the row recorded. A row missing both
// falls back to the ordinary next-session label — same as no row at all.
// Un-ticking removes the row, so the next render naturally reverts.
//
// A CATCH-UP day (the bot logging several sessions in one go) can write
// MULTIPLE done rows for the same activity/date — sessions 0, 1, 2 appended
// in whatever order the taps landed, which is not a promise about which is
// "current". Picking the first array match (the old bug here) could show a
// stale mid-catch-up label. The row with the HIGHEST numeric `session` is
// the one actually completed last today; a row with no session at all
// always loses to one that has one (nothing to compare), and a tie (incl.
// "neither has a session") keeps the LAST one in array order, so a same-day
// re-tick still wins by recency.
function latestTodayRow(rows) {
  let row = null;
  for (const e of rows) {
    const es = typeof e.session === 'number' ? e.session : -Infinity;
    const rs = row && typeof row.session === 'number' ? row.session : -Infinity;
    if (!row || es >= rs) row = e;
  }
  return row;
}

export function pacedRowLabel(a, log, today) {
  const rows = (Array.isArray(log) ? log : []).filter(e =>
    e && e.activityId === a.id && e.date === today && e.status === 'done' && !e.eventId);
  const row = latestTodayRow(rows);
  if (row) {
    if (row.label) return { label: row.label, cur: null };
    if (row.curriculum != null && row.session != null) {
      const cur = (a.chain || []).find(c => c && c.id === row.curriculum);
      if (cur) return { label: sessionLabel(cur, row.session), cur };
    }
  }
  const cur = currentCur(a);
  const ns = cur ? nextSession(cur) : null;
  return ns ? { label: ns.label, cur } : { label: null, cur: null };
}

export function renderToday() {
  const el = document.getElementById('view-today');
  if (!el || !plan.data) return;
  const today = todayStr();
  const d = new Date();
  const status = dayStatus(plan.data.periods, today);

  let h = `<div class="pcard"><div class="phead">${DAYS[dayIdx(today)]}, ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div><div class="pmeta">${chips(today)}<span id="psync" class="psync">${syncedCaption(syncedAt())}</span></div></div>`;
  // On an away day the banner IS the headline for the day, so the weekly
  // summary falls in behind it; on a normal day it sits right under the date.
  const week = thisWeekHtml(today);
  let items = [];
  if (status.away) {
    h += `<div class="pcard abanner"><div class="phead">${AWAY_ICON[status.type] || '✈'} ${
      esc(awayLabel(status))} · day ${status.dayN} of ${status.total}</div></div>${week}`;
  } else {
    h += week;
    items = timedFor(today);
    for (const it of items) {
      const st = statusOf(today, it);
      h += `<div class="tblock ${it.cls}${st ? ' st-' + st : ''}" data-key="${esc(it.key)}">
        <div class="trow"><span class="tnm">${esc(it.name)}</span><span class="ttm">${fmt(it.start)}–${fmt(it.end)}</span></div>
        ${it.note ? `<div class="tnote">${esc(it.note)}</div>` : ''}
        <div class="tbtns">${ST.map(([k, lbl]) =>
          `<button type="button" class="tbtn${st === k ? ' sel' : ''}" data-st="${k}">${lbl}</button>`).join('')}</div>
      </div>`;
    }
    if (!items.length) h += `<div class="pcard pmeta">No scheduled blocks today.</div>`;
  }

  const dailies = plan.data.activities.filter(a =>
    a.status === 'active' && a.type === 'paced' && !a.onGrid && dailyVisible(a, status));
  if (dailies.length) {
    h += `<div class="psec">Daily · no time slot</div>`;
    for (const a of dailies) {
      const done = doneOn(plan.data.log, a.id, today);
      const { label, cur } = pacedRowLabel(a, plan.data.log, today);
      let sub = '';
      if (a.rhythm?.kind === 'cycle') {
        const cs = cycleStats(a, today, plan.data.parentCycle, plan.data.log);
        sub = `this cycle: ${cs.done} of ${cs.targetMin}–${cs.targetMax}${cs.prevBehind ? ' · last cycle short' : ''}`;
      } else if (a.rhythm?.kind === 'daily') sub = actTotal(a) === 0 ? esc(a.note || '') : 'every day';
      h += `<div class="drow${done ? ' ck' : ''}" data-act="${esc(a.id)}">
        <span class="dbx">${done ? '✓' : ''}</span>
        <span class="dtx">${esc(a.name)}${label ? ` — ${esc(cur?.name ? cur.name + ' · ' : '')}${esc(label)}` : ''}
        ${sub ? `<small>${sub}</small>` : ''}</span></div>`;
    }
  }

  const tomorrow = addDays(today, 1);
  const tst = dayStatus(plan.data.periods, tomorrow);
  if (tst.away) {
    h += `<div class="tmwrow">Tomorrow: ${AWAY_ICON[tst.type] || '✈'} ${esc(awayLabel(tst))}</div>`;
  } else {
    const tmw = timedFor(tomorrow);
    if (tmw.length) h += `<div class="tmwrow">Tomorrow: ${tmw.map(t => `${esc(t.name)} ${fmt(t.start)}`).join(' · ')}</div>`;
  }
  h += yesterdayHtml(addDays(today, -1));

  el.innerHTML = h;
  el.querySelectorAll('.tbtn').forEach(b => b.addEventListener('click', e => {
    const block = e.target.closest('.tblock');
    const key = block.dataset.key;
    const it = items.find(x => x.key === key);
    logTimed(it.eventId || null, it.activityId || null, b.dataset.st);
  }));
  el.querySelectorAll('.drow').forEach(r =>
    r.addEventListener('click', () => togglePaced(r.dataset.act)));
}
