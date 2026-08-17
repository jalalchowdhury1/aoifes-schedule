// Save planner data. Before writing, copies the current value to
// aoife_plan_prev (one-step undo). Body is {data: "<json-string>"} —
// the same deliberate double-wrap convention as api/save.js.
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
    const res = await fetch(`${url}/set/aoife_plan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: request.body.data
    });
    const data = await res.json();
    return response.status(200).json(data);
  } catch (e) {
    return response.status(500).json({ error: e.message });
  }
}
