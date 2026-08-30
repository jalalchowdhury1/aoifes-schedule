// Scriptable rendering layer for Aoife's School medium widget.
// NEVER served or run alone — scripts/build-widget.mjs concatenates this
// after js/model.js + js/plan/model.js + js/plan/mday.js inside one async
// IIFE (Scriptable rejects top-level `await`, so the fetch below only works
// because the whole bundle is wrapped in `(async () => { ... })()`).
// Everything numeric/text comes from mday.js's widgetNext/sanitizePlan/
// todayStr — this file only fetches the two blobs and draws.
//
// 2026-08-31 redesign: countdown to the next/current class + the rest of
// today, replacing the old two-column "first/rest | done/total" layout.
// The big number is a live-ticking Scriptable date view (`addDate` +
// `applyRelativeStyle`/`applyTimerStyle`) so it counts down on its own,
// second by second, with NO widget refresh needed in between.
/* global Request, ListWidget, FileManager, Script, Color, Font, LinearGradient, config */
/* global sanitizePlan, todayStr, widgetNext, CATS */

const APP_BASE = 'https://aoifes-schedule.vercel.app';

const WCOL = {
  ground: new Color('#12141f'), ink: new Color('#eef0f6'),
  dim: new Color('#eef0f6', 0.58), faint: new Color('#eef0f6', 0.42),
  vio: new Color('#c9c0ff'), grn: new Color('#3ddc97'), red: new Color('#f0655a'),
};

// Top-left tiny caption per widgetNext's mode — 'now' deliberately keeps
// "until" lowercase (the approved copy is "NOW · until 1:00", not shouted).
function captionFor(m) {
  if (m.mode === 'next') return 'NEXT CLASS';
  if (m.mode === 'now') return `NOW · until ${m.atLabel}`;
  return 'TODAY';                                    // 'done' and 'none' both read as a plain day caption
}

async function fetchJSON(url) {
  const req = new Request(url);
  req.timeoutInterval = 15;
  return req.loadJSON();
}

// The day boundary is the PHONE's local date (this is a family-at-home
// surface, not a market one) — todayStr()/`now` both read the device clock,
// never anything server-supplied.
async function loadData() {
  const fm = FileManager.local();
  const cachePath = fm.joinPath(fm.cacheDirectory(), 'aoife-widget-cache.json');
  try {
    const [schedule, planRaw] = await Promise.all([
      fetchJSON(`${APP_BASE}/api/get`),
      fetchJSON(`${APP_BASE}/api/plan-get`),
    ]);
    const data = { schedule, planRaw };
    fm.writeString(cachePath, JSON.stringify(data));
    return { data, fromCache: false };
  } catch (e) {
    if (fm.fileExists(cachePath))
      return { data: JSON.parse(fm.readString(cachePath)), fromCache: true };
    return { data: null, fromCache: false };
  }
}

async function makeWidget() {
  const w = new ListWidget();
  w.url = `${APP_BASE}/m/`;
  // ListWidget has no real cornerRadius property (iOS rounds the outer shape
  // itself to match the home-screen grid) — set anyway, harmlessly, so the
  // spec's literal "corner radius 24" is on record and a future Scriptable
  // version that DOES honor it picks it up for free.
  w.cornerRadius = 24;
  w.backgroundColor = WCOL.ground;
  const grad = new LinearGradient();
  grad.colors = [new Color('#241f42'), new Color('#12141f')];
  grad.locations = [0, 0.75];
  w.backgroundGradient = grad;
  w.setPadding(16, 18, 14, 18);

  const { data, fromCache } = await loadData();
  if (!data) {
    const t = w.addText("Aoife's School unreachable");
    t.font = Font.semiboldSystemFont(13);
    t.textColor = WCOL.red;
    const s = w.addText('No cache yet — open the app once.');
    s.font = Font.systemFont(11);
    s.textColor = WCOL.dim;
    w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
    return w;
  }

  const plan = sanitizePlan(data.planRaw);
  const now = new Date();
  const dateStr = todayStr();
  const events = Array.isArray(data.schedule?.events) ? data.schedule.events : [];
  // Same catLabels-aware name resolution the app's own evLabel (js/state.js)
  // uses, so a renamed category (e.g. catLabels.barakot = "Mama Classes")
  // reads the same on the widget as it does on the desktop and /m — CATS
  // comes from js/model.js, bundled ahead of this file by build-widget.mjs.
  const catLabels = data.schedule?.catLabels || {};
  const nameForEvent = ev => ev.name || catLabels[ev.cat] || CATS[ev.cat]?.label || 'Event';
  const m = widgetNext(dateStr, events, plan, now, nameForEvent);

  const cap = w.addText(captionFor(m));
  cap.font = Font.boldSystemFont(9);
  cap.textColor = WCOL.faint;
  w.addSpacer(8);

  if (m.mode === 'next' || m.mode === 'now') {
    // A self-updating date view: iOS ticks the on-screen number by itself,
    // with no widget refresh in between (see the module header). 'next'
    // reads as a phrase ("in 1 hr, 25 min"); 'now' as a digital countdown
    // to the end of the running class ("0:34:12") — both target `m.at`,
    // an offset-less local ISO stamp `new Date()` parses as the phone's own
    // local time (see mday.js's isoLocal).
    const wd = w.addDate(new Date(m.at));
    if (m.mode === 'next') wd.applyRelativeStyle();
    else wd.applyTimerStyle();
    wd.font = Font.boldSystemFont(32);
    wd.textColor = WCOL.vio;
    wd.lineLimit = 1;
    wd.minimumScaleFactor = 0.6;
    w.addSpacer(4);
    const name = w.addText(m.name);
    name.font = Font.semiboldSystemFont(17);
    name.textColor = WCOL.ink;
    name.lineLimit = 1;
    name.minimumScaleFactor = 0.7;
  } else if (m.mode === 'done') {
    const left = m.total - m.doneCount;
    const big = w.addText(left > 0 ? `${left} left` : 'All done for today ✓');
    big.font = Font.semiboldSystemFont(21);
    big.textColor = left > 0 ? WCOL.ink : WCOL.grn;
    big.lineLimit = 2;
    big.minimumScaleFactor = 0.75;
  } else {
    const big = w.addText('No classes today');
    big.font = Font.semiboldSystemFont(21);
    big.textColor = WCOL.ink;
    big.lineLimit = 1;
    big.minimumScaleFactor = 0.75;
  }

  w.addSpacer();          // flexible: pushes "then …" (+ the cache flag) to the bottom

  if (m.rest.length) {
    const rest = w.addText(`then ${m.rest.join(' · ')}`);
    rest.font = Font.regularSystemFont(11);
    rest.textColor = WCOL.dim;
    rest.lineLimit = 2;
    rest.minimumScaleFactor = 0.8;
  }

  if (fromCache) {
    w.addSpacer(6);
    const c = w.addText('cached');
    c.font = Font.mediumSystemFont(8);
    c.textColor = WCOL.red;
  }

  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  return w;
}

async function run() {
  const w = await makeWidget();
  if (typeof config !== 'undefined' && config.runsInWidget) Script.setWidget(w);
  else await w.presentMedium();
  Script.complete();
}

run();
