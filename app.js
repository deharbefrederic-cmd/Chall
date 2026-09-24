'use strict';

/* ------------------------------------------------------------------ *
 * Challivretou — client
 * Écritures unitaires (une fiche = une requête), lecture hors ligne,
 * file d'attente rejouée au retour du réseau, rendu DOM sans innerHTML.
 * ------------------------------------------------------------------ */

// Repère de version, affiché dans le panneau : permet de vérifier d'un coup
// d'œil quelle version tourne réellement sur l'appareil.
const VERSION = '24/09 — clients récents';

const CACHE_KEY = 'chall_cache_v2';
const OUTBOX_KEY = 'chall_outbox_v2';
const ACCESS_KEY = 'chall_access_key';
const ADMIN_KEY = 'chall_admin_key';
const NOM_KEY = 'chall_nom';
const CLIENT_KEY = 'chall_client_id';
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

let records = [];
let editingId = null;
let filterRecentOnly = false;
let onglet = 'codes'; // 'codes' ou 'clients'
let isBusy = false;
let toastTimeout;
let deferredPrompt = null;

const $ = (id) => document.getElementById(id);

const searchInput = $('searchInput');
const clearBtn = $('clearBtn');
const codeList = $('codeList');
const itemCount = $('itemCount');
const syncStatus = $('syncStatus');
const editModal = $('editModal');
const modalAddress = $('modalAddress');
const modalCode = $('modalCode');
const modalTitle = $('modalTitle');
const deleteBtn = $('deleteBtn');
const hsToggleBtn = $('hsToggleBtn');
const saveBtn = $('saveModal');
const toast = $('toast');
const installBtn = $('installBtn');
const installPopupModal = $('installPopupModal');
const filterRecentBtn = $('filterRecentBtn');
const gateModal = $('gateModal');
const gateInput = $('gateInput');
const gateError = $('gateError');
const gateSubmit = $('gateSubmit');

/* ------------------------------- stockage ------------------------------- */

function getClientId() {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(36).slice(2))
      .replace(/[^A-Za-z0-9_-]/g, '');
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

const getAccessKey = () => localStorage.getItem(ACCESS_KEY) || '';

/**
 * Lien d'invitation : https://…/#k=LA_CLE
 * La clé est lue une seule fois, stockée sur l'appareil, puis effacée de la
 * barre d'adresse. Le livreur ne saisit jamais rien.
 * Le fragment (#) n'est pas transmis au serveur : la clé n'apparaît donc
 * dans aucun journal côté Cloudflare.
 */
function consumeKeyFromUrl() {
  let key = null;

  const fromHash = (location.hash || '').match(/[#&]k=([^&]+)/);
  if (fromHash) key = decodeURIComponent(fromHash[1]);
  else key = new URLSearchParams(location.search || '').get('k');

  if (!key) return false;

  localStorage.setItem(ACCESS_KEY, key.trim());
  history.replaceState(null, '', location.pathname);
  return true;
}

const buildInviteLink = () => location.origin + '/#k=' + encodeURIComponent(getAccessKey());

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota dépassé : on continue sans cache */
  }
}

const loadCache = () => readJson(CACHE_KEY, []);
const saveCache = () => writeJson(CACHE_KEY, records);
const loadOutbox = () => readJson(OUTBOX_KEY, []);
const saveOutbox = (ops) => writeJson(OUTBOX_KEY, ops);

function enqueue(op) {
  const ops = loadOutbox();
  ops.push(op);
  saveOutbox(ops);
  updateStatus();
}

/* --------------------------------- API --------------------------------- */

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.message || 'Erreur réseau');
    this.status = status;
    this.payload = payload || {};
  }
}

async function api(path, options = {}) {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  const headers = {
    'X-Chall-Key': getAccessKey(),
    'X-Chall-Client': getClientId(),
    'X-Chall-Mode': standalone ? 'app' : 'web',
    ...(localStorage.getItem(ADMIN_KEY) ? { 'X-Chall-Admin': localStorage.getItem(ADMIN_KEY) } : {}),
    ...(localStorage.getItem(NOM_KEY) ? { 'X-Chall-Nom': localStorage.getItem(NOM_KEY) } : {}),
    ...(etatPosition ? { 'X-Chall-Geo': etatPosition } : {}),
    ...(options.body ? { 'Content-Type': 'application/json' } : {})
  };

  const res = await fetch(path, { ...options, headers, cache: 'no-store' });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* réponse sans corps JSON */
  }

  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

/* ------------------------------- clé d'accès ----------------------------- */

function openGate(message) {
  gateError.textContent = message || '';
  gateInput.value = '';
  gateModal.style.display = 'flex';
  gateInput.focus();
}

gateSubmit.addEventListener('click', async () => {
  const value = gateInput.value.trim();
  if (!value) return;

  gateSubmit.disabled = true;
  gateError.textContent = '';
  localStorage.setItem(ACCESS_KEY, value);

  try {
    await api('/api/ping');
    gateModal.style.display = 'none';
    await loadData();
    trackDeviceInstallation();
  } catch (err) {
    localStorage.removeItem(ACCESS_KEY);
    gateError.textContent =
      err.status === 401 ? "Clé refusée. Vérifiez auprès de l'équipe." : 'Serveur injoignable. Réessayez.';
  } finally {
    gateSubmit.disabled = false;
  }
});

gateInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') gateSubmit.click();
});

// Empêche la page de défiler derrière une fenêtre ouverte. Un compteur gère
// les fenêtres empilées : le fond n'est libéré qu'à la fermeture de la dernière.
let fenetresOuvertes = 0;
function verrouillerFond() {
  fenetresOuvertes++;
  document.body.style.overflow = 'hidden';
  garder();
}
function libererFond() {
  fenetresOuvertes = Math.max(0, fenetresOuvertes - 1);
  if (!fenetresOuvertes) document.body.style.overflow = '';
}

/* ------------------------------- dialogues ------------------------------ */

function showDialog({ title, message, showCancel = true, okText = 'OK', cancelText = 'Annuler' }) {
  return new Promise((resolve) => {
    const modal = $('dialogModal');
    const okBtn = $('dialogOkBtn');
    const cancelBtn = $('dialogCancelBtn');

    $('dialogTitle').textContent = title || '';
    $('dialogMessage').textContent = message || '';
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    cancelBtn.style.display = showCancel ? 'block' : 'none';

    // Un journal de vingt lignes dépasse l'écran : il doit défiler dans la
    // fenêtre, et non entraîner la page derrière.
    const zone = $('dialogMessage');
    zone.style.maxHeight = '55vh';
    zone.style.overflowY = 'auto';
    zone.style.touchAction = 'pan-y';
    zone.style.overscrollBehavior = 'contain';
    zone.scrollTop = 0;

    // Cette fenêtre est un élément fixe du document : replacée en fin de page,
    // elle passe devant les panneaux créés à la volée (Appareils, groupes...),
    // sinon la confirmation s'ouvrirait derrière eux, invisible.
    document.body.appendChild(modal);
    modal.style.display = 'flex';
    verrouillerFond();

    const cleanup = () => {
      libererFond();
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

function showToast(message) {
  toast.textContent = message;
  toast.className = 'show';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.className = ''; }, 1800);
}

/* ------------------------- recherche et doublons ------------------------ */

function clean(str) {
  return (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const STREET_TYPES =
  /\b(avenue|ave|av|boulevard|bd|blvd|rue|chemin|che|ch|impasse|imp|route|rte|traverse|allee|place|cours|montee|residence|res|batiment|bat|corniche|quai|square|villa|passage)\b/g;

// Mots trop fréquents pour distinguer deux adresses.
const STOPWORDS = new Set([
  'de', 'des', 'du', 'la', 'le', 'les', 'aux', 'au', 'et', 'en', 'sur', 'sous',
  'saint', 'sainte', 'st', 'ste', 'general', 'grand', 'grande', 'vieux', 'vieille', 'petit', 'petite'
]);

// Abréviations de voies : « bd » et « boulevard » doivent trouver la même chose.
const ABBREVIATIONS = {
  // Jargon de l'équipe : une entrée peut valoir plusieurs mots.
  gbt: 'boulevard gambetta',
  av: 'avenue', ave: 'avenue', aven: 'avenue',
  bd: 'boulevard', bld: 'boulevard', blvd: 'boulevard', boul: 'boulevard',
  r: 'rue',
  ch: 'chemin', che: 'chemin', chem: 'chemin',
  imp: 'impasse',
  rte: 'route',
  st: 'saint', ste: 'sainte',
  pl: 'place',
  all: 'allee', allée: 'allee',
  res: 'residence', resid: 'residence',
  bat: 'batiment', bt: 'batiment',
  sq: 'square',
  tra: 'traverse', trav: 'traverse',
  crn: 'corniche',
  mtee: 'montee',
  qu: 'quai',
  vla: 'villa',
  psg: 'passage',
  crs: 'cours',
  esc: 'escalier',
  bis: 'bis'
};

/**
 * Texte ramené à une forme unique : abréviations développées, et surtout
 * suffixes de numéro harmonisés. Le référentiel officiel écrit « 10 bis »
 * là où les fiches portent souvent « 10B » — sans cette mise en forme, ce
 * sont deux adresses différentes.
 */
function searchKey(str) {
  return clean(str)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    // « 10 bis » -> « 10bis », « 10 ter » -> « 10ter »
    .replace(/\b(\d+)\s+(bis|ter|quater)\b/g, '$1$2')
    // « 10b » -> « 10bis », « 10t » -> « 10ter »
    .replace(/\b(\d+)b\b/g, '$1bis')
    .replace(/\b(\d+)t\b/g, '$1ter')
    .split(' ')
    .map((w) => ABBREVIATIONS[w] || w)
    .join(' ');
}

function coreTokens(str) {
  const base = clean(str).replace(STREET_TYPES, ' ').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  const number = (base.match(/\d+/) || [''])[0];
  const words = base
    .split(' ')
    .filter((w) => w && w !== number && w.length >= 3 && !STOPWORDS.has(w));
  return { base, number, words };
}

/**
 * Suggère une fiche existante à mettre à jour plutôt que de créer un doublon.
 * Le rapprochement approximatif n'a lieu qu'entre adresses portant le même
 * numéro de voie, et exige que les mots significatifs de l'une soient inclus
 * dans ceux de l'autre — « 12 rue des Fleurs » ne matche plus « 12 av des Roses ».
 */
function findSimilarAddress(address, ignoreId = null) {
  const a = coreTokens(address);

  for (const item of records) {
    if (ignoreId && item.id === ignoreId) continue;

    const b = coreTokens(item.address);
    if (a.base === b.base) return item;

    if (!a.number || !b.number || a.number !== b.number) continue;
    if (!a.words.length || !b.words.length) continue;

    const shared = a.words.filter((w) => b.words.includes(w));
    if (shared.length && shared.length === Math.min(a.words.length, b.words.length)) return item;
  }
  return null;
}

/* -------------------------------- rendu -------------------------------- */

function formatUpdateDate(ts) {
  if (!ts) return null;
  const days = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Aujourd'hui";
  if (days === 1) return 'Hier';
  if (days < 7) return `Il y a ${days} j`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // jamais innerHTML : pas d'injection possible
  return node;
}

function buildCard(item) {
  const isHS = Boolean(item.hs);
  const isRecent = item.updatedAt && Date.now() - item.updatedAt < RECENT_MS;

  const card = el('div', 'card' + (isHS ? ' is-hs' : ''));
  const info = el('div', 'card-info');
  info.appendChild(el('div', 'address', item.address));

  const row = el('div', 'code-row');
  row.appendChild(el('div', 'code-badge' + (isHS ? ' hs' : ''), (isHS ? '⚠️ ' : '') + item.code));
  if (isHS) row.appendChild(el('span', 'badge-tag badge-hs-alert', 'Code HS'));
  if (isRecent) row.appendChild(el('span', 'badge-tag badge-recent', 'MAJ'));
  info.appendChild(row);

  const dateLabel = formatUpdateDate(item.updatedAt);
  if (dateLabel) {
    // Seul le prénom déclaré est public. Le modèle de l'appareil ne l'est jamais.
    const par = item.parQui ? ' · par ' + item.parQui : '';
    info.appendChild(el('div', 'updated-date', '🕒 Modifié : ' + dateLabel + par));
  }

  // Le signalement a sa propre date : il ne remplace pas la modification,
  // il s'ajoute. Une fiche peut avoir été corrigée puis signalée depuis.
  const dateHS = isHS ? formatUpdateDate(item.hsAt) : null;
  if (dateHS) info.appendChild(el('div', 'updated-date', '⚠️ Signalé HS : ' + dateHS));

  const actions = el('div', 'actions');
  const editBtn = el('button', 'btn-action', '✏️');
  editBtn.type = 'button';
  editBtn.setAttribute('aria-label', 'Appui long pour modifier ' + item.address);
  editBtn.style.transition = 'background-color 600ms linear, transform 120ms';

  // Appui long : évite d'ouvrir la fiche par erreur en visant la copie.
  let minuteurEdit = null;
  let declenche = false;

  const armer = (e) => {
    e.stopPropagation();
    declenche = false;
    editBtn.style.backgroundColor = '#2563eb'; // remplissage progressif
    minuteurEdit = setTimeout(() => {
      declenche = true;
      minuteurEdit = null;
      editBtn.style.backgroundColor = '';
      editBtn.style.transform = 'scale(0.9)';
      setTimeout(() => { editBtn.style.transform = ''; }, 120);
      if (navigator.vibrate) navigator.vibrate(20);
      openEdit(item.id);
    }, 600);
  };

  const desarmer = () => {
    clearTimeout(minuteurEdit);
    minuteurEdit = null;
    editBtn.style.backgroundColor = '';
  };

  editBtn.addEventListener('pointerdown', armer);
  editBtn.addEventListener('pointerup', desarmer);
  editBtn.addEventListener('pointerleave', desarmer);
  editBtn.addEventListener('pointercancel', desarmer);
  editBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  // Un appui bref n'ouvre rien, mais explique quoi faire.
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!declenche) showToast('Appui long pour modifier');
    declenche = false;
  });

  actions.appendChild(editBtn);
  card.append(info, actions);
  return card;
}

function majBoutonEffacer() {
  // Rien à effacer quand le champ est vide : le bouton disparaît.
  clearBtn.style.display = searchInput.value ? '' : 'none';
}

function renderList() {
  majBoutonEffacer();
  if (onglet === 'clients') {
    renderClients();
    return;
  }
  const terms = searchKey(searchInput.value).split(' ').filter(Boolean);

  let filtered = records.filter((item) => {
    if (proximite && !proximite.includes(item.id)) return false;
    // « Récents » : sept jours pour tout. Une modification de code compte,
    // un signalement hors service aussi, chacun avec sa propre date.
    if (filterRecentOnly) {
      const modifiee = item.updatedAt && Date.now() - item.updatedAt < RECENT_MS;
      const signalee = item.hs && item.hsAt && Date.now() - item.hsAt < RECENT_MS;
      if (!modifiee && !signalee) return false;
    }
    if (!terms.length) return true;
    // Adresse seule (chercher « 69 » ne doit pas remonter les codes),
    // et abréviations développées des deux côtés.
    const target = searchKey(item.address);
    return terms.every((t) => target.includes(t));
  });

  if (proximite) {
    // Ordre de distance renvoyé par le service, du plus proche au plus loin.
    filtered.sort((x, y) => proximite.indexOf(x.id) - proximite.indexOf(y.id));
  } else if (filterRecentOnly) {
    // Chaque fiche est classée sur l'événement le plus récent la concernant.
    const quand = (r) => Math.max(r.updatedAt || 0, (r.hs && r.hsAt) || 0);
    filtered.sort((x, y) => quand(y) - quand(x));
  } else {
    filtered.sort((x, y) =>
      (x.address || '').localeCompare(y.address || '', 'fr', { numeric: true, sensitivity: 'base' })
    );
  }

  itemCount.textContent = proximite
    ? `📍 ${filtered.length} autour de vous`
    : `${filtered.length} résultat${filtered.length > 1 ? 's' : ''}`;

  const fragment = document.createDocumentFragment();
  if (!filtered.length) {
    fragment.appendChild(
      el('div', 'empty-state', records.length ? 'Aucune adresse ne correspond.' : 'Aucune adresse enregistrée. Appuyez sur + pour en ajouter une.')
    );
  } else {
    filtered.forEach((item) => fragment.appendChild(buildCard(item)));
  }

  codeList.replaceChildren(fragment);
}

function updateStatus(text) {
  if (text) {
    syncStatus.textContent = text;
    return;
  }
  const pending = loadOutbox().length;
  if (pending) syncStatus.textContent = `📦 ${pending} en attente`;
  else if (!navigator.onLine) syncStatus.textContent = '🔴 Hors ligne';
  else syncStatus.textContent = '🟢 À jour';
}

/* ------------------------ chargement et synchro ------------------------- */

async function loadData({ silent = false } = {}) {
  if (!silent) updateStatus('⏳ Connexion...');

  try {
    const data = await api('/api/codes');
    records = Array.isArray(data.records) ? data.records : [];
    saveCache();
    updateStatus();
  } catch (err) {
    if (err.status === 401) {
      openGate('Clé refusée. Saisissez la clé à jour.');
      return;
    }
    // Réseau indisponible : on garde le dernier état connu, l'appli reste utilisable.
    if (!records.length) records = loadCache();
    updateStatus(navigator.onLine ? '⚠️ Serveur injoignable' : '🔴 Hors ligne');
  }

  renderList();
}

function sendOp(op) {
  if (op.kind === 'create') {
    return api('/api/codes', {
      method: 'POST',
      body: JSON.stringify({ id: op.id, address: op.address, code: op.code })
    });
  }
  if (op.kind === 'patch') {
    return api('/api/codes/' + encodeURIComponent(op.id), {
      method: 'PATCH',
      body: JSON.stringify(op.patch)
    });
  }
  return api('/api/codes/' + encodeURIComponent(op.id), { method: 'DELETE' });
}

/** Rejoue la file dans l'ordre. Les ops rejetées définitivement sont abandonnées. */
async function flushOutbox() {
  let ops = loadOutbox();
  if (!ops.length) return true;

  updateStatus('⏳ Envoi...');
  const dropped = [];

  while (ops.length) {
    const op = ops[0];
    try {
      await sendOp(op);
      ops.shift();
      saveOutbox(ops);
    } catch (err) {
      if (err.status === 401) {
        openGate('Clé refusée. Saisissez la clé à jour.');
        return false;
      }
      if (err.status === 429 || err.status === undefined || err.status >= 500) {
        updateStatus(); // problème temporaire : on retentera plus tard
        return false;
      }
      dropped.push({ op, message: err.message });
      ops.shift();
      saveOutbox(ops);
    }
  }

  if (dropped.length) {
    showToast(`${dropped.length} modification(s) refusée(s)`);
    await showDialog({
      title: 'Modifications non enregistrées',
      message: dropped.map((d) => '• ' + d.message).join('\n'),
      showCancel: false,
      okText: 'Compris'
    });
  }
  return true;
}

/**
 * Applique une opération : envoi immédiat si possible, mise en file sinon.
 * Dans les deux cas l'écran est mis à jour tout de suite.
 */
async function commit(op, optimistic) {
  optimistic();
  saveCache();
  renderList();

  try {
    const result = await sendOp(op);
    if (result && result.record) {
      const idx = records.findIndex((r) => r.id === result.record.id);
      if (idx !== -1) records[idx] = result.record;
      // Fiches mises à jour en même temps (résidence à plusieurs entrées).
      for (const compagne of result.aussi || []) {
        const k = records.findIndex((r) => r.id === compagne.id);
        if (k !== -1) records[k] = compagne;
      }
      saveCache();
      renderList();
    }
    updateStatus();
    return { ok: true, data: result };
  } catch (err) {
    if (err.status === 401) {
      openGate('Clé refusée. Saisissez la clé à jour.');
      return { ok: false, err };
    }
    // Coupure réseau ou serveur momentanément indisponible : on garde l'op.
    if (err.status === undefined || err.status >= 500 || err.status === 429) {
      enqueue(op);
      showToast('Hors ligne — envoi différé');
      return { ok: true, queued: true };
    }
    // Refus définitif (doublon, droits, validation) : on resynchronise.
    await loadData({ silent: true });
    return { ok: false, err };
  }
}

/* ------------------- suggestions d'adresses (Base Adresse Nationale) ------------------- */

// Service public de l'IGN, gratuit et sans clé. Résultats limités à Nice.
const NICE_INSEE = '06088';

const suggestBox = document.createElement('div');
suggestBox.style.cssText =
  'display:none;margin:-6px 0 12px;border:1px solid #334155;border-radius:10px;' +
  'background:#0f172a;max-height:210px;overflow-y:auto;' +
  // pan-y : le doigt peut faire défiler la liste verticalement.
  'touch-action:pan-y;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;';
modalAddress.insertAdjacentElement('afterend', suggestBox);

let suggestTimer = null;
let suggestController = null;

function hideSuggestions() {
  suggestBox.style.display = 'none';
  suggestBox.replaceChildren();
}

function showSuggestions(labels) {
  if (!labels.length) {
    hideSuggestions();
    return;
  }
  const fragment = document.createDocumentFragment();

  labels.forEach((label) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.textContent = label; // texte, jamais de HTML
    row.style.cssText =
      'display:block;width:100%;text-align:left;padding:11px 14px;background:transparent;' +
      'border:0;border-bottom:1px solid #1e293b;color:#e2e8f0;font-size:14px;';
    // click, et surtout pas preventDefault sur l'appui : cela bloquerait
    // le geste de défilement de la liste.
    row.addEventListener('click', () => {
      modalAddress.value = label;
      hideSuggestions();
      modalCode.focus();
    });
    fragment.appendChild(row);
  });

  suggestBox.replaceChildren(fragment);
  suggestBox.style.display = 'block';
}

async function fetchSuggestions(query) {
  if (suggestController) suggestController.abort();
  suggestController = new AbortController();

  const url =
    'https://data.geopf.fr/geocodage/search?index=address&limit=6&citycode=' +
    NICE_INSEE +
    '&q=' +
    encodeURIComponent(query);

  // Numéro de voie saisi, à réinjecter si la suggestion est une rue sans numéro.
  // Le motif ne happe pas la première lettre du type de voie : dans « 12rue »,
  // le « r » n'est pas suivi d'une fin de mot, il n'est donc pas pris pour un bis.
  const saisi = query.match(/^\s*(\d+)(?:\s*(bis|ter)\b|([a-zA-Z])\b)?/i);
  let numero = null;
  if (saisi) {
    numero = saisi[1];
    if (saisi[2]) numero += saisi[2].toLowerCase();
    else if (saisi[3]) numero += saisi[3].toUpperCase();
  }

  try {
    // Requête vers un service tiers : aucun en-tête de l'application n'y est joint.
    const res = await fetch(url, { signal: suggestController.signal });
    if (!res.ok) return;

    const data = await res.json();
    const labels = [];
    for (const feature of data.features || []) {
      const props = feature.properties || {};
      let label = props.name || props.label;
      if (!label) continue;
      // La BAN renvoie la rue seule quand le numéro lui est inconnu.
      if (numero && !props.housenumber && !/^\d/.test(label)) label = numero + ' ' + label;
      if (!labels.includes(label)) labels.push(label);
    }
    showSuggestions(labels);
  } catch {
    // Hors ligne, requête annulée ou service indisponible : la saisie libre reste possible.
  }
}

modalAddress.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const query = modalAddress.value.trim();
  if (query.length < 3 || !navigator.onLine) {
    hideSuggestions();
    return;
  }
  suggestTimer = setTimeout(() => fetchSuggestions(query), 250);
});

// La liste se ferme quand on passe au champ Code, pas sur la perte de focus :
// un simple défilement faisait perdre le focus et fermait la liste.
modalCode.addEventListener('focus', hideSuggestions);

/* ------------------- résidences à plusieurs entrées ------------------- */

/**
 * Fiches susceptibles d'appartenir au même immeuble : celles déjà groupées
 * avec elle, plus celles qui portent encore l'ancien code.
 * Le nom de rue n'entre pas en compte : une résidence peut avoir deux entrées
 * sur deux voies différentes.
 */
function candidatsGroupe(item, ancienCode) {
  return records.filter(
    (r) =>
      r.id !== item.id &&
      ((item.groupe && r.groupe && r.groupe === item.groupe) || r.code === ancienCode)
  );
}

/** Renvoie les identifiants cochés, ou null si l'utilisateur annule. */
function showGroupDialog(item, candidats, nouveauCode) {
  return new Promise((resolve) => {
    const modal = el('div', 'modal');
    modal.style.display = 'flex';
    const box = el('div', 'modal-content');

    box.appendChild(el('h3', null, 'Même résidence ?'));

    const intro = el('p', null,
      candidats.length + (candidats.length > 1 ? ' autres adresses portent' : ' autre adresse porte') +
      ' le code ' + item.code + '. Cochez celles qui doivent passer à ' + nouveauCode + '.');
    intro.style.cssText = 'font-size:14px;color:#cbd5e1;line-height:1.5;margin-bottom:14px;';
    box.appendChild(intro);

    const liste = el('div');
    liste.style.cssText = 'max-height:240px;overflow-y:auto;touch-action:pan-y;overscroll-behavior:contain;margin-bottom:16px;';

    const cases = candidats.map((c) => {
      const ligne = el('label');
      ligne.style.cssText =
        'display:flex;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px solid #1e293b;font-size:14px;color:#e2e8f0;';
      const coche = document.createElement('input');
      coche.type = 'checkbox';
      // Un groupe déjà confirmé est coché d'office : l'appli se souvient.
      coche.checked = Boolean(item.groupe && c.groupe === item.groupe);
      coche.style.cssText = 'width:20px;height:20px;flex:none;';
      ligne.append(coche, el('span', null, c.address));
      liste.appendChild(ligne);
      return { coche, id: c.id };
    });

    box.appendChild(liste);

    const fermer = (valeur) => {
      libererFond();
      modal.remove();
      resolve(valeur);
    };

    const barre = el('div');
    barre.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px;';

    const bouton = (classe, texte, valeur, large) => {
      const b = el('button', classe, texte);
      b.type = 'button';
      b.style.cssText = 'width:100%;padding:12px 8px;font-size:15px;' + (large ? 'grid-column:1 / -1;' : '');
      b.addEventListener('click', () => fermer(valeur));
      barre.appendChild(b);
      return b;
    };

    bouton('btn-cancel', 'Celle-ci seule', []);
    const valider = el('button', 'btn-save', 'Valider');
    valider.type = 'button';
    valider.style.cssText = 'width:100%;padding:12px 8px;font-size:15px;';
    // Les cases sont lues au moment du clic, pas à la construction de la fenêtre.
    valider.addEventListener('click', () =>
      fermer(cases.filter((c) => c.coche.checked).map((c) => c.id))
    );
    barre.appendChild(valider);
    // Sortie neutre : sans elle, le geste de retour n'avait rien à actionner
    // et la fenêtre restait ouverte sans explication.
    bouton('btn-cancel', 'Annuler', null, true);

    box.appendChild(barre);

    modal.appendChild(box);
    document.body.appendChild(modal);
    verrouillerFond();
  });
}

/* ------------------------------- actions -------------------------------- */

$('openAddModal').addEventListener('click', () => {
  if (onglet === 'clients') {
    ouvrirClient(null);
    return;
  }
  editingId = null;
  modalTitle.textContent = 'Ajouter un code';
  modalAddress.value = '';
  modalCode.value = '';
  deleteBtn.style.display = 'none';
  hsToggleBtn.style.display = 'none';
  hideSuggestions();
  rafraichirSignature();
  editModal.style.display = 'flex';
  verrouillerFond();
  modalAddress.focus();
  proposerAdressesProches();
});

/**
 * À l'ouverture d'un ajout, propose les adresses officielles autour de soi.
 * On est devant l'immeuble : la bonne adresse est presque toujours dans la
 * liste, et il n'y a rien à taper.
 */
async function proposerAdressesProches() {
  if (!positionAutorisee || !navigator.onLine) return;

  try {
    const point = positionRecente() || (await obtenirPosition({ timeout: 6000 }));
    // L'utilisateur a pu commencer à taper pendant l'attente.
    if (modalAddress.value.trim() || editModal.style.display !== 'flex') return;

    const noms = await adressesAutour(point.lat, point.lon, 80);
    if (modalAddress.value.trim() || editModal.style.display !== 'flex') return;

    // Les adresses déjà enregistrées ne sont pas proposées : on ajoute
    // rarement une fiche qui existe.
    const nouvelles = noms.filter((nom) => fichesPour(nom).length === 0);
    showSuggestions(nouvelles.slice(0, 6));
  } catch {
    /* position ou service indisponible : saisie normale */
  }
}

$('cancelModal').addEventListener('click', () => {
  hideSuggestions();
  fermerEdition();
});

/** Fermeture de la fenêtre d'ajout/modification, en un seul endroit. */
function fermerEdition() {
  if (editModal.style.display === 'none') return;
  editModal.style.display = 'none';
  libererFond();
}

function openEdit(id) {
  const item = records.find((r) => r.id === id);
  if (!item) return;

  editingId = id;
  modalTitle.textContent = "Modifier l'adresse";
  modalAddress.value = item.address;
  modalCode.value = item.code;

  const canDelete = item.isMine && item.createdAt && Date.now() - item.createdAt < DELETE_WINDOW_MS;
  deleteBtn.textContent = '🗑️ Supprimer';
  deleteBtn.style.display = canDelete ? 'block' : 'none';

  hsToggleBtn.style.display = 'block';
  hsToggleBtn.textContent = item.hs ? '✅ Code valide' : '⚠️ Signaler HS';
  hsToggleBtn.style.background = item.hs ? '#059669' : '#d97706';

  hideSuggestions();
  rafraichirSignature();
  editModal.style.display = 'flex';
  verrouillerFond();
}

hsToggleBtn.addEventListener('click', async () => {
  if (!editingId || isBusy) return;
  const item = records.find((r) => r.id === editingId);
  if (!item) return;

  isBusy = true;
  const next = !item.hs;
  fermerEdition();

  const res = await commit(
    { kind: 'patch', id: item.id, patch: { hs: next } },
    () => { item.hs = next; }
  );

  if (res.ok) showToast(next ? 'Portail signalé HS' : 'Portail rétabli');
  else showToast(res.err.message);
  isBusy = false;
});

deleteBtn.addEventListener('click', async () => {
  if (!editingId || isBusy) return;
  const item = records.find((r) => r.id === editingId);
  if (!item) return;

  const confirmed = await showDialog({
    title: 'Confirmer la suppression',
    message: `Supprimer définitivement « ${item.address} » ?`,
    okText: 'Supprimer',
    cancelText: 'Annuler'
  });
  if (!confirmed) return;

  isBusy = true;
  fermerEdition();
  const res = await commit(
    { kind: 'delete', id: item.id },
    () => { records = records.filter((r) => r.id !== item.id); }
  );

  showToast(res.ok ? 'Adresse supprimée' : res.err.message);
  isBusy = false;
});

saveBtn.addEventListener('click', async () => {
  if (isBusy) return;

  const address = modalAddress.value.trim();
  const code = modalCode.value.trim();

  if (!address || !code) {
    await showDialog({
      title: 'Champs incomplets',
      message: "Renseignez l'adresse et le code.",
      showCancel: false,
      okText: 'Compris'
    });
    return;
  }

  isBusy = true;
  saveBtn.disabled = true;

  try {
    if (editingId === null) {
      const similar = findSimilarAddress(address);
      if (similar) {
        const shouldUpdate = await showDialog({
          title: '⚠️ Adresse similaire trouvée',
          message: `« ${similar.address} » existe déjà avec le code ${similar.code}.\n\nMettre à jour cette fiche avec « ${code} » plutôt que créer un doublon ?`,
          okText: 'Mettre à jour',
          cancelText: 'Créer à part'
        });

        if (shouldUpdate) {
          fermerEdition();
          const res = await commit(
            { kind: 'patch', id: similar.id, patch: { code } },
            () => { similar.code = code; similar.hs = false; similar.updatedAt = Date.now(); }
          );
          showToast(res.ok ? 'Fiche existante mise à jour' : res.err.message);
          return;
        }
      }

      const id = getClientId().slice(0, 8) + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const now = Date.now();
      fermerEdition();

      const res = await commit(
        { kind: 'create', id, address, code },
        () => {
          records.push({ id, address, code, hs: false, createdAt: now, updatedAt: now, isMine: true });
        }
      );

      if (!res.ok) {
        const existing = res.err.payload && res.err.payload.record;
        await showDialog({
          title: 'Adresse déjà enregistrée',
          message: existing
            ? `« ${existing.address} » existe déjà avec le code ${existing.code}.`
            : res.err.message,
          showCancel: false,
          okText: 'Compris'
        });
      } else if (res.data && res.data.corrige) {
        showToast('Adresse corrigée : ' + res.data.corrige);
      } else {
        showToast('Adresse ajoutée');
      }
      if (res.ok) await proposerPrenomApresContribution();
      return;
    }

    const item = records.find((r) => r.id === editingId);
    if (!item) return;

    if (item.address === address && item.code === code) {
      fermerEdition();
      return;
    }

    const codeChanged = item.code !== code;
    const ancienCode = item.code;

    let aussi = [];
    if (codeChanged) {
      const candidats = candidatsGroupe(item, ancienCode);
      if (candidats.length) {
        fermerEdition();
        const choix = await showGroupDialog(item, candidats, code);
        if (choix === null) return;
        aussi = choix;
      }
    }

    fermerEdition();
    const res = await commit(
      { kind: 'patch', id: item.id, patch: { address, code, aussi } },
      () => {
        item.address = address;
        item.code = code;
        if (codeChanged) item.hs = false;
        item.updatedAt = Date.now();
        // Application immédiate aux fiches cochées, avant la réponse serveur.
        for (const autreId of aussi) {
          const autre = records.find((r) => r.id === autreId);
          if (autre) {
            autre.code = code;
            autre.hs = false;
            autre.updatedAt = Date.now();
          }
        }
      }
    );

    if (!res.ok) showToast(res.err.message);
    else if (aussi.length) showToast((aussi.length + 1) + ' fiches mises à jour');
    else showToast('Fiche mise à jour');

    if (res.ok) await proposerPrenomApresContribution();
  } finally {
    saveBtn.disabled = false;
    isBusy = false;
  }
});

/* ------------------------------ recherche ------------------------------- */

/* --------------------- panneau d'administration --------------------- */

/** Fenêtre générique à boutons, construite sans HTML injecté. */
function panneau(titre, corps, boutons) {
  return new Promise((resolve) => {
    const modal = el('div', 'modal');
    modal.style.display = 'flex';
    const box = el('div', 'modal-content');
    box.appendChild(el('h3', null, titre));
    if (corps) box.appendChild(corps);

    // Grille à deux colonnes : des boutons de largeur égale, pas d'escalier.
    // Une entrée isolée (« Fermer ») occupe toute la largeur.
    const barre = el('div');
    barre.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px;';

    const principaux = boutons.filter((b) => b.valeur !== null);
    const sortie = boutons.filter((b) => b.valeur === null);

    const creer = (b, pleineLargeur) => {
      const bouton = el('button', b.classe || 'btn-save', b.texte);
      bouton.type = 'button';
      bouton.style.cssText =
        'width:100%;padding:13px 8px;font-size:15px;' +
        (pleineLargeur ? 'grid-column:1 / -1;' : '');
      bouton.addEventListener('click', () => {
        libererFond();
        modal.remove();
        resolve(b.valeur);
      });
      barre.appendChild(bouton);
    };

    // Nombre impair : le dernier bouton principal prend toute la largeur.
    principaux.forEach((b, i) =>
      creer(b, principaux.length % 2 === 1 && i === principaux.length - 1)
    );
    sortie.forEach((b) => creer(b, true));

    box.appendChild(barre);
    modal.appendChild(box);
    document.body.appendChild(modal);
    verrouillerFond();
  });
}

/** Demande la clé d'administration et la valide auprès du serveur. */
async function demanderCleAdmin() {
  const corps = el('div');
  const texte = el('p', null,
    "Réservé à l'administrateur. Cette clé est différente de celle des livreurs.");
  texte.style.cssText = 'font-size:14px;color:#94a3b8;line-height:1.4;margin-bottom:12px;';
  const champ = document.createElement('input');
  // Pas de type="password" : Chrome enregistrerait la clé comme mot de passe
  // du site et la proposerait ensuite dans la barre de recherche.
  champ.type = 'text';
  champ.autocomplete = 'off';
  champ.setAttribute('autocapitalize', 'off');
  champ.setAttribute('spellcheck', 'false');
  champ.style.webkitTextSecurity = 'disc';
  const erreur = el('p', 'gate-error');
  corps.append(texte, champ, erreur);

  const modal = el('div', 'modal');
  modal.style.display = 'flex';
  const box = el('div', 'modal-content');
  box.appendChild(el('h3', null, 'Accès administrateur'));
  box.appendChild(corps);

  return new Promise((resolve) => {
    const barre = el('div', 'modal-btns');
    barre.style.cssText = 'justify-content:flex-end;gap:10px;';
    const annuler = el('button', 'btn-cancel', 'Annuler');
    annuler.type = 'button';
    const valider = el('button', 'btn-save', 'Valider');
    valider.type = 'button';

    annuler.addEventListener('click', () => { libererFond(); modal.remove(); resolve(false); });

    valider.addEventListener('click', async () => {
      const saisie = champ.value.trim();
      if (!saisie) return;
      valider.disabled = true;
      erreur.textContent = '';
      localStorage.setItem(ADMIN_KEY, saisie);
      try {
        await api('/api/stats');
        libererFond();
        modal.remove();
        resolve(true);
      } catch (err) {
        localStorage.removeItem(ADMIN_KEY);
        erreur.textContent = err.status === 403 ? 'Clé refusée.' : 'Serveur injoignable.';
        valider.disabled = false;
      }
    });

    barre.append(annuler, valider);
    box.appendChild(barre);
    modal.appendChild(box);
    document.body.appendChild(modal);
    verrouillerFond();
    champ.focus();
  });
}

async function montrerStats() {
  try {
    const data = await api('/api/stats');
    const a = data.appareils || {};
    const plateformes =
      (data.plateformes || []).map((p) => `   ${p.nom} : ${p.n}`).join('\n') || '   aucune donnée';

    const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
    const nomJour = (iso) => {
      const d = new Date(iso + 'T12:00:00');
      const ecart = Math.round((Date.now() - d.getTime()) / 86400000);
      if (ecart <= 0) return "Aujourd'hui";
      if (ecart === 1) return 'Hier';
      return jours[d.getDay()];
    };

    const journal =
      (data.journal || [])
        .map((j) => {
          const entete = `   ${nomJour(j.jour)} : ${j.appareils} appareil(s) · ${j.ouvertures} ouverture(s)`;
          return j.qui ? entete + `\n      ${j.qui}` : entete;
        })
        .join('\n') || '   aucune donnée pour le moment';

    const totalRefus = (data.refus || []).reduce((n, r) => n + r.n, 0);

    await showDialog({
      title: '📊 Statistiques',
      message:
        `👥 Utilisateurs actifs (7 j) : ${a.actifs7 || 0}\n` +
        `📅 Actifs sur 30 j : ${a.actifs30 || 0}\n` +
        `🆕 Nouveaux cette semaine : ${a.nouveaux7 || 0}\n` +
        `📱 Appareils connus : ${a.total || 0}\n\n` +
        `📆 Connexions par jour :\n${journal}\n\n` +
        `📲 Répartition (30 j) :\n${plateformes}\n\n` +
        `🔑 Tentatives avec clé invalide (7 j) : ${totalRefus}`,
      showCancel: false,
      okText: 'Fermer'
    });
  } catch (err) {
    if (err.status === 403) localStorage.removeItem(ADMIN_KEY);
    await showDialog({
      title: 'Statistiques indisponibles',
      message: err.status === 403 ? "Clé d'administration refusée." : 'Le serveur n’a pas répondu.',
      showCancel: false,
      okText: 'Compris'
    });
  }
}

async function montrerJournal() {
  try {
    const data = await api('/api/historique');
    const entrees = data.entrees || [];

    // Une ligne d'historique contient l'état AVANT le changement. L'état APRÈS
    // est donc l'état archivé par la modification suivante de la même fiche,
    // ou l'état actuel s'il n'y en a pas eu. Sans ce chaînage, on compare à
    // l'état d'aujourd'hui et toute modification revenue en arrière paraît
    // n'avoir rien changé.
    const suivant = new Map();
    const lignes = [];

    for (const e of entrees) {
      const apres = suivant.get(e.id) || { adresse: e.adresse, code: e.code, hs: e.hs };
      suivant.set(e.id, { adresse: e.ancienneAdresse, code: e.ancienCode, hs: e.ancienHs });

      const quand = new Date(e.quand).toLocaleString('fr-FR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      const nom = e.ancienneAdresse;

      const par = e.auteur ? `  (${e.auteur})` : '';

      if (e.action === 'create') {
        lignes.push(`${quand}  ${nom}\n   créée (code ${e.ancienCode})${par}`);
      } else if (e.action === 'delete') {
        lignes.push(`${quand}  ${nom}\n   supprimée (code ${e.ancienCode})${par}`);
      } else if (e.ancienCode !== apres.code) {
        lignes.push(`${quand}  ${nom}\n   ${e.ancienCode} → ${apres.code}${par}`);
      } else if (e.ancienneAdresse !== apres.adresse) {
        lignes.push(`${quand}  ${nom}\n   renommée en ${apres.adresse}${par}`);
      } else if (Number(e.ancienHs) !== Number(apres.hs)) {
        lignes.push(
          `${quand}  ${nom}\n   ${Number(apres.hs) ? '⚠️ signalée HS' : '✅ remise en service'}${par}`
        );
      }
      // Les modifications sans effet réel ne sont pas affichées.
    }

    await showDialog({
      title: '🕘 Dernières modifications',
      message: lignes.length ? lignes.join('\n\n') : 'Aucune modification à signaler.',
      showCancel: false,
      okText: 'Fermer'
    });
  } catch (err) {
    if (err.status === 403) localStorage.removeItem(ADMIN_KEY);
    await showDialog({
      title: 'Journal indisponible',
      message: err.status === 403 ? "Clé d'administration refusée." : 'Le serveur n’a pas répondu.',
      showCancel: false,
      okText: 'Compris'
    });
  }
}

function exporterCsv() {
  const echappe = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const entetes = ['Adresse', 'Code', 'Hors service', 'Derniere modification'];
  const lignes = records
    .slice()
    .sort((a, b) => a.address.localeCompare(b.address, 'fr', { numeric: true }))
    .map((r) =>
      [
        r.address,
        r.code,
        r.hs ? 'oui' : 'non',
        r.updatedAt ? new Date(r.updatedAt).toLocaleDateString('fr-FR') : ''
      ].map(echappe).join(';')
    );

  // Point-virgule et BOM : ouverture directe dans un tableur français,
  // accents conservés.
  const contenu = '\uFEFF' + [entetes.map(echappe).join(';'), ...lignes].join('\r\n');
  const blob = new Blob([contenu], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const lien = document.createElement('a');
  lien.href = url;
  lien.download = 'challivretou-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(records.length + ' adresses exportées');
}

/**
 * Proposé après une première contribution, jamais à l'ouverture : à ce
 * moment-là le livreur vient de faire quelque chose et voit à quoi ça sert.
 * Une seule fois ; un refus n'est jamais relancé.
 */
async function proposerPrenomApresContribution() {
  if (localStorage.getItem(NOM_KEY) || localStorage.getItem('chall_nom_demande')) return;
  localStorage.setItem('chall_nom_demande', 'oui');

  const corps = el('div');
  const texte = el('p', null,
    "Bien joué, l'adresse est en ligne. 🎉\n\n"
    + "On met votre prénom à côté ? Les collègues sauront qui remercier.");
  texte.style.cssText =
    'font-size:14px;color:#cbd5e1;line-height:1.5;margin-bottom:14px;white-space:pre-line;';
  const champ = document.createElement('input');
  champ.type = 'text';
  champ.maxLength = 30;
  champ.autocomplete = 'given-name';
  champ.placeholder = 'Prénom';
  corps.append(texte, champ);

  const modal = el('div', 'modal');
  modal.style.display = 'flex';
  const box = el('div', 'modal-content');
  box.appendChild(corps);

  await new Promise((resolve) => {
    const barre = el('div', 'modal-btns');
    barre.style.cssText = 'justify-content:flex-end;gap:10px;';
    const passer = el('button', 'btn-cancel', 'Plus tard');
    passer.type = 'button';
    const valider = el('button', 'btn-save', "C'est moi");
    valider.type = 'button';

    // Inactif tant que rien n'est saisi : valider à vide reviendrait à
    // refuser sans le vouloir, et la fenêtre ne revient jamais.
    const majBouton = () => {
      const vide = !champ.value.trim();
      valider.disabled = vide;
      valider.style.opacity = vide ? '0.45' : '';
    };
    champ.addEventListener('input', majBouton);
    majBouton();

    const fin = () => { libererFond(); modal.remove(); resolve(); };
    passer.addEventListener('click', fin);
    valider.addEventListener('click', async () => {
      const v = champ.value.trim();
      if (!v) return;
      localStorage.setItem(NOM_KEY, v);
      fin();
      // Rechargement : le serveur enregistre le prénom et le renvoie
      // aussitôt sur les fiches concernées.
      await loadData({ silent: true });
    });
    barre.append(passer, valider);
    box.appendChild(barre);
    modal.appendChild(box);
    document.body.appendChild(modal);
    verrouillerFond();
    champ.focus();
  });
}

/* ------------------------- signature du livreur ------------------------- */

// Accessible en permanence sous le champ Code : un refus initial n'enferme
// personne, et on peut se retirer aussi facilement qu'on s'est signé.
const ligneSignature = el('button', null, '');
ligneSignature.type = 'button';
ligneSignature.style.cssText =
  'display:block;width:100%;text-align:left;background:transparent;border:0;padding:6px 2px 2px;' +
  'color:#64748b;font-size:13px;';
modalCode.insertAdjacentElement('afterend', ligneSignature);

function rafraichirSignature() {
  const nom = localStorage.getItem(NOM_KEY);
  ligneSignature.textContent = nom ? '✎ Signé : ' + nom : '✎ Signer mes ajouts';
}

ligneSignature.addEventListener('click', async () => {
  const actuel = localStorage.getItem(NOM_KEY) || '';
  const saisi = await demanderTexte('Votre prénom (laisser vide pour retirer)', actuel);
  if (saisi === null) return;

  if (saisi) localStorage.setItem(NOM_KEY, saisi);
  else localStorage.removeItem(NOM_KEY);

  // Plus de relance automatique : le choix est désormais explicite.
  localStorage.setItem('chall_nom_demande', 'oui');
  rafraichirSignature();
  showToast(saisi ? "C'est noté, " + saisi + ' 👍' : 'Signature retirée');
  await loadData({ silent: true });
});

/** Écran d'administration : liste des appareils, avec étiquetage manuel. */
async function montrerAppareils() {
  let data;
  try {
    data = await api('/api/appareils');
  } catch (err) {
    if (err.status === 403) localStorage.removeItem(ADMIN_KEY);
    await showDialog({
      title: 'Appareils indisponibles',
      message: err.status === 403 ? "Clé d'administration refusée." : 'Le serveur n’a pas répondu.',
      showCancel: false, okText: 'Compris'
    });
    return;
  }

  const liste = data.appareils || [];
  if (!liste.length) {
    await showDialog({
      title: '📱 Appareils', message: 'Aucun appareil enregistré.',
      showCancel: false, okText: 'Fermer'
    });
    return;
  }

  const corps = el('div');
  corps.style.cssText = 'max-height:55vh;overflow-y:auto;touch-action:pan-y;overscroll-behavior:contain;';

  const quand = (t) => {
    const j = Math.floor((Date.now() - t) / 86400000);
    if (j <= 0) return "aujourd'hui";
    if (j === 1) return 'hier';
    return 'il y a ' + j + ' j';
  };

  liste.forEach((a) => {
    const ligne = el('div');
    ligne.style.cssText = 'padding:12px 4px;border-bottom:1px solid #1e293b;';

    // Sans nom, l'identifiant court : deux « android-web » ne sont pas
    // distinguables, deux identifiants le sont toujours.
    const estMoi = a.id === getClientId();
    const titre = el('div', null,
      (a.nomAdmin || a.nomDeclare || a.modele || a.court) + (estMoi ? '  ← cet appareil' : ''));
    titre.style.cssText =
      'font-size:15px;font-weight:600;color:' + (estMoi ? '#38bdf8' : '#e2e8f0') + ';';

    const mode = a.plateforme && a.plateforme.endsWith('-app')
      ? 'appli installée'
      : 'ouvert dans le navigateur';
    const position =
      a.geoloc === 'granted' ? '📍 position autorisée'
      : a.geoloc === 'denied' ? '🚫 position refusée'
      : a.geoloc === 'prompt' ? '❔ position jamais demandée'
      : null;

    const detail = el('div', null,
      [a.court, a.modele, 'vu la dernière fois en ' + mode, position,
       a.nomDeclare ? 'se dit « ' + a.nomDeclare + ' »' : null]
        .filter(Boolean).join(' · '));
    detail.style.cssText = 'font-size:12px;color:#64748b;margin-top:2px;';

    const activite = el('div', null,
      a.modifications + ' modification(s) · vu ' + quand(a.derniereFois) +
      ' · connu depuis ' + quand(a.premiereFois));
    activite.style.cssText = 'font-size:12px;color:#64748b;margin-top:2px;';

    const barreBoutons = el('div');
    barreBoutons.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

    const bouton = el('button', 'btn-cancel', a.nomAdmin ? 'Renommer' : 'Nommer');
    bouton.type = 'button';
    bouton.style.cssText = 'padding:6px 12px;font-size:13px;';
    bouton.addEventListener('click', async () => {
      const saisi = await demanderTexte('Nom de cet appareil', a.nomAdmin || a.nomDeclare || '');
      if (saisi === null) return;
      try {
        await api('/api/appareils', { method: 'PATCH', body: JSON.stringify({ id: a.id, nom: saisi }) });
        a.nomAdmin = saisi || null;
        titre.textContent = a.nomAdmin || a.nomDeclare || a.modele || a.plateforme;
        bouton.textContent = a.nomAdmin ? 'Renommer' : 'Nommer';
        showToast('Appareil nommé');
      } catch {
        showToast('Échec de l’enregistrement');
      }
    });

    const suppr = el('button', 'btn-delete', 'Oublier');
    suppr.type = 'button';
    // La feuille de style masque .btn-delete par défaut (le bouton Supprimer
    // des fiches n'apparaît que dans certains cas) : il faut le réafficher ici.
    suppr.style.cssText = 'display:block;padding:6px 12px;font-size:13px;';
    suppr.addEventListener('click', async () => {
      const ok = await showDialog({
        title: 'Oublier cet appareil ?',
        message: 'Sa fiche et ses statistiques de visite disparaissent.\n\n'
          + "L'historique des modifications qu'il a faites est conservé, mais elles "
          + "n'afficheront plus de nom.\n\nS'il revient, il réapparaîtra comme un nouvel appareil.",
        okText: 'Oublier', cancelText: 'Annuler'
      });
      if (!ok) return;
      try {
        await api('/api/appareils', { method: 'DELETE', body: JSON.stringify({ id: a.id }) });
        ligne.remove();
        showToast('Appareil oublié');
      } catch {
        showToast('Échec de la suppression');
      }
    });

    barreBoutons.append(bouton, suppr);
    ligne.append(titre, detail, activite, barreBoutons);
    corps.appendChild(ligne);
  });

  await panneau('📱 Appareils', corps, [{ texte: 'Fermer', valeur: null, classe: 'btn-cancel' }]);
}

/** Petite saisie de texte. Renvoie null si l'utilisateur annule. */
function demanderTexte(titre, valeurInitiale) {
  return new Promise((resolve) => {
    const champ = document.createElement('input');
    champ.type = 'text';
    champ.maxLength = 30;
    champ.value = valeurInitiale || '';

    const modal = el('div', 'modal');
    modal.style.display = 'flex';
    const box = el('div', 'modal-content');
    box.appendChild(el('h3', null, titre));
    box.appendChild(champ);

    const barre = el('div', 'modal-btns');
    barre.style.cssText = 'justify-content:flex-end;gap:10px;';
    const annuler = el('button', 'btn-cancel', 'Annuler');
    annuler.type = 'button';
    const ok = el('button', 'btn-save', 'Valider');
    ok.type = 'button';
    const fin = (v) => { libererFond(); modal.remove(); resolve(v); };
    annuler.addEventListener('click', () => fin(null));
    ok.addEventListener('click', () => fin(champ.value.trim()));
    barre.append(annuler, ok);
    box.appendChild(barre);
    modal.appendChild(box);
    document.body.appendChild(modal);
    verrouillerFond();
    champ.focus();
  });
}

/**
 * Panneau d'administration. Il reste monté pendant qu'on navigue dans ses
 * écrans : le recréer après coup produirait une entrée d'historique posée
 * hors de tout geste, que Chrome ignore — et le geste de retour suivant
 * quitterait l'appli au lieu de refermer le panneau.
 */
async function ouvrirAdmin() {
  if (!localStorage.getItem(ADMIN_KEY)) {
    const ok = await demanderCleAdmin();
    if (!ok) return;
  }

  const modal = el('div', 'modal');
  modal.style.display = 'flex';
  const box = el('div', 'modal-content');

  box.appendChild(el('h3', null, '🔧 Administration'));

  const versionLigne = el('p', null, 'Version ' + VERSION);
  versionLigne.style.cssText = 'font-size:12px;color:#64748b;margin:-6px 0 4px;';
  box.appendChild(versionLigne);

  const barre = el('div');
  barre.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px;';

  const fermer = () => {
    libererFond();
    modal.remove();
  };

  const ajouter = (texte, action, options = {}) => {
    const bouton = el('button', options.classe || 'btn-save', texte);
    bouton.type = 'button';
    bouton.style.cssText =
      'width:100%;padding:13px 8px;font-size:15px;' + (options.large ? 'grid-column:1 / -1;' : '');
    bouton.addEventListener('click', action);
    barre.appendChild(bouton);
  };

  ajouter('📊 Statistiques', () => montrerStats());
  ajouter('🕘 Journal', () => montrerJournal());
  ajouter('📱 Appareils', () => montrerAppareils());
  ajouter('🏘️ Résidences', () => montrerResidences());
  ajouter('💾 Exporter', () => {
    exporterCsv();
    fermer();
  });
  ajouter("🔗 Lien d'accès", () => partagerLien());
  ajouter('Fermer', fermer, { large: true, classe: 'btn-cancel' });

  box.appendChild(barre);
  modal.appendChild(box);
  document.body.appendChild(modal);
  verrouillerFond();
}

async function partagerLien() {
  const lien = buildInviteLink();
  let copie = false;
  try {
    await navigator.clipboard.writeText(lien);
    copie = true;
  } catch {
    /* presse-papiers refusé */
  }
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Challivretou', text: "Lien d'accès Challivretou", url: lien });
      return;
    } catch {
      /* partage annulé */
    }
  }
  await showDialog({
    title: copie ? "Lien d'accès copié" : "Lien d'accès",
    message: lien + '\n\nEnvoyez-le au collègue. Un simple clic suffit, rien à saisir.',
    showCancel: false,
    okText: 'Fermer'
  });
}

// Ouverture du panneau : appui long sur le logo, ou saisie de #admin.
(function brancherAdmin() {
  const logo = document.querySelector('.brand-header img');
  if (!logo) return;
  let minuteur = null;
  const armer = () => {
    minuteur = setTimeout(() => { minuteur = null; ouvrirAdmin(); }, 3000);
  };
  const desarmer = () => { clearTimeout(minuteur); };
  logo.addEventListener('pointerdown', armer);
  logo.addEventListener('pointerup', desarmer);
  logo.addEventListener('pointerleave', desarmer);
  logo.addEventListener('contextmenu', (e) => e.preventDefault());
})();

async function checkAdminCommand(value) {
  const commande = value.trim().toLowerCase();

  if (commande === '#aide') {
    searchInput.value = '';
    searchInput.blur();
    renderList();
    lancerTuto();
    return;
  }

  if (commande !== '#admin') return;
  searchInput.value = '';
  renderList();
  await ouvrirAdmin();
}

searchInput.addEventListener('input', (e) => {
  if (e.target.value) {
    garderFiltre();
    quitterProximite();
  }
  checkAdminCommand(e.target.value);
  renderList();
});

clearBtn.addEventListener('click', () => {
  gardeFiltre = false;
  quitterProximite();
  searchInput.value = '';
  searchInput.focus();
  renderList();
});

filterRecentBtn.addEventListener('click', () => {
  filterRecentOnly = !filterRecentOnly;
  filterRecentBtn.classList.toggle('active', filterRecentOnly);
  filterRecentBtn.setAttribute('aria-pressed', String(filterRecentOnly));
  renderList();
});

/* --------------------------- autour de moi --------------------------- */

const RAYON_METRES = 80;

// Identifiants des fiches proches, dans l'ordre de distance. null = inactif.
let proximite = null;
// Adresses officielles autour de soi, triées par distance : sert à l'onglet
// Clients, dont les fiches ne sont pas des codes.
let nomsProches = [];

/**
 * Correspondance stricte entre une adresse officielle et une fiche : un
 * numéro doit correspondre à un numéro entier, sinon « 7 » trouve le 17.
 */
function correspondAdresse(adresse, cible) {
  const terms = searchKey(adresse).split(' ').filter(Boolean);
  if (!terms.length || !cible) return false;
  const cle = searchKey(cible);
  const mots = cle.split(' ');
  return terms.every((t) => {
    if (!/^\d+$/.test(t)) return cle.includes(t);
    // Un numéro doit correspondre à un numéro entier, éventuellement suivi
    // d'un suffixe : « 10 » retrouve « 10bis », mais jamais « 100 ».
    return mots.some((m) => m === t || (m.startsWith(t) && !/^\d/.test(m.slice(t.length))));
  });
}

function fichesPour(adresse) {
  return records.filter((r) => correspondAdresse(adresse, r.address));
}

/** Rang du client dans les adresses proches (0 = la plus proche), -1 s'il n'y est pas. */
function rangProche(c) {
  if (!c.adresse) return -1;
  return nomsProches.findIndex((nom) => correspondAdresse(nom, c.adresse));
}

/** Nombre de fiches affichées par « autour de moi », selon l'onglet. */
function nombreProches() {
  if (onglet === 'clients') return clients.filter((c) => rangProche(c) !== -1).length;
  return proximite ? proximite.length : 0;
}

function signalerAucunProche() {
  if (nombreProches()) return;
  showToast((onglet === 'clients' ? 'Aucun client connu' : 'Aucune fiche connue') + ' dans les ' + RAYON_METRES + ' m');
}

// Dernière position connue. La garder évite d'attendre le GPS à chaque fois :
// c'est ce qui rendait la recherche autour de soi lente.
let dernierePosition = null;

function positionRecente(ageMax = 90000) {
  if (!dernierePosition) return null;
  return Date.now() - dernierePosition.ts < ageMax ? dernierePosition : null;
}

function unePosition(options) {
  return new Promise((ok, ko) => {
    if (!navigator.geolocation) {
      ko({ code: 2 });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        dernierePosition = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          ts: Date.now()
        };
        ok(dernierePosition);
      },
      ko,
      options
    );
  });
}

/**
 * Essaie d'abord le GPS précis, puis se rabat sur la localisation par réseau.
 * En intérieur, le GPS n'accroche souvent pas : sans ce repli, la demande
 * échouait purement et simplement.
 */
async function obtenirPosition({ timeout = 6000 } = {}) {
  try {
    return await unePosition({ enableHighAccuracy: true, timeout, maximumAge: 60000 });
  } catch (err) {
    // Une autorisation refusée ne se rattrape pas : inutile de réessayer.
    if (err && err.code === 1) throw err;
    return unePosition({ enableHighAccuracy: false, timeout: 8000, maximumAge: 180000 });
  }
}

/** Message fidèle à la cause réelle. */
function messagePosition(err) {
  if (err && err.code === 1) return 'Position non autorisée pour ce site';
  if (err && err.code === 3) return 'Position trop longue à obtenir';
  return 'Position indisponible ici';
}

/** Distance approximative entre deux points, en mètres. */
function distanceMetres(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const x = dLon * Math.cos(lat);
  return Math.round(R * Math.sqrt(dLat * dLat + x * x));
}

// Résultat déjà calculé, prêt à être affiché sans aucune attente.
let cacheProches = null; // { ids, noms, point, ts }
let pointInterroge = null;
let surveillanceId = null;

/**
 * Recalcule la liste des fiches proches, mais seulement si on a bougé d'au
 * moins 30 m ou si le résultat date de plus d'une minute : inutile
 * d'interroger le service à chaque frémissement du GPS.
 */
async function rafraichirProches(point) {
  const bouge = !pointInterroge || distanceMetres(pointInterroge, point) > 30;
  const vieux = !cacheProches || Date.now() - cacheProches.ts > 60000;
  if (!bouge && !vieux) return;
  if (!navigator.onLine) return;

  pointInterroge = point;
  try {
    const noms = await adressesAutour(point.lat, point.lon);
    const vus = new Set();
    for (const nom of noms) for (const fiche of fichesPour(nom)) vus.add(fiche.id);
    cacheProches = { ids: [...vus], noms, point, ts: Date.now() };

    // Si la liste des adresses proches est affichée, elle suit le déplacement
    // au lieu de rester figée sur le point où on l'avait ouverte.
    if (proximite !== null) {
      proximite = cacheProches.ids;
      nomsProches = cacheProches.noms;
      renderList();
    }
  } catch {
    /* service indisponible : on retentera au prochain point */
  }
}

/**
 * Suit la position tant que l'appli est à l'écran. C'est ce qui rend la
 * recherche autour de soi instantanée : le GPS est déjà fixé et la liste
 * déjà calculée quand on touche la barre de recherche. La surveillance est
 * arrêtée dès que l'appli passe en arrière-plan, pour la batterie.
 */
function demarrerSurveillance() {
  if (!positionAutorisee || surveillanceId !== null || !navigator.geolocation) return;
  surveillanceId = navigator.geolocation.watchPosition(
    (pos) => {
      dernierePosition = { lat: pos.coords.latitude, lon: pos.coords.longitude, ts: Date.now() };
      rafraichirProches(dernierePosition);
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}

function arreterSurveillance() {
  if (surveillanceId === null) return;
  navigator.geolocation.clearWatch(surveillanceId);
  surveillanceId = null;
}

/** Demande la position sans rien afficher, pour l'avoir prête au besoin. */
function prechaufferPosition() {
  if (!positionAutorisee) return;
  demarrerSurveillance();
  if (positionRecente(60000)) return;
  obtenirPosition({ timeout: 10000 })
    .then((point) => rafraichirProches(point))
    .catch(() => {});
}

/** Adresses officielles autour d'un point, triées par distance. */
async function adressesAutour(lat, lon, rayon = RAYON_METRES) {
  const cercle = JSON.stringify({ type: 'Circle', coordinates: [lon, lat], radius: rayon });
  const url =
    'https://data.geopf.fr/geocodage/reverse?index=address&limit=30' +
    '&lon=' + lon + '&lat=' + lat +
    '&searchgeom=' + encodeURIComponent(cercle);

  // Service tiers : aucun en-tête de l'application n'y est joint, et la
  // position ne quitte pas cet appel — rien n'est envoyé à ton serveur.
  const res = await fetch(url);
  if (!res.ok) throw new Error('service indisponible');
  const data = await res.json();

  const noms = [];
  for (const feature of data.features || []) {
    const nom = (feature.properties || {}).name;
    if (nom && !noms.includes(nom)) noms.push(nom);
  }
  return noms;
}

function quitterProximite() {
  if (proximite === null) return;
  proximite = null;
  renderList();
}

async function autourDeMoi() {
  if (!navigator.geolocation) {
    showToast('Position indisponible sur cet appareil');
    return;
  }
  if (!navigator.onLine) {
    showToast('Hors ligne — position impossible');
    return;
  }

  // Résultat déjà prêt : affichage immédiat, aucune attente.
  if (cacheProches && Date.now() - cacheProches.ts < 60000) {
    proximite = cacheProches.ids;
    nomsProches = cacheProches.noms;
    searchInput.value = '';
    renderList();
    signalerAucunProche();
    return;
  }

  const connue = positionRecente();
  if (!connue) updateStatus('📍 Localisation...');

  let point;
  try {
    point = connue || (await obtenirPosition());
  } catch (err) {
    updateStatus();
    showToast(messagePosition(err));
    return;
  }

  const { lat, lon } = point;
  try {
    const adresses = await adressesAutour(lat, lon);

    // Les résultats arrivent triés par distance : on conserve cet ordre.
    const vus = new Set();
    for (const nom of adresses) {
      for (const fiche of fichesPour(nom)) vus.add(fiche.id);
    }

    proximite = [...vus];
    nomsProches = adresses;
    cacheProches = { ids: proximite, noms: adresses, point: { lat, lon }, ts: Date.now() };
    pointInterroge = { lat, lon };
    searchInput.value = '';
    renderList();
    updateStatus();

    signalerAucunProche();
  } catch {
    updateStatus();
    showToast('Service d’adresses injoignable');
  }
}

// Bouton dans la barre d'état, à gauche du filtre Récents. Il ne sert qu'à
// accorder l'autorisation la première fois : une fois accordée, la recherche
// déclenche seule la localisation et le bouton disparaît.
const btnProximite = el('button', 'btn-toggle-recent', '📍 Autour de moi');
btnProximite.type = 'button';
btnProximite.addEventListener('click', async () => {
  // Un refus est mémorisé par le navigateur : une nouvelle tentative serait
  // rejetée sans rien demander. Mieux vaut expliquer comment le lever.
  if (etatPosition === 'denied') {
    await showDialog({
      title: 'Position bloquée',
      message:
        "Votre navigateur a mémorisé un refus pour ce site. Il ne redemandera plus.\n\n"
        + "Pour la réactiver : appuyez sur l'icône à gauche de l'adresse du site, "
        + "puis Autorisations ou Paramètres du site, puis Position → Autoriser.\n\n"
        + "Dans l'application installée, passez par les réglages Android : "
        + "Applications → Challivretou → Autorisations → Position.",
      showCancel: false,
      okText: 'Compris'
    });
    return;
  }
  garderFiltre();
  autourDeMoi();
});
btnProximite.style.display = 'none';
filterRecentBtn.insertAdjacentElement('beforebegin', btnProximite);

let positionAutorisee = false;
let etatPosition = null; // 'granted' | 'denied' | 'prompt'

function majBoutonProximite(etat) {
  etatPosition = etat;
  positionAutorisee = etat === 'granted';
  // Le bouton ne sert qu'à accorder l'autorisation. Il n'apparaît donc que
  // pendant la saisie, et disparaît définitivement une fois accordée.
  btnProximite.style.display = 'none';
  if (positionAutorisee) prechaufferPosition();
}

(async function suivrePermissionPosition() {
  if (!navigator.permissions) return; // navigateur sans gestion des permissions
  try {
    const etat = await navigator.permissions.query({ name: 'geolocation' });
    majBoutonProximite(etat.state);
    // L'autorisation peut être accordée ou révoquée en cours de route.
    etat.onchange = () => majBoutonProximite(etat.state);
  } catch {
    /* permission non interrogeable : le bouton reste disponible */
  }
})();

// Déclenchement automatique à l'ouverture de la recherche, mais seulement si
// l'autorisation est déjà accordée : pas de demande de position surgissant
// dès qu'on touche le champ.
searchInput.addEventListener('focus', () => {
  if (searchInput.value || proximite !== null) return;
  if (positionAutorisee) {
    // Posée ici, dans le geste : une entrée créée après l'attente du GPS
    // serait ignorée par le navigateur.
    garderFiltre();
    autourDeMoi();
  } else {
    btnProximite.style.display = '';
  }
});

searchInput.addEventListener('blur', () => {
  // Laisse le temps d'appuyer sur le bouton avant de le retirer.
  setTimeout(() => {
    if (positionAutorisee || document.activeElement === searchInput) return;
    btnProximite.style.display = 'none';
  }, 200);
});

/* ------------------------ installation et statistiques ------------------ */

async function trackDeviceInstallation() {
  if (!getAccessKey()) return;

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const ua = navigator.userAgent || '';

  try {
    if (standalone) {
      if (localStorage.getItem('chall_installed_reported')) return;
      const platform = /android/i.test(ua) ? 'android' : /iphone|ipad|ipod/i.test(ua) ? 'ios' : null;
      if (!platform) return;
      await api('/api/stats', { method: 'POST', body: JSON.stringify({ type: 'install', platform }) });
      localStorage.setItem('chall_installed_reported', 'true');
    } else {
      if (localStorage.getItem('chall_web_reported') || localStorage.getItem('chall_installed_reported')) return;
      await api('/api/stats', { method: 'POST', body: JSON.stringify({ type: 'web' }) });
      localStorage.setItem('chall_web_reported', 'true');
    }
  } catch {
    /* statistique non critique */
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = 'inline-block';
  if (!localStorage.getItem('pwa_prompt_shown') && getAccessKey()) {
    localStorage.setItem('pwa_prompt_shown', 'true');
    installPopupModal.style.display = 'flex';
  }
});

async function promptInstall() {
  installPopupModal.style.display = 'none';
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') installBtn.style.display = 'none';
  deferredPrompt = null;
}

$('confirmInstallPopup').addEventListener('click', promptInstall);
installBtn.addEventListener('click', promptInstall);
$('dismissInstallPopup').addEventListener('click', () => {
  installPopupModal.style.display = 'none';
});

window.addEventListener('appinstalled', async () => {
  installBtn.style.display = 'none';
  installPopupModal.style.display = 'none';
  deferredPrompt = null;

  if (localStorage.getItem('chall_installed_reported')) return;
  const platform = /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'ios' : 'android';
  try {
    await api('/api/stats', { method: 'POST', body: JSON.stringify({ type: 'install', platform }) });
    localStorage.setItem('chall_installed_reported', 'true');
  } catch {
    /* statistique non critique */
  }
});

/* --------------------------- geste de retour --------------------------- */

/**
 * Le geste de retour referme d'abord ce qui est ouvert, et ne quitte l'appli
 * qu'ensuite.
 *
 * Point délicat : Chrome ignore les entrées d'historique créées sans geste de
 * l'utilisateur. L'entrée doit donc être posée pendant l'appui qui ouvre la
 * fenêtre, jamais depuis le gestionnaire de retour.
 */

function estAffiche(element) {
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return element.getClientRects().length > 0;
}

/**
 * Pose une entrée de réserve, pendant le geste qui ouvre la fenêtre.
 *
 * On ne retire jamais d'entrée à la fermeture : retirer et reposer presque
 * simultanément — ce qui arrive quand une fenêtre s'en ouvre une autre — se
 * neutralisait, et il ne restait plus rien pour absorber le geste suivant.
 * Les entrées inutilisées sont simplement déroulées au moment de sortir.
 */
function garder() {
  history.pushState({ chall: true }, '');
}

// Un filtre actif — recherche ou proximité — doit lui aussi pouvoir absorber
// un geste de retour. Une seule entrée suffit pour tout l'état filtré.
let gardeFiltre = false;

function garderFiltre() {
  if (gardeFiltre) return;
  gardeFiltre = true;
  garder();
}

function fenetreOuverte() {
  const visibles = [...document.querySelectorAll('.modal')].filter(
    // L'écran de clé d'accès ne se referme pas : sans clé, il n'y a pas d'appli.
    (m) => m.id !== 'gateModal' && estAffiche(m)
  );
  return visibles.length ? visibles[visibles.length - 1] : null;
}

function refermerFenetre(modal) {
  const boutons = [...modal.querySelectorAll('button')].filter(estAffiche);
  const sortie = boutons.find((b) => /annuler|fermer|plus tard|compris/i.test(b.textContent));
  if (!sortie) return false; // pas de sortie neutre : on ne touche à rien
  sortie.click();
  return true;
}

// Nombre d'entrées inutilisées déroulées d'affilée, pour ne pas boucler.
let deroulement = 0;

window.addEventListener('popstate', () => {
  const fenetre = fenetreOuverte();
  if (fenetre && refermerFenetre(fenetre)) {
    deroulement = 0;
    return;
  }

  if (proximite !== null || searchInput.value) {
    quitterProximite();
    searchInput.value = '';
    searchInput.blur();
    renderList();
    gardeFiltre = false;
    deroulement = 0;
    return;
  }

  // Plus rien à refermer. On déroule les entrées laissées par les fenêtres
  // déjà refermées à la main, jusqu'à sortir pour de bon.
  if (deroulement++ < 12) history.back();
});

/* --------------------- détection de résidences ------------------------- */

// Deux entrées d'une même résidence sont rarement à plus de cette distance.
const RAYON_RESIDENCE = 150;

/** Coordonnées officielles d'une adresse, ou null si elle est introuvable. */
async function geocoder(adresse) {
  const url =
    'https://data.geopf.fr/geocodage/search?index=address&limit=1&citycode=06088&q=' +
    encodeURIComponent(adresse);
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const point = (data.features || [])[0];
    if (!point || !point.geometry) return null;
    const [lon, lat] = point.geometry.coordinates;
    return { lat, lon };
  } catch {
    return null;
  }
}

/** Parcelle cadastrale d'un point, via le relais du serveur. */
async function parcellePour(point) {
  if (!point) return null;
  try {
    const res = await api('/api/parcelle?lat=' + point.lat + '&lon=' + point.lon);
    return res.parcelle ? { id: res.parcelle, libelle: res.libelle } : null;
  } catch {
    return null;
  }
}

/**
 * Cherche les fiches qui partagent un même code et appartiennent vraisem-
 * blablement à la même résidence : même parcelle cadastrale, ou à défaut
 * quelques dizaines de mètres l'une de l'autre.
 */
async function detecterResidences() {
  // Regroupement par code, en ignorant la casse et les espaces.
  const parCode = new Map();
  for (const r of records) {
    const cle = (r.code || '').trim().toUpperCase();
    if (!cle) continue;
    if (!parCode.has(cle)) parCode.set(cle, []);
    parCode.get(cle).push(r);
  }

  const candidats = [...parCode.values()].filter((lot) => {
    if (lot.length < 2) return false;
    // Déjà liées entre elles : rien à proposer.
    const groupes = new Set(lot.map((r) => r.groupe || null));
    return !(groupes.size === 1 && lot[0].groupe);
  });

  if (!candidats.length) {
    await showDialog({
      title: '🔍 Détection',
      message: 'Aucun code partagé par plusieurs fiches non déjà liées.',
      showCancel: false,
      okText: 'Fermer'
    });
    return;
  }

  const combien = candidats.reduce((n, lot) => n + lot.length, 0);
  const lancer = await showDialog({
    title: '🔍 Détection',
    message:
      combien + ' fiches partagent un code avec une autre. Leurs adresses vont être '
      + "localisées pour repérer celles qui appartiennent à une même résidence.\n\n"
      + "Cela interroge le référentiel d'adresses, comptez quelques secondes.",
    okText: 'Lancer',
    cancelText: 'Annuler'
  });
  if (!lancer) return;

  updateStatus('🏘️ Localisation des adresses...');
  const positions = new Map();
  for (const lot of candidats) {
    for (const r of lot) {
      if (positions.has(r.id)) continue;
      positions.set(r.id, await geocoder(r.address));
    }
  }

  updateStatus('🏘️ Consultation du cadastre...');
  const parcelles = new Map();
  for (const [id, point] of positions) {
    parcelles.set(id, await parcellePour(point));
  }
  updateStatus();

  // Un lot est retenu s'il partage une parcelle cadastrale, ou à défaut si
  // ses adresses sont proches. La parcelle est une preuve, la distance un
  // simple indice.
  const propositions = [];
  for (const lot of candidats) {
    const situees = lot.filter((r) => positions.get(r.id));
    if (situees.length < 2) continue;

    let ecart = 0;
    for (let i = 0; i < situees.length; i++) {
      for (let j = i + 1; j < situees.length; j++) {
        ecart = Math.max(
          ecart,
          distanceMetres(positions.get(situees[i].id), positions.get(situees[j].id))
        );
      }
    }

    const refs = situees.map((r) => parcelles.get(r.id)).filter(Boolean);
    const memeParcelle =
      refs.length === situees.length && new Set(refs.map((x) => x.id)).size === 1;

    if (memeParcelle) {
      propositions.push({ fiches: situees, ecart, parcelle: refs[0].libelle, certain: true });
    } else if (ecart <= RAYON_RESIDENCE) {
      propositions.push({ fiches: situees, ecart, parcelle: null, certain: false });
    }
  }

  if (!propositions.length) {
    await showDialog({
      title: '🔍 Détection',
      message:
        'Des codes sont partagés, mais les adresses concernées sont trop éloignées '
        + "les unes des autres pour appartenir à la même résidence.",
      showCancel: false,
      okText: 'Fermer'
    });
    return;
  }

  // Les regroupements confirmés par le cadastre passent devant.
  propositions.sort((a, b) => Number(b.certain) - Number(a.certain) || a.ecart - b.ecart);

  const corps = el('div');
  corps.style.cssText =
    'max-height:55vh;overflow-y:auto;touch-action:pan-y;overscroll-behavior:contain;';

  for (const proposition of propositions) {
    const ligne = el('div');
    ligne.style.cssText = 'padding:12px 4px;border-bottom:1px solid #1e293b;';

    const entete = el('div', null, 'Code ' + proposition.fiches[0].code);
    entete.style.cssText = 'font-size:15px;font-weight:600;color:#e2e8f0;';

    const preuve = el('div', null,
      proposition.certain
        ? '✅ même parcelle cadastrale' + (proposition.parcelle ? ' ' + proposition.parcelle : '')
        : '📏 ' + proposition.ecart + ' m · parcelles différentes');
    preuve.style.cssText =
      'font-size:12px;margin-top:3px;color:' + (proposition.certain ? '#34d399' : '#94a3b8') + ';';

    const liste = el('div', null, proposition.fiches.map((r) => r.address).join('\n'));
    liste.style.cssText =
      'font-size:13px;color:#94a3b8;margin-top:4px;white-space:pre-line;line-height:1.5;';

    const lier = el('button', 'btn-save', 'Lier ces ' + proposition.fiches.length + ' fiches');
    lier.type = 'button';
    lier.style.cssText = 'margin-top:10px;padding:8px 14px;font-size:13px;';
    lier.addEventListener('click', async () => {
      lier.disabled = true;
      try {
        const res = await api('/api/groupes', {
          method: 'POST',
          body: JSON.stringify({ ids: proposition.fiches.map((r) => r.id) })
        });
        proposition.fiches.forEach((r) => {
          r.groupe = res.groupe;
        });
        lier.textContent = '✓ Liées';
      } catch {
        lier.disabled = false;
        showToast('Échec du regroupement');
      }
    });

    ligne.append(entete, preuve, liste, lier);
    corps.appendChild(ligne);
  }

  await panneau('🏘️ Résidences probables', corps, [
    { texte: 'Fermer', valeur: null, classe: 'btn-cancel' }
  ]);
}

/** Petite liste de sélection d'une fiche, avec filtre. Renvoie un id ou null. */
function choisirFiche(exclus) {
  return new Promise((resolve) => {
    const modal = el('div', 'modal');
    modal.style.display = 'flex';
    const box = el('div', 'modal-content');
    box.appendChild(el('h3', null, 'Ajouter une adresse'));

    const champ = document.createElement('input');
    champ.type = 'text';
    champ.placeholder = 'Rechercher une adresse';
    box.appendChild(champ);

    const liste = el('div');
    liste.style.cssText =
      'max-height:40vh;overflow-y:auto;margin-top:10px;touch-action:pan-y;overscroll-behavior:contain;';
    box.appendChild(liste);

    const fermer = (valeur) => {
      libererFond();
      modal.remove();
      resolve(valeur);
    };

    const remplir = () => {
      liste.textContent = '';
      const terms = searchKey(champ.value).split(' ').filter(Boolean);
      const trouvees = records
        .filter((r) => !exclus.includes(r.id))
        .filter((r) => !terms.length || terms.every((t) => searchKey(r.address).includes(t)))
        .slice(0, 12);

      if (!trouvees.length) {
        const vide = el('p', null, 'Aucune adresse.');
        vide.style.cssText = 'font-size:13px;color:#64748b;padding:8px 2px;';
        liste.appendChild(vide);
        return;
      }

      for (const r of trouvees) {
        const ligne = el('button', null, r.address + '  ·  ' + r.code);
        ligne.type = 'button';
        ligne.style.cssText =
          'display:block;width:100%;text-align:left;background:transparent;border:0;' +
          'border-bottom:1px solid #1e293b;padding:11px 2px;color:#cbd5e1;font-size:14px;';
        ligne.addEventListener('click', () => fermer(r.id));
        liste.appendChild(ligne);
      }
    };

    champ.addEventListener('input', remplir);
    remplir();

    const barre = el('div');
    barre.style.cssText = 'display:grid;grid-template-columns:1fr;gap:10px;margin-top:14px;';
    const annuler = el('button', 'btn-cancel', 'Annuler');
    annuler.type = 'button';
    annuler.style.cssText = 'width:100%;padding:12px;font-size:15px;';
    annuler.addEventListener('click', () => fermer(null));
    barre.appendChild(annuler);
    box.appendChild(barre);

    modal.appendChild(box);
    document.body.appendChild(modal);
    verrouillerFond();
    champ.focus();
  });
}

/** Résidences déjà constituées, et détection de nouvelles. */
async function montrerResidences() {
  const corps = el('div');
  corps.style.cssText =
    'max-height:55vh;overflow-y:auto;touch-action:pan-y;overscroll-behavior:contain;';

  const dessiner = () => {
    corps.textContent = '';

    const groupes = new Map();
    for (const r of records) {
      if (!r.groupe) continue;
      if (!groupes.has(r.groupe)) groupes.set(r.groupe, []);
      groupes.get(r.groupe).push(r);
    }

    if (!groupes.size) {
      const vide = el('p', null,
        "Aucune résidence enregistrée. La détection ci-dessous en propose à partir des codes partagés.");
      vide.style.cssText = 'font-size:13px;color:#64748b;line-height:1.5;padding:6px 2px 12px;';
      corps.appendChild(vide);
    }

    for (const [id, fiches] of groupes) {
      const bloc = el('div');
      bloc.style.cssText = 'padding:12px 4px;border-bottom:1px solid #1e293b;';

      const titre = el('div', null, fiches.length + ' entrées');
      titre.style.cssText = 'font-size:14px;font-weight:600;color:#e2e8f0;margin-bottom:6px;';
      bloc.appendChild(titre);

      for (const f of fiches) {
        const ligne = el('div');
        ligne.style.cssText =
          'display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px;color:#94a3b8;';

        const texte = el('span', null, f.address + '  ·  ' + f.code);
        texte.style.cssText = 'flex:1;';

        const retirer = el('button', null, '✕');
        retirer.type = 'button';
        retirer.style.cssText =
          'background:transparent;border:0;color:#64748b;font-size:15px;padding:2px 6px;';
        retirer.addEventListener('click', async () => {
          try {
            await api('/api/groupes', { method: 'DELETE', body: JSON.stringify({ id: f.id }) });
            f.groupe = null;
            dessiner();
            showToast('Retirée de la résidence');
          } catch {
            showToast('Échec du retrait');
          }
        });

        ligne.append(texte, retirer);
        bloc.appendChild(ligne);
      }

      const ajouter = el('button', 'btn-cancel', '+ Ajouter une adresse');
      ajouter.type = 'button';
      ajouter.style.cssText = 'margin-top:8px;padding:7px 12px;font-size:13px;';
      ajouter.addEventListener('click', async () => {
        const choisi = await choisirFiche(fiches.map((f) => f.id));
        if (!choisi) return;
        try {
          await api('/api/groupes', {
            method: 'POST',
            body: JSON.stringify({ ids: [...fiches.map((f) => f.id), choisi] })
          });
          const fiche = records.find((r) => r.id === choisi);
          if (fiche) fiche.groupe = id;
          dessiner();
          showToast('Adresse rattachée');
        } catch {
          showToast('Échec du rattachement');
        }
      });

      bloc.appendChild(ajouter);
      corps.appendChild(bloc);
    }
  };

  dessiner();

  const choix = await panneau('🏘️ Résidences', corps, [
    { texte: '🔍 Détecter', valeur: 'detecter' },
    { texte: 'Fermer', valeur: null, classe: 'btn-cancel' }
  ]);

  if (choix === 'detecter') await detecterResidences();
}


/* ------------------------------- guide ---------------------------------- */

const TUTO_KEY = 'chall_tuto_v1';

// Uniquement ce qui ne se devine pas. Le reste s'apprend en utilisant.
const ETAPES_TUTO = [
  {
    cible: () => searchInput,
    titre: '📍 Les immeubles autour de vous',
    texte:
      "Touchez simplement la barre de recherche : les adresses situées à moins de 80 m "
      + "s'affichent en premier, la plus proche en tête. Rien à taper."
  },
  {
    cible: () => document.querySelector('.card .btn-action'),
    titre: '✏️ Corriger un code',
    texte:
      "Appui long sur le crayon, une seconde. Un appui bref ne fait rien : c'est voulu, "
      + "pour ne pas ouvrir une fiche par erreur. C'est aussi là qu'on signale un code HS."
  },
  {
    cible: () => $('openAddModal'),
    titre: '➕ Ajouter un immeuble',
    texte:
      "Si un code manque, ajoutez-le. Devant l'immeuble, l'adresse vous est proposée "
      + "automatiquement, vous n'avez que le code à saisir."
  },
  {
    // Le bouton est toujours présent, contrairement au badge MAJ qui n'existe
    // que si une fiche a changé récemment.
    cible: () => filterRecentBtn,
    titre: '🔄 Les codes récents',
    texte:
      "Un badge MAJ signale un code changé dans les sept derniers jours. "
      + "Ce bouton n'affiche que ceux-là."
  }
];

function lancerTuto() {
  const etapes = ETAPES_TUTO.filter((e) => e.cible());
  if (!etapes.length) return;

  let index = 0;

  const couche = el('div', 'modal');
  couche.style.cssText =
    'display:block;background:transparent;padding:0;position:fixed;inset:0;z-index:60;';

  const trou = el('div');
  trou.style.cssText =
    'position:absolute;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,0.78);' +
    'border:2px solid #38bdf8;transition:all 180ms;pointer-events:none;';

  const bulle = el('div');
  bulle.style.cssText =
    'position:absolute;left:16px;right:16px;background:#1e293b;border-radius:14px;' +
    'padding:16px;box-shadow:0 10px 30px rgba(0,0,0,0.5);';

  const titre = el('h3', null, '');
  titre.style.cssText = 'font-size:16px;margin-bottom:8px;color:#e2e8f0;';
  const texte = el('p', null, '');
  texte.style.cssText = 'font-size:14px;line-height:1.5;color:#cbd5e1;margin-bottom:14px;';

  const barre = el('div');
  barre.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;align-items:center;';
  const compteur = el('span', null, '');
  compteur.style.cssText = 'margin-right:auto;font-size:12px;color:#64748b;';
  const passer = el('button', 'btn-cancel', 'Fermer le guide');
  passer.type = 'button';
  const suivant = el('button', 'btn-save', 'Suivant');
  suivant.type = 'button';
  barre.append(compteur, passer, suivant);

  bulle.append(titre, texte, barre);
  couche.append(trou, bulle);

  const terminer = () => {
    localStorage.setItem(TUTO_KEY, 'vu');
    libererFond();
    couche.remove();
  };

  const afficher = () => {
    const etape = etapes[index];
    const cible = etape.cible();
    if (!cible) {
      terminer();
      return;
    }

    const r = cible.getBoundingClientRect();
    if (!r.width && !r.height) {
      terminer(); // cible disparue de l'écran
      return;
    }

    const marge = 8;
    trou.style.top = r.top - marge + 'px';
    trou.style.left = r.left - marge + 'px';
    trou.style.width = r.width + marge * 2 + 'px';
    trou.style.height = r.height + marge * 2 + 'px';

    // Le texte d'abord : la hauteur réelle de la bulle est nécessaire pour la
    // placer, faute de quoi elle peut se retrouver hors de l'écran.
    titre.textContent = etape.titre;
    texte.textContent = etape.texte;
    compteur.textContent = index + 1 + ' / ' + etapes.length;
    suivant.textContent = index === etapes.length - 1 ? 'Compris' : 'Suivant';

    bulle.style.bottom = '';
    bulle.style.top = '0px';
    const hauteur = bulle.offsetHeight;
    const dessous = r.bottom + 20;
    const dessus = r.top - 20 - hauteur;

    let haut = dessous + hauteur + 12 <= window.innerHeight ? dessous : dessus;
    // Bornage : la bulle reste entièrement visible quoi qu'il arrive.
    haut = Math.max(12, Math.min(haut, window.innerHeight - hauteur - 12));
    bulle.style.top = haut + 'px';
  };

  passer.addEventListener('click', terminer);
  suivant.addEventListener('click', () => {
    index++;
    if (index >= etapes.length) terminer();
    else afficher();
  });

  document.body.appendChild(couche);
  verrouillerFond();
  afficher();
}

/** Première ouverture : on montre le guide une fois la liste affichée. */
function proposerTuto() {
  if (localStorage.getItem(TUTO_KEY) || !records.length) return;
  setTimeout(lancerTuto, 600);
}

/* ------------------------- registre des clients ------------------------- */

const CLIENTS_CACHE_KEY = 'chall_clients_v1';
const ONGLET_KEY = 'chall_onglet';

let clients = readJson(CLIENTS_CACHE_KEY, []);
let clientEnCours = null; // id de la fiche ouverte, null pour un ajout

const clientList = $('clientList');
const clientModal = $('clientModal');
const clientNom = $('clientNom');
const clientAdresse = $('clientAdresse');
const clientInfo = $('clientInfo');
const clientDeleteBtn = $('clientDeleteBtn');
const clientSaveBtn = $('clientSaveBtn');

const saveClientsCache = () => writeJson(CLIENTS_CACHE_KEY, clients);

/** Code d'accès connu pour l'adresse du client, seulement s'il est sans ambiguïté. */
function codePourClient(c) {
  if (!c.adresse) return null;
  const fiches = fichesPour(c.adresse);
  return fiches.length === 1 ? fiches[0] : null;
}

function buildClientCard(c) {
  const card = el('div', 'card');
  const info = el('div', 'card-info');
  const titre = el('div', 'code-row');
  titre.style.marginTop = '0';
  titre.appendChild(el('span', 'client-nom', c.nom));
  if (c.updatedAt && Date.now() - c.updatedAt < RECENT_MS) titre.appendChild(el('span', 'badge-tag badge-recent', 'MAJ'));
  info.appendChild(titre);
  if (c.adresse) info.appendChild(el('div', 'client-adresse', '📍 ' + c.adresse));
  if (c.info) info.appendChild(el('div', 'client-info', c.info));

  const fiche = codePourClient(c);
  if (fiche) info.appendChild(el('div', 'client-code', '🔑 ' + fiche.code + (fiche.hs ? ' (HS)' : '')));

  const dateLabel = formatUpdateDate(c.updatedAt);
  if (dateLabel) {
    const par = c.parQui ? ' · par ' + c.parQui : '';
    info.appendChild(el('div', 'updated-date', '🕒 Modifié : ' + dateLabel + par));
  }

  const actions = el('div', 'actions');
  const editBtn = el('button', 'btn-action', '✏️');
  editBtn.type = 'button';
  editBtn.setAttribute('aria-label', 'Modifier ' + c.nom);
  editBtn.addEventListener('click', () => ouvrirClient(c.id));
  actions.appendChild(editBtn);

  card.append(info, actions);
  return card;
}

function renderClients() {
  const terms = searchKey(searchInput.value).split(' ').filter(Boolean);

  // Recherche sur le nom, l'adresse et les infos à la fois.
  let filtres;
  if (proximite !== null) {
    // Autour de moi : les clients dont l'adresse est dans le rayon, du plus
    // proche au plus loin.
    filtres = clients
      .map((c) => ({ c, rang: rangProche(c) }))
      .filter((x) => x.rang !== -1)
      .sort((x, y) => x.rang - y.rang)
      .map((x) => x.c);
  } else {
    filtres = clients.filter((c) => {
      // « Récents » : fiches ajoutées ou modifiées ces sept derniers jours.
      if (filterRecentOnly && !(c.updatedAt && Date.now() - c.updatedAt < RECENT_MS)) return false;
      if (!terms.length) return true;
      const cible = searchKey([c.nom, c.adresse, c.info].join(' '));
      return terms.every((t) => cible.includes(t));
    });
    if (filterRecentOnly) filtres.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
    else filtres.sort((x, y) => (x.nom || '').localeCompare(y.nom || '', 'fr', { numeric: true, sensitivity: 'base' }));
  }

  itemCount.textContent = proximite !== null
    ? `📍 ${filtres.length} autour de vous`
    : `${filtres.length} client${filtres.length > 1 ? 's' : ''}`;

  const fragment = document.createDocumentFragment();
  if (!filtres.length) {
    const vide = proximite !== null
      ? 'Aucun client connu dans les ' + RAYON_METRES + ' m.'
      : filterRecentOnly && !terms.length ? 'Aucun client modifié ces 7 derniers jours.'
      : clients.length ? 'Aucun client ne correspond.' : 'Aucun client enregistré. Appuyez sur + pour en ajouter un.';
    fragment.appendChild(el('div', 'empty-state', vide));
  } else {
    filtres.forEach((c) => fragment.appendChild(buildClientCard(c)));
  }
  clientList.replaceChildren(fragment);
}

async function loadClients() {
  try {
    const data = await api('/api/clients');
    clients = Array.isArray(data.clients) ? data.clients : [];
    saveClientsCache();
  } catch (err) {
    if (err.status === 401) openGate('Clé refusée. Saisissez la clé à jour.');
    // Sinon : on garde la dernière liste connue.
  }
  if (onglet === 'clients') renderList();
}

function changerOnglet(nouveau) {
  onglet = nouveau === 'clients' ? 'clients' : 'codes';
  try { localStorage.setItem(ONGLET_KEY, onglet); } catch { /* sans mémoire */ }

  const surClients = onglet === 'clients';
  $('tabCodes').classList.toggle('active', !surClients);
  $('tabClients').classList.toggle('active', surClients);
  $('tabCodes').setAttribute('aria-selected', String(!surClients));
  $('tabClients').setAttribute('aria-selected', String(surClients));
  codeList.hidden = surClients;
  clientList.hidden = !surClients;

  quitterProximite();

  searchInput.value = '';
  searchInput.placeholder = surClients ? 'Rechercher nom, adresse, info...' : 'Rechercher rue, numéro...';
  $('openAddModal').setAttribute('aria-label', surClients ? 'Ajouter un client' : 'Ajouter un code');

  renderList();
  if (surClients && getAccessKey() && navigator.onLine) loadClients();
}

$('tabCodes').addEventListener('click', () => changerOnglet('codes'));
$('tabClients').addEventListener('click', () => changerOnglet('clients'));

function ouvrirClient(id) {
  const c = id ? clients.find((x) => x.id === id) : null;
  clientEnCours = c ? c.id : null;

  $('clientModalTitle').textContent = c ? 'Fiche client' : 'Nouveau client';
  clientNom.value = c ? c.nom : '';
  clientAdresse.value = c ? c.adresse : '';
  clientInfo.value = c ? c.info : '';
  // Suppression : l'auteur de la fiche, ou l'administrateur (vérifié côté serveur).
  clientDeleteBtn.style.display = c && (c.isMine || localStorage.getItem(ADMIN_KEY)) ? 'block' : 'none';

  clientModal.style.display = 'flex';
  verrouillerFond();
  if (!c) clientNom.focus();
}

function fermerClient() {
  if (clientModal.style.display !== 'flex') return;
  clientModal.style.display = 'none';
  libererFond();
}

$('clientCancelBtn').addEventListener('click', fermerClient);

/** Erreur d'écriture : la fenêtre reste ouverte, rien de ce qui a été tapé n'est perdu. */
async function signalerEchecClient(err) {
  if (err.status === 401) {
    fermerClient();
    openGate('Clé refusée. Saisissez la clé à jour.');
    return;
  }
  const horsLigne = err.status === undefined;
  await showDialog({
    title: horsLigne ? 'Connexion requise' : 'Enregistrement refusé',
    message: horsLigne
      ? 'Les fiches clients ne sont enregistrées qu’avec du réseau. Réessayez une fois connecté.'
      : err.message,
    showCancel: false,
    okText: 'Compris'
  });
}

clientSaveBtn.addEventListener('click', async () => {
  if (isBusy) return;

  const nom = clientNom.value.trim();
  const adresse = clientAdresse.value.trim();
  const info = clientInfo.value.trim();

  if (!nom) {
    await showDialog({ title: 'Nom manquant', message: 'Renseignez au moins le nom du client.', showCancel: false, okText: 'Compris' });
    return;
  }

  isBusy = true;
  clientSaveBtn.disabled = true;
  try {
    let data;
    if (clientEnCours) {
      data = await api('/api/clients/' + encodeURIComponent(clientEnCours), {
        method: 'PATCH',
        body: JSON.stringify({ nom, adresse, info })
      });
      const idx = clients.findIndex((x) => x.id === clientEnCours);
      if (idx !== -1 && data.client) clients[idx] = data.client;
    } else {
      const id = getClientId().slice(0, 8) + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      data = await api('/api/clients', { method: 'POST', body: JSON.stringify({ id, nom, adresse, info }) });
      if (data.client) clients.push(data.client);
    }
    saveClientsCache();
    fermerClient();
    renderList();
    showToast(clientEnCours ? 'Fiche client mise à jour' : 'Client ajouté');
  } catch (err) {
    await signalerEchecClient(err);
  } finally {
    clientSaveBtn.disabled = false;
    isBusy = false;
  }
});

clientDeleteBtn.addEventListener('click', async () => {
  if (!clientEnCours || isBusy) return;
  const c = clients.find((x) => x.id === clientEnCours);
  if (!c) return;

  const ok = await showDialog({
    title: 'Confirmer la suppression',
    message: `Supprimer la fiche de « ${c.nom} » ?`,
    okText: 'Supprimer',
    cancelText: 'Annuler'
  });
  if (!ok) return;

  isBusy = true;
  try {
    await api('/api/clients/' + encodeURIComponent(c.id), { method: 'DELETE' });
    clients = clients.filter((x) => x.id !== c.id);
    saveClientsCache();
    fermerClient();
    renderList();
    showToast('Fiche client supprimée');
  } catch (err) {
    await signalerEchecClient(err);
  } finally {
    isBusy = false;
  }
});

/* ------------------------------ démarrage ------------------------------- */

window.addEventListener('online', async () => {
  if (await flushOutbox()) await loadData({ silent: true });
});
window.addEventListener('offline', () => updateStatus());

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') {
    arreterSurveillance();
    return;
  }
  if (!navigator.onLine || !getAccessKey()) return;
  prechaufferPosition();

  // Retour sur l'appli après un verrouillage : on a pu changer d'immeuble
  // entre-temps, la liste des adresses proches est donc recalculée.
  if (proximite !== null) {
    try {
      const point = await obtenirPosition({ timeout: 6000 });
      await rafraichirProches(point);
    } catch {
      /* position indisponible : on garde l'affichage précédent */
    }
  }
  if (await flushOutbox()) await loadData({ silent: true });
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

(async function start() {
  // Une clé présente dans le lien est adoptée avant tout le reste.
  consumeKeyFromUrl();

  // Le cache s'affiche immédiatement : l'appli est lisible avant toute requête.
  records = loadCache();
  let ongletMemorise = 'codes';
  try { ongletMemorise = localStorage.getItem(ONGLET_KEY) || 'codes'; } catch { /* sans mémoire */ }
  changerOnglet(ongletMemorise);
  updateStatus();

  if (!getAccessKey()) {
    openGate('');
    return;
  }

  await flushOutbox();
  await loadData();
  trackDeviceInstallation();
  proposerTuto();
})();
