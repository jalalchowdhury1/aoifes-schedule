// Planner data endpoint. Mirrors api/get.js conventions (unwrap loop, env
// fallbacks). ?prev=1 returns the one-step-undo copy written by plan-save.
export default async function handler(request, response) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return response.status(200).json({ error: "no-kv" });
  }

  const key = request.query && request.query.prev ? 'aoife_plan_prev' : 'aoife_plan';
  try {
    const res = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.result) {
      let parsed = data.result;
      while (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) { break; }
      }
      return response.status(200).json(parsed);
    }
    return response.status(200).json({ error: "empty" });
  } catch (e) {
    return response.status(500).json({ error: e.message });
  }
}
