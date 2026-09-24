// Registre des clients : utilitaires partagés par /api/clients et /api/clients/:id.

import { sanitizeText } from './_lib.js';

export const MAX_NOM = 60;
export const MAX_ADRESSE = 120;
export const MAX_INFO = 500;

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
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL,
         author     TEXT,
         maj_par    TEXT
       )`
    ),
    db.prepare('CREATE INDEX IF NOT EXISTS clients_nom ON clients (nom COLLATE NOCASE)')
  ]);
  tablePrete = true;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parQui: row.par_qui || null,
    isMine: Boolean(me && row.author && row.author === me)
  };
}
