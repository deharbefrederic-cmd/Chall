import {
  json, sanitizeText, isValidId, clientId, readJson, rateLimit, ipBucket, formatAddress, deviceNom, estAdmin
} from '../_lib.js';
import {
  assurerTable, sanitizeInfo, sanitizeOptionnel, toClient, normBatiment, normEtage, normInterphone,
  COLONNES, MAX_NOM, MAX_ADRESSE
} from '../_clients.js';

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

  if (!isValidId(params.id)) {
    return { error: json({ error: 'bad_request', message: 'Identifiant invalide.' }, 400) };
  }

  await assurerTable(db);
  const row = await db
    .prepare(`SELECT ${COLONNES} FROM clients WHERE id = ?1`)
    .bind(params.id)
    .first();

  return { db, id: params.id, row, me: clientId(request) };
}

export async function onRequestPatch(context) {
  const g = await guard(context);
  if (g.error) return g.error;
  const { db, id, row, me } = g;

  if (!row) return json({ error: 'not_found', message: 'Cette fiche client a été supprimée.' }, 404);

  const body = await readJson(context.request);
  if (!body) return json({ error: 'bad_request', message: 'Corps de requête illisible.' }, 400);

  let { nom, adresse, info } = row;
  let batiment = row.batiment || '';
  let etage = row.etage || '';
  let interphone = row.interphone || '';

  if (body.nom !== undefined) {
    nom = sanitizeText(body.nom, MAX_NOM);
    if (!nom) return json({ error: 'invalid_nom', message: 'Nom manquant ou trop long.' }, 400);
  }
  if (body.adresse !== undefined) {
    const brute = sanitizeOptionnel(body.adresse, MAX_ADRESSE);
    if (brute === null) return json({ error: 'invalid_adresse', message: 'Adresse trop longue.' }, 400);
    adresse = brute ? formatAddress(brute) : '';
  }
  if (body.info !== undefined) {
    info = sanitizeInfo(body.info);
    if (info === null) return json({ error: 'invalid_info', message: 'Informations trop longues.' }, 400);
  }

  const champs = [
    ['batiment', normBatiment, 'Bâtiment trop long.'],
    ['etage', normEtage, 'Étage trop long.'],
    ['interphone', normInterphone, 'Interphone trop long.']
  ];
  const valeurs = { batiment, etage, interphone };
  for (const [cle, norm, message] of champs) {
    if (body[cle] === undefined) continue;
    const v = norm(body[cle]);
    if (v === null) return json({ error: 'invalid_champ', message }, 400);
    valeurs[cle] = v;
  }
  ({ batiment, etage, interphone } = valeurs);

  if (
    nom === row.nom && adresse === (row.adresse || '') && info === (row.info || '') &&
    batiment === (row.batiment || '') && etage === (row.etage || '') && interphone === (row.interphone || '')
  ) {
    return json({ client: toClient(row, me) });
  }

  const now = Date.now();
  await db
    .prepare(
      `UPDATE clients SET nom = ?1, adresse = ?2, info = ?3, batiment = ?4, etage = ?5, interphone = ?6,
                          updated_at = ?7, maj_par = ?8 WHERE id = ?9`
    )
    .bind(nom, adresse, info, batiment, etage, interphone, now, me, id)
    .run();

  return json({
    client: toClient(
      { ...row, nom, adresse, info, batiment, etage, interphone, updated_at: now, par_qui: deviceNom(context.request) },
      me
    )
  });
}

/** Suppression : l'auteur de la fiche, ou l'administrateur. */
export async function onRequestDelete(context) {
  const g = await guard(context);
  if (g.error) return g.error;
  const { db, id, row, me } = g;

  if (!row) return json({ ok: true });

  const admin = estAdmin(context.request, context.env);
  if (!admin && (!me || row.author !== me)) {
    return json({ error: 'forbidden', message: 'Seul l’auteur de la fiche peut la supprimer.' }, 403);
  }

  await db.prepare('DELETE FROM clients WHERE id = ?1').bind(id).run();
  return json({ ok: true });
}
