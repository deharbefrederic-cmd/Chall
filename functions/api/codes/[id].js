import {
  json, sanitizeText, normAddress, isValidId, clientId, toRecord, readJson,
  rateLimit, ipBucket, archive, formatAddress, MAX_ADDRESS, MAX_CODE, DELETE_WINDOW_MS
} from '../_lib.js';

async function guard(context) {
  const { request, env, params } = context;
  const db = env.DB;

  const limit = await rateLimit(db, ipBucket(request, 'write'), 60, 3600);
  if (!limit.ok) {
    return {
      error: json(
        { error: 'rate_limited', message: 'Trop de modifications. Réessayez dans un moment.' },
        429,
        { 'Retry-After': String(limit.retryAfter) }
      )
    };
  }

  const id = params.id;
  if (!isValidId(id)) {
    return { error: json({ error: 'bad_request', message: 'Identifiant invalide.' }, 400) };
  }

  const row = await db
    .prepare(`SELECT id, address, code, hs, created_at, updated_at, author FROM codes WHERE id = ?1`)
    .bind(id)
    .first();

  return { db, id, row, me: clientId(request) };
}

export async function onRequestPatch(context) {
  const g = await guard(context);
  if (g.error) return g.error;
  const { db, id, row, me } = g;

  if (!row) return json({ error: 'not_found', message: 'Cette fiche a été supprimée.' }, 404);

  const body = await readJson(context.request);
  if (!body) return json({ error: 'bad_request', message: 'Corps de requête illisible.' }, 400);

  let address = row.address;
  let code = row.code;
  let hs = row.hs;

  if (body.address !== undefined) {
    const next = sanitizeText(body.address, MAX_ADDRESS);
    if (!next || next.length < 3) {
      return json({ error: 'invalid_address', message: 'Adresse manquante ou trop courte.' }, 400);
    }
    address = formatAddress(next);
  }

  if (body.code !== undefined) {
    const next = sanitizeText(body.code, MAX_CODE);
    if (!next) return json({ error: 'invalid_code', message: 'Code manquant ou trop long.' }, 400);
    code = next;
  }

  if (body.hs !== undefined) {
    if (typeof body.hs !== 'boolean') {
      return json({ error: 'bad_request', message: 'Champ « hs » invalide.' }, 400);
    }
    hs = body.hs ? 1 : 0;
  }

  const codeChanged = code !== row.code;
  const addressChanged = address !== row.address;

  // Un code corrigé annule automatiquement le signalement HS.
  if (codeChanged) hs = 0;

  if (!codeChanged && !addressChanged && hs === row.hs) {
    return json({ record: toRecord(row, me) });
  }

  const norm = normAddress(address);
  if (addressChanged) {
    const clash = await db
      .prepare(`SELECT id FROM codes WHERE norm_address = ?1 AND id <> ?2`)
      .bind(norm, id)
      .first();
    if (clash) {
      return json({ error: 'duplicate', message: 'Une autre fiche porte déjà cette adresse.' }, 409);
    }
  }

  await archive(db, row, 'update', me);

  const now = Date.now();
  // Un signalement HS seul ne rajeunit pas la fiche : le badge « MAJ »
  // doit rester réservé aux changements de code ou d'adresse.
  const updatedAt = codeChanged || addressChanged ? now : row.updated_at;

  await db
    .prepare(
      `UPDATE codes SET address = ?1, norm_address = ?2, code = ?3, hs = ?4, updated_at = ?5 WHERE id = ?6`
    )
    .bind(address, norm, code, hs, updatedAt, id)
    .run();

  return json({
    record: toRecord(
      { ...row, address, code, hs, updated_at: updatedAt },
      me
    )
  });
}

export async function onRequestDelete(context) {
  const g = await guard(context);
  if (g.error) return g.error;
  const { db, id, row, me } = g;

  // Suppression déjà effectuée : on répond OK pour que la file d'attente
  // hors ligne puisse être rejouée sans erreur.
  if (!row) return json({ ok: true });

  if (!me || row.author !== me) {
    return json({ error: 'forbidden', message: 'Vous ne pouvez supprimer que vos propres ajouts.' }, 403);
  }

  if (Date.now() - row.created_at > DELETE_WINDOW_MS) {
    return json(
      { error: 'too_late', message: 'La suppression n’est possible que dans les 24 h suivant l’ajout.' },
      403
    );
  }

  await archive(db, row, 'delete', me);
  await db.prepare(`DELETE FROM codes WHERE id = ?1`).bind(id).run();

  return json({ ok: true });
}
