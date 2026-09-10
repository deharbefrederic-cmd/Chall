export async function onRequestGet(context) {
  // Récupère les codes stockés dans Cloudflare KV
  const codes = await context.env.CODES_KV.get("delivery_data");
  
  return new Response(codes || "[]", {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestPost(context) {
  try {
    const data = await context.request.json();
    // Sauvegarde la nouvelle liste dans Cloudflare KV
    await context.env.CODES_KV.put("delivery_data", JSON.stringify(data));
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Format invalide" }), { status: 400 });
  }
}
