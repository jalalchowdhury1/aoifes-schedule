import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAYS, S, E, SPH, PPH, CATS, fmt, snap, clampStart, clampEnd,
  todayIndex, defEvents, maxIdNum, serialize, applyAltSun, esc,
} from '../js/model.js';

test('constants match the v1 contract', () => {
  assert.deepEqual(DAYS, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.equal(S, 9);
  assert.equal(E, 17);
  assert.equal(SPH, 66);
  assert.equal(PPH, 78);
  assert.deepEqual(Object.keys(CATS), ['quran', 'ruhamah', 'hala', 'barakot', 'art', 'other']);
});

test('fmt renders 12-hour times', () => {
  assert.equal(fmt(9), '9am');
  assert.equal(fmt(10.5), '10:30am');
  assert.equal(fmt(12), '12pm');
  assert.equal(fmt(13), '1pm');
  assert.equal(fmt(16.5), '4:30pm');
});

test('snap rounds to half hours', () => {
  assert.equal(snap(10.2), 10);
  assert.equal(snap(10.3), 10.5);
  assert.equal(snap(10.76), 11);
});

test('clamps keep events inside 9-17', () => {
  assert.equal(clampStart(8, 1), 9);          // too early -> 9
  assert.equal(clampStart(16.5, 1), 16);      // 1h event can start at 16 latest
  assert.equal(clampEnd(10, 9), 10.5);        // end can never be <= start
  assert.equal(clampEnd(10, 20), 17);         // end capped at 17
});

test('todayIndex maps JS getDay (Sun=0) to Mon-first index', () => {
  assert.equal(todayIndex(0), 6); // Sunday
  assert.equal(todayIndex(1), 0); // Monday
  assert.equal(todayIndex(6), 5); // Saturday
});

test('defEvents matches the v1 default schedule', () => {
  const evs = defEvents();
  assert.equal(evs.length, 12);
  for (const e of evs) {
    assert.deepEqual(Object.keys(e).sort(), ['cat', 'day', 'end', 'id', 'name', 'note', 'start']);
    assert.match(e.id, /^e\d+$/);
  }
  assert.equal(evs.filter(e => e.cat === 'quran').length, 3);
  assert.equal(evs.filter(e => e.cat === 'ruhamah').length, 5);
  assert.equal(evs.filter(e => e.cat === 'hala').length, 3);
  assert.equal(evs.filter(e => e.cat === 'barakot').length, 1);

  assert.deepEqual(evs.filter(e => e.cat === 'quran').map(e => [e.day, e.start, e.end]), [[0, 10, 11], [2, 10, 11], [4, 10, 11]]);
  assert.deepEqual(evs.filter(e => e.cat === 'hala').map(e => [e.day, e.start, e.end]), [[1, 14, 16], [2, 14, 16], [3, 14, 16]]);
  const sun = evs.find(e => e.cat === 'ruhamah' && e.day === 6);
  assert.deepEqual([sun.start, sun.end, sun.note], [11, 13, 'Regular Sun — every other week at 10am']);
  const bara = evs.find(e => e.cat === 'barakot');
  assert.deepEqual([bara.day, bara.start, bara.end, bara.note, bara.name], [6, 9, 10, 'Mostly Sundays', 'Barrington trip']);
  assert.deepEqual(evs.map(e => e.id), ['e1','e2','e3','e4','e5','e6','e7','e8','e9','e10','e11','e12']);
});

test('maxIdNum finds the highest numeric id', () => {
  assert.equal(maxIdNum([{ id: 'e3' }, { id: 'e11' }, { id: 'e7' }]), 11);
  assert.equal(maxIdNum([]), 0);
});

test('serialize produces the exact v1 storage shape', () => {
  const state = { events: defEvents(), altSun: true, catLabels: { quran: 'Q' }, junk: 'ignored' };
  const parsed = JSON.parse(serialize(state));
  assert.deepEqual(Object.keys(parsed), ['events', 'altSun', 'catLabels']);
  assert.equal(parsed.altSun, true);
  assert.deepEqual(parsed.catLabels, { quran: 'Q' });
  assert.equal(parsed.events.length, 12);
});

test('applyAltSun toggles the Sunday Ruhamah slot both ways', () => {
  const alt = applyAltSun(defEvents(), true);
  const sun = alt.find(e => e.cat === 'ruhamah' && e.day === 6);
  assert.equal(sun.start, 10);
  assert.equal(sun.end, 12);
  assert.equal(sun.note, 'Alt Sunday — Ruhamah at 10am');
  const back = applyAltSun(alt, false).find(e => e.cat === 'ruhamah' && e.day === 6);
  assert.equal(back.start, 11);
  assert.equal(back.end, 13);
  assert.equal(back.note, 'Regular Sun — every other week at 10am');
});

test('esc neutralizes HTML metacharacters', () => {
  assert.equal(esc('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
});
