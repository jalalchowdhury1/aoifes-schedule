// /m — the iPhone PWA page. DOM-only glue: all day/subject/widget maths
// lives in js/plan/mday.js (pure, Node-tested). This file lays models out,
// wires taps, and re-syncs. Every write goes through togglePaced/logTimed
// (js/plan/state.js) — never a direct log/KV write, same rule as the rest
// of the planner.
import { esc, fmt } from './model.js';
import { store, initState, fetchRemote } from './state.js';
import {
  initPlan, syncPlan, plan, onPlanChange, togglePaced, logTimed,
} from './plan/state.js';
import {
  todayStr, addDays, mondayOf, dayStatus, currentCur, nextSession,
  chainTimeline, planDeltaChip, actTotal, daysBetween,
} from './plan/model.js';
import { dayItems, dayHeader, nowBlock, subjectCards } from './plan/mday.js';
import { yesterdayHtml } from './plan/today.js';
import { syncedAt } from './sync.js';

const $ = id => document.getElementById(id);

// ── view-local state (never persisted, except the last tab) ─
const TK = 'aoife_mtab';
const state = {
  tab: 'today',
  weekDate: todayStr(),
  singaporeExtra: false,     // ➕ revealed for the current daily's NEXT lesson
  statusPickKey: null,       // which timed row's "…" status picker is open
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
function applyFieldState() {
  if (!plan.data) return;
  const today = todayStr();
  const items = dayItems(today, store.events, plan.data);
  const loggable = items.filter(it => it.kind === 'timed' || it.note || it.status !== undefined || true);
  const allDone = loggable.length > 0 && loggable.every(it => it.status === 'done');
  const hourFloat = new Date().getHours() + new Date().getMinutes() / 60;
  const late = !allDone && hourFloat >= 18 && loggable.some(it => it.status === undefined);
  document.body.className = allDone ? 'done' : late ? 'late' : 'day';
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
        const items = dayItems(today, store.events, plan.data);
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

  const items = dayItems(today, store.events, plan.data);
  const hourFloat = new Date().getHours() + new Date().getMinutes() / 60;
  const nb = nowBlock(today, items, hourFloat);

  h += `<div class="glass hero">`;
  if (nb.state === 'now') {
    const pct = Math.max(0, Math.min(100, ((hourFloat - nb.item.start) / (nb.item.end - nb.item.start)) * 100));
    h += `<div class="tiny">Right now · ${fmt(hourFloat)}</div>
      <div class="big">${esc(nb.item.name)}</div>
      <div class="pair"><span class="mono dim" style="font-size:13px">${fmt(nb.item.start)}–${fmt(nb.item.end)}</span><span class="rel">· ${fmtDur(nb.minutesLeft)} left</span></div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>`;
  } else if (nb.state === 'next') {
    h += `<div class="tiny">Next</div><div class="big">${fmt(nb.item.start)} ${esc(nb.item.name)}</div>
      <div class="pair"><span class="rel">in ${fmtDur(nb.minutesUntil)}</span></div>`;
  } else {
    h += `<div class="tiny">${today}</div><div class="big">${nb.left ? `${nb.left} left` : 'Day done 🎉'}</div>`;
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
  h += yesterdayHtml(addDays(today, -1));

  el.innerHTML = h;
  wireTodayEvents(el, items, today);
  if (window.__mObserveHero) window.__mObserveHero();
}

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
  let actions;
  if (isTbWbDaily) {
    // Not a toggle here — the dual textbook/workbook card below drives it.
    actions = `<span class="chk${checkCls}" aria-hidden="true">${checkGlyph}</span>`;
  } else if (it.kind === 'timed') {
    actions = `<span class="ractions">
      <button type="button" class="chk${checkCls}" data-check="${esc(it.key)}" aria-pressed="${st === 'done'}" aria-label="Mark ${esc(it.name)} done">${checkGlyph}</button>
      <button type="button" class="more-btn" data-more="${esc(it.key)}" aria-label="More statuses for ${esc(it.name)}">…</button>
    </span>`;
  } else {
    actions = `<button type="button" class="chk${checkCls}" data-daily="${esc(it.activityId)}" aria-pressed="${st === 'done'}" aria-label="Toggle ${esc(it.name)}">${checkGlyph}</button>`;
  }
  let row = `<div class="item" data-key="${esc(it.key)}">
    <span class="t mono">${it.kind === 'timed' ? esc(time) : '—'}</span>
    <span class="em" aria-hidden="true">${it.emoji}</span>
    <span class="n"><b>${esc(it.name)}</b>${it.note ? `<span>${esc(it.note)}</span>` : ''}</span>
    ${actions}
  </div>`;
  if (state.statusPickKey === it.key && it.kind === 'timed') {
    row += `<div class="status-pick" data-pick-for="${esc(it.key)}">
      <button type="button" data-pickst="done" class="${st === 'done' ? 'sel' : ''}">✓ Done</button>
      <button type="button" data-pickst="partial" class="${st === 'partial' ? 'sel' : ''}">◐ Didn't finish</button>
      <button type="button" data-pickst="missed" class="${st === 'missed' ? 'sel' : ''}">✗ Missed</button>
    </div>`;
  }
  return row;
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

function wireTodayEvents(el, items, today) {
  el.querySelectorAll('[data-check]').forEach(b => b.addEventListener('click', () => {
    const it = items.find(x => x.key === b.dataset.check);
    if (!it) return;
    logTimed(it.eventId || null, it.activityId || null, 'done');
    state.statusPickKey = null;
    showToast(`Logged ${esc(it.name)} ✓`, () => logTimed(it.eventId || null, it.activityId || null, 'done'));
    renderAll();
  }));
  el.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', () => {
    state.statusPickKey = state.statusPickKey === b.dataset.more ? null : b.dataset.more;
    renderToday();
  }));
  el.querySelectorAll('[data-pickst]').forEach(b => b.addEventListener('click', () => {
    const wrap = b.closest('[data-pick-for]');
    const it = items.find(x => x.key === wrap.dataset.pickFor);
    if (!it) return;
    logTimed(it.eventId || null, it.activityId || null, b.dataset.pickst);
    state.statusPickKey = null;
    showToast(`Logged ${esc(it.name)} ${b.dataset.pickst}`, () => logTimed(it.eventId || null, it.activityId || null, b.dataset.pickst));
    renderAll();
  }));
  el.querySelectorAll('[data-daily]').forEach(b => b.addEventListener('click', () => {
    togglePaced(b.dataset.daily);
    showToast(`Logged ✓`, () => togglePaced(b.dataset.daily));
    renderAll();
  }));
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

// ── Week tab (read-only) ─────────────────────────────────────
function renderWeek() {
  const el = $('tab-week');
  if (!plan.data) { el.innerHTML = ''; return; }
  const today = todayStr();
  const weekStart = mondayOf(today);
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let chips = '<div class="daychips">';
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const dNum = Number(d.slice(-2));
    chips += `<button type="button" class="daychip${d === state.weekDate ? ' on' : ''}${d === today ? ' today' : ''}" data-day="${d}"><b>${dNum}</b>${DOW[i]}</button>`;
  }
  chips += '</div>';

  const status = dayStatus(plan.data.periods, state.weekDate);
  let body;
  if (status.away) {
    body = `<div class="glass away-banner">${status.type === 'off' ? '⏸' : '✈'} ${esc((status.label || '').replace(/[✈⏸]/g, '').trim() || (status.type === 'off' ? 'Off' : 'Time away'))} · day ${status.dayN} of ${status.total}</div>`;
  } else {
    const items = dayItems(state.weekDate, store.events, plan.data);
    if (!items.length) body = `<div class="glass dim">Nothing scheduled.</div>`;
    else body = `<div class="glass">${items.map(it => `<div class="item">
      <span class="t mono">${it.kind === 'timed' ? esc(fmt(it.start)) : '—'}</span>
      <span class="em" aria-hidden="true">${it.emoji}</span>
      <span class="n"><b>${esc(it.name)}</b>${it.note ? `<span>${esc(it.note)}</span>` : ''}</span>
    </div>`).join('')}</div>`;
  }

  el.innerHTML = chips + body;
  el.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
    state.weekDate = b.dataset.day;
    renderWeek();
  }));
  wireWeekSwipe(el, weekStart);
}

function wireWeekSwipe(el, weekStart) {
  let startX = null;
  el.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    if (Math.abs(dx) < 40) return;
    const idx = daysBetween(weekStart, state.weekDate);
    const next = Math.max(0, Math.min(6, idx + (dx < 0 ? 1 : -1)));
    state.weekDate = addDays(weekStart, next);
    renderWeek();
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

function oopsRowHtml(act) {
  const last = [...plan.data.log].reverse().find(e =>
    e && e.activityId === act.id && !e.timed && !e.eventId);
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
    const last = [...plan.data.log].reverse().find(e => e && e.activityId === act.id && !e.timed && !e.eventId);
    if (last) togglePaced(act.id, last.date);
    closeSheet();
    renderAll();
  });
}

// ── Year tab (read-only) ─────────────────────────────────────
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
    h += `<div class="glass trip-card"><div><div class="tiny">Next</div><div class="big" style="font-size:17px">${next.type === 'off' ? '⏸' : '✈'} ${esc(label)}</div><div class="dim" style="font-size:12px">${fmtDateShort(next.start)} – ${fmtDateShort(next.end)}</div></div><div class="rel dim">in ${days} day${days === 1 ? '' : 's'}</div></div>`;
  }

  const acts = (plan.data.activities || []).filter(a => a.type === 'paced' && a.status === 'active' && actTotal(a) > 0);
  for (const a of acts) {
    const rows = chainTimeline(a, today, plan.data);
    const base = a.baseline?.rows;
    h += `<div class="psec">${esc(a.name)}</div><div class="glass">`;
    for (const r of rows.slice(0, 40)) {
      const planD = base ? base[r.key] : null;
      const state = r.complete ? '✓ done' : r.finish ? fmtDateShort(r.finish) : '—';
      h += `<div class="tl-mini"><span class="nm">${esc(r.label)}</span><span class="dt">${planD ? `plan ${fmtDateShort(planD)} · ` : ''}${state}</span></div>`;
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
