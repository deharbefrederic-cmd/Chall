import {
  json, sanitizeText, normAddress, isValidId, clientId, toRecord, readJson,
  rateLimit, ipBucket, devicePlatform, touchDevice, MAX_ADDRESS, MAX_CODE
} from './_lib.js';

export async function onRequestGet(context) {
  const db = context.env.DB;
  const me = clientId(context.request);

  const { results } = await db
    .prepare(
      `SELECT id, address, code, hs, created_at, updated_at, author
       FROM codes
       ORDER BY address COLLATE NOCASE`
    )
    .all();

  // Présence de l'appareil : c'est ce qui permet de compter les utilisateurs actifs.
  await touchDevice(db, me, devicePlatform(context.request));

  return json({ records: (results || []).map((row) => toRecord(row, me)) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;

  const limit = await rateLimit(db, ipBucket(request, 'write'), 60, 3600);
  if (!limit.ok) {
    return json(
      { error: 'rate_limited', message: 'Trop de modifications. Réessayez dans un moment.' },
      429,
      { 'Retry-After': String(limit.retryAfter) }
    );
  }

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request', message: 'Corps de requête illisible.' }, 400);

  const address = sanitizeText(body.address, MAX_ADDRESS);
  const code = sanitizeText(body.code, MAX_CODE);

  if (!address || address.length < 3) {
    return json({ error: 'invalid_address', message: 'Adresse manquante ou trop courte.' }, 400);
  }
  if (!code) {
    return json({ error: 'invalid_code', message: 'Code manquant ou trop long.' }, 400);
  }

  // L'identifiant peut venir du client : rejouer une création mise en file
  // d'attente hors ligne reste alors sans effet de bord.
  const id = isValidId(body.id) ? body.id : crypto.randomUUID();
  const author = clientId(request);
  const norm = normAddress(address);
  const now = Date.now();

  const existing = await db
    .prepare(`SELECT id, address, code, hs, created_at, updated_at, author FROM codes WHERE norm_address = ?1`)
    .bind(norm)
    .first();

  if (existing) {
    if (existing.id === id) return json({ record: toRecord(existing, author) }, 200);
    return json(
      { error: 'duplicate', message: 'Cette adresse existe déjà.', record: toRecord(existing, author) },
      409
    );
  }

  try {
    await db
      .prepare(
        `INSERT INTO codes (id, address, norm_address, code, hs, created_at, updated_at, author)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5, ?6)
         ON CONFLICT(id) DO NOTHING`
      )
      .bind(id, address, norm, code, now, author)
      .run();
  } catch (err) {
    const again = await db
      .prepare(`SELECT id, address, code, hs, created_at, updated_at, author FROM codes WHERE norm_address = ?1`)
      .bind(norm)
      .first();
    if (again) {
      return json(
        { error: 'duplicate', message: 'Cette adresse existe déjà.', record: toRecord(again, author) },
        409
      );
    }
    return json({ error: 'write_failed', message: "L'enregistrement a échoué." }, 500);
  }

  const created = await db
    .prepare(`SELECT id, address, code, hs, created_at, updated_at, author FROM codes WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ record: toRecord(created, author) }, 201);
}
