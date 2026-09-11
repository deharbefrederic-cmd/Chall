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
      `INSERT INTO codes_history (id, address, code, hs, action, actor, archived_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(row.id, row.address, row.code, row.hs, action, actor, Date.now())
    .run();
}

/** Système + mode d'affichage, déduits des en-têtes. */
export function devicePlatform(request) {
  const ua = request.headers.get('User-Agent') || '';
  const mode = request.headers.get('X-Chall-Mode') === 'app' ? 'app' : 'web';
  const os = /android/i.test(ua) ? 'android' : /iphone|ipad|ipod/i.test(ua) ? 'ios' : 'autre';
  return os + '-' + mode;
}

/** Marque l'appareil comme vu. Une ligne par appareil, jamais de doublon. */
export async function touchDevice(db, id, platform) {
  if (!id) return;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO devices (client_id, platform, first_seen, last_seen)
       VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(client_id) DO UPDATE SET last_seen = ?3, platform = ?2`
    )
    .bind(id, platform, now)
    .run();
}
