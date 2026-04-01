export default async function handler(request, response) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  
  if (!url || !token) {
    return response.status(200).json({ error: "no-kv" });
  }

  try {
    const res = await fetch(`${url}/get/aoifes_schedule`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.result) {
       return response.status(200).json(JSON.parse(data.result));
    }
    return response.status(200).json({ error: "empty" });
  } catch(e) {
    return response.status(500).json({ error: e.message });
  }
}
