// Registre des clients : utilitaires partagés par /api/clients et /api/clients/:id.

import { sanitizeText } from './_lib.js';

export const MAX_NOM = 60;
export const MAX_ADRESSE = 120;
export const MAX_INFO = 500;
export const MAX_BATIMENT = 20;
export const MAX_ETAGE = 20;
export const MAX_INTERPHONE = 40;

/**
 * La table est créée à la première utilisation : rien à coller dans la
 * console D1 pour activer l'onglet. CREATE IF NOT EXISTS est sans effet
 * une fois la table en place.
 */
let tablePrete = false;
export async function assurerTable(db) {
  if (tablePrete) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS clients (
         id         TEXT PRIMARY KEY,
         nom        TEXT NOT NULL,
         adresse    TEXT,
         info       TEXT,
         batiment   TEXT,
         etage      TEXT,
         interphone TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         author     TEXT,
         maj_par    TEXT
       )`
    ),
    db.prepare('CREATE INDEX IF NOT EXISTS clients_nom ON clients (nom COLLATE NOCASE)')
  ]);
  // Table créée avant l'arrivée des champs structurés : on les ajoute.
  // Une colonne déjà présente fait échouer l'ALTER, ce qui est sans gravité.
  for (const col of ['batiment', 'etage', 'interphone']) {
    try {
      await db.prepare(`ALTER TABLE clients ADD COLUMN ${col} TEXT`).run();
    } catch {
      /* colonne déjà là */
    }
  }
  tablePrete = true;
}

export const COLONNES = 'id, nom, adresse, info, batiment, etage, interphone, created_at, updated_at, author';

/** « b » -> « B », « bat. c » -> « C » : une seule écriture pour toute l'équipe. */
export function normBatiment(value) {
  const v = sanitizeOptionnel(value, MAX_BATIMENT);
  if (!v) return v;
  return v.replace(/^(b[aâ]t(iment)?|bt)\b\.?\s*/i, '').toUpperCase();
}

/** « rdc », « 0 » -> « RDC » ; « 3e », « 3ème », « 3° » -> « 3 ». */
export function normEtage(value) {
  const v = sanitizeOptionnel(value, MAX_ETAGE);
  if (!v) return v;
  const brut = v.replace(/^[ée]t(age)?\b\.?\s*/i, '').trim();
  if (/^(rdc|rez[- ]de[- ]chauss[ée]e|0)$/i.test(brut)) return 'RDC';
  const n = brut.match(/^(-?\d+)\s*(e|er|re|ère|eme|ème|°)?$/i);
  if (n) return n[1];
  return brut;
}

/** Interphone : nom ou numéro tel qu'affiché sur la plaque, espaces écrasés. */
export function normInterphone(value) {
  return sanitizeOptionnel(value, MAX_INTERPHONE);
}

/**
 * Texte libre sur plusieurs lignes : on garde les retours à la ligne,
 * on retire le reste des caractères de contrôle.
 */
export function sanitizeInfo(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > MAX_INFO ? null : cleaned;
}

/** Champ facultatif sur une ligne : vide accepté, trop long refusé. */
export function sanitizeOptionnel(value, max) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string') return null;
  if (!value.trim()) return '';
  return sanitizeText(value, max);
}

export function toClient(row, me) {
  return {
    id: row.id,
    nom: row.nom,
    adresse: row.adresse || '',
    info: row.info || '',
    batiment: row.batiment || '',
    etage: row.etage || '',
    interphone: row.interphone || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parQui: row.par_qui || null,
    isMine: Boolean(me && row.author && row.author === me)
  };
}
