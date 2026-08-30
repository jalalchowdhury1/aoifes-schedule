// /m — the iPhone PWA page. DOM-only glue: all day/subject/widget maths
// lives in js/plan/mday.js (pure, Node-tested). This file lays models out,
// wires taps, and re-syncs. Every write goes through togglePaced/logTimed
// (js/plan/state.js) — never a direct log/KV write, same rule as the rest
// of the planner.
import { esc, fmt } from './model.js';
import { store, initState, fetchRemote, catLabel } from './state.js';
import {
  initPlan, syncPlan, plan, onPlanChange, togglePaced, logTimed, logDailyStatus,
} from './plan/state.js';
import {
  todayStr, addDays, mondayOf, dayStatus, currentCur, nextSession,
  chainTimeline, planDeltaChip, actTotal, daysBetween, dayIdx, isWorkDay,
  actualFinishes,
} from './plan/model.js';
import { dayItems, dayHeader, nowBlock, dayState, fieldClassFor, subjectCards, receipt } from './plan/mday.js';
import { syncedAt } from './sync.js';

const $ = id => document.getElementById(id);

// Same name resolution today.js's timedFor uses (evLabel: name || the
// catLabels-aware category rename) — dayItems/buildTimed default to the
// plain CATS label when no resolver is given, which would silently ignore a
// family rename (e.g. catLabels.barakot = "Mama Classes") that the desktop
// Today view honors. Passed to every dayItems() call below so /m never
// disagrees with the desktop about what a renamed category is called.
const nameForEvent = ev => ev.name || catLabel(ev.cat);

// ── view-local state (never persisted, except the last tab) ─
const TK = 'aoife_mtab';
const state = {
  tab: 'today',
  weekStart: null,           // Monday of the visible week (Week tab); lazily set to this week
  weekDate: todayStr(),      // the selected day within that week
  singaporeExtra: false,     // ➕ revealed for the current daily's NEXT lesson
  statusPickKey: null,       // which row's long-press status menu is open
  toastTimer: null,
  toastUndo: null,
  toastArmed: false,
};

// ── boot ──────────────────────────────────────────────────────
function boot() {
  initState();
  initPlan();
  try { state.tab = localStorage.getItem(TK) || 'today'; } catch (e) {}
  wireTabs();
  wireSheet();
  wirePTR();
  wireCompactBar();
  renderAll();               // instant open from localStorage — never a spinner
  Promise.all([fetchRemote(), syncPlan()]).then(renderAll).catch(() => {});
  onPlanChange(renderAll);
  initLiveSync();
  setInterval(tickStamp, 30000);
}

// ── live re-sync: visibilitychange/focus + a 60s poll while visible ──
// Same idiom as js/plan/tabs.js's initLiveSync (visibility-gated poll, one
// wake = one round), a fresh small copy here rather than importing tabs.js
// itself — that module also wires the desktop grid's drag-hold and the
// overlay's MutationObserver, neither of which this page has any use for.
function initLiveSync() {
  let last = -Infinity, inflight = false;
  const fire = () => {
    const t = Date.now();
    if (inflight || t - last < 1000) return;
    last = t; inflight = true;
    Promise.all([fetchRemote(), syncPlan()]).then(renderAll).catch(() => {})
      .then(() => { inflight = false; last = Date.now(); });
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fire(); });
  window.addEventListener('focus', fire);
  setInterval(() => { if (document.visibilityState === 'visible') fire(); }, 60000);
}

function renderAll() {
  renderTopBar();
  if (state.tab === 'today') renderToday();
  else if (state.tab === 'week') renderWeek();
  else if (state.tab === 'subjects') renderSubjects();
  else if (state.tab === 'year') renderYear();
  applyFieldState();
  tickStamp();
}

// ── field state: violet in progress -> green all done -> amber late ──
// Reads the SAME dayState() the Today hero renders from (mday.js) — one
// function decides both, so the hero can never say "3 left" while the field
// has already gone green (polish round 2, item G).
function applyFieldState() {
  if (!plan.data) return;
  const today = todayStr();
  const items = dayItems(today, store.events, plan.data, nameForEvent);
  const hourFloat = new Date().getHours() + new Date().getMinutes() / 60;
  document.body.className = fieldClassFor(dayState(items, hourFloat));
}

// ── top bar (normal <-> compact via IntersectionObserver) ────
function renderTopBar() {
  if (!plan.data || state.tab !== 'today') { $('top-normal').hidden = false; $('top-compact').hidden = true; return; }
  const today = todayStr();
  const h = dayHeader(today, plan.data);
  const mamaTxt = h.mama ? ` · Mama: ${h.mama}` : '';
  $('top-date').textContent = `${h.dateLabel}${mamaTxt}`;
}

function wireCompactBar() {
  if (!('IntersectionObserver' in window)) return;
  let observer = null;
  window.__mObserveHero = () => {
    if (observer) observer.disconnect();
    const hero = document.querySelector('#tab-today .hero');
    if (!hero) { $('topbar').classList.remove('compact'); $('top-normal').hidden = false; $('top-compact').hidden = true; return; }
    observer = new IntersectionObserver(entries => {
      const out = !entries[0].isIntersecting && state.tab === 'today';
      $('topbar').classList.toggle('compact', out);
      $('top-normal').hidden = out;
      $('top-compact').hidden = !out;
      if (out && plan.data) {
        const today = todayStr();
        const items = dayItems(today, store.events, plan.data, nameForEvent);
        const done = items.filter(it => it.status === 'done').length;
        const nb = nowBlock(today, items, new Date().getHours() + new Date().getMinutes() / 60);
        $('top-frac').textContent = `${done}/${items.length} done`;
        $('top-next').textContent = nb.item ? `· next ${nb.item.name}` : '';
      }
    }, { rootMargin: '-70px 0px 0px 0px' });
    observer.observe(hero);
  };
  window.__mObserveHero();
}

// ── freshness ticker ──────────────────────────────────────────
function agoText(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return mins < 1 ? 'just now' : `${mins}m ago`;
}
function tickStamp() {
  const el = $('stamp');
  const at = syncedAt();
  if (!at) { el.textContent = 'not yet synced'; el.style.color = ''; return; }
  const mins = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  el.textContent = `updated ${agoText(at)}`;
  el.style.color = mins >= 120 ? 'var(--red)' : mins >= 30 ? 'var(--amb)' : '';
}

// ── duration formatting ───────────────────────────────────────
function fmtDur(mins) {
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// ── toast (write confirmation, two-tap undo) ─────────────────
function showToast(html, undoFn) {
  clearTimeout(state.toastTimer);
  state.toastUndo = undoFn;
  state.toastArmed = false;
  const t = $('toast');
  t.innerHTML = `<span>${html}</span>${undoFn ? '<button type="button" id="toast-undo">Undo</button>' : ''}`;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('on'));
  const undoBtn = $('toast-undo');
  if (undoBtn) undoBtn.addEventListener('click', () => {
    if (!state.toastArmed) {
      state.toastArmed = true;
      undoBtn.textContent = 'Really undo?';
      clearTimeout(state.toastTimer);
      state.toastTimer = setTimeout(() => hideToast(), 3000);
      return;
    }
    const fn = state.toastUndo;
    hideToast();
    if (fn) fn();
  });
  state.toastTimer = setTimeout(hideToast, 4000);
}
function hideToast() {
  clearTimeout(state.toastTimer);
  const t = $('toast');
  t.classList.remove('on');
  setTimeout(() => { t.hidden = true; }, 200);
}

// ── Today tab ─────────────────────────────────────────────────
function renderToday() {
  const el = $('tab-today');
  if (!plan.data) { el.innerHTML = ''; return; }
  const today = todayStr();
  const status = dayStatus(plan.data.periods, today);
  const header = dayHeader(today, plan.data);
  let h = '';

  if (status.away) {
    h += `<div class="glass away-banner">${status.type === 'off' ? '⏸' : '✈'} ${esc(header.away.label)} · day ${status.dayN} of ${status.total}</div>`;
  }

  const items = dayItems(today, store.events, plan.data, nameForEvent);
  const hourFloat = new Date().getHours() + new Date().getMinutes() / 60;
  const ds = dayState(items, hourFloat);

  // Hero (item A, polish round 2): "Right now" during a block, "Next" before
  // one, and after the last block either a celebratory all-done line or the
  // count + NAMES of what's still unlogged — never a raw ISO-date caption
  // (header.dateLabel is always "Sun Aug 30"/the clock, per dayHeader).
  h += `<div class="glass hero">`;
  if (ds.phase === 'now') {
    const pct = Math.max(0, Math.min(100, ((hourFloat - ds.item.start) / (ds.item.end - ds.item.start)) * 100));
    h += `<div class="tiny">Right now · ${fmt(hourFloat)}</div>
      <div class="big">${esc(ds.item.name)}</div>
      <div class="pair"><span class="mono dim" style="font-size:13px">${fmt(ds.item.start)}–${fmt(ds.item.end)}</span><span class="rel">· ${fmtDur(ds.minutesLeft)} left</span></div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>`;
  } else if (ds.phase === 'next') {
    h += `<div class="tiny">Next</div><div class="big">${fmt(ds.item.start)} ${esc(ds.item.name)}</div>
      <div class="pair"><span class="rel">in ${fmtDur(ds.minutesUntil)}</span></div>`;
  } else if (ds.phase === 'done') {
    h += `<div class="tiny">${esc(header.dateLabel)}</div>
      <div class="big">All done for today 🎉 · ${ds.answered}/${ds.total}</div>`;
  } else if (ds.phase === 'left') {
    h += `<div class="tiny">${esc(header.dateLabel)}</div>
      <div class="big">${ds.left} left</div>
      <div class="pair"><span class="rel">${esc(ds.names.join(', '))}</span></div>`;
  } else {
    h += `<div class="tiny">${esc(header.dateLabel)}</div><div class="big">Nothing scheduled</div>`;
  }
  h += `</div>`;

  const doneCount = items.filter(it => it.status === 'done').length;
  h += `<div class="glass">
    <div class="tiny" style="margin-bottom:4px">The day · ${doneCount} of ${items.length} done</div>`;
  for (const it of items) {
    h += itemRowHtml(it, today);
  }
  h += `</div>`;

  // ── Singapore-style dual card: any tb-wb daily whose check is NOT a
  // simple toggle. Only paced dailies with a currently-open tb-wb chapter.
  for (const it of items.filter(x => x.kind === 'daily')) {
    const act = plan.data.activities.find(a => a.id === it.activityId);
    const cur = act ? currentCur(act) : null;
    if (!cur || cur.pattern !== 'tb-wb') continue;
    h += tbWbCardHtml(act, cur, it, today);
  }

  h += thisWeekCardHtml(today);
  h += yesterdayReceiptHtml(addDays(today, -1));

  el.innerHTML = h;
  wireTodayEvents(el, items, today);
  if (window.__mObserveHero) window.__mObserveHero();
}

// ── Yesterday receipt (item B, polish round 2) — collapsed per-activity
// recap (mday.js's receipt()) instead of a raw one-line-per-tap dump, so
// four Singapore Math taps read as "✓ Singapore L2 + L3", not four repeats
// of the same name.
function yesterdayReceiptHtml(dateStr) {
  const h = dayHeader(dateStr, plan.data);
  if (h.away) return `<div class="tmwrow">Yesterday: ${h.away.type === 'off' ? '⏸' : '✈'} ${esc(h.away.label)}</div>`;
  const rows = receipt(dateStr, store.events, plan.data, nameForEvent);
  if (!rows.length) return '';
  const line = rows.map(r => `${r.mark} ${esc(r.name)}${r.detail ? ' ' + esc(r.detail) : ''}`).join(' · ');
  return `<div class="tmwrow">Yesterday: ${line}</div>`;
}

// Item D (polish round 2): the "…" button is gone. Every row's ONLY status
// control is the round check; a long-press on it (wireLongPress, ≥450ms)
// opens a tiny inline menu instead. A faint chevron at the far right of
// EVERY row hints that more exists — identical everywhere, so no one row
// (Ruhama's old "…") looks singled out. The tb-wb daily's check stays
// status-only (the dual textbook/workbook card below is what actually
// advances it), but it now ALSO answers a long-press with "✗ skipped", so
// a whole no-show Singapore day can be marked without touching that card.
function itemRowHtml(it, dateStr) {
  const st = it.status;
  const time = it.kind === 'timed' ? `${fmt(it.start)}` : '—';
  const isTbWbDaily = it.kind === 'daily' && (() => {
    const act = plan.data.activities.find(a => a.id === it.activityId);
    const cur = act ? currentCur(act) : null;
    return cur && cur.pattern === 'tb-wb';
  })();
  const checkCls = st ? ` st-${st}` : '';
  const checkGlyph = st === 'done' ? '✓' : st === 'half' ? '◐' : st === 'partial' ? '◐' : st === 'missed' ? '✗' : '';
  let check;
  if (isTbWbDaily) {
    check = `<button type="button" class="chk${checkCls}" data-tbwbcheck="${esc(it.key)}" aria-label="More options for ${esc(it.name)}">${checkGlyph}</button>`;
  } else if (it.kind === 'timed') {
    check = `<button type="button" class="chk${checkCls}" data-check="${esc(it.key)}" aria-pressed="${st === 'done'}" aria-label="Mark ${esc(it.name)} done">${checkGlyph}</button>`;
  } else {
    check = `<button type="button" class="chk${checkCls}" data-daily="${esc(it.activityId)}" aria-pressed="${st === 'done'}" aria-label="Toggle ${esc(it.name)}">${checkGlyph}</button>`;
  }
  let row = `<div class="item" data-key="${esc(it.key)}">
    <span class="t mono">${it.kind === 'timed' ? esc(time) : '—'}</span>
    <span class="em" aria-hidden="true">${it.emoji}</span>
    <span class="n"><b>${esc(it.name)}</b>${it.note ? `<span>${esc(it.note)}</span>` : ''}</span>
    <span class="ractions">${check}<i class="hintdot" aria-hidden="true">⌄</i></span>
  </div>`;
  if (state.statusPickKey === it.key) {
    if (it.kind === 'timed') {
      row += `<div class="status-pick" data-pick-for="${esc(it.key)}">
        <button type="button" data-pickst="partial" class="${st === 'partial' ? 'sel' : ''}">◐ Didn't finish</button>
        <button type="button" data-pickst="missed" class="${st === 'missed' ? 'sel' : ''}">✗ Missed</button>
      </div>`;
    } else if (isTbWbDaily) {
      // 'half' (textbook alone logged) or 'done' (full lesson) both mean real
      // work already exists today — offering ✗ there would just toast
      // "Already logged today" (logDailyStatus's guard, review 2). Only
      // "nothing yet" or an already-missed row (to un-mark it) get the
      // button, matching the bot's own checkin_message, which drops the ✗
      // button the moment ANY session is logged that day.
      row += `<div class="status-pick" data-pick-for="${esc(it.key)}">
        ${!st || st === 'missed' ? `<button type="button" data-tbwbmiss="${esc(it.activityId)}" class="${st === 'missed' ? 'sel' : ''}">✗ Skipped</button>` : ''}
      </div>`;
    } else {
      row += `<div class="status-pick" data-pick-for="${esc(it.key)}">
        ${!st || st === 'missed' ? `<button type="button" data-dailymiss="${esc(it.activityId)}" class="${st === 'missed' ? 'sel' : ''}">✗ Skipped</button>` : ''}
      </div>`;
    }
  }
  return row;
}

// "3A Ch 1 · Numbers to 10,000" -> "3A Ch 1" (mday.js's own shortChainName
// idiom, kept local here — one line, not worth a shared export for it).
const shortChainName = c => String(c?.name || '').split('·')[0].trim();

// Item F (polish round 2): a small pace line under the buttons —
// "L6 · 2 of 22 sessions in 3A Ch 1 · ▲ 2 lessons ahead". The session count
// is the chain's own raw done/lessons*2 (NOT subjectCards' lesson-fraction
// numbers, which would read "2 of 22" as "1 of 11"); the ahead/behind figure
// is in LESSONS, not weeks, via the exact plan-vs-now day gap the Subjects
// sheet's own consequence sentence uses (chainTimeline + the frozen
// baseline) — 1 extra lesson pulls the finish 1 day earlier.
function tbWbPaceLine(act, cur, today) {
  const sessDone = Math.min(Math.max(0, cur.done || 0), (cur.lessons || 0) * 2);
  const sessTotal = (cur.lessons || 0) * 2;
  let aheadTxt = '';
  const rows = chainTimeline(act, today, plan.data);
  const curRow = [...rows].reverse().find(r => !r.complete && r.sessions > 0);
  const base = act.baseline?.rows;
  const baseDate = curRow && base ? base[curRow.key] : null;
  if (curRow?.finish && baseDate) {
    const dd = daysBetween(curRow.finish, baseDate);         // + = later (behind), - = earlier (ahead)
    const gap = Math.round(Math.abs(dd));
    if (gap) aheadTxt = ` · ${dd < 0 ? '▲' : '▼'} ${gap} lesson${gap === 1 ? '' : 's'} ${dd < 0 ? 'ahead' : 'behind'}`;
  }
  return `<div class="chline">L${Math.floor((cur.done || 0) / 2) + 1} · ${sessDone} of ${sessTotal} sessions in ${esc(shortChainName(cur))}${aheadTxt}</div>`;
}

function tbWbCardHtml(act, cur, item, today) {
  const lessonNum = Math.floor((cur.done || 0) / 2) + 1;
  const doneToday = item.status === 'done';
  let h = `<div class="glass"><div class="tiny">${esc(act.name)} · lesson ${lessonNum}</div>`;
  if (doneToday && !state.singaporeExtra) {
    h += `<div class="dual"><button type="button" class="btn q" data-extra="${esc(act.id)}">➕ Add another lesson</button></div>`;
  } else {
    const ns = nextSession(cur);
    const nextIsWorkbook = ns && /workbook/.test(ns.label);
    h += `<div class="dual">
      <button type="button" class="btn${nextIsWorkbook ? '' : ' pri'}" data-tbwb="${esc(act.id)}">✓ Textbook</button>
      <button type="button" class="btn${nextIsWorkbook ? ' pri' : ''}" data-tbwb="${esc(act.id)}">✓ Workbook</button>
    </div>`;
  }
  h += tbWbPaceLine(act, cur, today);
  h += `</div>`;
  return h;
}

function thisWeekCardHtml(today) {
  const cards = subjectCards(plan.data, today)
    .filter(c => c.status === 'active' && (c.sessionsThisWeek > 0 || c.streak >= 2));
  if (!cards.length) return '';
  const lines = cards.map(c => {
    const chips = [];
    if (c.delta) chips.push(c.delta.state === 'on'
      ? `<span class="cap grn">on plan</span>`
      : c.delta.state === 'ahead'
        ? `<span class="cap grn">▲ ${c.delta.weeks} wk${c.delta.weeks > 1 ? 's' : ''} ahead</span>`
        : `<span class="cap amb">▼ ${c.delta.weeks} wk${c.delta.weeks > 1 ? 's' : ''} behind</span>`);
    if (c.streak >= 2) chips.push(`<span class="cap">${c.streak}-day streak</span>`);
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0">
      <div><b style="font-size:14px">${esc(c.name)}</b> — <span class="dim" style="font-size:13px">${c.sessionsThisWeek} session${c.sessionsThisWeek === 1 ? '' : 's'}</span></div>
      <div>${chips.join('')}</div></div>`;
  }).join('');
  return `<div class="psec">This week</div><div class="glass">${lines}</div>`;
}

// ── long-press (item D, polish round 2) ──────────────────────
// Pointer Events only (works for touch AND a desktop mouse, e.g. testing in
// a laptop browser): a short press fires `onTap` on release, a hold past
// LONG_PRESS_MS fires `onLong` instead and swallows the release so it never
// ALSO fires the tap. No native context menu, no text-selection callout —
// this runs on a phone, not a right-click surface.
const LONG_PRESS_MS = 450;
// A scroll typically self-cancels via a native pointercancel once the UA
// commits to panning (touch-action: manipulation allows that on `.chk`), but
// that decision is on the UA's own schedule — a slow drag can still be mid-
// recognition when the 450ms timer fires. Track the finger explicitly and
// cancel past 10px of movement (review 2) so a scroll that starts on a check
// button can never pop the long-press menu instead.
const MOVE_CANCEL_PX = 10;
function wireLongPress(btn, onTap, onLong) {
  let timer = null, fired = false, sx = 0, sy = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  btn.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    fired = false;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { fired = true; onLong(); }, LONG_PRESS_MS);
  });
  btn.addEventListener('pointermove', e => {
    if (!timer) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > MOVE_CANCEL_PX) clear();
  });
  btn.addEventListener('pointerup', e => {
    clear();
    if (fired) { e.preventDefault(); return; }
    onTap();
  });
  btn.addEventListener('pointercancel', clear);
  btn.addEventListener('pointerleave', clear);
  btn.addEventListener('contextmenu', e => e.preventDefault());
}

function wireTodayEvents(el, items, today) {
  el.querySelectorAll('[data-check]').forEach(b => {
    const it = items.find(x => x.key === b.dataset.check);
    if (!it) return;
    wireLongPress(b,
      () => {
        logTimed(it.eventId || null, it.activityId || null, 'done');
        state.statusPickKey = null;
        showToast(`Logged ${esc(it.name)} ✓`, () => logTimed(it.eventId || null, it.activityId || null, 'done'));
        renderAll();
      },
      () => { state.statusPickKey = state.statusPickKey === it.key ? null : it.key; renderToday(); });
  });
  el.querySelectorAll('[data-tbwbcheck]').forEach(b => {
    const it = items.find(x => x.key === b.dataset.tbwbcheck);
    if (!it) return;
    // Short tap does nothing — status-only row, the dual card below is what
    // actually advances it. Long-press still opens "✗ Skipped".
    wireLongPress(b, () => {},
      () => { state.statusPickKey = state.statusPickKey === it.key ? null : it.key; renderToday(); });
  });
  el.querySelectorAll('[data-pickst]').forEach(b => b.addEventListener('click', () => {
    const wrap = b.closest('[data-pick-for]');
    const it = items.find(x => x.key === wrap.dataset.pickFor);
    if (!it) return;
    logTimed(it.eventId || null, it.activityId || null, b.dataset.pickst);
    state.statusPickKey = null;
    showToast(`Logged ${esc(it.name)} ${b.dataset.pickst}`, () => logTimed(it.eventId || null, it.activityId || null, b.dataset.pickst));
    renderAll();
  }));
  el.querySelectorAll('[data-tbwbmiss],[data-dailymiss]').forEach(b => b.addEventListener('click', () => {
    const actId = b.dataset.tbwbmiss || b.dataset.dailymiss;
    const ok = logDailyStatus(actId, 'missed', today);
    state.statusPickKey = null;
    // logDailyStatus returns false when real work is already logged today
    // (review 2 guard, mirrors the bot's guard_missed_tap) — nothing was
    // written, so no toast claiming otherwise and no Undo to offer.
    if (ok === false) showToast(`Already logged today`);
    else showToast(`Marked skipped`, () => logDailyStatus(actId, 'missed', today));
    renderAll();
  }));
  el.querySelectorAll('[data-daily]').forEach(b => {
    const actId = b.dataset.daily;
    wireLongPress(b,
      () => {
        togglePaced(actId);
        showToast(`Logged ✓`, () => togglePaced(actId));
        renderAll();
      },
      () => { state.statusPickKey = state.statusPickKey === `act:${actId}` ? null : `act:${actId}`; renderToday(); });
  });
  el.querySelectorAll('[data-tbwb]').forEach(b => b.addEventListener('click', () => {
    const act = plan.data.activities.find(a => a.id === b.dataset.tbwb);
    const cur = act ? currentCur(act) : null;
    const label = cur ? nextSession(cur)?.label : '';
    togglePaced(b.dataset.tbwb);
    state.singaporeExtra = false;
    showToast(`Logged ${esc(label || 'session')} ✓`, () => togglePaced(b.dataset.tbwb));
    renderAll();
  }));
  el.querySelectorAll('[data-extra]').forEach(b => b.addEventListener('click', () => {
    state.singaporeExtra = true;
    renderToday();
  }));
}

// ── Week tab (read-only; item E, polish round 2) ─────────────
// Navigable week window (unlimited both directions — ‹ › buttons or a
// horizontal swipe), a "This week" snap-back capsule when off the current
// week, a per-day dot under each chip (green all-done/amber some-logged/
// red-ish any-missed/none for empty or future), away days show ✈/⏸ in the
// chip instead. A PAST selected day shows its collapsed receipt (mday.js's
// receipt(), item B) instead of the plan list; today/future show the plan
// list, same as before. The selected day is remembered only for the session.
const WEEK_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function weekRangeLabel(start, end) {
  const [ys, ms, ds] = start.split('-').map(Number);
  const [ye, me, de] = end.split('-').map(Number);
  const sameMonth = ys === ye && ms === me;
  return `${WEEK_MON[ms - 1]} ${ds} – ${sameMonth ? de : `${WEEK_MON[me - 1]} ${de}`}`;
}

function dotClassFor(dateStr, today) {
  if (dateStr > today) return null;
  const items = dayItems(dateStr, store.events, plan.data, nameForEvent);
  if (!items.length) return null;
  if (items.some(it => it.status === 'missed')) return 'red';
  if (items.every(it => it.status === 'done')) return 'grn';
  if (items.some(it => it.status != null)) return 'amb';
  return null;
}

function renderWeek() {
  const el = $('tab-week');
  if (!plan.data) { el.innerHTML = ''; return; }
  const today = todayStr();
  const curMon = mondayOf(today);
  if (!state.weekStart) state.weekStart = curMon;
  const weekStart = state.weekStart, weekEnd = addDays(weekStart, 6);
  if (state.weekDate < weekStart || state.weekDate > weekEnd) state.weekDate = weekStart;
  const isCurWeek = weekStart === curMon;
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const hasCycle = plan.data.activities.some(a => a && a.status === 'active' && a.rhythm?.kind === 'cycle');
  const mamaTxt = hasCycle ? ` · Mama: ${isWorkDay(plan.data.parentCycle, weekStart) ? 'work' : 'home'}` : '';
  let h = `<div class="wknav">
    <button type="button" class="wkstep glass" data-wk="-1" aria-label="Previous week">‹</button>
    <div class="wklabel"><b>${esc(weekRangeLabel(weekStart, weekEnd))}</b><span class="dim">${esc(mamaTxt)}</span></div>
    <button type="button" class="wkstep glass" data-wk="1" aria-label="Next week">›</button>
  </div>`;
  if (!isCurWeek) h += `<button type="button" id="wk-today" class="cap vio wk-today-cap">This week</button>`;

  h += '<div class="daychips">';
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const dNum = Number(d.slice(-2));
    const st = dayStatus(plan.data.periods, d);
    const dotCls = st.away ? null : dotClassFor(d, today);
    const mark = st.away ? `<i class="chipaway">${st.type === 'off' ? '⏸' : '✈'}</i>`
      : dotCls ? `<i class="chipdot ${dotCls}"></i>` : '';
    h += `<button type="button" class="daychip${d === state.weekDate ? ' on' : ''}${d === today ? ' today' : ''}" data-day="${d}"><b>${dNum}</b>${DOW[i]}${mark}</button>`;
  }
  h += '</div>';

  const sel = state.weekDate;
  const status = dayStatus(plan.data.periods, sel);
  let body;
  if (status.away) {
    body = `<div class="glass away-banner">${status.type === 'off' ? '⏸' : '✈'} ${esc((status.label || '').replace(/[✈⏸]/g, '').trim() || (status.type === 'off' ? 'Off' : 'Time away'))} · day ${status.dayN} of ${status.total}</div>`;
  } else if (sel < today) {
    const rows = receipt(sel, store.events, plan.data, nameForEvent);
    body = !rows.length ? `<div class="glass dim">Nothing logged.</div>`
      : `<div class="glass">${rows.map(r => `<div class="item">
      <span class="em" aria-hidden="true">${r.emoji}</span>
      <span class="n"><b>${esc(r.name)}</b>${r.detail ? `<span>${esc(r.detail)}</span>` : ''}</span>
      <span class="rcpt-mk">${r.mark}</span>
    </div>`).join('')}</div>`;
  } else {
    const items = dayItems(sel, store.events, plan.data, nameForEvent);
    body = !items.length ? `<div class="glass dim">Nothing scheduled.</div>`
      : `<div class="glass">${items.map(it => `<div class="item">
      <span class="t mono">${it.kind === 'timed' ? esc(fmt(it.start)) : '—'}</span>
      <span class="em" aria-hidden="true">${it.emoji}</span>
      <span class="n"><b>${esc(it.name)}</b>${it.note ? `<span>${esc(it.note)}</span>` : ''}</span>
    </div>`).join('')}</div>`;
  }

  el.innerHTML = h + body;
  wireWeekNav(el);
}

function shiftWeek(nWeeks) {
  const idxInWeek = dayIdx(state.weekDate);
  state.weekStart = addDays(state.weekStart, nWeeks * 7);
  state.weekDate = addDays(state.weekStart, idxInWeek);
  renderWeek();
}

function wireWeekNav(el) {
  el.querySelectorAll('[data-wk]').forEach(b => b.addEventListener('click', () => shiftWeek(Number(b.dataset.wk))));
  const t = $('wk-today');
  if (t) t.addEventListener('click', () => { state.weekStart = mondayOf(todayStr()); state.weekDate = todayStr(); renderWeek(); });
  el.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
    state.weekDate = b.dataset.day;
    renderWeek();
  }));
  wireWeekSwipe(el);
}

// ≥40px horizontal, ignoring a vertical scroll: tracked via touchmove so a
// gesture that moves mostly vertically never gets mistaken for a week swipe.
function wireWeekSwipe(el) {
  let startX = null, startY = null, horiz = false;
  el.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX; startY = e.touches[0].clientY; horiz = false;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (startX == null) return;
    const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy)) horiz = true;
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (!horiz || Math.abs(dx) < 40) return;
    shiftWeek(dx < 0 ? 1 : -1);
  });
}

// ── Subjects tab ──────────────────────────────────────────────
function renderSubjects() {
  const el = $('tab-subjects');
  if (!plan.data) { el.innerHTML = ''; return; }
  const today = todayStr();
  const cards = subjectCards(plan.data, today);
  el.innerHTML = cards.map(c => cardHtml(c)).join('');
  el.querySelectorAll('.sub').forEach(node => node.addEventListener('click', () => openSubjectSheet(node.dataset.id)));
}

function cardHtml(c) {
  const finTxt = c.status !== 'active' ? (c.status === 'planned' ? 'planned' : c.status)
    : c.finish ? `→ ${fmtDateShort(c.finish)}` : c.lessonsTotal ? 'counts pending' : '';
  const dots = c.isTbWb && c.chapterSessions
    ? `<div class="chline">${esc(c.chapterLabel)} · ${c.chapterDone} of ${c.chapterSessions}</div>`
    : '';
  const caps = [];
  if (c.status === 'active') {
    if (c.delta) caps.push(c.delta.state === 'on' ? `<span class="cap grn">on plan</span>`
      : c.delta.state === 'ahead' ? `<span class="cap grn">▲ ${c.delta.weeks} wk${c.delta.weeks > 1 ? 's' : ''} ahead</span>`
      : `<span class="cap amb">▼ ${c.delta.weeks} wk${c.delta.weeks > 1 ? 's' : ''} behind</span>`);
    if (c.streak >= 2) caps.push(`<span class="cap">${c.streak}-day streak</span>`);
    if (c.nextLabel) caps.push(`<span class="cap vio">next: ${esc(c.nextLabel)}</span>`);
  }
  return `<div class="glass sub${c.status !== 'active' ? ' dim-card' : ''}" data-id="${esc(c.id)}" role="button" tabindex="0">
    <div class="hd"><b><span class="dotc" style="background:${c.color}"></span>${esc(c.name)}</b><span class="fin">${finTxt}</span></div>
    <div class="nums"><span class="big mono">${c.lessonsDone}<span class="of">/${c.lessonsTotal}</span></span><span class="rel dim">${c.lessonsTotal ? `· ${c.pct}%` : ''}</span></div>
    ${c.lessonsTotal ? `<div class="bar"><i style="width:${c.pct}%;background:${c.color}"></i></div>` : ''}
    ${dots}
    <div>${caps.join('')}</div>
  </div>`;
}

function fmtDateShort(iso) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = iso.split('-').map(Number);
  return `${MON[m - 1]} ${d}, ${y}`;
}

function openSubjectSheet(id) {
  const act = plan.data.activities.find(a => a.id === id);
  if (!act) return;
  const today = todayStr();
  const c = subjectCards(plan.data, today).find(x => x.id === id);
  const body = $('sheet-body');
  let h = `<div class="sh-t">${esc(c.name)}</div><div class="sh-s">${esc(subtitleFor(act))}</div>`;

  if (c.status === 'active' && actTotal(act) > 0) {
    const rows = chainTimeline(act, today, plan.data);
    const curRow = [...rows].reverse().find(r => !r.complete && r.sessions > 0);
    const base = act.baseline?.rows;
    const baseDate = curRow && base ? base[curRow.key] : null;
    const nowDate = curRow ? curRow.finish : null;
    const delta = planDeltaChip(nowDate, baseDate);
    h += `<div class="two">
      <div class="glass"><div class="lab">Plan</div><div class="v">${baseDate ? fmtDateShort(baseDate) : '—'}</div><div class="dim" style="font-size:11px">${act.baseline ? `frozen ${fmtDateShort(act.baseline.setOn)}` : 'not set'}</div></div>
      <div class="glass"><div class="lab">Now</div><div class="v${delta && delta.state !== 'behind' ? ' grn' : ''}">${nowDate ? fmtDateShort(nowDate) : '—'}</div><div class="dim" style="font-size:11px">${deltaCaption(delta)}</div></div>
    </div>`;
    if (baseDate && nowDate) h += `<p class="conseq">${consequenceSentence(daysBetween(nowDate, baseDate))}</p>`;
  }

  h += oopsRowHtml(act);
  h += `<p class="foot dim"><a href="/">Full site →</a></p>`;
  body.innerHTML = h;
  wireSheetInteractive(body, act);
  openSheet();
}

function subtitleFor(act) {
  const r = act.rhythm || {};
  const spd = Number(r.sessionsPerDay) > 1 ? `${r.sessionsPerDay} sessions a day` : '1 lesson a day';
  const travel = act.travel?.mode === 'reduced' ? ' · half speed on trips'
    : act.travel?.mode === 'continue' ? ' · keeps going on trips' : ' · pauses on trips';
  const hasTbWb = (act.chain || []).some(c => c.pattern === 'tb-wb');
  return `${spd}${hasTbWb ? ' · textbook + workbook' : ''}${travel}`;
}

function deltaCaption(delta) {
  if (!delta) return 'no baseline yet';
  if (delta.state === 'on') return 'on plan';
  const n = Math.abs(delta.weeks);
  return delta.state === 'ahead' ? `${n} wk${n === 1 ? '' : 's'} ahead` : `${n} wk${n === 1 ? '' : 's'} behind`;
}

// dd = daysBetween(nowDate, baseDate): + when now is LATER than baseline (behind), see planDeltaChip's own sign convention (mirrored here so this sentence and the chip above it never disagree).
function consequenceSentence(dd) {
  const gap = Math.round(Math.abs(dd));
  if (!gap) return "She's exactly on the plan right now.";
  const ahead = dd < 0;
  const dir = ahead ? 'ahead of' : 'behind';
  const verb = ahead ? 'earlier' : 'later';
  const arrow = ahead ? '▲' : '▼';
  const weeksNow = Math.floor(gap / 7);
  const more = gap % 7 === 0 ? 7 : 7 - (gap % 7);
  return `She's <b>${gap} lesson${gap === 1 ? '' : 's'} ${dir}</b> the plan. Every extra lesson pulls the finish 1 day ${verb}; ${more} more and the card reads <b>${arrow} ${weeksNow + 1} wk ${ahead ? 'ahead' : 'behind'}</b>.`;
}

// Only a status:'done' row is something togglePaced can actually undo — it
// finds-and-removes exactly that shape (js/plan/state.js). A 'missed' marker
// (the bot's ✗ skip button writes one for a no-slot daily too) is a DIFFERENT
// kind of row: feeding its date to togglePaced would find no 'done' entry
// there and fall into the ELSE branch, silently LOGGING A NEW SESSION instead
// of removing anything. So "last logged session" here means the same thing
// togglePaced means by it: the latest 'done' row, never a missed marker.
export function lastDoneEntry(act) {
  return [...plan.data.log].reverse().find(e =>
    e && e.activityId === act.id && e.status === 'done' && !e.timed && !e.eventId);
}

function oopsRowHtml(act) {
  const last = lastDoneEntry(act);
  if (!last) return '';
  const label = last.label || (last.curriculum ? sessionLabelFor(act, last) : 'the last logged session');
  return `<div class="oops-row" data-oops="${esc(act.id)}" data-oops-armed="0">
    <button type="button">Oops — remove last logged session (${esc(label)}, ${esc(last.date)})</button>
  </div>`;
}
function sessionLabelFor(act, entry) {
  const cur = (act.chain || []).find(c => c && c.id === entry.curriculum);
  if (!cur) return 'the last logged session';
  return nextSession({ ...cur, done: Math.max(0, (entry.session ?? cur.done - 1)) })?.label || 'the last logged session';
}

function wireSheetInteractive(body, act) {
  const row = body.querySelector('[data-oops]');
  if (!row) return;
  const btn = row.querySelector('button');
  btn.addEventListener('click', () => {
    if (row.dataset.oopsArmed !== '1') {
      row.dataset.oopsArmed = '1';
      btn.textContent = 'Tap again to remove it';
      return;
    }
    const last = lastDoneEntry(act);
    if (last) togglePaced(act.id, last.date);
    closeSheet();
    renderAll();
  });
}

// ── Year tab (read-only; item C, polish round 2) ─────────────
// Each chapter row: label (one line, ellipsis) left; a compact mono
// "plan → now" date pair right (no year unless it differs from the plan
// year; a complete row shows the log-attested actual date instead of a
// projection, with a ✓), plus a small state chip. The current (in-progress)
// row is highlighted, same "first not-complete row with sessions" idiom
// subjects.js's own 📅 Timeline uses.
const YEAR_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtCompactDate(iso, showYear) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${YEAR_MON[m - 1]} ${d}${showYear ? `, ${y}` : ''}`;
}

function yearRowHtml(r, base, actual, isCurrent) {
  const planD = base ? base[r.key] : null;
  const nowD = r.complete ? (actual[r.key] || null) : r.finish;
  const planYear = planD ? planD.slice(0, 4) : null;
  const nowYear = nowD ? nowD.slice(0, 4) : null;
  let chip;
  if (r.complete) chip = `<span class="ychip ok">✓</span>`;
  else if (isCurrent) chip = `<span class="ychip cur">●</span>`;
  else {
    const delta = planD && nowD ? planDeltaChip(nowD, planD) : null;
    chip = delta?.state === 'ahead' ? `<span class="ychip ahead">▲</span>`
      : delta?.state === 'behind' ? `<span class="ychip behind">▼</span>`
      : `<span class="ychip pend">—</span>`;
  }
  let dt;
  if (r.complete) dt = nowD ? `✓ ${fmtCompactDate(nowD, true)}` : '✓';
  else {
    const planTxt = planD ? fmtCompactDate(planD, false) : '—';
    const nowTxt = nowD ? fmtCompactDate(nowD, planYear !== nowYear) : '—';
    dt = `${planTxt} → ${nowTxt}`;
  }
  return `<div class="ychrow${isCurrent ? ' cur' : ''}">
    <span class="ynm" title="${esc(r.label)}">${esc(r.label)}</span>
    <span class="ydt mono">${dt}</span>${chip}
  </div>`;
}

function renderYear() {
  const el = $('tab-year');
  if (!plan.data) { el.innerHTML = ''; return; }
  const today = todayStr();
  const periods = plan.data.periods || [];
  const next = periods.find(p => p.start > today);
  let h = '';
  if (next) {
    const label = String(next.label || '').replace(/[✈⏸]/g, '').trim() || (next.type === 'off' ? 'Off' : 'Time away');
    const days = daysBetween(today, next.start);
    h += `<div class="glass trip-card"><div class="tc-body">
      <div class="tiny">Next</div>
      <div class="tc-label">${next.type === 'off' ? '⏸' : '✈'} ${esc(label)}</div>
      <div class="dim tc-dates">${fmtDateShort(next.start)} – ${fmtDateShort(next.end)}</div>
    </div><span class="cap vio tc-days">in ${days} day${days === 1 ? '' : 's'}</span></div>`;
  }

  const acts = (plan.data.activities || []).filter(a => a.type === 'paced' && a.status === 'active' && actTotal(a) > 0);
  for (const a of acts) {
    const rows = chainTimeline(a, today, plan.data);
    const base = a.baseline?.rows;
    const actual = actualFinishes(a, plan.data.log);
    let curSeen = false;
    h += `<div class="psec">${esc(a.name)}</div><div class="glass">`;
    for (const r of rows.slice(0, 40)) {
      let isCurrent = false;
      if (!curSeen && !r.complete && r.sessions > 0) { curSeen = true; isCurrent = true; }
      h += yearRowHtml(r, base, actual, isCurrent);
    }
    h += `</div>`;
  }
  el.innerHTML = h || `<div class="glass dim">Nothing on the calendar yet.</div>`;
}

// ── sheet mechanics (grab-to-close, backdrop tap) ────────────
function openSheet() {
  $('sheet-dim').hidden = false;
  $('sheet').hidden = false;
  requestAnimationFrame(() => { $('sheet-dim').classList.add('on'); $('sheet').classList.add('on'); });
}
function closeSheet() {
  const sh = $('sheet'), dim = $('sheet-dim');
  sh.classList.remove('on'); dim.classList.remove('on');
  sh.style.transform = '';
  setTimeout(() => { sh.hidden = true; dim.hidden = true; }, 320);
}
function wireSheet() {
  $('sheet-dim').addEventListener('click', closeSheet);
  const sh = $('sheet');
  let startY = null, dy = 0;
  sh.addEventListener('touchstart', e => { startY = e.touches[0].clientY; dy = 0; sh.classList.add('dragging'); }, { passive: true });
  sh.addEventListener('touchmove', e => {
    if (startY === null) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    sh.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sh.addEventListener('touchend', () => {
    sh.classList.remove('dragging');
    if (dy > 90) closeSheet(); else sh.style.transform = '';
    startY = null;
  });
}

// ── tabs ──────────────────────────────────────────────────────
function wireTabs() {
  document.querySelectorAll('#tabbar button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  setTab(state.tab, true);
}
function setTab(tab, initial) {
  state.tab = tab;
  try { localStorage.setItem(TK, tab); } catch (e) {}
  document.querySelectorAll('.tab').forEach(s => { s.hidden = s.id !== `tab-${tab}`; });
  document.querySelectorAll('#tabbar button').forEach(b => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  if (!initial) renderAll();
}

// ── pull-to-refresh ───────────────────────────────────────────
function wirePTR() {
  let startY = null, armed = false;
  const ptr = $('ptr');
  document.addEventListener('touchstart', e => {
    if (window.scrollY <= 0 && $('sheet').hidden) startY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 24 && window.scrollY <= 0) {
      ptr.classList.add('show');
      armed = dy > 70;
      ptr.classList.toggle('armed', armed);
      ptr.textContent = armed ? '↑ refreshing on release' : '↓ pull to refresh';
    }
  }, { passive: true });
  document.addEventListener('touchend', () => {
    ptr.classList.remove('show'); ptr.classList.remove('armed');
    if (armed) Promise.all([fetchRemote(), syncPlan()]).then(renderAll).catch(() => {});
    startY = null; armed = false;
  });
}

document.addEventListener('DOMContentLoaded', boot);
