// Save planner data. Before writing, copies the current value to
// aoife_plan_prev (one-step undo). Body is {data: "<json-string>"} —
// the same deliberate double-wrap convention as api/save.js.
//
// CONCURRENT WRITES: the body may also carry {base: "<savedAt>"} — the stamp of
// the blob this snapshot was edited on top of. When KV has moved on since (the
// Telegram bot wrote while a tab had the page open, or two phones tapped at
// once), the two writes are merged instead of the later one winning outright.
// A body WITHOUT `base` (an older client, a Claude session, a hand-rolled
// curl) keeps the old blind-overwrite behaviour on purpose.
import { mergePlanWrites } from '../js/plan/model.js';

export default async function handler(request, response) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return response.status(200).json({ error: "no-kv" });
  }

  try {
    const cur = await fetch(`${url}/get/aoife_plan`, {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.json()).catch(() => null);
    if (cur && cur.result) {
      await fetch(`${url}/set/aoife_plan_prev`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: cur.result
      });
    }

    let body = request.body.data;
    let merged = false;
    const base = request.body.base;
    if (base && cur && cur.result) {
      // get.js's defensive unwrap: KV stores a JSON *string*, historically
      // double-stringified. Parse the same way here or the merge sees nothing.
      let stored = cur.result;
      while (typeof stored === 'string') {
        try { stored = JSON.parse(stored); } catch (e) { break; }
      }
      if (stored && typeof stored === 'object' && stored.savedAt && stored.savedAt !== base) {
        let incoming = null;
        try { incoming = JSON.parse(body); } catch (e) {}
        if (incoming && typeof incoming === 'object') {
          const out = mergePlanWrites(stored, incoming);
          if (out !== incoming) { body = JSON.stringify(out); merged = true; }
        }
      }
    }

    const res = await fetch(`${url}/set/aoife_plan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body
    });
    const data = await res.json();
    return response.status(200).json(merged ? { ...data, merged: true } : data);
  } catch (e) {
    return response.status(500).json({ error: e.message });
  }
}
