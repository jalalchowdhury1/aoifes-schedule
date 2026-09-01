// m/widget.js is GENERATED (scripts/build-widget.mjs) from js/model.js +
// js/plan/model.js + js/plan/mday.js + scripts/widget-ui.js. These tests
// cover what a Node process CAN verify without a phone: the bundle is
// syntactically legal for Scriptable's engine (no ESM syntax, no top-level
// await, no browser globals), the build is deterministic, and the exact
// strings widget-ui.js draws (via widgetNext, the 2026-08-31 redesign —
// countdown to the next/current class + the rest of today) match the
// fixture. Drawing itself (ListWidget/Font/Color/addDate calls) can only be
// eyeballed on-device or via a throwaway stub harness — not part of this
// suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildBundle, stripModuleSyntax, SOURCES } from '../scripts/build-widget.mjs';
import { sanitizePlan } from '../js/plan/model.js';
import { widgetNext } from '../js/plan/mday.js';

const { bundle: bundleA, hash: hashA } = buildBundle();

test('bundle hygiene: no import/export syntax, no top-level await, no browser globals', () => {
  // Strip the module header comment before scanning (it legitimately talks
  // ABOUT imports/exports in prose).
  const body = bundleA.split('*/').slice(1).join('*/');
  assert.doesNotMatch(body, /^\s*import\s/m, 'no import statement survives the strip');
  assert.doesNotMatch(body, /^\s*export\s/m, 'no export keyword survives the strip');
  assert.doesNotMatch(body, /^\s*await\s/m, 'no top-level await (must be inside the async IIFE)');
  assert.doesNotMatch(body, /\bdocument\./, 'no document usage — Scriptable has no DOM');
  // Real usage only (`localStorage.getItem(...)`) — the source files' own
  // header comments legitimately SAY "no localStorage" in prose (mday.js:
  // "PURE: no DOM, no fetch, no globals, no localStorage.").
  assert.doesNotMatch(body, /\blocalStorage(\.\w+\(|\[)/, 'no localStorage usage — Scriptable has no web storage');
  assert.match(bundleA, /\n\(async \(\) => \{\n/, 'wrapped in an async IIFE (after the header comment)');
  assert.match(bundleA.trim(), /\}\)\(\);$/, 'the IIFE is actually invoked');
});

test('deterministic rebuild: building twice from the same sources is byte-for-byte identical', () => {
  const { bundle: bundleB, hash: hashB } = buildBundle();
  assert.equal(bundleA, bundleB);
  assert.equal(hashA, hashB);
});

test('deterministic rebuild: the hash changes when a source byte changes', () => {
  const { hash: mutated } = buildBundle(rel =>
    (rel === 'scripts/widget-ui.js' ? '// mutated\n' : readFileSync(pathFor(rel), 'utf8')));
  assert.notEqual(mutated, hashA);
});

function pathFor(rel) {
  return new URL(`../${rel}`, import.meta.url);
}

test('stripModuleSyntax: strips both single-line and multi-line import blocks, and export keywords, leaving the declaration', () => {
  const src = `import { CATS } from '../model.js';
import {
  dayIdx, dayStatus,
} from './model.js';
export function dayItems() {}
export const X = 1;
export async function run() {}
`;
  const out = stripModuleSyntax(src);
  assert.doesNotMatch(out, /import/);
  assert.doesNotMatch(out, /export/);
  assert.match(out, /function dayItems\(\) \{\}/);
  assert.match(out, /const X = 1;/);
  assert.match(out, /async function run\(\) \{\}/);
});

test('SOURCES lists the real engine files in dependency order (root model before plan/model before mday)', () => {
  assert.deepEqual(SOURCES, ['js/model.js', 'js/plan/model.js', 'js/plan/mday.js', 'scripts/widget-ui.js']);
});

// ── widgetNext strings for the fixture (same contract widget-ui.js draws) ──
// jj (Jiu Jitsu) is an active onGrid Monday 16-17 slot as of 2026-08-30 —
// tests/fixtures/plan-mday-plan.json was refreshed from the live
// /api/plan-get to reflect that (it used to be 'planned' with no slots).
const events = JSON.parse(readFileSync(new URL('./fixtures/plan-mday-schedule.json', import.meta.url), 'utf8')).events;
const plan = sanitizePlan(JSON.parse(readFileSync(new URL('./fixtures/plan-mday-plan.json', import.meta.url), 'utf8')));

test('widgetNext: Mon Aug 31 09:30 fixture — the exact strings the widget layout consumes', () => {
  const m = widgetNext('2026-08-31', events, plan, new Date(2026, 7, 31, 9, 30));
  assert.equal(m.mode, 'next');                              // widget-ui.js's "NEXT CLASS" caption
  assert.equal(m.name, 'Quran');
  assert.equal(m.atLabel, '10:00');
  assert.equal(m.at, '2026-08-31T10:00:00');                 // fed to addDate().applyRelativeStyle()
  assert.deepEqual(m.rest, ['11:00 Ruhama', '4:00 Jiu Jitsu', 'Singapore', 'LoE']);
  assert.equal(`${m.doneCount}/${m.total}`, '0/5');
});

test('widgetNext: Mon Aug 31 12:00 fixture — "now" mode, the widget\'s "NOW · until …" caption', () => {
  const m = widgetNext('2026-08-31', events, plan, new Date(2026, 7, 31, 12, 0));
  assert.equal(m.mode, 'now');
  assert.equal(m.name, 'Ruhama');
  assert.equal(m.atLabel, '1:00');                           // widget-ui.js: `NOW · until ${atLabel}`
});


test('widget tap opens /m in SAFARI via the x-safari-https scheme (Nabila\'s default browser is Chrome)', () => {
  const ui = readFileSync(new URL('../scripts/widget-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /w\.url = `x-safari-\$\{APP_BASE\}\/m\/`/);
  assert.match(readFileSync(new URL('../m/widget.js', import.meta.url), 'utf8'), /x-safari-\$\{APP_BASE\}\/m\//);
});
