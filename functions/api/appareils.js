import { json, estAdmin, readJson, sanitizeText } from './_lib.js';

/** Liste des appareils connus, avec leur nombre de modifications. */
export async function onRequestGet(context) {
  if (!estAdmin(context.request, context.env)) {
    return json({ error: 'forbidden', message: "Réservé à l'administrateur." }, 403);
  }

  const { results } = await context.env.DB
    .prepare(
      `SELECT d.client_id, d.platform, d.model, d.nom_declare, d.nom_admin,
              d.first_seen, d.last_seen,
              (SELECT COUNT(*) FROM codes_history h WHERE h.actor = d.client_id) AS modifications
       FROM devices d
       ORDER BY d.last_seen DESC
       LIMIT 50`
    )
    .all();

  return json({
    appareils: (results || []).map((r) => ({
      id: r.client_id,
      plateforme: r.platform,
      modele: r.model,
      nomDeclare: r.nom_declare,
      nomAdmin: r.nom_admin,
      premiereFois: r.first_seen,
      derniereFois: r.last_seen,
      modifications: r.modifications
    }))
  });
}

/** Nommer un appareil. Le nom donné ici prime sur le prénom déclaré. */
export async function onRequestPatch(context) {
  if (!estAdmin(context.request, context.env)) {
    return json({ error: 'forbidden', message: "Réservé à l'administrateur." }, 403);
  }

  const body = await readJson(context.request);
  if (!body || typeof body.id !== 'string') {
    return json({ error: 'bad_request', message: 'Requête incomplète.' }, 400);
  }

  // Un nom vide efface l'étiquette sans toucher au prénom déclaré.
  const nom = body.nom ? sanitizeText(body.nom, 30) : null;

  await context.env.DB
    .prepare('UPDATE devices SET nom_admin = ?1 WHERE client_id = ?2')
    .bind(nom, body.id)
    .run();

  return json({ ok: true });
}

/**
 * Supprime la fiche d'un appareil. Sert à effacer les doublons créés par un
 * vidage de cache ou un onglet privé. L'historique des modifications n'est
 * pas touché : seule l'étiquette disparaît.
 */
export async function onRequestDelete(context) {
  if (!estAdmin(context.request, context.env)) {
    return json({ error: 'forbidden', message: "Réservé à l'administrateur." }, 403);
  }

  const body = await readJson(context.request);
  if (!body || typeof body.id !== 'string') {
    return json({ error: 'bad_request', message: 'Requête incomplète.' }, 400);
  }

  await context.env.DB.batch([
    context.env.DB.prepare('DELETE FROM devices WHERE client_id = ?1').bind(body.id),
    context.env.DB.prepare('DELETE FROM visites WHERE client_id = ?1').bind(body.id)
  ]);

  return json({ ok: true });
}
