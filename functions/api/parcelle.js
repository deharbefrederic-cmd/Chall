import { json, estAdmin } from './_lib.js';

/**
 * Parcelle cadastrale contenant un point donné.
 *
 * L'appel passe par le serveur plutôt que par le navigateur : le service de
 * l'IGN n'autorise pas forcément les requêtes directes depuis une page web.
 */
export async function onRequestGet(context) {
  if (!estAdmin(context.request, context.env)) {
    return json({ error: 'forbidden', message: "Réservé à l'administrateur." }, 403);
  }

  const url = new URL(context.request.url);
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: 'bad_request', message: 'Coordonnées manquantes.' }, 400);
  }

  const geom = JSON.stringify({ type: 'Point', coordinates: [lon, lat] });
  const cible =
    'https://apicarto.ign.fr/api/cadastre/parcelle?_limit=1&geom=' + encodeURIComponent(geom);

  try {
    const res = await fetch(cible, { headers: { Accept: 'application/json' } });
    if (!res.ok) return json({ parcelle: null });

    const data = await res.json();
    const p = ((data.features || [])[0] || {}).properties;
    if (!p) return json({ parcelle: null });

    return json({
      // L'identifiant unique sert à comparer, le libellé à afficher.
      parcelle: p.idu || (p.code_insee || '') + (p.section || '') + (p.numero || ''),
      libelle: [p.section, p.numero].filter(Boolean).join(' ') || null
    });
  } catch {
    return json({ parcelle: null });
  }
}
