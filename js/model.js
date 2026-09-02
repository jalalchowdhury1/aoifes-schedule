// Pure data model — no DOM, no storage. Imported by the app and by Node tests.
// The event shape and category keys are the v1 storage contract: DO NOT CHANGE.

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const S = 9;      // grid start hour (9am)
export const E = 17;     // grid end hour (5pm)
export const SPH = 66;   // screen pixels per hour
export const PPH = 72;   // print pixels per hour (644px total — fits letter AND A4 landscape with headroom for up to ~110% print scale)

export const CATS = {
  quran:   { label: 'Quran',                                  cls: 'q'  },
  ruhamah: { label: 'Ruhama — ELA/Math',                 cls: 'r'  },
  hala:    { label: 'Miss Hala — Arabic/Islamic Studies', cls: 'h' },
  barakot: { label: 'Barrington trip',                        cls: 'b'  },
  art:     { label: 'Art Class with Ayra',                    cls: 'a'  },
  other:   { label: 'Other',                                  cls: 'ot' },
};

export function fmt(h) {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60), ap = hh >= 12 ? 'pm' : 'am';
  const h12 = hh > 12 ? hh - 12 : hh === 0 ? 12 : hh;
  return mm ? `${h12}:${String(mm).padStart(2, '0')}${ap}` : `${h12}${ap}`;
}

export const snap = h => Math.round(h * 2) / 2;
export const clampStart = (start, dur) => Math.max(S, Math.min(E - dur, start));
export const clampEnd = (start, end) => Math.min(E, Math.max(start + 0.5, end));

// JS Date.getDay() (Sun=0) -> Mon-first index (Mon=0 ... Sun=6)
export const todayIndex = jsDay => (jsDay + 6) % 7;

export const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function defEvents() {
  let n = 0;
  const uid = () => `e${++n}`;
  return [
    ...[0, 2, 4].map(d => ({ id: uid(), cat: 'quran', day: d, start: 10, end: 11, note: '', name: '' })),
    { id: uid(), cat: 'ruhamah', day: 0, start: 11, end: 13, note: '2-hr session', name: '' },
    { id: uid(), cat: 'ruhamah', day: 1, start: 11, end: 12, note: '', name: '' },
    { id: uid(), cat: 'ruhamah', day: 3, start: 11, end: 12, note: '', name: '' },
    { id: uid(), cat: 'ruhamah', day: 5, start: 11, end: 13, note: '2-hr session', name: '' },
    { id: uid(), cat: 'ruhamah', day: 6, start: 11, end: 13, note: 'Regular Sun — every other week at 10am', name: '' },
    ...[1, 2, 3].map(d => ({ id: uid(), cat: 'hala', day: d, start: 14, end: 16, note: '', name: '' })),
    { id: uid(), cat: 'barakot', day: 6, start: 9, end: 10, note: 'Mostly Sundays', name: 'Barrington trip' },
  ];
}

export const maxIdNum = events =>
  events.reduce((mx, e) => Math.max(mx, parseInt(String(e.id).replace('e', ''), 10) || 0), 0);

// An event may additionally carry `ask: false` (additive, 2026-09-02): the
// Optional `emoji` on an event: shown in the phone's Week grid / Today rows instead
// of the category's default (Jumu'ah 🤲; cat 'other' would otherwise fall back to 📌).
// block is real on the calendar/grid/print, but no ✓/◐/✗ question is ever
// asked about it (Jumu'ah) — isValidEvent/sanitizeEvents/updateEvent all
// pass it through untouched since none of them check beyond the keys below.
export const isValidEvent = e =>
  !!e && typeof e === 'object' && 'id' in e && 'cat' in e &&
  typeof e.day === 'number' && typeof e.start === 'number' && typeof e.end === 'number';
export const sanitizeEvents = events => (Array.isArray(events) ? events.filter(isValidEvent) : []);

export const serialize = ({ events, altSun, catLabels }) =>
  JSON.stringify({ events, altSun, catLabels });

export const applyAltSun = (events, altSun) =>
  events.map(ev =>
    ev.cat === 'ruhamah' && ev.day === 6
      ? altSun
        ? { ...ev, start: 10, end: 12, note: 'Alt Sunday — Ruhamah at 10am' }
        : { ...ev, start: 11, end: 13, note: 'Regular Sun — every other week at 10am' }
      : ev
  );
