import {
  json, sanitizeText, normAddress, isValidId, clientId, toRecord, readJson,
  rateLimit, ipBucket, archive, formatAddress, corrigerViaBAN, MAX_ADDRESS, MAX_CODE, DELETE_WINDOW_MS
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
    const officielle = await corrigerViaBAN(address);
    if (officielle) address = officielle;
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

  const now = Date.now();

  // Retour en arrière : si la valeur enregistrée est exactement celle d'avant
  // la dernière modification, et que celle-ci est récente, c'est une annulation.
  // On restaure alors l'état antérieur plutôt que de marquer la fiche comme
  // modifiée — un code corrigé puis remis ne doit pas afficher le badge MAJ.
  let annulation = null;
  if (codeChanged || addressChanged) {
    const precedent = await db
      .prepare(
        `SELECT address, code, hs, prev_updated_at, archived_at
         FROM codes_history WHERE id = ?1 AND action = 'update' ORDER BY seq DESC LIMIT 1`
      )
      .bind(id)
      .first();

    if (
      precedent &&
      precedent.address === address &&
      precedent.code === code &&
      now - precedent.archived_at < DELETE_WINDOW_MS
    ) {
      annulation = precedent;
    }
  }

  if (annulation) hs = annulation.hs;

  // Un signalement HS seul ne rajeunit pas la fiche : le badge « MAJ »
  // doit rester réservé aux changements de code ou d'adresse.
  const updatedAt = annulation
    ? annulation.prev_updated_at || 0
    : codeChanged || addressChanged
      ? now
      : row.updated_at;

  // Fiches à mettre à jour en même temps (résidence à plusieurs entrées).
  let compagnes = [];
  if (codeChanged && Array.isArray(body.aussi) && body.aussi.length) {
    const ids = body.aussi.filter((x) => isValidId(x) && x !== id).slice(0, 20);
    if (ids.length) {
      const marques = ids.map((_, i) => '?' + (i + 1)).join(',');
      const res = await db
        .prepare(
          `SELECT id, address, code, hs, created_at, updated_at, author, groupe_id
           FROM codes WHERE id IN (${marques})`
        )
        .bind(...ids)
        .all();
      compagnes = res.results || [];
    }
  }

  // Un groupe existant est réutilisé plutôt que dupliqué.
  let groupeId = row.groupe_id || null;
  if (compagnes.length) {
    groupeId = groupeId || compagnes.find((c) => c.groupe_id)?.groupe_id || crypto.randomUUID();
  }

  // Tout part en un seul lot : soit l'ensemble des fiches est à jour,
  // soit aucune. Jamais d'état intermédiaire après une coupure réseau.
  const lot = [
    db
      .prepare(
        `INSERT INTO codes_history (id, address, code, hs, action, actor, archived_at, prev_updated_at)
         VALUES (?1, ?2, ?3, ?4, 'update', ?5, ?6, ?7)`
      )
      .bind(row.id, row.address, row.code, row.hs, me, now, row.updated_at),
    db
      .prepare(
        `UPDATE codes SET address = ?1, norm_address = ?2, code = ?3, hs = ?4, updated_at = ?5, groupe_id = ?6 WHERE id = ?7`
      )
      .bind(address, norm, code, hs, updatedAt, groupeId, id)
  ];

  for (const c of compagnes) {
    lot.push(
      db
        .prepare(
          `INSERT INTO codes_history (id, address, code, hs, action, actor, archived_at, prev_updated_at)
           VALUES (?1, ?2, ?3, ?4, 'update', ?5, ?6, ?7)`
        )
        .bind(c.id, c.address, c.code, c.hs, me, now, c.updated_at)
    );
    lot.push(
      db
        .prepare(`UPDATE codes SET code = ?1, hs = 0, updated_at = ?2, groupe_id = ?3 WHERE id = ?4`)
        .bind(code, now, groupeId, c.id)
    );
  }

  await db.batch(lot);

  const misAJour = compagnes.map((c) =>
    toRecord({ ...c, code, hs: 0, updated_at: now, groupe_id: groupeId }, me)
  );

  return json({
    record: toRecord({ ...row, address, code, hs, updated_at: updatedAt, groupe_id: groupeId }, me),
    aussi: misAJour
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
