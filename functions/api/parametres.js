import { json, estAdmin, readJson } from './_lib.js';

// Réglages communs à toute l'équipe, fixés par l'administrateur :
// dates de clôture de la paie et montants des primes exceptionnelles.
// Tout le monde les lit ; seul l'administrateur les modifie.

let tablePrete = false;
async function assurerTable(db) {
  if (tablePrete) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS parametres (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)').run();
  tablePrete = true;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MOIS_RE = /^\d{4}-\d{2}$/;
const CODE_RE = /^[A-Z]{3}$/;

/** Dates de clôture : { 'AAAA-MM': 'AAAA-MM-JJ' }. Tout le reste est écarté. */
function validerClotures(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const propre = {};
  for (const [mois, date] of Object.entries(v).slice(0, 120)) {
    if (MOIS_RE.test(mois) && typeof date === 'string' && DATE_RE.test(date)) propre[mois] = date;
  }
  return propre;
}

/** Primes exceptionnelles : { RCM: { nom, montant } }, montant brut en euros. */
function validerPrimes(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const propre = {};
  for (const [code, p] of Object.entries(v).slice(0, 20)) {
    if (!CODE_RE.test(code) || !p || typeof p !== 'object') continue;
    const montant = Number(p.montant);
    const nom = typeof p.nom === 'string' ? p.nom.slice(0, 40) : code;
    if (Number.isFinite(montant) && montant >= 0 && montant < 10000) propre[code] = { nom, montant: Math.round(montant * 100) / 100 };
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
  if (!estAdmin(context.request, context.env)) {
    return json({ error: 'forbidden', message: "Réservé à l'administrateur." }, 403);
  }
  const body = await readJson(context.request);
  if (!body) return json({ error: 'bad_request', message: 'Corps de requête illisible.' }, 400);

  const db = context.env.DB;
  await assurerTable(db);
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
  }
  if (body.clotureHabituelle !== undefined) {
    const j = parseInt(body.clotureHabituelle, 10);
    if (!(j >= 1 && j <= 31)) return json({ error: 'bad_request', message: 'Jour de clôture invalide.' }, 400);
    lot.push(ecrire('clotureHabituelle', j));
  }
  if (body.primesExc !== undefined) {
    const p = validerPrimes(body.primesExc);
    if (!p) return json({ error: 'bad_request', message: 'Primes invalides.' }, 400);
    lot.push(ecrire('primesExc', p));
  }
  if (lot.length) await db.batch(lot);

  return json({ parametres: await lire(db) });
}
