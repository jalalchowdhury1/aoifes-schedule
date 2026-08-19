// Year view (v2): VIEW-ONLY tracks + a day-precise time-away list.
// A tap on the grid never mutates anything — it opens an info card. Every
// change goes through the add/edit sheet, which previews its own impact live.
// NO browser dialogs anywhere (prompt/alert/confirm): this runs on the family's
// phones, where a native dialog is easy to mis-tap and impossible to style.
// Deleting is a two-tap button; validation errors render inline as .form-err.
import { esc } from '../model.js';
import { store, catLabel } from '../state.js';
import {
  todayStr, addDays, mondayOf, weeksBetween, daysBetween, dayStatus,
  weekCapacity, actTotal, actDone, projectFinish, tripImpact, isWorkDay,
  weekAttendance, okCls, WALK_CAP,
} from './model.js';
import { plan, addPeriod, updatePeriod, deletePeriod } from './state.js';

// ── Date formatting (view-only, deliberately locale-free) ───
// Intl's 'short' month renders "Sept" on CLDR 42+, which breaks the 3-letter
// axis, so the month names are a constant instead of toLocaleDateString.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const D = s => new Date(s + 'T12:00');            // noon: DST can never shift the date
const fmtDay = s => { const d = D(s); return `${MON[d.getMonth()]} ${d.getDate()}`; };
// "Jan 4 – 10" inside one month, "Jan 4 – Feb 6" across months (and across
// years, where the month has to be repeated too). Exported for tests only.
export const fmtRange = (a, b) => {
  const x = D(a), y = D(b);
  const same = x.getMonth() === y.getMonth() && x.getFullYear() === y.getFullYear();
  return `${fmtDay(a)} – ${same ? y.getDate() : fmtDay(b)}`;
};
const ICON = { travel: '✈', off: '⏸' };
// The icon is drawn from the period's TYPE, so strip any the family typed into
// the label themselves ("Dhaka ✈" renders as "✈ Dhaka", not "✈ Dhaka ✈").
export const perName = p => {
  const l = String(p.label || '').replace(/[✈⏸]/g, '').trim();
  return l || (p.type === 'off' ? 'Off' : 'Time away');
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ── View-local UI state (survives re-render; never persisted) ──
let openWeek = null;      // Monday of the week whose info card is showing
let sheet = null;         // {mode:'add'|'edit', id, start, end, type, label, err}
let delArmed = false;     // two-tap delete: armed by the first tap
let justOpened = false;   // one render only: scroll the sheet in + focus it

const periodsOf = () => plan.data.periods || [];
const findPeriod = id => periodsOf().find(p => p.id === id) || null;

function yearWeeks() {
  const { start, end } = plan.data.year;
  const out = [];
  let w = mondayOf(start);
  // Same rationale as model.js's walks: never let a malformed `end` hang the UI.
  while (w <= end && out.length < WALK_CAP) { out.push(w); w = addDays(w, 7); }
  return out;
}

// Away days in one week, split by type, plus the distinct periods involved.
// (model's awayDaysInWeek returns the same total; the tracks also need the
// travel/off split to pick a hatch, so one dayStatus pass produces both.)
export function weekAway(periods, weekStart) {
  const seen = new Map();
  let travel = 0, off = 0;
  for (let i = 0; i < 7; i++) {
    const s = dayStatus(periods, addDays(weekStart, i));
    if (!s.away) continue;
    if (s.type === 'off') off++; else travel++;
    if (!seen.has(s.id)) seen.set(s.id, { id: s.id, type: s.type, label: s.label });
  }
  return { travel, off, total: travel + off, list: [...seen.values()] };
}

// 7 away days -> full hatch, 1-6 -> half-height hatch; `off` hatches darker.
// A week overlapped by both types takes whichever covers more days (travel wins ties).
export const awayCls = aw =>
  !aw.total ? '' : (aw.off > aw.travel ? 'offw' : 'trip') + (aw.total === 7 ? '' : '-part');

// ── Tracks ──────────────────────────────────────────────────
// Away hatching and the selection outline are identical on every row, whatever
// drew the cell underneath them, so both kinds of track finish a cell here.
function cellHtml(cls, aw, w) {
  const ac = awayCls(aw);
  if (ac) cls.push(ac);
  if (w === openWeek) cls.push('sel');
  return `<i class="${cls.join(' ')}" data-w="${w}"></i>`;
}

const trackShell = (cls, name, sub, cells) =>
  `<div class="track ${cls ? okCls(cls) : ''}"><div class="tl"><b>${esc(name)}</b><small>${esc(sub)}</small></div>
    <div class="tgrid" style="--n:${cells.length}">${cells.join('')}</div></div>`;

function trackFor(a, wks, away, today) {
  const p = plan.data;
  const total = actTotal(a);
  const paced = a.type === 'paced' && a.status === 'active' && total > 0;
  let remainingDone = actDone(a);
  const mon = mondayOf(today);
  const cells = wks.map((w, i) => {
    const cls = [];
    if (paced) {
      const cap = weekCapacity(a, w, p.periods, p.parentCycle);
      if (w <= mon && remainingDone > 0) { cls.push('fill'); remainingDone -= cap; }
      else if (cap > 0) cls.push('plan');
    } else if (a.status === 'active' && away[i].total < 7) {
      cls.push(w <= mon ? 'fill' : 'plan');
    }
    return cellHtml(cls, away[i], w);
  });
  const fin = paced ? projectFinish(a, today, p) : null;
  const sub = fin ? (fin.done ? 'finished 🎉' : `→ ${fmtDay(fin.date)}`)
    : a.type === 'paced' && total === 0 ? 'counts pending' : '';
  return trackShell(a.cls, a.name || a.id, sub, cells);
}

// ── Core attendance rows (replaces the old synthetic "Core" row) ──
// One row per core subject instead of one lump: "Core — ELA·Math·Arabic·Quran"
// filled solid for every past week whatever actually happened, which made it
// decoration. These cells are counted from the template and the log.
//
// The rows are DERIVED, never listed: every ACTIVE `ongoing` activity whose
// category actually appears in the weekly template. That is why Art and Mama
// Classes stay off this page — they have no recurring blocks to attend — and
// why putting a new category on the grid is enough to grow a row here, with no
// code change and no second list to keep in sync.
export function coreRows(activities, events) {
  const cats = new Set((Array.isArray(events) ? events : [])
    .filter(e => e && e.cat != null).map(e => e.cat));
  return (Array.isArray(activities) ? activities : []).filter(a =>
    a && a.type === 'ongoing' && a.status === 'active' && a.cat != null && cats.has(a.cat));
}

// The same title rule as everywhere else (Subjects cards, the grid, the calendar
// sync): the activity's own name, else the legend's label for its category. A
// rename in the legend therefore reaches this page too.
const coreName = a => a.name || catLabel(a.cat);

function coreTrack(a, wks, away, today) {
  const p = plan.data, mon = mondayOf(today);
  const cells = wks.map((w, i) => {
    const { expected, done } = weekAttendance(store.events, p, w, a.cat);
    const cls = [];
    // A week that expects nothing — the whole week away, or the subject not on
    // the grid at all — claims no colour, only its hatch. Anything else is at
    // least planned; a week that has begun then shows how much of it landed.
    if (expected > 0) {
      if (w > mon || done === 0) cls.push('plan');
      else if (done >= expected) cls.push('fill');
      else cls.push('plan', 'att-part');
    }
    return cellHtml(cls, away[i], w);
  });
  return trackShell(a.cls, coreName(a), '', cells);
}

// ── Tap layer ───────────────────────────────────────────────
// The track cells are 14px tall — far too small a target for a finger, and
// ~350 of them meant ~350 click listeners per render. One transparent column
// per week, full height across every track, sits on top instead: fat targets,
// ONE delegated listener (see wire()), and the selected column doubles as the
// highlight band. It repeats the .tgrid metrics exactly (repeat(n, 1fr) with a
// 1px gap), so a column and the cells under it line up to the pixel.
// Keyboard: exposing 55 tab stops would be hostile, so exactly ONE column is
// reachable — this week's, or the first if the year hasn't started — as a
// role=button with Enter/Space (wire()). From there the arrow keys walk the
// year and Escape closes, so the whole layer is operable without a pointer.
function hitHtml(wks) {
  const mon = mondayOf(todayStr());
  const kb = wks.includes(mon) ? mon : wks[0];
  return `<div class="yhit" style="--n:${wks.length}">${wks.map(w => {
    const cls = w === openWeek ? ' class="yband"' : '';
    const key = w === kb ? ' role="button" tabindex="0" aria-label="Select week"' : '';
    return `<i data-w="${esc(w)}"${cls}${key}></i>`;
  }).join('')}</div>`;
}

// Month labels under the tracks, each spanning its own weeks so they line up.
export function monthGroups(wks) {
  const groups = [];
  for (const w of wks) {
    const m = D(w).getMonth();
    const last = groups[groups.length - 1];
    if (last && last.m === m) last.n++;
    else groups.push({ m, n: 1 });
  }
  return groups;
}

// A month that owns fewer than MIN_LABEL_SPAN week-columns — the part-months at
// either end of the school year — keeps its column span (the axis has to stay
// aligned with the tracks) but drops its LABEL: on a phone the year's first
// partial Aug and the full Sep next to it overprint each other otherwise.
// 4, not 3: at 390px a column is ~5px, so a 3-column month gets ~15px for a
// 3-letter label at 9px type — still clipped, still colliding with its neighbour.
export const MIN_LABEL_SPAN = 4;
export function axisHtml(wks) {
  return `<div class="yaxis" style="--n:${wks.length}">${monthGroups(wks)
    .map(g => `<span style="grid-column:span ${g.n}">${g.n < MIN_LABEL_SPAN ? '' : MON[g.m]}</span>`)
    .join('')}</div>`;
}

const legendHtml = () =>
  `<div class="yleg"><span><i class="yl fill"></i>done</span><span><i class="yl att-part"></i>some done</span>
    <span><i class="yl plan"></i>planned</span>
    <span><i class="yl trip"></i>travel</span><span><i class="yl offw"></i>off</span></div>`;

// "Ruhama — ELA/Math" -> "Ruhama". Three subjects share one line on a 390px
// phone, where the full legend names do not fit; the part before the em dash is
// what the family calls each of them anyway. A name without one is kept whole.
export const shortName = n => String(n).split('—')[0].trim() || String(n).trim();

// The card's attendance line: "Quran 1/3 · Ruhama 2/5 · Miss Hala 1/3", the
// numbers behind the coloured cells directly above it. Only for a week that has
// already begun — "Quran 0/3" for a week that has not happened yet would read
// as three missed sessions. Subjects with nothing scheduled that week are
// dropped rather than printed as 0/0.
export function weekAttHtml(weekStart, today) {
  if (!plan.data || weekStart > mondayOf(today)) return '';
  const p = plan.data;
  const parts = coreRows(p.activities, store.events).map(a => {
    const { expected, done } = weekAttendance(store.events, p, weekStart, a.cat);
    return expected ? `${esc(shortName(coreName(a)))} ${done}/${expected}` : '';
  }).filter(Boolean);
  return parts.length ? `<div class="pmeta">${parts.join(' · ')}</div>` : '';
}

// ── Week info card (read-only; the only way it changes data is by
//    opening the sheet, which the family still has to confirm with Save) ──
function cardHtml(wks, away) {
  if (openWeek == null) return '';
  const i = wks.indexOf(openWeek);
  if (i < 0) return '';
  const aw = away[i];
  // ‹ › nudge the selection one week either way — tap roughly with a thumb,
  // then adjust exactly. Disabled at the ends of the year so they never lie.
  let h = `<div class="pcard ycard"><div class="trow"><span class="tnm">Week of ${esc(fmtRange(openWeek, addDays(openWeek, 6)))}</span>
    <span class="ynav">
      <button type="button" class="ystep" data-ystep="-1" aria-label="Previous week"${i === 0 ? ' disabled' : ''}>‹</button>
      <button type="button" class="ystep" data-ystep="1" aria-label="Next week"${i === wks.length - 1 ? ' disabled' : ''}>›</button>
      <button type="button" class="ycls" id="ycard-x" aria-label="Close">✕</button></span></div>`;
  if (!aw.total) {
    h += `<div class="pmeta">School all week</div>${weekAttHtml(openWeek, todayStr())}
      <div class="sctl"><button type="button" data-yadd="${openWeek}">+ Time away this week</button></div>`;
  } else {
    const names = aw.list.map(x => `${ICON[x.type]} ${esc(perName(x))}`).join(' · ');
    h += `<div class="pmeta">${plural(aw.total, 'away day')} · ${names}</div>${weekAttHtml(openWeek, todayStr())}
      <div class="sctl">${aw.list.map(x => `<button type="button" data-yedit="${esc(x.id)}">${
        aw.list.length > 1 ? `Edit ${ICON[x.type]} ${esc(perName(x))}` : 'Edit trip'}</button>`).join('')}</div>`;
  }
  return `${h}</div>`;
}

// ── Time-away list ──────────────────────────────────────────
function listHtml() {
  const ps = periodsOf();
  let h = `<div class="psec">Time away</div><div class="pcard yaway">`;
  if (!ps.length) h += `<div class="pmeta">No time away planned yet.</div>`;
  for (const p of ps) {
    const days = daysBetween(p.start, p.end) + 1;
    h += `<div class="yrow" data-yedit="${esc(p.id)}" role="button" tabindex="0">
      <span class="yrow-t">${ICON[p.type]} ${esc(perName(p))}</span>
      <span class="yrow-d">${esc(fmtRange(p.start, p.end))} · ${plural(days, 'day')}</span></div>`;
  }
  return `${h}<button type="button" id="yadd" class="ybtn-add">+ Add time away</button></div>`;
}

// ── Sheet: live impact preview ──────────────────────────────
function impactHtml() {
  if (!sheet) return '';
  const { start, end, type, mode, id } = sheet;
  if (!start || !end || end < start)
    return `<div class="pmeta">Pick both dates to see what this moves.</div>`;
  const rows = tripImpact(plan.data, { ...(mode === 'edit' ? { id } : {}), start, end, type }, todayStr());
  if (!rows.length) return `<div class="pmeta">Nothing paced is running yet — no dates move.</div>`;
  return rows.map(r => {
    const a = plan.data.activities.find(x => x.id === r.id);
    let line = `<div class="yimp"><b>${esc(r.name)}</b> → ${r.after ? esc(fmtDay(r.after)) : 'not in this year'}`;
    if (r.after && r.before)
      line += r.after === r.before ? ` <small>(unchanged)</small>` : ` <small>(was ${esc(fmtDay(r.before))})</small>`;
    const goal = a && a.goal ? a.goal.finishBy : null;
    if (goal && r.after) {
      const wks = Math.round((D(goal) - D(r.after)) / 604800000);
      line += wks >= 0 ? ` <span class="pchip ok">${plural(wks, 'wk')} before goal ✓</span>`
                       : ` <span class="pchip warn">${plural(-wks, 'wk')} past goal</span>`;
    }
    return `${line}</div>`;
  }).join('');
}

// ── Overlap notice (advisory, never blocking) ───────────────
// Two periods may legitimately overlap (a work trip inside a longer break), so
// Save stays enabled. What the family CAN'T see from two date ranges is which
// one wins on the shared days, so name it: dayAway() resolves `off` over
// `travel`, and the notice says exactly that.
function draftOverlaps() {
  if (!sheet || !sheet.start || !sheet.end || sheet.end < sheet.start) return [];
  return periodsOf().filter(p =>
    p.id !== sheet.id && p.start <= sheet.end && sheet.start <= p.end);
}

function warnHtml() {
  const hits = draftOverlaps();
  if (!hits.length) return '';
  const names = hits.map(p =>
    `${ICON[p.type]} ${esc(perName(p))} (${esc(fmtRange(p.start, p.end))})`).join(', ');
  return `Overlaps ${names} — Off days win over Travel days.`;
}

function sheetHtml() {
  if (!sheet) return '';
  const edit = sheet.mode === 'edit';
  const title = edit ? 'Edit time away' : 'Add time away';
  const warn = warnHtml();
  return `<div class="ysh-bd" id="ysh-bd"></div>
  <div class="ysh" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="ysh-h">${title}</div>
    <div class="ysh-dates">
      <div><label for="ysh-start">From</label><input type="date" id="ysh-start" value="${esc(sheet.start)}"></div>
      <div><label for="ysh-end">To</label><input type="date" id="ysh-end" value="${esc(sheet.end)}"></div>
    </div>
    <div class="ysh-row"><label for="ysh-label">Label</label>
      <input type="text" id="ysh-label" placeholder="Dhaka ✈" value="${esc(sheet.label)}"></div>
    <div class="ysh-row"><label>Type</label>
      <div class="ysh-radios">
        <label class="ysh-rad"><input type="radio" name="ysh-type" id="ysh-t-travel" value="travel"${sheet.type === 'off' ? '' : ' checked'}> Travel</label>
        <label class="ysh-rad"><input type="radio" name="ysh-type" id="ysh-t-off" value="off"${sheet.type === 'off' ? ' checked' : ''}> Off</label>
      </div>
      <div class="ysh-help">Travel = Singapore Math keeps going every other day · Off = everything pauses</div>
    </div>
    <div class="form-err${sheet.err ? ' show' : ''}" id="ysh-err">${esc(sheet.err || '')}</div>
    <div class="form-err warn${warn ? ' show' : ''}" id="ysh-warn">${warn}</div>
    <div class="psec">What this moves</div>
    <div class="ysh-imp" id="ysh-imp">${impactHtml()}</div>
    <div class="ysh-btns">
      ${edit ? `<button type="button" class="danger-btn" id="ysh-del">Delete</button>` : ''}
      <button type="button" id="ysh-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="ysh-save">Save</button>
    </div>
  </div>`;
}

// ── Footer: the parent cycle, stated once, with no controls ──
// A work stretch runs Tue -> Mon; its first day is the one where isWorkDay
// flips false -> true. Scan a fortnight forward and stop at the first.
export function nextWorkStart(cycle, from) {
  for (let i = 0; i < 15; i++) {
    const d = addDays(from, i);
    if (isWorkDay(cycle, d) && !isWorkDay(cycle, addDays(d, -1))) return d;
  }
  return null;
}

// ── Open/close helpers ──────────────────────────────────────
function openAdd(weekStart) {
  const t = todayStr();
  sheet = { mode: 'add', id: null, start: weekStart || t,
            end: weekStart ? addDays(weekStart, 6) : t, type: 'travel', label: '', err: '' };
  delArmed = false; justOpened = true;
  renderYear();
}

function openEdit(id) {
  const p = findPeriod(id);
  if (!p) return;
  sheet = { mode: 'edit', id, start: p.start, end: p.end, type: p.type, label: p.label || '', err: '' };
  delArmed = false; justOpened = true;
  renderYear();
}

function closeSheet() { sheet = null; delArmed = false; renderYear(); }

// One week back/forward from the open card (‹ ›, ArrowLeft/ArrowRight).
// Clamped: stepping past either end of the year is a no-op, not a wrap.
function stepWeek(delta) {
  const wks = yearWeeks();
  const i = wks.indexOf(openWeek);
  if (i < 0) return;
  const j = Math.max(0, Math.min(wks.length - 1, i + delta));
  if (j === i) return;
  openWeek = wks[j];
  renderYear();
}

// ── Document-level dismissal (bound only while something is open) ──
// Both handlers are stable references, so addEventListener is idempotent —
// calling this on every render neither stacks nor leaks listeners.
function onDocTap(e) {
  // A tap anywhere that is not a week cell and not inside the info card
  // dismisses the card. The sheet is exempt outright: it renders ON TOP of the
  // card, and re-rendering mid-interaction would tear its inputs out from
  // under the family's finger.
  if (sheet || openWeek == null) return;
  const t = e.target;
  if (t && t.closest && (t.closest('.ycard') || t.closest('.yhit'))) return;
  openWeek = null;
  renderYear();
}

function onDocKey(e) {
  // Escape closes the sheet, and the info card underneath it with it; with no
  // sheet open it closes the card on its own.
  if (e.key === 'Escape' && (sheet || openWeek != null)) {
    sheet = null; delArmed = false; openWeek = null;
    renderYear();
    return;
  }
  // Arrows step the open card one week. Never while the sheet is up: its date
  // fields own the arrow keys, and never from inside a field for the same reason.
  if (sheet || openWeek == null) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  e.preventDefault();                       // or the page scrolls sideways too
  stepWeek(e.key === 'ArrowRight' ? 1 : -1);
}

function bindDismiss() {
  if (openWeek != null) document.addEventListener('click', onDocTap);
  else document.removeEventListener('click', onDocTap);
  if (sheet || openWeek != null) document.addEventListener('keydown', onDocKey);
  else document.removeEventListener('keydown', onDocKey);
}

// ── Render ──────────────────────────────────────────────────
export function renderYear() {
  const el = document.getElementById('view-year');
  if (!el || !plan.data) return;
  const p = plan.data, today = todayStr(), wks = yearWeeks();
  // year.end before year.start walks zero weeks; everything below indexes wks[0].
  if (!wks.length) {
    el.innerHTML = `<div class="pcard pmeta">The school year's dates look wrong — check the plan's year range.</div>`;
    // Nothing left to point a card or sheet at. Drop both and unbind, or the
    // document listeners would re-render this message on every stray tap.
    openWeek = null; sheet = null; delArmed = false; justOpened = false;
    bindDismiss();
    return;
  }
  if (openWeek && !wks.includes(openWeek)) openWeek = null;
  const away = wks.map(w => weekAway(p.periods, w));
  const todayPct = Math.min(100, Math.max(0,
    (weeksBetween(wks[0], today) + 0.5) / wks.length * 100));

  const rows = p.activities.filter(a =>
    ['paced', 'target', 'external'].includes(a.type) && a.status === 'active');

  let h = `<div class="pcard"><div class="phead">${esc(p.year.label)} · year-round</div>
    <div class="pmeta"><span class="pchip">tap a week for details</span></div></div>
    <div class="pcard ytracks"><div class="ytw" style="--tp:${todayPct.toFixed(2)}">
    <div class="ynow"><i>today</i></div>`;
  for (const a of rows) h += trackFor(a, wks, away, today);
  for (const a of coreRows(p.activities, store.events)) h += coreTrack(a, wks, away, today);
  // The tap layer is written LAST inside .ytw so it paints over the cells it
  // covers (the today line keeps its own z-index above the band).
  h += `${hitHtml(wks)}</div>${axisHtml(wks)}${legendHtml()}</div>`;

  // Everything that is not running yet collapses to one line — the Subjects
  // tab owns those decisions, the Year page just says they exist.
  const grouped = [['Not started', 'planned'], ['Parked', 'parked'], ['Done', 'done']]
    .map(([label, st]) => {
      const names = p.activities.filter(a => a.status === st).map(a => esc(a.name || a.id));
      return names.length ? `${label}: ${names.join(' · ')}` : '';
    }).filter(Boolean);
  if (grouped.length)
    h += `<div class="pcard pmeta ycoll">${grouped.join(' · ')} — manage in Subjects</div>`;

  h += cardHtml(wks, away);
  h += listHtml();

  const nw = nextWorkStart(p.parentCycle, today);
  h += `<div class="pcard pmeta yfoot">Mama works Tue–Mon, every other week${
    nw ? ` · next work week: ${esc(fmtDay(nw))}` : ''}</div>`;
  h += sheetHtml();

  el.innerHTML = h;
  wire(el);
  bindDismiss();

  // On a laptop the sheet renders inline at the BOTTOM of a tall year page, so
  // opening it can leave Save below the fold with no hint anything happened.
  // Pull it into view and put the caret in the first field — once, on open
  // only: the impact block re-renders on every keystroke (see sync()) and
  // planNotify() re-renders on every save, and neither may steal the scroll
  // position or the focus back.
  if (justOpened) {
    justOpened = false;
    el.querySelector('.ysh')?.scrollIntoView({ block: 'nearest' });
    el.querySelector('#ysh-start')?.focus({ preventScroll: true });
  }
}

// ── Wiring ──────────────────────────────────────────────────
function wire(el) {
  const $ = id => document.getElementById(id);

  // ONE delegated listener for all ~55 week columns (this used to be one
  // listener per track cell — ~350 of them, re-bound on every render).
  const hit = el.querySelector('.yhit');
  if (hit) hit.addEventListener('click', e => {
    const col = e.target.closest ? e.target.closest('[data-w]') : null;
    if (!col) return;
    openWeek = openWeek === col.dataset.w ? null : col.dataset.w;  // same column closes
    renderYear();
  });
  // The one keyboard-reachable column is an <i role=button>, so the browser
  // focuses it but gives it none of a real button's Enter/Space activation —
  // same gap the time-away list rows have, handled the same way.
  const kb = el.querySelector('.yhit i[role="button"]');
  if (kb) kb.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();                     // Space would otherwise page-scroll
    openWeek = openWeek === kb.dataset.w ? null : kb.dataset.w;
    renderYear();
  });
  el.querySelectorAll('[data-ystep]').forEach(b =>
    b.addEventListener('click', () => stepWeek(Number(b.dataset.ystep))));
  el.querySelectorAll('[data-yedit]').forEach(b =>
    b.addEventListener('click', () => openEdit(b.dataset.yedit)));
  // The list rows are divs with role=button/tabindex=0, so the browser gives
  // them focus but NOT the Enter/Space activation a real <button> gets.
  // (The card's Edit controls are real buttons and already work.)
  el.querySelectorAll('.yrow[data-yedit]').forEach(r =>
    r.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();                     // Space would otherwise page-scroll
      openEdit(r.dataset.yedit);
    }));
  el.querySelectorAll('[data-yadd]').forEach(b =>
    b.addEventListener('click', () => openAdd(b.dataset.yadd)));

  const x = $('ycard-x');
  if (x) x.addEventListener('click', () => { openWeek = null; renderYear(); });
  const add = $('yadd');
  if (add) add.addEventListener('click', () => openAdd(null));

  if (!sheet) return;
  const start = $('ysh-start'), end = $('ysh-end'), label = $('ysh-label');
  const travel = $('ysh-t-travel'), off = $('ysh-t-off');
  const err = $('ysh-err'), warn = $('ysh-warn'), imp = $('ysh-imp'), del = $('ysh-del');

  const showErr = msg => {
    sheet.err = msg;
    err.textContent = msg;
    err.className = `form-err${msg ? ' show' : ''}`;
  };
  const disarm = () => { if (del && delArmed) { delArmed = false; del.textContent = 'Delete'; } };
  // Re-render ONLY the impact block on input: a full re-render would take the
  // keyboard focus off the field being typed into.
  const sync = () => {
    sheet.start = start.value; sheet.end = end.value; sheet.label = label.value;
    sheet.type = off.checked ? 'off' : 'travel';
    imp.innerHTML = impactHtml();
    const w = warnHtml();                     // advisory only — Save stays enabled
    warn.innerHTML = w;
    warn.className = `form-err warn${w ? ' show' : ''}`;
    if (sheet.err) showErr('');
    disarm();
  };
  [start, end, label].forEach(i => {
    i.addEventListener('input', sync);
    i.addEventListener('change', sync);
  });
  [travel, off].forEach(i => i.addEventListener('change', sync));

  $('ysh-cancel').addEventListener('click', closeSheet);
  $('ysh-bd').addEventListener('click', closeSheet);

  $('ysh-save').addEventListener('click', () => {
    const s = start.value, e = end.value;
    if (!s || !e) return showErr('Pick both a start and an end date.');
    if (e < s) return showErr('The end date has to be on or after the start date.');
    const patch = { start: s, end: e, type: off.checked ? 'off' : 'travel', label: label.value.trim() };
    const mode = sheet.mode, id = sheet.id;
    sheet = null; delArmed = false; openWeek = null;
    // commit() inside the mutation notifies, which re-renders this view.
    if (mode === 'edit') updatePeriod(id, patch); else addPeriod(patch);
  });

  if (del) del.addEventListener('click', () => {
    if (!delArmed) { delArmed = true; del.textContent = 'Tap again to delete'; return; }
    const id = sheet.id;
    sheet = null; delArmed = false; openWeek = null;
    deletePeriod(id);
  });
}
