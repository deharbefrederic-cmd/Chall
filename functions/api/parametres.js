import { json, estAdmin, readJson, rateLimit, ipBucket, deviceNom } from './_lib.js';

// Réglages communs à toute l'équipe : dates de clôture de la paie et jour
// habituel. Tout livreur peut les saisir (celui qui apprend la date la donne
// aux autres) ; qui et quand sont notés.

let tablePrete = false;
async function assurerTable(db) {
  if (tablePrete) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS parametres (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)').run();
  tablePrete = true;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MOIS_RE = /^\d{4}-\d{2}$/;

/** Dates de clôture : { 'AAAA-MM': 'AAAA-MM-JJ' }. Tout le reste est écarté. */
function validerClotures(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const propre = {};
  for (const [mois, date] of Object.entries(v).slice(0, 120)) {
    if (MOIS_RE.test(mois) && typeof date === 'string' && DATE_RE.test(date)) propre[mois] = date;
  }
  return propre;
}

async function lire(db) {
  await assurerTable(db);
  const { results } = await db.prepare('SELECT cle, valeur FROM parametres').all();
  const out = {};
  for (const r of results || []) {
    try {
      out[r.cle] = JSON.parse(r.valeur);
    } catch {
      /* valeur illisible : ignorée */
    }
  }
  return out;
}

export async function onRequestGet(context) {
  return json({ parametres: await lire(context.env.DB) });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request', message: 'Corps de requête illisible.' }, 400);

  const db = env.DB;
  const limit = await rateLimit(db, ipBucket(request, 'write'), 60, 3600);
  if (!limit.ok) {
    return json({ error: 'rate_limited', message: 'Trop de modifications. Réessayez dans un moment.' }, 429,
      { 'Retry-After': String(limit.retryAfter) });
  }
  await assurerTable(db);
  const avant = await lire(db);
  const ecrire = (cle, valeur) =>
    db.prepare(
      `INSERT INTO parametres (cle, valeur) VALUES (?1, ?2)
       ON CONFLICT(cle) DO UPDATE SET valeur = ?2`
    ).bind(cle, JSON.stringify(valeur));

  const lot = [];
  if (body.clotures !== undefined) {
    const c = validerClotures(body.clotures);
    if (!c) return json({ error: 'bad_request', message: 'Dates de clôture invalides.' }, 400);
    lot.push(ecrire('clotures', c));

    // Qui a saisi, modifié ou effacé chaque clôture, et quand.
    const anciennes = avant.clotures || {};
    const suivi = { ...(avant.cloturesMaj || {}) };
    const par = deviceNom(request) || (estAdmin(request, env) ? 'administrateur' : 'un livreur');
    for (const mois of new Set([...Object.keys(anciennes), ...Object.keys(c)])) {
      if (anciennes[mois] !== c[mois]) suivi[mois] = { par, le: Date.now(), efface: !c[mois] };
    }
    lot.push(ecrire('cloturesMaj', suivi));
  }
  if (body.clotureHabituelle !== undefined) {
    const j = parseInt(body.clotureHabituelle, 10);
    if (!(j >= 1 && j <= 31)) return json({ error: 'bad_request', message: 'Jour de clôture invalide.' }, 400);
    lot.push(ecrire('clotureHabituelle', j));
  }
  if (lot.length) await db.batch(lot);

  return json({ parametres: await lire(db) });
}
