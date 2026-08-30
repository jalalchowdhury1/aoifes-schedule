// Scriptable rendering layer for Aoife's School medium widget.
// NEVER served or run alone — scripts/build-widget.mjs concatenates this
// after js/model.js + js/plan/model.js + js/plan/mday.js inside one async
// IIFE (Scriptable rejects top-level `await`, so the fetch below only works
// because the whole bundle is wrapped in `(async () => { ... })()`).
// Everything numeric/text comes from mday.js's widgetModel/sanitizePlan/
// todayStr — this file only fetches the two blobs and draws.
/* global Request, ListWidget, FileManager, Script, Color, Font, LinearGradient, config */
/* global sanitizePlan, todayStr, widgetModel, CATS */

const APP_BASE = 'https://aoifes-schedule.vercel.app';

const WCOL = {
  ground: new Color('#12141f'), ink: new Color('#eef0f6'),
  dim: new Color('#eef0f6', 0.58), faint: new Color('#eef0f6', 0.42),
  red: new Color('#f0655a'),
};

const localHourFloat = d => d.getHours() + d.getMinutes() / 60;

async function fetchJSON(url) {
  const req = new Request(url);
  req.timeoutInterval = 15;
  return req.loadJSON();
}

// The day boundary is the PHONE's local date (this is a family-at-home
// surface, not a market one) — todayStr()/localHourFloat() both read the
// device clock, never anything server-supplied.
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
  const hourFloat = localHourFloat(now);
  const events = Array.isArray(data.schedule?.events) ? data.schedule.events : [];
  // Same catLabels-aware name resolution the app's own evLabel (js/state.js)
  // uses, so a renamed category (e.g. catLabels.barakot = "Mama Classes")
  // reads the same on the widget as it does on the desktop and /m — CATS
  // comes from js/model.js, bundled ahead of this file by build-widget.mjs.
  const catLabels = data.schedule?.catLabels || {};
  const nameForEvent = ev => ev.name || catLabels[ev.cat] || CATS[ev.cat]?.label || 'Event';
  const m = widgetModel(dateStr, events, plan, hourFloat, nameForEvent);

  const cols = w.addStack();
  cols.spacing = 14;

  const left = cols.addStack();
  left.layoutVertically();
  const lcap = left.addText(m.dayLabel.toUpperCase());
  lcap.font = Font.boldSystemFont(9);
  lcap.textColor = WCOL.faint;
  left.addSpacer(6);
  const lbig = left.addText(m.first || '—');
  lbig.font = Font.boldMonospacedSystemFont(19);
  lbig.textColor = WCOL.ink;
  lbig.lineLimit = 1;
  lbig.minimumScaleFactor = 0.7;
  left.addSpacer(4);
  const lsub = left.addText(m.rest || '');
  lsub.font = Font.regularSystemFont(11);
  lsub.textColor = WCOL.dim;
  lsub.lineLimit = 2;
  lsub.minimumScaleFactor = 0.8;

  cols.addSpacer();          // flexible: pushes DONE to the right column

  const right = cols.addStack();
  right.layoutVertically();
  const rcap = right.addText('DONE');
  rcap.font = Font.boldSystemFont(9);
  rcap.textColor = WCOL.faint;
  right.addSpacer(6);
  const rrow = right.addStack();
  const rbig = rrow.addText(String(m.done));
  rbig.font = Font.boldMonospacedSystemFont(19);
  rbig.textColor = WCOL.ink;
  const rtot = rrow.addText(`/${m.total}`);
  rtot.font = Font.mediumMonospacedSystemFont(14);
  rtot.textColor = WCOL.faint;
  right.addSpacer(4);
  const rsub = right.addText(m.mama || '');
  rsub.font = Font.regularSystemFont(11);
  rsub.textColor = WCOL.dim;
  rsub.lineLimit = 1;
  rsub.minimumScaleFactor = 0.8;

  if (fromCache) {
    w.addSpacer(8);
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
