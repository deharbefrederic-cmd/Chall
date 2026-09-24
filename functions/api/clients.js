import { json, sanitizeText, isValidId, clientId, readJson, rateLimit, ipBucket, formatAddress, deviceNom } from './_lib.js';
import {
  assurerTable, sanitizeInfo, sanitizeOptionnel, toClient, normBatiment, normEtage, normInterphone,
  COLONNES, MAX_NOM, MAX_ADRESSE
} from './_clients.js';

export async function onRequestGet(context) {
  const db = context.env.DB;
  const me = clientId(context.request);
  await assurerTable(db);

  const { results } = await db
    .prepare(
      `SELECT c.id, c.nom, c.adresse, c.info, c.batiment, c.etage, c.interphone,
              c.created_at, c.updated_at, c.author,
              d.nom_declare AS par_qui
       FROM clients c
       LEFT JOIN devices d ON d.client_id = c.maj_par
       ORDER BY c.nom COLLATE NOCASE`
    )
    .all();

  return json({ clients: (results || []).map((row) => toClient(row, me)) });
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

  const nom = sanitizeText(body.nom, MAX_NOM);
  if (!nom) return json({ error: 'invalid_nom', message: 'Nom manquant ou trop long.' }, 400);

  const adresseBrute = sanitizeOptionnel(body.adresse, MAX_ADRESSE);
  if (adresseBrute === null) return json({ error: 'invalid_adresse', message: 'Adresse trop longue.' }, 400);
  const adresse = adresseBrute ? formatAddress(adresseBrute) : '';

  const info = sanitizeInfo(body.info);
  if (info === null) return json({ error: 'invalid_info', message: 'Informations trop longues.' }, 400);

  const batiment = normBatiment(body.batiment);
  const etage = normEtage(body.etage);
  const interphone = normInterphone(body.interphone);
  if (batiment === null || etage === null || interphone === null) {
    return json({ error: 'invalid_champ', message: 'Bâtiment, étage ou interphone trop long.' }, 400);
  }

  await assurerTable(db);

  const id = isValidId(body.id) ? body.id : crypto.randomUUID();
  const author = clientId(request);
  const now = Date.now();

  // Identifiant fourni par le client : un double envoi ne crée pas de doublon.
  await db
    .prepare(
      `INSERT INTO clients (id, nom, adresse, info, batiment, etage, interphone, created_at, updated_at, author, maj_par)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?9)
       ON CONFLICT(id) DO NOTHING`
    )
    .bind(id, nom, adresse, info, batiment, etage, interphone, now, author)
    .run();

  const row = await db
    .prepare(`SELECT ${COLONNES} FROM clients WHERE id = ?1`)
    .bind(id)
    .first();

  return json({ client: toClient({ ...row, par_qui: deviceNom(request) }, author) }, 201);
}
