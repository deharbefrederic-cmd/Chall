function getKV(env) {
  return env.CODES_KV || env.CODES || env.KV || Object.values(env).find(v => v && typeof v.get === 'function');
}

export async function onRequestGet(context) {
  const kv = getKV(context.env);
  const raw = kv ? await kv.get("stats_installs") : null;
  const s = raw ? JSON.parse(raw) : { android: 0, ios: 0, web: 0 };
  const totalInstalls = (s.android || 0) + (s.ios || 0);
  const totalGlobal = totalInstalls + (s.web || 0);

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Statistiques Challivretou</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px 16px; margin: 0; }
    .container { max-width: 420px; margin: 0 auto; }
    h2 { text-align: center; margin-bottom: 20px; font-size: 20px; }
    .card { background: #1e293b; border-radius: 12px; padding: 16px 20px; margin-bottom: 16px; border: 1px solid #334155; }
    .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #334155; font-size: 15px; }
    .stat-row:last-child { border-bottom: none; }
    .val { font-weight: 700; font-size: 17px; color: #38bdf8; }
    .card-total { background: #064e3b; border-color: #059669; }
    .val-total { font-weight: 800; font-size: 20px; color: #34d399; }
    .note { text-align: center; font-size: 12px; color: #64748b; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <h2>📊 Utilisateurs Challivretou</h2>
    <div class="card">
      <div class="stat-row"><span>🤖 Appli installée Android</span><span class="val">${s.android || 0}</span></div>
      <div class="stat-row"><span>🍏 Appli installée Apple (iOS)</span><span class="val">${s.ios || 0}</span></div>
      <div class="stat-row" style="opacity: 0.8;"><span>📱 Sous-total Applis</span><span class="val">${totalInstalls}</span></div>
    </div>
    <div class="card">
      <div class="stat-row"><span>🌐 Navigateur (via URL sans install)</span><span class="val">${s.web || 0}</span></div>
    </div>
    <div class="card card-total">
      <div class="stat-row"><span style="font-weight:600;">👥 Total Appareils Uniques</span><span class="val-total">${totalGlobal}</span></div>
    </div>
    <div class="note">Données enregistrées en temps réel sur Cloudflare KV</div>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
