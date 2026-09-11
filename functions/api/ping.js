import { json } from './_lib.js';

// Route protégée par le middleware : une réponse 200 signifie que la clé est bonne.
export function onRequestGet() {
  return json({ ok: true });
}
