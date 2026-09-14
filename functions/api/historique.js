import { json, estAdmin } from './_lib.js';

/** Vingt dernières modifications, la plus récente en tête. */
export async function onRequestGet(context) {
  if (!estAdmin(context.request, context.env)) {
    return json({ error: 'forbidden', message: "Réservé à l'administrateur." }, 403);
  }

  const { results } = await context.env.DB
    .prepare(
      `SELECT h.id, h.archived_at, h.action,
              h.address AS ancienne_adresse, h.code AS ancien_code,
              c.address AS adresse, c.code AS code,
              COALESCE(d.nom_admin, d.nom_declare, d.model, d.platform) AS auteur
       FROM codes_history h
       LEFT JOIN codes c ON c.id = h.id
       LEFT JOIN devices d ON d.client_id = h.actor
       ORDER BY h.seq DESC
       LIMIT 20`
    )
    .all();

  return json({
    entrees: (results || []).map((r) => ({
      id: r.id,
      quand: r.archived_at,
      action: r.action,
      // État archivé, c'est-à-dire celui d'avant ce changement.
      ancienneAdresse: r.ancienne_adresse,
      ancienCode: r.ancien_code,
      // État actuel de la fiche, si elle existe encore.
      adresse: r.adresse,
      code: r.code,
      auteur: r.auteur
    }))
  });
}
