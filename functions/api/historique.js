import { json, estAdmin } from './_lib.js';

/** Vingt dernières modifications, la plus récente en tête. */
export async function onRequestGet(context) {
  if (!estAdmin(context.request, context.env)) {
    return json({ error: 'forbidden', message: "Réservé à l'administrateur." }, 403);
  }

  const { results } = await context.env.DB
    .prepare(
      `SELECT h.archived_at, h.action,
              h.address AS ancienne_adresse, h.code AS ancien_code,
              c.address AS adresse, c.code AS code
       FROM codes_history h
       LEFT JOIN codes c ON c.id = h.id
       ORDER BY h.seq DESC
       LIMIT 20`
    )
    .all();

  return json({
    entrees: (results || []).map((r) => ({
      quand: r.archived_at,
      action: r.action,
      adresse: r.adresse || r.ancienne_adresse,
      ancienCode: r.ancien_code,
      code: r.action === 'delete' ? null : r.code
    }))
  });
}
