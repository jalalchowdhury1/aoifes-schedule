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
  dayIdx, dayStatus, isWorkDay, currentCur, nextSession, okCls, sessionsCount,
  actTotal, lessonTotals, chainTimeline, projectFinish, planDeltaChip, paceGapLessons,
  dailyStreak, mondayOf, addDays, compareSubjects, s2d, sessionLabel,
  expectedSessions, dayAway, nextIndex, isSessionDone, timelineRows,
} from './model.js';

// ── Emoji map (port of the bot's EMOJI_MAP) ─────────────────
export const EMOJI_MAP = {
  quran: '📖', ruhamah: '✏️', hala: '🕌', art: '🎨', barakot: '🏠',
  geography: '🌍', science: '🔬', jj: '🥋', loe: '📚', singapore: '➗',
};
export const EMOJI_FALLBACK = '📌';
export const emojiFor = key => (key != null && EMOJI_MAP[key]) || EMOJI_FALLBACK;

// ── Subject color dots (Subjects tab + Year) ────────────────
export const SUBJECT_COLORS = { singapore: '#e8834a', loe: '#5ea3f2', geography: '#4cc9b0', science: '#378add' };
export const SUBJECT_COLOR_NEUTRAL = '#9aa0b4';
export const colorFor = id => SUBJECT_COLORS[id] || SUBJECT_COLOR_NEUTRAL;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
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
      emoji: ev.emoji || emojiFor(ev.cat), start: ev.start, end: ev.end, note: ev.note || '',
      // A template event may opt out of ever being asked about (Jumu'ah,
      // `ask: false`) — the block stays real (grid/print/calendar/"now-next"
      // untouched) but day-done counts and the ✓/◐/✗ controls skip it.
      ask: ev.ask !== false });
  for (const a of activities.filter(a => a && a.status === 'active' && a.onGrid))
    for (const s of a.slots || [])
      if (s && s.day === d) {
        const cur = currentCur(a);
        items.push({ key: `act:${a.id}`, kind: 'timed', eventId: undefined, activityId: a.id,
          cls: okCls(a.cls), name: a.name, emoji: emojiFor(a.id), start: s.start, end: s.end,
          note: cur && nextSession(cur) ? nextSession(cur).label : '', ask: true });
      }
  for (const [i, o] of overrides.entries())
    if (o && o.date === dateStr && o.action === 'add') {
      const a = activities.find(x => x.id === o.activityId);
      items.push({ key: `ov:${o.id || i}`, kind: 'timed', eventId: o.id || undefined,
        activityId: o.activityId, cls: okCls(a?.cls),
        name: o.name || (a?.name || 'Extra') + ' · makeup', emoji: emojiFor(a?.id),
        start: o.start, end: o.end, note: o.note && o.note !== o.name ? o.note : '', ask: true });
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

// ── tbWbCard: the phone's Singapore-style lesson card, as a pure model ──
// The card used to be two buttons that BOTH meant "advance to whatever is
// next", with the violet highlight marking which one that happened to be. On
// a real phone (2026-08-31) that reads as "Textbook is selected", so the next
// tap on Workbook looks like a second choice — and was in fact an UNDO, since
// both buttons called togglePaced and togglePaced is a per-day toggle. Two
// things were missing and both live here now:
//   * every half is its OWN session index, with its own done/next/undoable
//     state, so a button says WHAT IT IS rather than what comes next;
//   * more than one lesson a day is expressible — every lesson touched today
//     keeps a row, and the next one is offered behind an explicit ➕ so it is
//     a deliberate tap and never an accident.
// Ordering is still the chain's: `done` is a COUNT, so a workbook half cannot
// be logged over an unlogged textbook half without fabricating it. A half
// whose turn has not come carries `needs` (the label that must be tapped
// first) and the page refuses the write with that name in the toast.
// Pure — js/m.js renders it, tests/plan-mday.test.mjs pins it.
export const HALF_LABELS = ['Textbook', 'Workbook'];

// What ONE session's button says: inside the paired region a lesson's two
// halves are just 'Textbook'/'Workbook' (the lesson number lives on the row),
// past it a trailing chapter review rides on sessionLabel's own 'Test n'.
export function halfLabel(cur, session) {
  const paired = Math.max(0, (cur?.lessons || 0) * 2);
  return session < paired ? HALF_LABELS[session % 2] : sessionLabel(cur, session);
}

export function tbWbCard(act, cur, log, dateStr, extraOpen = false) {
  if (!act || !cur || cur.pattern !== 'tb-wb') return null;
  const total = sessionsCount(cur);
  if (!total) return null;                    // counts still pending: nothing to tap
  const paired = Math.max(0, (cur.lessons || 0) * 2);
  const done = Math.min(Math.max(0, cur.done || 0), total);
  const ni = nextIndex(cur);                  // the lowest OWED slot if any, else the fresh next
  const rows = (Array.isArray(log) ? log : []).filter(e =>
    e && e.activityId === act.id && e.status === 'done' && !e.timed && !e.eventId &&
    e.curriculum && typeof e.session === 'number');
  // "Did anything at all get logged today?" spans EVERY chapter, not just the
  // open one: a day that finished 3A Ch 1 and rolled into Ch 2 has nothing
  // logged against Ch 2 yet, and must still gate its first lesson behind ➕
  // instead of laying a fresh pair of buttons under the family's thumb.
  const anyToday = rows.some(e => e.date === dateStr);
  // A `done` counter bumped without log rows (a Claude session's bulk set)
  // leaves loggedOn null — the half reads ticked and simply is not undoable
  // here, which is honest: there is no row on this date to take back.
  const dateOf = s => rows.find(e => e.curriculum === cur.id && e.session === s)?.date || null;
  const item = s => {
    const on = dateOf(s);
    const done_ = isSessionDone(cur, s);
    return { session: s, label: halfLabel(cur, s), fullLabel: sessionLabel(cur, s),
      done: done_, loggedOn: on, undoable: !!on && on === dateStr, next: s === ni,
      needs: (!done_ && s !== ni && ni != null) ? halfLabel(cur, ni) : null };
  };
  const base = { chapter: shortChainName(cur), curId: cur.id,
    doneSessions: done, totalSessions: total };

  if (ni == null || ni >= paired) {           // trailing chapter review(s), self-contained
    const tests = [];
    for (let s = paired; s < total; s++) tests.push(item(s));
    return { ...base, lessons: [], tests, addLesson: null,
      currentLabel: ni == null ? null : sessionLabel(cur, ni) };
  }

  const current = Math.floor(ni / 2) + 1;     // first lesson with a half still owed
  const inProgress = ni % 2 === 1;            // textbook logged, workbook outstanding
  // An OWED lesson (below the high-water mark, from `skipped`) is unfinished
  // work, never a voluntary new addition — it must show unconditionally, the
  // same as an in-progress lesson, rather than sit behind the ➕ gate meant
  // for "start a further lesson today".
  const owed = Array.isArray(cur.skipped) && cur.skipped.length > 0;
  const lessonsToday = [...new Set(rows
    .filter(e => e.date === dateStr && e.curriculum === cur.id && e.session < paired)
    .map(e => Math.floor(e.session / 2) + 1))];
  const showCurrent = inProgress || !anyToday || !!extraOpen || owed;
  const nums = [...new Set([...lessonsToday, ...(showCurrent ? [current] : [])])]
    .sort((a, b) => a - b);
  return { ...base, tests: [], currentLabel: `L${current}`,
    lessons: nums.map(n => ({ lesson: n, halves: [item((n - 1) * 2), item((n - 1) * 2 + 1)] })),
    addLesson: showCurrent ? null : current };
}

function noteForDaily(cur) {
  if (!cur) return '';
  const ns = nextSession(cur);
  if (!ns) return '';
  const prefix = cur.pattern === 'tb-wb' ? shortChainName(cur) : '';
  return prefix ? `${prefix} · ${ns.label}` : ns.label;
}

// ── receipt: a short, COLLAPSED recap of what actually got logged on a past
// date (planner-v2.9 polish round B) — the phone's "Yesterday" line and a
// tapped past day on Week both read this instead of a raw one-row-per-tap
// dump. A timed block is one row, keyed off its own logged status (no
// collapsing needed — one block, one status). A no-slot daily COLLAPSES its
// raw session taps: a tb-wb chain's textbook+workbook rows for the same
// lesson become ONE line naming every distinct lesson touched that day
// ("Singapore L2 + L3" — floor(session/2)+1 is the lesson number, same math
// tbWbCardHtml already uses), a simple chain's rows become one line per
// distinct session label (sessionLabel, the exact string year.js's
// historyRows shows). A marker row (missed/partial, or a plain 'done' bump
// with no curriculum) is its own mark-only line — same priority as
// dailyStatus: a marker settles the whole day, so it wins over any session
// rows logged alongside it. `nameForEvent` is passed straight through to
// buildTimed (see its own comment) so a catLabels rename shows here too.
// Exported as `statusMark` too: the Week tab's today rows and the receipt rows
// draw the same glyph for the same status (2026-08-31 week-glance round).
const markFor = status => status === 'done' ? '✓' : status === 'half' || status === 'partial' ? '◐' : '✗';
export const statusMark = markFor;

// One receipt line's lesson detail for a paced activity's rows on the day —
// the tb-wb half/pair folding and the simple-chain label list. Shared by the
// timed pass (an on-grid class whose ✓ also logged its lesson, 2026-09-01)
// and the no-slot dailies pass, so both read identically.
function lessonDetail(act, entries) {
  const byChain = new Map();
  for (const e of entries) {
    if (!byChain.has(e.curriculum)) byChain.set(e.curriculum, []);
    byChain.get(e.curriculum).push(e);
  }
  const details = [];
  for (const [curId, es] of byChain) {
    const cur = (act.chain || []).find(c => c && c.id === curId);
    if (!cur) continue;
    if (cur.pattern === 'tb-wb') {
      // Mirror sessionLabel/_tb_wb_paired_sessions' own paired-region
      // boundary (review 2 fix): a session at or past `lessons*2` is a
      // trailing, unpaired review/test (the real dm3 shape — a chapter
      // with an odd `tests` count, e.g. dm3-c4/c7/c11/c15 in production)
      // and has no lesson number to fold into — the naive floor(session/2)
      // math used to fabricate one ('L11' for the first test after an
      // 10-lesson/20-session chapter). It now renders via sessionLabel
      // itself ('Test 1'), same as the bot. Inside the paired region, a
      // lesson touched by BOTH halves collapses to 'L6'; a lone half (the
      // day only got the textbook, or only the workbook — an unfinished
      // pair, still a real thing to show on a past day even though
      // dailyStatus itself reads 'half' rather than 'done' for it) stays
      // 'L6 textbook' / 'L6 workbook' rather than silently dropping which
      // half actually happened.
      const paired = (cur.lessons || 0) * 2;
      const lessonHalves = new Map();      // lesson# -> Set(0=textbook,1=workbook)
      const trailing = new Set();
      for (const e of es) {
        const s = e.session ?? 0;
        if (s >= paired) { trailing.add(s); continue; }
        const lesson = Math.floor(s / 2) + 1;
        if (!lessonHalves.has(lesson)) lessonHalves.set(lesson, new Set());
        lessonHalves.get(lesson).add(s % 2);
      }
      const lessonParts = [...lessonHalves.entries()].sort((a, b) => a[0] - b[0])
        .map(([n, halves]) => halves.size >= 2 ? `L${n}` : `L${n} ${halves.has(1) ? 'workbook' : 'textbook'}`);
      const trailingParts = [...trailing].sort((a, b) => a - b).map(s => sessionLabel(cur, s));
      details.push([...lessonParts, ...trailingParts].join(' + '));
    } else {
      const labels = [...new Set(es.map(e => sessionLabel(cur, e.session ?? 0)))];
      details.push(labels.join(' + '));
    }
  }
  return details.filter(Boolean).join(' · ');
}

export function receipt(dateStr, events, plan, nameForEvent) {
  const out = [];
  const byAct = new Map();
  for (const e of plan?.log || []) {
    if (!e || e.date !== dateStr || e.timed || e.eventId || e.activityId == null) continue;
    if (!byAct.has(e.activityId)) byAct.set(e.activityId, []);
    byAct.get(e.activityId).push(e);
  }
  const timed = buildTimed(dateStr, events, plan, nameForEvent);
  for (const it of timed) {
    const st = statusOfTimed(plan, dateStr, it);
    if (st == null) continue;
    // An on-grid class whose ✓ also logged its lesson (logTimed, 2026-09-01)
    // leaves two rows for one class: fold the lesson label into this timed
    // line and take the activity out of the dailies pass below, or the day
    // would read "Geography ✓" twice.
    //
    // L8 (red-team 2026-09-02): when several timed items share an
    // activityId — the act: slot PLUS a same-day ov: makeup — only the act:
    // item is the real lesson slot; the ov: one stays a bare line. Without
    // this check, whichever item happened to sort FIRST by start time (not
    // necessarily act:) grabbed the shared byAct entries. When there is no
    // act: item at all for this activityId (only ov: makeups, say), the
    // first one processed still takes it — today's behaviour, unchanged.
    let detail = '';
    const entries = it.activityId != null ? byAct.get(it.activityId) : null;
    if (entries) {
      const hasActItem = timed.some(x => x.activityId === it.activityId && x.key.startsWith('act:'));
      if (!hasActItem || it.key.startsWith('act:')) {
        const act = (plan?.activities || []).find(a => a && a.id === it.activityId);
        const marker = entries.find(e => e.status !== 'done' || !e.curriculum);
        if (act && !marker) detail = lessonDetail(act, entries);
        byAct.delete(it.activityId);
      }
    }
    out.push({ emoji: it.emoji, name: widgetName(it), mark: markFor(st), detail });
  }
  for (const [actId, entries] of byAct) {
    const act = (plan?.activities || []).find(a => a && a.id === actId);
    if (!act) continue;
    const nick = WIDGET_NICK[actId] || shortName(act.name || act.id);
    const marker = entries.find(e => e.status !== 'done' || !e.curriculum);
    if (marker) { out.push({ emoji: emojiFor(actId), name: nick, mark: markFor(marker.status), detail: '' }); continue; }
    out.push({ emoji: emojiFor(actId), name: nick, mark: '✓', detail: lessonDetail(act, entries) });
  }
  return out;
}

// ── dayItems: the whole day's list, timed first then no-slot dailies ──
// `nameForEvent` (see buildTimed) is optional and passed straight through —
// a caller with catLabels renames (js/m.js, the widget) can get the SAME
// renamed names the desktop Today view shows; without it the plain
// CATS-default label is used, same as before this parameter existed.
export function dayItems(dateStr, events, plan, nameForEvent) {
  const status = dayStatus(plan?.periods, dateStr);
  const timed = status.away ? [] : buildTimed(dateStr, events, plan, nameForEvent)
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
  const d = s2d(dateStr);
  const dateLabel = `${DAYS_SHORT[idx]} ${MON[d.getMonth()]} ${d.getDate()}`;
  const hasCycle = (plan?.activities || []).some(a => a && a.status === 'active' && a.rhythm?.kind === 'cycle');
  const mama = hasCycle ? (isWorkDay(plan.parentCycle, dateStr) ? 'work' : 'home') : null;
  const status = dayStatus(plan?.periods, dateStr);
  const away = status.away ? { type: status.type, label: awayLabelFor(status) } : null;
  return { dateLabel, mama, away };
}

// ── dayState: the ONE function behind both the Today hero and the field's
// state color (planner-v2.9 polish round) — "single source of truth" so a
// hero that says "3 left" and a field that has already gone green can never
// happen at once. Five phases:
//   'now'   — inside a timed block: {item, minutesLeft}
//   'next'  — before one: {item, minutesUntil}
//   'done'  — after the last timed block (or an all-daily day) and every
//             loggable item has SOME status — done/partial/missed all count
//             as "answered", same as the bot's unlogged_items check: a
//             recorded miss is not "still open". {answered, total}
//   'left'  — after the last timed block, something has no status yet:
//             {left, names, answered, total, late} — `late` is hourFloat>=18,
//             carried here (not left to the caller) so the field color and
//             the hero copy can never read the clock two different ways.
//   'empty' — nothing loggable exists for the date at all (an away day with
//             every daily paused, say): {left:0, total:0}
export function dayState(items, hourFloat) {
  const timed = (items || []).filter(it => it.kind === 'timed' && it.start != null && it.end != null);
  const current = timed.find(it => hourFloat >= it.start && hourFloat < it.end);
  if (current) return { phase: 'now', item: current,
    minutesLeft: Math.max(0, Math.round((current.end - hourFloat) * 60)) };
  const next = timed.filter(it => it.start > hourFloat).sort((a, b) => a.start - b.start)[0];
  if (next) return { phase: 'next', item: next,
    minutesUntil: Math.max(0, Math.round((next.start - hourFloat) * 60)) };
  // An ask:false block (Jumu'ah) is real — the current/next phases above see
  // it like any other timed block — but nobody is ever asked whether it
  // happened, so it drops out of total/unlogged/left/names from here down.
  const all = (items || []).filter(it => it.ask !== false);
  const total = all.length;
  if (!total) return { phase: 'empty', left: 0, total: 0 };
  const unlogged = all.filter(it => it.status == null);
  const left = unlogged.length;
  if (!left) return { phase: 'done', left: 0, total, answered: total };
  return { phase: 'left', left, total, answered: total - left,
    names: unlogged.map(it => it.name), late: hourFloat >= 18 };
}

// The field's body class (css/m.css body.day/.done/.late), derived from the
// SAME dayState the hero reads — 'now'/'next'/an on-time 'left' all read as
// "in progress" (violet); 'done' is green; only a LATE 'left' goes amber.
export function fieldClassFor(state) {
  if (state.phase === 'done') return 'done';
  if (state.phase === 'left' && state.late) return 'late';
  return 'day';
}

// ── nowBlock: thin back-compat wrapper over dayState (kept for the
// top-compact bar, which only ever wants "what's running/next") ──
export function nowBlock(dateStr, items, hourFloat) {
  const ds = dayState(items, hourFloat);
  if (ds.phase === 'now') return { state: 'now', item: ds.item, minutesLeft: ds.minutesLeft };
  if (ds.phase === 'next') return { state: 'next', item: ds.item, minutesUntil: ds.minutesUntil };
  return { state: 'after', item: null, left: ds.left };
}

// ── chapterPills: the Subjects card's per-chapter capsules (user sketch 2026-09-02,
//    style "C · fold the finished") ─────────────────────────────────────────
// One pill per tb-wb chapter, or per timelineRows band of a simple chain (LoE's
// fives; Geography's tens). Three shapes, chosen by STATE so the eye lands on
// the one that matters: a finished group folds to a solid "Ch 1 ✓" pill, the
// CURRENT group opens up with its dots (full / half = textbook only / empty, ◆
// reviews) and a done/total count, a future group is a hollow pill with its
// size. Exactly one group is `cur` — the first with anything left — so the
// glow never appears twice. Pure; rendered by m.js pillHtml.
export function chapterPills(act) {
  const chain = Array.isArray(act?.chain) ? act.chain : [];
  const rows = chain.some(c => c && c.pattern === 'simple') ? timelineRows(act) : [];
  const out = [];
  let curSeen = false;
  const push = g => { if (!curSeen && !g.complete) { g.kind = 'cur'; curSeen = true; } else g.kind = g.complete ? 'done' : 'todo'; out.push(g); };
  for (const c of chain) {
    if (!c || !c.pattern) continue;
    if (c.pattern === 'tb-wb') {
      const L = Math.max(0, c.lessons || 0); if (!L) continue;
      const d = Math.min(Math.max(0, c.done || 0), L * 2), T = Math.max(0, c.tests || 0);
      const dots = Array.from({ length: L }, (_, i) => d >= (i + 1) * 2 ? 'full' : d === i * 2 + 1 ? 'half' : 'empty');
      const revs = Array.from({ length: T }, (_, k) => (c.done || 0) > L * 2 + k);
      const m = /Ch\s*(\d+)/.exec(c.name || '');
      push({ key: c.id, short: m ? `Ch ${m[1]}` : shortName(c.name || c.id), label: c.name || c.id,
        dots, revs, done: Math.floor(d / 2) + (d % 2 ? 0.5 : 0), total: L,
        complete: d >= L * 2 && revs.every(Boolean) });
    } else if (c.pattern === 'simple') {
      for (const r of rows.filter(r => r.chainId === c.id)) {
        if (!r.sessions) continue;
        const m = /(\d+)\s*[–-]\s*(\d+)/.exec(r.label || '');
        push({ key: r.key, short: m ? `${m[1]}–${m[2]}` : r.label, label: r.label,
          dots: Array.from({ length: r.sessions }, (_, i) => i < r.done ? 'full' : 'empty'), revs: [],
          done: r.done, total: r.sessions, complete: r.done >= r.sessions });
      }
    }
  }
  return out;
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
    // Lesson rows only: an on-grid class also carries a `timed` attendance row
    // for the same date (logTimed, 2026-09-01), and that is not a second session.
    const sessionsThisWeek = (Array.isArray(plan?.log) ? plan.log : []).filter(e =>
      e && e.activityId === a.id && e.status === 'done' && !e.timed && !e.eventId &&
      e.date >= weekStart && e.date <= weekEnd).length;
    return {
      id: a.id, name: a.name || a.id, color: colorFor(a.id), status: a.status,
      lessonsDone: lt.done, lessonsTotal: lt.total, pct, finish, delta,
      // `delta` is derived from two projected DATES (exact days since
      // 2026-09-05, Sundays before) — fine as a coarse chip, useless as a
      // precise claim. `pace` is the honest one: sessions logged against
      // sessions this subject's own plan expected (paceGap in model.js).
      pace: paceGapLessons(a, plan, dateStr),
      streak: dailyStreak(plan?.log, a.id, plan?.periods, dateStr),
      chapterLabel, chapterDone, chapterSessions,
      nextLabel: ns ? ns.label : null, isTbWb, sessionsThisWeek,
      pills: a.status === 'active' ? chapterPills(a) : [],
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

// A daily (no-slot) item has no `start` — only a TIMED item earns the h:mm
// prefix. Widget-model callers hit this for real: a day with 0 or 1 timed
// blocks still has no-slot dailies in items[0]/items[1], and prefixing one
// with a fabricated "12:00" (h=0 -> fmtHM(0)) would invent a time slot that
// does not exist (caught 2026-08-31 verifying the live deploy against a real
// Sunday with only one timed block).
const widgetLabel = it => (it.kind === 'timed' ? `${fmtHM(it.start)} ${widgetName(it)}` : widgetName(it));

export function widgetModel(dateStr, events, plan, hourFloat, nameForEvent) {
  const items = dayItems(dateStr, events, plan, nameForEvent);
  const header = dayHeader(dateStr, plan);
  const idx = dayIdx(dateStr);
  const dayLabel = `Today · ${DAYS_SHORT[idx]}`;
  const first = items[0] ? widgetLabel(items[0]) : '';
  let rest = '';
  if (items[1]) {
    const restNames = items.slice(2).map(widgetName);
    rest = widgetLabel(items[1]) + (restNames.length ? ` · then ${restNames.join(' + ')}` : '');
  }
  const done = items.filter(it => it.status === 'done').length;
  const mama = header.mama ? `Mama: ${header.mama} day` : '';
  return { dayLabel, first, rest, done, total: items.length, mama };
}

// A local-time ISO-ish stamp with NO trailing offset/Z — the Date Time String
// Format (ES2015+) parses a date-time form (has a "T") with no zone as LOCAL
// time, so `new Date(isoLocal(...))` on the phone lands on the phone's own
// clock, matching todayStr()/localHourFloat()'s existing "device clock only"
// rule (see widget-ui.js's header comment). A date-ONLY string ("2026-08-31")
// would parse as UTC instead — that's why the "T00:00:00" time part matters.
function isoLocal(dateStr, hourFloat) {
  let hh = Math.floor(hourFloat), mm = Math.round((hourFloat - hh) * 60);
  if (mm === 60) { hh += 1; mm = 0; }
  return `${dateStr}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

// ── widgetNext: what the redesigned widget actually draws — "hours/minutes
// to the next class, its name, and a small line of what's left today"
// (2026-08-31 redesign; widgetModel above is kept for compatibility but no
// longer used by scripts/widget-ui.js). Deliberately COARSER than dayState:
// picking the current/next timed block is TIME-ONLY off the day's `timed`
// blocks (ignores any already-logged status on that same block — same as
// dayState/the hero elsewhere — so a block backfilled with a status ahead of
// its own clock time still counts as "next" until its start time actually
// passes; see tests/plan-mday.test.mjs's 2026-08-30 08:00 case, where Ruhama
// is already logged 'missed' yet is still the widget's "next" class at that
// hour). 'rest', however, DOES drop anything already logged — that is the
// one place "logged" matters here.
//   'now'  — a timed block is running: countdown target = its end.
//   'next' — a later timed block exists today: countdown target = its start.
//   'done' — every timed block for the day is in the past (there WERE some)
//            — independent of whether the day's dailies are logged yet; the
//            "All done ✓" vs "N left" split is left to widget-ui.js off
//            doneCount/total, not encoded in the mode.
//   'none' — no timed blocks at all today (including an away day, where
//            dayItems/buildTimed already empty out `timed`).
const LOOKAHEAD_CAP = 14;

// Walk forward from the day AFTER `dateStr`, up to LOOKAHEAD_CAP days, for the
// first date carrying at least one TIMED item — used once today's own timed
// blocks are done/none (2026-09-01 addition: "even after all done for today,
// show the next class with the countdown"). Reuses `dayItems` per candidate
// date so away days, skip overrides and one-off adds all apply exactly as
// they would if that date were "today" — a trip period (buildTimed emptied
// by dayItems' own away check) is walked straight through with NOTHING
// leaking from it, including a 'reduced'-travel daily that's still VISIBLE
// on those days: this only ever looks at `kind === 'timed'`, so a daily
// alone never counts as "found". `rest` is that day's remaining timed
// blocks then its no-slot dailies, unfiltered by logged status — nothing
// is logged on a date that hasn't happened yet. Returns null (never a
// partial/misleading result) if nothing turns up within the cap, so the
// caller falls back to the plain 'done'/'none' rendering.
function lookAheadNext(dateStr, events, plan, nameForEvent) {
  for (let n = 1; n <= LOOKAHEAD_CAP; n++) {
    const d = addDays(dateStr, n);
    const items = dayItems(d, events, plan, nameForEvent);
    const futureTimed = items.filter(it => it.kind === 'timed').sort((a, b) => a.start - b.start);
    if (!futureTimed.length) continue;
    const [next, ...later] = futureTimed;
    const rest = [...later.map(widgetLabel), ...items.filter(it => it.kind === 'daily').map(widgetName)];
    return { mode: 'next', name: widgetName(next), at: isoLocal(d, next.start),
      atLabel: `${DAYS_SHORT[dayIdx(d)]} ${fmtHM(next.start)}`, rest };
  }
  return null;
}

export function widgetNext(dateStr, events, plan, now, nameForEvent) {
  const hourFloat = now.getHours() + now.getMinutes() / 60;
  const status = dayStatus(plan?.periods, dateStr);
  const timed = status.away ? [] : buildTimed(dateStr, events, plan, nameForEvent)
    .map(it => ({ ...it, status: statusOfTimed(plan, dateStr, it) }));
  const dailies = (plan?.activities || []).filter(a =>
    a && a.status === 'active' && a.type === 'paced' && !a.onGrid && dailyVisible(a, status));
  const dailyItems = dailies.map(a => ({
    key: `act:${a.id}`, kind: 'daily', activityId: a.id, name: a.name || a.id,
    status: dailyStatus(a, plan?.log, dateStr),
  }));
  // `ask:false` blocks (Jumu'ah) stay on the timeline (now/next/"then …") but
  // are not tasks: they never get a status, so they leave the done/total count.
  const countable = [...timed.filter(it => it.ask !== false), ...dailyItems];
  const total = countable.length;
  const doneCount = countable.filter(it => it.status != null).length;
  const unloggedDailies = dailyItems.filter(it => it.status == null).map(widgetName);

  const current = timed.find(it => hourFloat >= it.start && hourFloat < it.end);
  const anchor = current || timed.filter(it => it.start > hourFloat).sort((a, b) => a.start - b.start)[0];
  if (anchor) {
    const laterTimed = timed
      .filter(it => it.start > anchor.start && it.status == null)
      .sort((a, b) => a.start - b.start)
      .map(widgetLabel);
    const rest = [...laterTimed, ...unloggedDailies];
    return current
      ? { mode: 'now', name: widgetName(current), at: isoLocal(dateStr, current.end),
          atLabel: fmtHM(current.end), rest, doneCount, total }
      : { mode: 'next', name: widgetName(anchor), at: isoLocal(dateStr, anchor.start),
          atLabel: fmtHM(anchor.start), rest, doneCount, total };
  }
  const ahead = lookAheadNext(dateStr, events, plan, nameForEvent);
  if (ahead) return { ...ahead, doneCount, total };
  return { mode: timed.length ? 'done' : 'none', name: null, at: null, atLabel: null,
    rest: unloggedDailies, doneCount, total };
}


// ── Week at a glance (2026-08-31) ───────────────────────────
// The /m Week tab used to be seven chips and ONE day's list — you had to tap
// every day to learn anything, and the "Mama: work" caption read Monday's
// state only although a Charlton duty stretch runs Tue→Mon (so Mon and
// Tue–Sun are usually opposite). `weekGlance` is the pure model behind the
// redesigned tab: the week's timed blocks laid on an hour axis, a per-day
// cell for every paced daily, honest Mama runs, the week's numbers in pairs,
// and the one-offs/skips/away days that differ from the recurring template.
// js/m.js only draws it; tests/plan-mday.test.mjs pins it on real fixture
// weeks.

// The chip dot (moved here from js/m.js's dotClassFor so the chip and the
// dailies rail can never disagree): green = every loggable item done, red =
// anything missed, amber = something logged but not everything, null for an
// empty day or a future day.
export function dayDot(items, dateStr, today) {
  if (dateStr > today) return null;
  if (!items || !items.length) return null;
  if (items.some(it => it.status === 'missed')) return 'red';
  if (items.every(it => it.status === 'done')) return 'grn';
  if (items.some(it => it.status != null)) return 'amb';
  return null;
}

const DOW3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const rangeDow = (a, b) => (a === b ? DOW3[a] : `${DOW3[a]}–${DOW3[b]}`);

// Consecutive-day runs of the parent cycle across Mon..Sun, e.g.
// [{state:'work', from:0, to:0}, {state:'home', from:1, to:6}]; empty when no
// active activity rides the cycle (same gate dayHeader uses for its caption).
export function mamaRuns(plan, weekStart) {
  const hasCycle = (plan?.activities || []).some(a => a && a.status === 'active' && a.rhythm?.kind === 'cycle');
  if (!hasCycle) return [];
  const runs = [];
  for (let i = 0; i < 7; i++) {
    const state = isWorkDay(plan.parentCycle, addDays(weekStart, i)) ? 'work' : 'home';
    const last = runs[runs.length - 1];
    if (last && last.state === state) last.to = i;
    else runs.push({ state, from: i, to: i });
  }
  return runs;
}
export const mamaLabel = runs => !runs.length ? ''
  : runs.length === 1 ? `Mama: ${runs[0].state}`
  : 'Mama: ' + runs.map(r => `${r.state} ${rangeDow(r.from, r.to)}`).join(' · ');

// h → "10am" / "12pm" / "2:30pm" — the grid's own compact clock.
export function fmtClock(h) {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${hh < 12 ? 'am' : 'pm'}`;
}

export function weekGlance(weekStart, events, plan, today, nameForEvent) {
  const weekEnd = addDays(weekStart, 6);
  const dailies = (plan?.activities || []).filter(a =>
    a && a.status === 'active' && a.type === 'paced' && !a.onGrid);
  const days = [];
  let hourMin = Infinity, hourMax = -Infinity;
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const st = dayStatus(plan?.periods, date);
    const items = dayItems(date, events, plan, nameForEvent);
    const timed = items.filter(it => it.kind === 'timed').map(it => ({
      key: it.key, start: it.start, end: it.end, cls: it.cls, name: it.name,
      emoji: it.emoji, status: it.status ?? null, oneOff: it.key.startsWith('ov:'),
      ask: it.ask !== false,
    }));
    for (const t of timed) { hourMin = Math.min(hourMin, t.start); hourMax = Math.max(hourMax, t.end); }
    const cells = dailies.map(a => {
      const visible = dailyVisible(a, st);
      return { id: a.id, color: colorFor(a.id), visible,
        status: visible ? (dailyStatus(a, plan?.log, date) ?? null) : null };
    });
    // The block still draws on the hour axis (it's real) but an ask:false
    // item (Jumu'ah) never counts toward the day's dot — nobody is ever asked
    // about it, so it must never read as "amber"/"missed" for having no status.
    const countable = items.filter(it => it.ask !== false);
    days.push({
      date, idx: i, dow: DOW3[i], dNum: Number(date.slice(-2)),
      isToday: date === today, isPast: date < today,
      away: st.away ? { type: st.type, label: awayLabelFor(st), dayN: st.dayN, total: st.total } : null,
      timed, dailies: cells, dot: st.away ? null : dayDot(countable, date, today),
    });
  }
  if (!Number.isFinite(hourMin)) { hourMin = null; hourMax = null; }
  else {
    hourMin = Math.floor(hourMin); hourMax = Math.ceil(hourMax);
    if (hourMax - hourMin < 6) hourMax = hourMin + 6;    // a two-block week still gets a readable axis
  }

  // The week's numbers. `total` counts every timed block on a non-away day
  // (an away day contributes none — dayItems already empties it); `elapsed`
  // is the part of that already behind us, so a current week can say "5
  // left" honestly.
  const all = days.flatMap(d => d.timed.filter(t => t.ask).map(t => ({ ...t, date: d.date })));
  const timedSum = {
    total: all.length,
    done: all.filter(t => t.status === 'done').length,
    missed: all.filter(t => t.status === 'missed').length,
    elapsed: all.filter(t => t.date <= today).length,
  };
  const log = Array.isArray(plan?.log) ? plan.log : [];
  const paced = dailies.map(a => {
    const cur = currentCur(a);
    const per = cur?.pattern === 'tb-wb' ? 2 : 1;
    const sessions = log.filter(e => e && e.activityId === a.id && e.status === 'done' &&
      !e.timed && !e.eventId && e.curriculum && e.date >= weekStart && e.date <= weekEnd).length;
    const expected = expectedSessions(a, weekStart, weekEnd, plan);
    return { id: a.id, name: a.name || a.id, short: WIDGET_NICK[a.id] || shortName(a.name || a.id),
      color: colorFor(a.id), sessions, expected, per,
      unit: per === 2 ? 'lessons' : 'sessions' };
  });

  // What differs from the recurring template this week: dated one-offs,
  // skips, and away runs (an away period that straddles the week is clipped
  // to it, with the day-of-trip count from its first day in the week).
  const changes = [];
  const overrides = Array.isArray(plan?.overrides) ? plan.overrides : [];
  for (const o of overrides) {
    if (!o || o.date < weekStart || o.date > weekEnd) continue;
    const i = dayIdx(o.date);
    if (o.action === 'add') {
      const a = (plan?.activities || []).find(x => x && x.id === o.activityId);
      changes.push({ kind: 'add', date: o.date, dow: DOW3[i], sort: `${o.date}${String(o.start).padStart(5, '0')}`,
        label: o.name || (a?.name || 'Extra') + ' · makeup',
        time: Number.isFinite(o.start) && Number.isFinite(o.end) ? `${fmtClock(o.start)}–${fmtClock(o.end)}` : '' });
    } else if (o.action === 'skip') {
      const ev = (events || []).find(e => e && e.id === o.eventId);
      const a = (plan?.activities || []).find(x => x && x.id === o.activityId);
      const name = ev ? (nameForEvent ? nameForEvent(ev) : ev.name) || catLabelDefault(ev.cat) : (a?.name || 'Class');
      changes.push({ kind: 'skip', date: o.date, dow: DOW3[i], sort: `${o.date}zz`, label: name,
        time: ev && Number.isFinite(ev.start) ? fmtClock(ev.start) : '' });
    }
  }
  let i = 0;
  while (i < 7) {
    const d = days[i];
    if (!d.away) { i++; continue; }
    let j = i;
    while (j + 1 < 7 && days[j + 1].away && days[j + 1].away.label === d.away.label) j++;
    changes.push({ kind: d.away.type === 'off' ? 'off' : 'away', date: d.date, dow: rangeDow(i, j),
      sort: `${d.date}00`, label: d.away.label,
      time: d.away.total > 1 ? `day ${d.away.dayN}${j > i ? `–${d.away.dayN + (j - i)}` : ''} of ${d.away.total}` : '' });
    i = j + 1;
  }
  changes.sort((a, b) => a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0);

  const runs = mamaRuns(plan, weekStart);
  return { weekStart, weekEnd, hourMin, hourMax, days, mamaRuns: runs, mamaLabel: mamaLabel(runs),
    timed: timedSum, paced, changes };
}
