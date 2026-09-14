import { json, noterCleInvalide } from './_lib.js';

const encoder = new TextEncoder();

/** Comparaison à temps constant : évite de fuiter la clé octet par octet. */
function safeEqual(a, b) {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function onRequest(context) {
  const { request, env, next } = context;

  const expected = env.CHALL_KEY;
  if (!expected) {
    return json({ error: 'server_misconfigured', message: "La clé d'accès n'est pas configurée." }, 500);
  }

  if (!env.DB) {
    return json({ error: 'server_misconfigured', message: 'La base D1 n\'est pas liée.' }, 500);
  }

  const provided = request.headers.get('X-Chall-Key') || '';
  if (!safeEqual(provided, expected)) {
    // Une clé fournie mais fausse signale un vrai porteur de lien (périmé, mal
    // recopié, ou qui a circulé). Une requête sans aucune clé est un robot :
    // on ne la compte pas, pour ne pas transformer le compteur en bruit.
    if (provided) context.waitUntil(noterCleInvalide(env.DB));
    return json({ error: 'unauthorized', message: "Clé d'accès invalide." }, 401);
  }

  // La clé voyage dans un en-tête personnalisé : un site tiers ne peut pas
  // l'ajouter sans préflight CORS, qu'on n'autorise jamais. Pas de CSRF possible.
  const response = await next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // Demande au navigateur de joindre le modèle aux requêtes suivantes.
  // Silencieux côté utilisateur : aucune fenêtre d'autorisation.
  response.headers.set('Accept-CH', 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
