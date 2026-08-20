#!/usr/bin/env node
// planner-v2.8 live-data migration — spec §1/§2/§5-data/Geography.
// COMMITTED BUT NOT RUN AS PART OF THIS RELEASE. Run by hand, after v2.8 has
// been deployed and tagged, with:
//   node scripts/migrate-v28.mjs
// Every edit checks the CURRENT fetched state before applying itself, so the
// whole script is safe to run twice (or more) — see the per-edit comments
// for exactly how each one stays idempotent. It fetches the live plan,
// applies every edit in memory, POSTs the result with `base` (so a
// concurrent bot/family write merges instead of being clobbered — see
// AGENTS.md "Concurrent writes & merge"), then GETs again and verifies
// every single edit actually landed, printing a ✅/❌ checklist. Nothing here
// is run automatically; nothing here touches localStorage or the browser.
import { readFileSync, existsSync } from 'node:fs';
import { chainTimeline } from '../js/plan/model.js';

const SITE = process.env.AOIFE_SITE_URL || 'https://aoifes-schedule.vercel.app';
const GET_URL = `${SITE}/api/plan-get`;
const SAVE_URL = `${SITE}/api/plan-save`;

// "Today" as of the family feedback session this migration implements
// (2026-08-19) — the exact date the spec's log row and re-baseline are
// anchored to, so re-running the script on a LATER calendar day still
// produces the identical, idempotent result rather than drifting.
const MIGRATION_DATE = '2026-08-19';

const GEO_TITLES_PATH = '/private/tmp/claude-501/-Users-jalalchowdhury/d162264c-538b-499e-a540-927ddba563ba/scratchpad/geography_titles.json';
// The book states "This is a 30-week program" (TOC confirmed: Wk1 intro,
// 2-5 N.America, 6-9 S.America, 10-14 Europe, 15-19 Asia, 20-24 Africa,
// 25-27 Oceania, 28-30 Antarctica/review) — NOT 36 as first assumed in
// AGENTS.md's open-items note. lastUnit moves to 30 so the card reads 0/30
// with no phantom "Week 31-36" labels; firstUnit (1) is unchanged.
const GEO_LAST_UNIT = 30;

const findAct = (plan, id) => (Array.isArray(plan.activities) ? plan.activities : []).find(a => a && a.id === id);
const findChain = (act, id) => (Array.isArray(act?.chain) ? act.chain : []).find(c => c && c.id === id);

// ── §2: loe-c / loe-d chain shape ────────────────────────────
// Idempotent by construction: only fields that differ from the target are
// written, so a second run touches nothing.
function applyLoeChainEdits(plan) {
  const loe = findAct(plan, 'loe');
  if (!loe) return { ok: false, reason: 'activity "loe" not found' };
  const edits = [
    [findChain(loe, 'loe-c'), { firstUnit: 101, lastUnit: 120, done: 2, bandSize: 5 }],
    [findChain(loe, 'loe-d'), { firstUnit: 121, lastUnit: 160, done: 0, bandSize: 5 }],
  ];
  let changed = false;
  for (const [chain, want] of edits) {
    if (!chain) return { ok: false, reason: 'loe-c/loe-d chain missing' };
    for (const [k, v] of Object.entries(want)) if (chain[k] !== v) { chain[k] = v; changed = true; }
  }
  return { ok: true, changed };
}

// ── §2: remap loe-c's pre-migration log rows ─────────────────
// Old numbering counted sessions from 81 (firstUnit was 81); new numbering
// counts from 101. To keep the SAME lesson mapped: 81+old = 101+new, so
// new = old-20. A row with old session < 20 names a lesson before 101
// (81-100, pre-tracking under the new window) — its session index can't be
// remapped into range, so it keeps its `curriculum` (never nulled — history
// views must still be able to group it) and instead gets an explicit
// `label: "Lesson <81+old>"` so sessionLabel() is never consulted for it
// (views prefer row.label, per T3/T6).
//
// IDEMPOTENCY: once a row is remapped, its NEW session is always < 20 (the
// chain now only has 20 valid indices), which is indistinguishable from an
// original pre-tracking row's session on a second read — so remapping
// cannot be safely re-derived from session value alone. Each touched row is
// stamped `v28Remap: true`; a second run skips any row that already carries
// it, so nothing is ever double-shifted or wrongly re-labeled. Rows without
// that stamp and without curriculum:'loe-c' are never touched.
function remapLoeCLogRows(plan) {
  const log = Array.isArray(plan.log) ? plan.log : [];
  let remapped = 0, labeled = 0, skipped = 0;
  for (const e of log) {
    if (!e || e.curriculum !== 'loe-c' || typeof e.session !== 'number') continue;
    // A row dated ON OR AFTER migration day is new-numbering territory by
    // construction (the spec's own precondition: "no LoE row exists today"
    // before this script appends one) — never a pre-migration row that needs
    // remapping. Belt-and-braces alongside the v28Remap marker below: this
    // guard is what keeps the row appendLesson102Row() creates (session 1,
    // no marker yet in the SAME run) from being caught if step order ever
    // changed, and protects any real tick logged on migration day itself.
    if (e.date >= MIGRATION_DATE) { skipped++; continue; }
    if (e.v28Remap === true) { skipped++; continue; }
    if (e.session >= 20) { e.session = e.session - 20; remapped++; }
    else { e.label = `Lesson ${81 + e.session}`; labeled++; }
    e.v28Remap = true;
  }
  return { ok: true, remapped, labeled, skipped };
}

// ── §2: append today's log row for lesson 102 ────────────────
// Idempotent: only appends when no `done` row for `loe` exists on
// MIGRATION_DATE yet (matches the spec's own stated precondition — verified
// live done was 21 through lesson 101, so 102 is the very next tick).
function appendLesson102Row(plan) {
  plan.log = Array.isArray(plan.log) ? plan.log : [];
  const already = plan.log.some(e => e && e.activityId === 'loe' && e.date === MIGRATION_DATE && e.status === 'done');
  if (already) return { ok: true, changed: false };
  plan.log.push({ date: MIGRATION_DATE, activityId: 'loe', status: 'done', curriculum: 'loe-c', session: 1 });
  return { ok: true, changed: true };
}

// ── §1: core-mama display rename ─────────────────────────────
function renameCoreMama(plan) {
  const a = findAct(plan, 'core-mama');
  if (!a) return { ok: false, reason: 'activity "core-mama" not found' };
  const changed = a.name !== 'Miscellaneous';
  a.name = 'Miscellaneous';
  return { ok: true, changed };
}

// ── §4/§5: clear stale static notes (replaced by computed lines) ──
function clearNotes(plan) {
  let changed = false;
  for (const id of ['singapore', 'loe']) {
    const a = findAct(plan, id);
    if (a && 'note' in a) { delete a.note; changed = true; }
  }
  return { ok: true, changed };
}

// ── §2: re-freeze the LoE baseline (setBaseline semantics) ───
// Band keys changed shape (bandSize 10 -> 5), which orphans the old
// baseline rows entirely, so this REPLACES loe.baseline the same way the
// Subjects "Re-baseline" button does — freeze every unfinished, dated row
// AS OF MIGRATION_DATE (never live todayStr(), so re-running the script
// later reproduces byte-identical output rather than drifting the
// reference plan). Singapore's baseline is a completely separate object on
// a completely separate activity and is never touched here.
function refreezeLoeBaseline(plan) {
  const loe = findAct(plan, 'loe');
  if (!loe) return { ok: false, reason: 'activity "loe" not found' };
  const rows = {};
  for (const r of chainTimeline(loe, MIGRATION_DATE, plan))
    if (!r.complete && r.finish) rows[r.key] = r.finish;
  loe.baseline = { setOn: MIGRATION_DATE, rows };
  return { ok: true };
}

// ── Geography: unit titles + 30-week correction (data-only) ──
// Skips silently (not an error) when the titles file isn't there — Claude
// sessions bulk-load this once it's provided, per AGENTS.md's open item.
function applyGeographyTitles(plan) {
  if (!existsSync(GEO_TITLES_PATH)) return { ok: true, skipped: true };
  let titles;
  try { titles = JSON.parse(readFileSync(GEO_TITLES_PATH, 'utf8')); }
  catch (e) { return { ok: false, reason: `unreadable titles JSON: ${e.message}` }; }
  const geography = findAct(plan, 'geography');
  const geo1 = findChain(geography, 'geo-1');
  if (!geography || !geo1) return { ok: false, reason: 'activity "geography" or chain "geo-1" not found' };
  geo1.titles = { ...titles };
  geo1.lastUnit = GEO_LAST_UNIT;                    // 30-week program, not 36 (book TOC verified)
  const changed = 'note' in geography;
  if (changed) delete geography.note;
  return { ok: true, skipped: false, changed };
}

// ── Fetch helpers (mirrors AGENTS.md's double-wrap / unwrap convention) ──
async function fetchPlan() {
  const res = await fetch(GET_URL);
  const data = await res.json();
  if (!data || data.error) throw new Error(`plan-get failed: ${data?.error || res.status}`);
  return data;
}

async function savePlan(plan, base) {
  const res = await fetch(SAVE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: JSON.stringify(plan), ...(base ? { base } : {}) }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.error) throw new Error(`plan-save failed: ${data?.error || res.status}`);
  return data;
}

// ── Verification: re-fetch and check every edit actually landed ──
function verify(plan, { singaporeBaselineBefore, geoTitlesApplied }) {
  const checks = [];
  const check = (label, pass) => checks.push({ label, pass: !!pass });

  const loe = findAct(plan, 'loe');
  const loeC = findChain(loe, 'loe-c'), loeD = findChain(loe, 'loe-d');
  check('loe-c = {firstUnit:101, lastUnit:120, done:2, bandSize:5}',
    loeC && loeC.firstUnit === 101 && loeC.lastUnit === 120 && loeC.done === 2 && loeC.bandSize === 5);
  check('loe-d = {firstUnit:121, lastUnit:160, done:0, bandSize:5}',
    loeD && loeD.firstUnit === 121 && loeD.lastUnit === 160 && loeD.done === 0 && loeD.bandSize === 5);

  const loeCRows = (plan.log || []).filter(e => e && e.curriculum === 'loe-c');
  check('no loe-c log row has session >= 20 (all remapped)', loeCRows.every(e => e.session < 20));
  // A labeled row is always a pre-tracking one (a remapped ex->=20 row never
  // gets a label) — check that whichever rows DO carry one are well-formed,
  // rather than asserting every remapped row has one (it must NOT).
  check('every labeled loe-c row keeps its curriculum and a well-formed "Lesson <n>" label',
    loeCRows.filter(e => e.label != null).every(e => e.curriculum === 'loe-c' && /^Lesson \d+$/.test(e.label)));

  check(`a done "loe" row exists on ${MIGRATION_DATE} (curriculum loe-c, session 1)`,
    (plan.log || []).some(e => e && e.activityId === 'loe' && e.date === MIGRATION_DATE &&
      e.status === 'done' && e.curriculum === 'loe-c' && e.session === 1));

  const mama = findAct(plan, 'core-mama');
  check('core-mama.name === "Miscellaneous"', mama && mama.name === 'Miscellaneous');

  const singapore = findAct(plan, 'singapore');
  check('singapore.note deleted', singapore && !('note' in singapore));
  check('loe.note deleted', loe && !('note' in loe));

  check(`loe.baseline re-frozen as-of ${MIGRATION_DATE} with new (bandSize=5) row keys`,
    loe && loe.baseline && loe.baseline.setOn === MIGRATION_DATE &&
    Object.keys(loe.baseline.rows || {}).some(k => k.startsWith('loe-c:') || k.startsWith('loe-d:')));
  check('singapore.baseline left untouched',
    JSON.stringify(singapore?.baseline ?? null) === JSON.stringify(singaporeBaselineBefore ?? null));

  if (geoTitlesApplied) {
    const geography = findAct(plan, 'geography');
    const geo1 = findChain(geography, 'geo-1');
    const titles = geo1?.titles || {};
    check('geo-1.lastUnit === 30', geo1 && geo1.lastUnit === GEO_LAST_UNIT);
    check('geo-1.titles has exactly 30 entries', Object.keys(titles).length === 30);
    check(`geo-1.titles['1'] === 'Introduction to Geography'`, titles['1'] === 'Introduction to Geography');
    check('geo-1.titles[\'30\'] is non-empty', typeof titles['30'] === 'string' && titles['30'].length > 0);
    check('geography.note deleted', geography && !('note' in geography));
  } else {
    check('geography titles JSON absent — geography step skipped as designed', true);
  }

  return checks;
}

async function main() {
  console.log(`[migrate-v28] fetching ${GET_URL}`);
  const plan = await fetchPlan();
  const base = plan.savedAt || null;

  // Snapshot BEFORE any mutation, purely to verify singapore.baseline is
  // untouched (deep-compared, not just "still present").
  const singaporeBaselineBefore = findAct(plan, 'singapore')?.baseline ?? null;

  const results = {
    loeChain: applyLoeChainEdits(plan),
    loeLogRemap: remapLoeCLogRows(plan),
    lesson102: appendLesson102Row(plan),
    coreMama: renameCoreMama(plan),
    notes: clearNotes(plan),
    baseline: refreezeLoeBaseline(plan),
    geography: applyGeographyTitles(plan),
  };
  for (const [step, r] of Object.entries(results))
    if (!r.ok) throw new Error(`[migrate-v28] step "${step}" failed: ${r.reason}`);

  console.log('[migrate-v28] edits applied in memory:', JSON.stringify(results, null, 2));
  console.log(`[migrate-v28] saving to ${SAVE_URL} (base=${base ? 'present' : 'none'})`);
  await savePlan(plan, base);

  console.log('[migrate-v28] re-fetching to verify…');
  const verified = await fetchPlan();
  const checks = verify(verified, {
    singaporeBaselineBefore,
    geoTitlesApplied: !results.geography.skipped,
  });

  console.log('\n[migrate-v28] verification checklist:');
  let allOk = true;
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.label}`);
    if (!c.pass) allOk = false;
  }
  if (!allOk) {
    console.error('\n[migrate-v28] FAILED — one or more edits did not land. Investigate before re-running.');
    process.exitCode = 1;
  } else {
    console.log('\n[migrate-v28] OK — every edit verified.');
  }
}

main().catch(e => {
  console.error('[migrate-v28] FAILED:', e.message);
  process.exitCode = 1;
});
