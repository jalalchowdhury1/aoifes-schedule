// Verifies the app's serializer round-trips REAL production data unchanged
// (after sanitizeEvents, which drops malformed records — the live KV blob
// contains a known stray {"id":"e999"} with no fields).
// The fixture is fetched from the live API before running and is gitignored;
// the test skips gracefully when it's absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serialize, maxIdNum, sanitizeEvents } from '../js/model.js';

let prod = null;
try {
  prod = JSON.parse(readFileSync(new URL('./fixtures/production.json', import.meta.url), 'utf8'));
} catch (e) {}

test('production data round-trips through serialize after sanitization', { skip: !prod }, () => {
  assert.ok(Array.isArray(prod.events), 'production data has an events array');
  const events = sanitizeEvents(prod.events);
  assert.ok(events.length > 0, 'sanitized production events remain');
  for (const ev of events) {
    for (const k of ['id', 'cat', 'day', 'start', 'end']) assert.ok(k in ev, `event has ${k}`);
  }
  const roundTripped = JSON.parse(serialize({
    events,
    altSun: prod.altSun ?? false,
    catLabels: prod.catLabels ?? {},
  }));
  assert.deepEqual(roundTripped.events, events);
  assert.equal(roundTripped.altSun, prod.altSun ?? false);
  assert.deepEqual(roundTripped.catLabels, prod.catLabels ?? {});
  assert.ok(maxIdNum(events) >= 0);
});
