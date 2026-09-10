// Détecte automatiquement la liaison KV sur Cloudflare
function getKV(env) {
  return env.CODES_KV || env.CODES || env.KV || Object.values(env).find(v => v && typeof v.get === 'function');
}

export async function onRequestGet(context) {
  const kv = getKV(context.env);
  if (!kv) return new Response(JSON.stringify({ error: "KV non trouvé" }), { status: 500 });

  const raw = await kv.get("stats_installs");
  const stats = raw ? JSON.parse(raw) : { android: 0, ios: 0 };

  return new Response(JSON.stringify(stats), {
    headers: { "Content-Type": "application/json" }
  });
}

export async function onRequestPost(context) {
  const kv = getKV(context.env);
  if (!kv) return new Response(JSON.stringify({ error: "KV non trouvé" }), { status: 500 });

  try {
    const { platform } = await context.request.json();
    const raw = await kv.get("stats_installs");
    const stats = raw ? JSON.parse(raw) : { android: 0, ios: 0 };

    if (platform === 'android') {
      stats.android = (stats.android || 0) + 1;
    } else if (platform === 'ios') {
      stats.ios = (stats.ios || 0) + 1;
    }

    await kv.put("stats_installs", JSON.stringify(stats));
    return new Response(JSON.stringify({ ok: true, stats }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Erreur enregistrement" }), { status: 400 });
  }
}
