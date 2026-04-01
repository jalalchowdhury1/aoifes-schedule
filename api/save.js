export default async function handler(request, response) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  
  if (!url || !token) {
    return response.status(200).json({ error: "no-kv" });
  }

  try {
    const res = await fetch(`${url}/set/aoifes_schedule`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(request.body.data)
    });
    const data = await res.json();
    return response.status(200).json(data);
  } catch(e) {
    return response.status(500).json({ error: e.message });
  }
}
