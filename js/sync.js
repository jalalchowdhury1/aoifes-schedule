// Shared spine for the two stores' live re-sync (planner-v2.5).
// Deliberately tiny and dependency-free: js/state.js (template) and
// js/plan/state.js (planner) both import it, so neither store has to import the
// other, and neither has to import the frozen view layer to learn that a drag
// is in progress or an input is focused.

// ── Hold registry ────────────────────────────────────────────
// A view registers a predicate for an interaction that a fetched blob must not
// interrupt (a drag/resize, an open add form, a focused input). ONE registry
// for both stores: a half-typed trip label in the Year sheet is as much an
// uncommitted edit as a half-finished drag on the grid, and neither store may
// re-render underneath it.
const holds = new Set();
export const holdSync = fn => holds.add(fn);
export const onHold = () => {
  // A throwing predicate must never take the whole sync down with it: treat it
  // as "not holding" and carry on with the rest.
  for (const fn of holds) { try { if (fn()) return true; } catch (e) {} }
  return false;
};

// ── Freshness marks ──────────────────────────────────────────
// Each store stamps itself when it completes a round with the server. The
// Today page reads BOTH blobs (template events + planner overrides/log), so it
// may only claim to be "synced" as of the OLDER of the two — a template that
// last spoke to KV an hour ago makes the page an hour stale no matter how fresh
// the planner half is. Null until both have been heard from: a tab that has
// only ever loaded one of them claims nothing.
export const syncInfo = { plan: null, schedule: null };
export const markSynced = (which, at = new Date().toISOString()) => { syncInfo[which] = at; };
export const syncedAt = () => {
  const { plan, schedule } = syncInfo;
  if (!plan || !schedule) return null;
  return plan < schedule ? plan : schedule;      // both are our own ISO stamps
};
