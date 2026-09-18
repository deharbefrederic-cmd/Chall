import { json, estAdmin, readJson, isValidId } from './_lib.js';

/**
 * Lie plusieurs fiches à une même résidence, sans toucher aux codes.
 * Aucune trace dans l'historique : ce n'est pas une modification de code,
 * seulement un regroupement.
 */
export async function onRequestPost(context) {
  if (!estAdmin(context.request, context.env)) {
    return json({ error: 'forbidden', message: "Réservé à l'administrateur." }, 403);
  }

  const body = await readJson(context.request);
  const ids = Array.isArray(body && body.ids) ? body.ids.filter(isValidId).slice(0, 20) : [];
  if (ids.length < 2) {
    return json({ error: 'bad_request', message: 'Au moins deux fiches sont nécessaires.' }, 400);
  }

  const db = context.env.DB;
  const marques = ids.map((_, i) => '?' + (i + 1)).join(',');
  const { results } = await db
    .prepare(`SELECT id, groupe_id FROM codes WHERE id IN (${marques})`)
    .bind(...ids)
    .all();

  if (!results || results.length < 2) {
    return json({ error: 'not_found', message: 'Fiches introuvables.' }, 404);
  }

  // Un groupe déjà existant est réutilisé plutôt que dupliqué.
  const groupeId = results.find((r) => r.groupe_id)?.groupe_id || crypto.randomUUID();

  await db.batch(
    results.map((r) =>
      db.prepare('UPDATE codes SET groupe_id = ?1 WHERE id = ?2').bind(groupeId, r.id)
    )
  );

  return json({ ok: true, groupe: groupeId, liees: results.length });
}

/** Retire une fiche de sa résidence. */
export async function onRequestDelete(context) {
  if (!estAdmin(context.request, context.env)) {
    return json({ error: 'forbidden', message: "Réservé à l'administrateur." }, 403);
  }

  const body = await readJson(context.request);
  if (!body || !isValidId(body.id)) {
    return json({ error: 'bad_request', message: 'Fiche non précisée.' }, 400);
  }

  await context.env.DB
    .prepare('UPDATE codes SET groupe_id = NULL WHERE id = ?1')
    .bind(body.id)
    .run();

  return json({ ok: true });
}
