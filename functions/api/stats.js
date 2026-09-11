import { json, readJson, rateLimit, ipBucket } from './_lib.js';

const KEYS = ['android', 'ios', 'web'];

export async function onRequestGet(context) {
  const { results } = await context.env.DB
    .prepare(`SELECT key, value FROM stats WHERE key IN ('android','ios','web')`)
    .all();

  const stats = { android: 0, ios: 0, web: 0 };
  for (const row of results || []) stats[row.key] = row.value;

  return json(stats);
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
