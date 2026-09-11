import { json, readJson, rateLimit, ipBucket } from './_lib.js';

const KEYS = ['android', 'ios', 'web'];

export async function onRequestGet(context) {
  const db = context.env.DB;
  const now = Date.now();
  const j7 = now - 7 * 24 * 60 * 60 * 1000;
  const j30 = now - 30 * 24 * 60 * 60 * 1000;

  const [installs, devices, parPlateforme] = await Promise.all([
    db.prepare(`SELECT key, value FROM stats WHERE key IN ('android','ios','web')`).all(),
    db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN last_seen >= ?1 THEN 1 ELSE 0 END) AS actifs7,
           SUM(CASE WHEN last_seen >= ?2 THEN 1 ELSE 0 END) AS actifs30,
           SUM(CASE WHEN first_seen >= ?1 THEN 1 ELSE 0 END) AS nouveaux7
         FROM devices`
      )
      .bind(j7, j30)
      .first(),
    db
      .prepare(
        `SELECT platform, COUNT(*) AS n FROM devices WHERE last_seen >= ?1 GROUP BY platform ORDER BY n DESC`
      )
      .bind(j30)
      .all()
  ]);

  const stats = { android: 0, ios: 0, web: 0 };
  for (const row of installs.results || []) stats[row.key] = row.value;

  return json({
    installs: stats,
    appareils: {
      total: devices?.total || 0,
      actifs7: devices?.actifs7 || 0,
      actifs30: devices?.actifs30 || 0,
      nouveaux7: devices?.nouveaux7 || 0
    },
    plateformes: (parPlateforme.results || []).map((r) => ({ nom: r.platform, n: r.n }))
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const limit = await rateLimit(env.DB, ipBucket(request, 'stats'), 10, 3600);
  if (!limit.ok) return json({ ok: true });

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, 400);

  const key = body.type === 'install' ? body.platform : 'web';
  if (!KEYS.includes(key)) return json({ error: 'bad_request' }, 400);

  await env.DB
    .prepare(
      `INSERT INTO stats (key, value) VALUES (?1, 1)
       ON CONFLICT(key) DO UPDATE SET value = stats.value + 1`
    )
    .bind(key)
    .run();

  return json({ ok: true });
}
