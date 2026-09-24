import { json, isValidId, clientId, rateLimit, ipBucket } from '../_lib.js';
import { assurerTable, toClient, COLONNES } from '../_clients.js';

// Photo d'une fiche client, stockée dans R2 (liaison PHOTOS).
// Une seule photo par client : un nouvel envoi remplace l'ancienne.

const TAILLE_MAX = 600 * 1024; // compressée côté téléphone, ~150 Ko en pratique
const TYPES = ['image/jpeg', 'image/webp', 'image/png'];

function nonConfigure() {
  return json(
    { error: 'photos_off', message: 'Le stockage des photos n’est pas encore activé sur le serveur.' },
    503
  );
}

async function ficheClient(context) {
  const { env, params } = context;
  if (!isValidId(params.id)) {
    return { error: json({ error: 'bad_request', message: 'Identifiant invalide.' }, 400) };
  }
  await assurerTable(env.DB);
  const row = await env.DB.prepare(`SELECT ${COLONNES} FROM clients WHERE id = ?1`).bind(params.id).first();
  if (!row) return { error: json({ error: 'not_found', message: 'Cette fiche client a été supprimée.' }, 404) };
  return { row };
}

export async function onRequestGet(context) {
  if (!context.env.PHOTOS) return nonConfigure();
  if (!isValidId(context.params.id)) return json({ error: 'bad_request', message: 'Identifiant invalide.' }, 400);

  const objet = await context.env.PHOTOS.get('clients/' + context.params.id);
  if (!objet) return json({ error: 'not_found', message: 'Pas de photo.' }, 404);

  return new Response(objet.body, {
    headers: {
      'Content-Type': objet.httpMetadata?.contentType || 'image/jpeg',
      // L'application garde sa propre copie : pas de cache partagé.
      'Cache-Control': 'private, no-store'
    }
  });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  if (!env.PHOTOS) return nonConfigure();

  const limit = await rateLimit(env.DB, ipBucket(request, 'write'), 60, 3600);
  if (!limit.ok) {
    return json(
      { error: 'rate_limited', message: 'Trop de modifications. Réessayez dans un moment.' },
      429,
      { 'Retry-After': String(limit.retryAfter) }
    );
  }

  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!TYPES.includes(type)) return json({ error: 'bad_type', message: 'Format de photo non pris en charge.' }, 415);

  const f = await ficheClient(context);
  if (f.error) return f.error;

  const donnees = await request.arrayBuffer();
  if (!donnees.byteLength) return json({ error: 'bad_request', message: 'Photo vide.' }, 400);
  if (donnees.byteLength > TAILLE_MAX) return json({ error: 'too_large', message: 'Photo trop lourde.' }, 413);

  await env.PHOTOS.put('clients/' + f.row.id, donnees, { httpMetadata: { contentType: type } });

  const me = clientId(request);
  const now = Date.now();
  await env.DB
    .prepare('UPDATE clients SET photo = ?1, updated_at = ?1, maj_par = ?2 WHERE id = ?3')
    .bind(now, me, f.row.id)
    .run();

  return json({ client: toClient({ ...f.row, photo: now, updated_at: now }, me) });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!env.PHOTOS) return nonConfigure();

  const limit = await rateLimit(env.DB, ipBucket(request, 'write'), 60, 3600);
  if (!limit.ok) {
    return json(
      { error: 'rate_limited', message: 'Trop de modifications. Réessayez dans un moment.' },
      429,
      { 'Retry-After': String(limit.retryAfter) }
    );
  }

  const f = await ficheClient(context);
  // Fiche déjà supprimée : rien à faire, la file hors ligne peut continuer.
  if (f.error) return f.error.status === 404 ? json({ ok: true }) : f.error;

  await env.PHOTOS.delete('clients/' + f.row.id);
  const me = clientId(request);
  const now = Date.now();
  await env.DB
    .prepare('UPDATE clients SET photo = NULL, updated_at = ?1, maj_par = ?2 WHERE id = ?3')
    .bind(now, me, f.row.id)
    .run();

  return json({ client: toClient({ ...f.row, photo: null, updated_at: now }, me) });
}
