// mday.js — the ONE engine behind the /m PWA page and the Scriptable widget.
// PURE: no DOM, no fetch, no globals, no localStorage. Node-testable in
// isolation (tests/plan-mday.test.mjs). today.js's `timedFor`/`statusOf`/
// `dailyVisible` are thin wrappers around this module's `buildTimed`/
// `statusOfTimed`/`dailyVisible` — ONE implementation, so the desktop Today
// view and the phone app can never silently disagree about what "today"
// looks like.
//
// Emoji map is a straight port of aoife-school-bot/lib/compose.py's
// EMOJI_MAP (keyed off a template event's `cat` or an activity's own `id`);
// the tb-wb daily half/done/missed logic mirrors that file's `item_status`
// exactly, with one addition the bot doesn't need: a `half` status (only the
// textbook half of a lesson logged today) so the phone checkbox can show an
// amber in-between state instead of collapsing it into "nothing logged yet".
import { CATS } from '../model.js';
import {
  dayIdx, dayStatus, isWorkDay, currentCur, nextSession, okCls,
  actTotal, lessonTotals, chainTimeline, projectFinish, planDeltaChip,
  dailyStreak, mondayOf, addDays, compareSubjects, s2d,
} from './model.js';

// ── Emoji map (port of the bot's EMOJI_MAP) ─────────────────
export const EMOJI_MAP = {
  quran: '📖', ruhamah: '✏️', hala: '🕌', art: '🎨', barakot: '🏠',
  geography: '🌍', science: '🔬', jj: '🥋', loe: '📚', singapore: '➗',
};
export const EMOJI_FALLBACK = '📌';
export const emojiFor = key => (key != null && EMOJI_MAP[key]) || EMOJI_FALLBACK;

// ── Subject color dots (Subjects tab + Year) ────────────────
export const SUBJECT_COLORS = { singapore: '#e8834a', loe: '#5ea3f2', geography: '#4cc9b0' };
export const SUBJECT_COLOR_NEUTRAL = '#9aa0b4';
export const colorFor = id => SUBJECT_COLORS[id] || SUBJECT_COLOR_NEUTRAL;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const catLabelDefault = cat => CATS[cat]?.label || 'Event';

// A chain name like "3A Ch 1 · Numbers to 10,000" — the part the family
// actually calls the chapter is what comes before the em-dash-style "·".
// Mirrors subjects.js's own shortChainName (kept in sync deliberately: same
// idea, two small pure helpers, not worth a shared import for one line).
const shortChainName = c => String(c?.name || '').split('·')[0].trim();

// ── dailyVisible (moved from today.js — today.js re-exports this) ──
// A daily (no-time-slot) activity shows on a normal day; on a travel-type
// away day only if it doesn't pause for travel; never on an off-type day.
export function dailyVisible(act, status) {
  if (!status.away) return true;
  if (status.type === 'off') return false;
  return (act.travel?.mode || 'pause') !== 'pause';
}

// ── Timed blocks for a date (moved from today.js's timedFor) ───────
// `nameForEvent` defaults to a catLabels-UNAWARE fallback (this module never
// sees the store's catLabels renames — it only takes plain `events`); a
// caller that has catLabels (today.js's evLabel, or js/m.js) may pass its
// own resolver and get byte-identical names to the rest of the app. Order:
// template events for the weekday, then on-grid activity slots, then `add`
// overrides, minus anything `skip`ped — same three-source union + skip
// filter as the original, sorted by start.
export function buildTimed(dateStr, events, plan, nameForEvent = ev => ev.name || catLabelDefault(ev.cat)) {
  const d = dayIdx(dateStr);
  const activities = plan?.activities || [];
  const overrides = plan?.overrides || [];
  const items = [];
  for (const ev of (events || []).filter(e => e && e.day === d))
    items.push({ key: `ev:${ev.id}`, kind: 'timed', eventId: ev.id, activityId: undefined,
      cls: okCls(CATS[ev.cat]?.cls), name: nameForEvent(ev) || catLabelDefault(ev.cat),
      emoji: emojiFor(ev.cat), start: ev.start, end: ev.end, note: ev.note || '' });
  for (const a of activities.filter(a => a && a.status === 'active' && a.onGrid))
    for (const s of a.slots || [])
      if (s && s.day === d) {
        const cur = currentCur(a);
        items.push({ key: `act:${a.id}`, kind: 'timed', eventId: undefined, activityId: a.id,
          cls: okCls(a.cls), name: a.name, emoji: emojiFor(a.id), start: s.start, end: s.end,
          note: cur && nextSession(cur) ? nextSession(cur).label : '' });
      }
  for (const [i, o] of overrides.entries())
    if (o && o.date === dateStr && o.action === 'add') {
      const a = activities.find(x => x.id === o.activityId);
      items.push({ key: `ov:${o.id || i}`, kind: 'timed', eventId: o.id || undefined,
        activityId: o.activityId, cls: okCls(a?.cls),
        name: o.name || (a?.name || 'Extra') + ' · makeup', emoji: emojiFor(a?.id),
        start: o.start, end: o.end, note: o.note && o.note !== o.name ? o.note : '' });
    }
  const skips = new Set(overrides
    .filter(o => o && o.date === dateStr && o.action === 'skip')
    .map(o => o.eventId || `act:${o.activityId}`));
  return items.filter(it => !skips.has(it.eventId) && !skips.has(it.key))
    .sort((a, b) => a.start - b.start);
}

// ── Logged status for one timed item (moved from today.js's statusOf) ──
// A non-null key is REQUIRED to match (see today.js's own comment on this
// trap: keyless items must never cross-match on `undefined === undefined`).
export function statusOfTimed(plan, dateStr, it) {
  return (plan?.log || []).find(e => e && e.date === dateStr &&
    (it.eventId ? e.eventId === it.eventId
                : it.activityId != null && e.activityId === it.activityId && e.timed))?.status;
}

// ── Daily (no-slot) status: port of the bot's item_status, tb-wb half ──
// A tb-wb daily needs BOTH the textbook and workbook session of the SAME
// lesson logged TODAY before it reads 'done'; one half alone reads 'half'
// (the one addition over the bot, which just leaves it unanswered — see the
// module header). A marker row (a missed/partial entry, or ANY 'done' row
// with no curriculum — a plain daily bump) settles the day outright, same
// priority order as compose.py's item_status. A trailing review/test
// session (past the paired lesson sessions) is self-contained and reads
// 'done' alone, exactly like the bot.
export function dailyStatus(act, log, dateStr) {
  const entries = (Array.isArray(log) ? log : []).filter(e =>
    e && e.date === dateStr && e.activityId === act?.id && !e.timed && !e.eventId);
  if (!entries.length) return undefined;
  const marker = entries.find(e => e.status !== 'done' || !e.curriculum);
  if (marker) return marker.status;
  const cur = (act.chain || []).find(c => c && c.id === entries[0].curriculum);
  if (!cur || cur.pattern !== 'tb-wb') return 'done';
  const sessionsToday = entries
    .filter(e => e.status === 'done' && typeof e.session === 'number')
    .map(e => e.session).sort((a, b) => a - b);
  if (!sessionsToday.length) return undefined;
  const latest = sessionsToday[sessionsToday.length - 1];
  const paired = (cur.lessons || 0) * 2;
  if (latest >= paired) return 'done';               // trailing test/review: self-contained
  const latestLesson = Math.floor(latest / 2);
  const count = sessionsToday.filter(s => Math.floor(s / 2) === latestLesson).length;
  return count >= 2 ? 'done' : 'half';
}

function noteForDaily(cur) {
  if (!cur) return '';
  const ns = nextSession(cur);
  if (!ns) return '';
  const prefix = cur.pattern === 'tb-wb' ? shortChainName(cur) : '';
  return prefix ? `${prefix} · ${ns.label}` : ns.label;
}

// ── dayItems: the whole day's list, timed first then no-slot dailies ──
export function dayItems(dateStr, events, plan) {
  const status = dayStatus(plan?.periods, dateStr);
  const timed = status.away ? [] : buildTimed(dateStr, events, plan)
    .map(it => ({ ...it, status: statusOfTimed(plan, dateStr, it) }));
  const dailies = (plan?.activities || []).filter(a =>
    a && a.status === 'active' && a.type === 'paced' && !a.onGrid && dailyVisible(a, status));
  const dailyItems = dailies.map(a => {
    const cur = currentCur(a);
    return { key: `act:${a.id}`, kind: 'daily', eventId: undefined, activityId: a.id,
      name: a.name || a.id, emoji: emojiFor(a.id), note: noteForDaily(cur),
      status: dailyStatus(a, plan?.log, dateStr) };
  });
  return [...timed, ...dailyItems];
}

// ── dayHeader: date label, Mama work/home, away banner ──────
const awayLabelFor = status => {
  const l = String(status.label || '').replace(/[✈⏸]/g, '').trim();
  return l || (status.type === 'off' ? 'Off' : 'Time away');
};

export function dayHeader(dateStr, plan) {
  const idx = dayIdx(dateStr);
  const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const d = s2d(dateStr);
  const dateLabel = `${DAYS_SHORT[idx]} ${MON[d.getMonth()]} ${d.getDate()}`;
  const hasCycle = (plan?.activities || []).some(a => a && a.status === 'active' && a.rhythm?.kind === 'cycle');
  const mama = hasCycle ? (isWorkDay(plan.parentCycle, dateStr) ? 'work' : 'home') : null;
  const status = dayStatus(plan?.periods, dateStr);
  const away = status.away ? { type: status.type, label: awayLabelFor(status) } : null;
  return { dateLabel, mama, away };
}

// ── nowBlock: the current timed item, or the next one, or "day done" ──
export function nowBlock(dateStr, items, hourFloat) {
  const timed = (items || []).filter(it => it.kind === 'timed' && it.start != null && it.end != null);
  const current = timed.find(it => hourFloat >= it.start && hourFloat < it.end);
  if (current) return { state: 'now', item: current,
    minutesLeft: Math.max(0, Math.round((current.end - hourFloat) * 60)) };
  const next = timed.filter(it => it.start > hourFloat).sort((a, b) => a.start - b.start)[0];
  if (next) return { state: 'next', item: next,
    minutesUntil: Math.max(0, Math.round((next.start - hourFloat) * 60)) };
  const left = (items || []).filter(it => !it.status).length;
  return { state: 'after', item: null, left };
}

// ── subjectCards: one card per PACED subject, in SUBJECT_ORDER ──
// Planned/parked subjects come through too (status carried on the card so
// the page can dim them), but only an ACTIVE subject gets a projected
// finish/delta — projecting a date for a subject that hasn't started yet
// would be fiction (same rule subjects.js's paceLine already applies).
export function subjectCards(plan, dateStr) {
  const acts = (plan?.activities || []).filter(a => a && a.type === 'paced');
  return [...acts].sort(compareSubjects).map(a => {
    const lt = lessonTotals(a);
    const pct = lt.total ? Math.round((lt.done / lt.total) * 100) : 0;
    const cur = currentCur(a);
    const ns = cur ? nextSession(cur) : null;
    const isTbWb = cur?.pattern === 'tb-wb';
    let chapterLabel = null, chapterDone = null, chapterSessions = null;
    if (isTbWb) {
      const lessons = Math.max(0, cur.lessons || 0);
      const done = Math.min(Math.max(0, cur.done || 0), lessons * 2);
      chapterLabel = cur.name || cur.id;
      chapterDone = Math.floor(done / 2) + (done % 2 ? 0.5 : 0);
      chapterSessions = lessons;
    }
    let finish = null, delta = null;
    if (a.status === 'active' && actTotal(a) > 0) {
      const fin = projectFinish(a, dateStr, plan);
      if (fin) {
        finish = fin.date;
        const rows = chainTimeline(a, dateStr, plan);
        const curRow = [...rows].reverse().find(r => !r.complete && r.sessions > 0);
        const base = a.baseline?.rows;
        delta = curRow ? planDeltaChip(curRow.finish, base ? base[curRow.key] : null) : null;
      }
    }
    const weekStart = mondayOf(dateStr), weekEnd = addDays(weekStart, 6);
    const sessionsThisWeek = (Array.isArray(plan?.log) ? plan.log : []).filter(e =>
      e && e.activityId === a.id && e.status === 'done' && e.date >= weekStart && e.date <= weekEnd).length;
    return {
      id: a.id, name: a.name || a.id, color: colorFor(a.id), status: a.status,
      lessonsDone: lt.done, lessonsTotal: lt.total, pct, finish, delta,
      streak: dailyStreak(plan?.log, a.id, plan?.periods, dateStr),
      chapterLabel, chapterDone, chapterSessions,
      nextLabel: ns ? ns.label : null, isTbWb, sessionsThisWeek,
    };
  });
}

// ── widgetModel: the exact strings the Scriptable widget renders ────
// Times as h:mm, no am/pm (mirror of the bot's fmt_hm morning-preview
// style — mornings read like 24h without the suffix; afternoon hours are
// 12-hour, same as the bot).
export function fmtHM(hour) {
  let hh = Math.floor(hour), mm = Math.round((hour - hh) * 60);
  if (mm === 60) { hh += 1; mm = 0; }
  const h12 = hh > 12 ? hh - 12 : hh === 0 ? 12 : hh;
  return `${h12}:${String(mm).padStart(2, '0')}`;
}

// "Ruhama — ELA/Math" -> "Ruhama" (year.js's own shortName idiom).
const shortName = n => String(n || '').split('—')[0].trim() || String(n || '').trim();
// A couple of subjects read better by their family nickname than a plain
// truncation ("Singapore Math" -> "Singapore", "Logic of English" -> "LoE");
// anything else falls back to the generic em-dash split.
const WIDGET_NICK = { singapore: 'Singapore', loe: 'LoE' };
const widgetName = it => WIDGET_NICK[it.activityId] || shortName(it.name);

export function widgetModel(dateStr, events, plan, hourFloat) {
  const items = dayItems(dateStr, events, plan);
  const header = dayHeader(dateStr, plan);
  const idx = dayIdx(dateStr);
  const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dayLabel = `Today · ${DAYS_SHORT[idx]}`;
  const first = items[0] ? `${fmtHM(items[0].start ?? 0)} ${widgetName(items[0])}`.trim() : '';
  let rest = '';
  if (items[1]) {
    const restNames = items.slice(2).map(widgetName);
    rest = `${fmtHM(items[1].start ?? 0)} ${widgetName(items[1])}` +
      (restNames.length ? ` · then ${restNames.join(' + ')}` : '');
  }
  const done = items.filter(it => it.status === 'done').length;
  const mama = header.mama ? `Mama: ${header.mama} day` : '';
  return { dayLabel, first, rest, done, total: items.length, mama };
}
