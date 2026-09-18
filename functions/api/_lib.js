// Utilitaires partagés par les fonctions /api/*.
// Les fichiers préfixés par _ ne sont pas exposés comme routes par Cloudflare Pages.

export const MAX_ADDRESS = 120;
export const MAX_CODE = 40;
export const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

/** Retire les caractères de contrôle, écrase les espaces multiples, borne la longueur. */
export function sanitizeText(value, max) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > max) return null;
  return cleaned;
}

/**
 * Normalisation stricte, utilisée pour l'unicité en base.
 * On garde le type de voie ("rue", "avenue") : seules les fiches réellement
 * identiques sont bloquées. Le rapprochement approximatif reste une
 * suggestion côté client.
 */
export function normAddress(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function clientId(request) {
  const raw = request.headers.get('X-Chall-Client') || '';
  return ID_RE.test(raw) ? raw : null;
}

/** Ligne SQL -> objet envoyé au navigateur. */
export function toRecord(row, me) {
  return {
    id: row.id,
    address: row.address,
    code: row.code,
    hs: row.hs === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    groupe: row.groupe_id || null,
    // Date du signalement hors service, pour l'afficher comme une modification.
    hsAt: row.hs_at || null,
    // Prénom déclaré du dernier modificateur. Public, contrairement au modèle
    // de l'appareil, qui reste réservé au panneau d'administration.
    parQui: row.par_qui || null,
    isMine: Boolean(me && row.author && row.author === me)
  };
}

export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Compteur glissant en base. Renvoie { ok, retryAfter }.
 * Appelé uniquement sur les écritures pour limiter le coût.
 */
export async function rateLimit(db, bucket, limit, windowSec) {
  const nowSec = Math.floor(Date.now() / 1000);
  const resetAt = nowSec + windowSec;

  await db
    .prepare(
      `INSERT INTO rate_limit (bucket, count, reset_at)
       VALUES (?1, 1, ?2)
       ON CONFLICT(bucket) DO UPDATE SET
         count    = CASE WHEN rate_limit.reset_at <= ?3 THEN 1   ELSE rate_limit.count + 1 END,
         reset_at = CASE WHEN rate_limit.reset_at <= ?3 THEN ?2  ELSE rate_limit.reset_at END`
    )
    .bind(bucket, resetAt, nowSec)
    .run();

  const row = await db
    .prepare('SELECT count, reset_at FROM rate_limit WHERE bucket = ?1')
    .bind(bucket)
    .first();

  if (!row) return { ok: true, retryAfter: 0 };
  return { ok: row.count <= limit, retryAfter: Math.max(1, row.reset_at - nowSec) };
}

export function ipBucket(request, prefix) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return `${prefix}:${ip}`;
}

export async function archive(db, row, action, actor) {
  await db
    .prepare(
      `INSERT INTO codes_history (id, address, code, hs, action, actor, archived_at, prev_updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(row.id, row.address, row.code, row.hs, action, actor, Date.now(), row.updated_at)
    .run();
}

/** Système + mode d'affichage, déduits des en-têtes. */
export function devicePlatform(request) {
  const ua = request.headers.get('User-Agent') || '';
  const mode = request.headers.get('X-Chall-Mode') === 'app' ? 'app' : 'web';
  const os = /android/i.test(ua) ? 'android' : /iphone|ipad|ipod/i.test(ua) ? 'ios' : 'autre';
  return os + '-' + mode;
}

/**
 * Modèle de l'appareil, quand le navigateur veut bien le donner.
 * Chrome a figé le modèle dans l'identification classique depuis 2023 : il
 * n'arrive que via Sec-CH-UA-Model, et seulement après que le serveur l'ait
 * demandé. Safari ne le fournit jamais — sur iPhone on n'aura rien.
 */
export function deviceModel(request) {
  const brut = request.headers.get('Sec-CH-UA-Model') || '';
  const modele = brut.replace(/^"|"$/g, '').trim();
  if (!modele || modele === 'K') return null; // « K » est la valeur bidon d'Android
  return modele.slice(0, 60);
}

/** Prénom facultatif déclaré par le livreur. */
export function deviceNom(request) {
  const brut = sanitizeText(request.headers.get('X-Chall-Nom') || '', 30);
  return brut || null;
}

/** Marque l'appareil comme vu. Une ligne par appareil, jamais de doublon. */
export async function touchDevice(db, id, platform, model, nom, geoloc) {
  if (!id) return;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO devices (client_id, platform, model, nom_declare, geoloc, first_seen, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(client_id) DO UPDATE SET
         last_seen = ?6,
         platform = ?2,
         -- On ne remplace jamais une valeur connue par du vide.
         model = COALESCE(?3, devices.model),
         nom_declare = COALESCE(?4, devices.nom_declare),
         geoloc = COALESCE(?5, devices.geoloc)`
    )
    .bind(id, platform, model, nom, geoloc, now)
    .run();
}

// Particules qui restent en minuscules sauf en début d'adresse.
const PARTICULES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'au', 'aux', 'et', 'sur', 'sous', 'en']);

// Types de voie collés au numéro : « 12rue » doit devenir « 12 rue ».
const TYPES_VOIE =
  'avenue|av|boulevard|bd|blvd|rue|chemin|impasse|route|traverse|allee|allée|place|cours|montee|montée|corniche|quai|square|villa|passage|residence|résidence';

/**
 * Met une adresse en forme : espaces et majuscules là où il faut.
 * Prudent par construction : un mot contenant déjà une majuscule n'est jamais
 * retouché, pour ne pas transformer « Code WC » en « Code Wc ».
 */
/**
 * Jargon de l'équipe : raccourcis maison développés en adresse complète.
 * Les valeurs sont en minuscules, la mise en majuscules se fait ensuite.
 */
const JARGON = {
  gbt: 'boulevard gambetta'
};

// Abréviations de voie développées à l'enregistrement, pour un registre homogène.
const EXPANSIONS = {
  av: 'Avenue', ave: 'Avenue', aven: 'Avenue',
  bd: 'Boulevard', bld: 'Boulevard', blvd: 'Boulevard', boul: 'Boulevard',
  r: 'Rue',
  ch: 'Chemin', che: 'Chemin', chem: 'Chemin',
  imp: 'Impasse',
  rte: 'Route',
  st: 'Saint', ste: 'Sainte',
  pl: 'Place',
  crn: 'Corniche',
  trav: 'Traverse',
  mtee: 'Montée',
  psg: 'Passage',
  sq: 'Square'
};

/** Développe une abréviation isolée. Traite aussi les parties d'un mot composé. */
function developper(mot) {
  const entier = mot.replace(/\.$/, '').toLowerCase();
  if (JARGON[entier]) return JARGON[entier];

  return mot
    .split('-')
    .map((part) => {
      const nu = part.replace(/\.$/, '').toLowerCase();
      return EXPANSIONS[nu] || part;
    })
    .join('-');
}

export function formatAddress(str) {
  let out = str;

  // 0. abréviations : « bd » -> « Boulevard », « st-jean » -> « Saint-Jean »
  out = out.split(' ').map(developper).join(' ');

  // 1. espace manquant entre le numéro et le type de voie
  out = out.replace(new RegExp('\\b(\\d+)(' + TYPES_VOIE + ')\\b', 'gi'), '$1 $2');

  // 2. espaces autour des séparateurs
  out = out.replace(/\s*\/\s*/g, '/').replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();

  // 3. majuscules, en laissant intact tout mot qui en contient déjà une
  out = out
    .split(' ')
    .map((mot, i) => {
      if (i > 0 && PARTICULES.has(mot.toLowerCase()) && !/[A-ZÀ-Þ]/.test(mot)) return mot;
      // Chaque partie d'un mot composé est jugée séparément : dans
      // « Saint-barthelemy », le « Saint » est déjà correct mais pas la suite.
      return mot
        .split('-')
        .map((part) => {
          if (/[A-ZÀ-Þ]/.test(part)) return part;
          return part.replace(/(^|')([a-zà-ÿ])/g, (m, sep, c) => sep + c.toUpperCase());
        })
        .join('-');
    })
    .join(' ');

  return out;
}

/** Distance de Levenshtein, bornée : sert à mesurer un écart de frappe. */
export function distance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Corrige l'orthographe d'une adresse via la Base Adresse Nationale.
 * Très prudent : ne corrige que si le numéro est identique et que l'écart
 * avec la saisie est minime. Renvoie null si aucune correction sûre.
 */
export async function corrigerViaBAN(address) {
  // Seules les vraies adresses sont vérifiées. « Code WC », « Parc St Exupéry »
  // ne commencent pas par un numéro : on n'y touche jamais.
  const numSaisi = (address.match(/^\s*(\d+)/) || [])[1];
  if (!numSaisi) return null;

  const url =
    'https://data.geopf.fr/geocodage/search?index=address&limit=1&citycode=06088&q=' +
    encodeURIComponent(address);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;

    const data = await res.json();
    const props = (data.features && data.features[0] && data.features[0].properties) || null;
    if (!props || props.type !== 'housenumber') return null;
    if (typeof props.score === 'number' && props.score < 0.9) return null;

    const officielle = props.name;
    if (!officielle) return null;

    // Le numéro doit être rigoureusement le même : jamais de glissement d'immeuble.
    if ((officielle.match(/^\s*(\d+)/) || [])[1] !== numSaisi) return null;

    const a = normAddress(address);
    const b = normAddress(officielle);
    if (a === b) return null; // identique aux accents près : rien à corriger

    // Au-delà de deux caractères d'écart, ce n'est plus une faute de frappe.
    if (distance(a, b) > 2) return null;

    return officielle;
  } catch {
    return null; // service indisponible ou trop lent : on garde la saisie
  }
}

const jourCourant = () => new Date().toISOString().slice(0, 10);

/** Une ligne par appareil et par jour, compteur d'ouvertures. */
export async function noterVisite(db, clientId) {
  if (!clientId) return;
  await db
    .prepare(
      `INSERT INTO visites (jour, client_id, ouvertures) VALUES (?1, ?2, 1)
       ON CONFLICT(jour, client_id) DO UPDATE SET ouvertures = visites.ouvertures + 1`
    )
    .bind(jourCourant(), clientId)
    .run();
}

/**
 * Compte les refus avec clé fournie mais fausse. Plafonné à 500 écritures
 * par jour : un robot qui martèle l'adresse ne peut pas épuiser le quota.
 */
export async function noterCleInvalide(db) {
  const jour = jourCourant();
  try {
    const row = await db
      .prepare('SELECT cle_invalide FROM acces_refuses WHERE jour = ?1')
      .bind(jour)
      .first();
    if (row && row.cle_invalide >= 500) return;

    await db
      .prepare(
        `INSERT INTO acces_refuses (jour, cle_invalide) VALUES (?1, 1)
         ON CONFLICT(jour) DO UPDATE SET cle_invalide = acces_refuses.cle_invalide + 1`
      )
      .bind(jour)
      .run();
  } catch {
    // Le comptage ne doit jamais empêcher le refus lui-même.
  }
}

const encodeurAdmin = new TextEncoder();

/** Comparaison à temps constant, pour ne pas fuiter la clé octet par octet. */
function egaliteConstante(a, b) {
  const ab = encodeurAdmin.encode(a);
  const bb = encodeurAdmin.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Vérifie la clé d'administration, distincte de la clé d'accès partagée.
 * Sans elle, le serveur refuse : masquer une commande dans le navigateur
 * ne protégerait rien, puisque tous les livreurs ont le même code.
 */
export function estAdmin(request, env) {
  const attendue = env.CHALL_ADMIN_KEY;
  if (!attendue) return false;
  return egaliteConstante(request.headers.get('X-Chall-Admin') || '', attendue);
}

/**
 * État de l'autorisation de position déclaré par le navigateur.
 * « prompt » ne veut pas dire refus : c'est qu'elle n'a jamais été demandée.
 */
export function deviceGeo(request) {
  const valeur = (request.headers.get('X-Chall-Geo') || '').toLowerCase();
  return ['granted', 'denied', 'prompt'].includes(valeur) ? valeur : null;
}
