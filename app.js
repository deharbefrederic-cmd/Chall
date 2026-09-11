'use strict';

/* ------------------------------------------------------------------ *
 * Challivretou — client
 * Écritures unitaires (une fiche = une requête), lecture hors ligne,
 * file d'attente rejouée au retour du réseau, rendu DOM sans innerHTML.
 * ------------------------------------------------------------------ */

const CACHE_KEY = 'chall_cache_v2';
const OUTBOX_KEY = 'chall_outbox_v2';
const ACCESS_KEY = 'chall_access_key';
const CLIENT_KEY = 'chall_client_id';
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

let records = [];
let editingId = null;
let filterRecentOnly = false;
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
    modal.style.display = 'flex';

    const cleanup = () => {
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

/** Texte ramené à une forme unique, abréviations développées. */
function searchKey(str) {
  return clean(str)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
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
  if (dateLabel) info.appendChild(el('div', 'updated-date', '🕒 Modifié : ' + dateLabel));

  const actions = el('div', 'actions');

  const copyBtn = el('button', 'btn-action', '📋');
  copyBtn.type = 'button';
  copyBtn.setAttribute('aria-label', 'Copier le code de ' + item.address);
  copyBtn.addEventListener('click', () => copyCode(item.code));

  const editBtn = el('button', 'btn-action', '✏️');
  editBtn.type = 'button';
  editBtn.setAttribute('aria-label', 'Modifier ' + item.address);
  editBtn.addEventListener('click', () => openEdit(item.id));

  actions.append(copyBtn, editBtn);
  card.append(info, actions);
  return card;
}

function renderList() {
  const terms = searchKey(searchInput.value).split(' ').filter(Boolean);

  let filtered = records.filter((item) => {
    if (filterRecentOnly && !item.updatedAt) return false;
    if (!terms.length) return true;
    // Adresse seule (chercher « 69 » ne doit pas remonter les codes),
    // et abréviations développées des deux côtés.
    const target = searchKey(item.address);
    return terms.every((t) => target.includes(t));
  });

  filtered.sort((x, y) =>
    filterRecentOnly
      ? (y.updatedAt || 0) - (x.updatedAt || 0)
      : (x.address || '').localeCompare(y.address || '', 'fr', { numeric: true, sensitivity: 'base' })
  );

  itemCount.textContent = `${filtered.length} résultat${filtered.length > 1 ? 's' : ''}`;

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

async function copyCode(value) {
  try {
    await navigator.clipboard.writeText(value);
    showToast('Code copié : ' + value);
  } catch {
    showToast('Code : ' + value); // clipboard refusé hors HTTPS ou sans geste utilisateur
  }
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
      saveCache();
      renderList();
    }
    updateStatus();
    return { ok: true };
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
  'background:#0f172a;max-height:190px;overflow-y:auto;';
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
    // pointerdown plutôt que click : se déclenche avant que le champ perde le focus.
    row.addEventListener('pointerdown', (e) => {
      e.preventDefault();
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

  try {
    // Requête vers un service tiers : aucun en-tête de l'application n'y est joint.
    const res = await fetch(url, { signal: suggestController.signal });
    if (!res.ok) return;

    const data = await res.json();
    const labels = [];
    for (const feature of data.features || []) {
      const props = feature.properties || {};
      const label = props.name || props.label;
      if (label && !labels.includes(label)) labels.push(label);
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

modalAddress.addEventListener('blur', () => setTimeout(hideSuggestions, 150));

/* ------------------------------- actions -------------------------------- */

$('openAddModal').addEventListener('click', () => {
  editingId = null;
  modalTitle.textContent = 'Ajouter un code';
  modalAddress.value = '';
  modalCode.value = '';
  deleteBtn.style.display = 'none';
  hsToggleBtn.style.display = 'none';
  hideSuggestions();
  editModal.style.display = 'flex';
  modalAddress.focus();
});

$('cancelModal').addEventListener('click', () => {
  hideSuggestions();
  editModal.style.display = 'none';
});

function openEdit(id) {
  const item = records.find((r) => r.id === id);
  if (!item) return;

  editingId = id;
  modalTitle.textContent = "Modifier l'adresse";
  modalAddress.value = item.address;
  modalCode.value = item.code;

  const canDelete = item.isMine && item.createdAt && Date.now() - item.createdAt < DELETE_WINDOW_MS;
  deleteBtn.style.display = canDelete ? 'block' : 'none';

  hsToggleBtn.style.display = 'block';
  hsToggleBtn.textContent = item.hs ? '✅ Code valide' : '⚠️ Signaler HS';
  hsToggleBtn.style.background = item.hs ? '#059669' : '#d97706';

  hideSuggestions();
  editModal.style.display = 'flex';
}

hsToggleBtn.addEventListener('click', async () => {
  if (!editingId || isBusy) return;
  const item = records.find((r) => r.id === editingId);
  if (!item) return;

  isBusy = true;
  const next = !item.hs;
  editModal.style.display = 'none';

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
  editModal.style.display = 'none';
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
          editModal.style.display = 'none';
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
      editModal.style.display = 'none';

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
      } else {
        showToast('Adresse ajoutée');
      }
      return;
    }

    const item = records.find((r) => r.id === editingId);
    if (!item) return;

    if (item.address === address && item.code === code) {
      editModal.style.display = 'none';
      return;
    }

    editModal.style.display = 'none';
    const res = await commit(
      { kind: 'patch', id: item.id, patch: { address, code } },
      () => {
        const codeChanged = item.code !== code;
        item.address = address;
        item.code = code;
        if (codeChanged) item.hs = false;
        item.updatedAt = Date.now();
      }
    );

    showToast(res.ok ? 'Fiche mise à jour' : res.err.message);
  } finally {
    saveBtn.disabled = false;
    isBusy = false;
  }
});

/* ------------------------------ recherche ------------------------------- */

async function checkAdminCommand(value) {
  const command = value.trim().toLowerCase();

  // Repartager l'accès à un collègue sans jamais retaper la clé.
  if (command === '#lien') {
    searchInput.value = '';
    renderList();

    const link = buildInviteLink();
    let copied = false;
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
    } catch {
      /* presse-papiers refusé : le lien reste affiché */
    }

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Challivretou', text: "Lien d'accès Challivretou", url: link });
        return;
      } catch {
        /* partage annulé */
      }
    }

    await showDialog({
      title: copied ? "Lien d'accès copié" : "Lien d'accès",
      message: link + '\n\nEnvoyez-le au collègue. Un simple clic suffit, rien à saisir.',
      showCancel: false,
      okText: 'Fermer'
    });
    return;
  }

  if (command !== '#stats') return;

  searchInput.value = '';
  renderList();

  try {
    const data = await api('/api/stats');
    const a = data.appareils || {};
    const plateformes = (data.plateformes || [])
      .map((p) => `   ${p.nom} : ${p.n}`)
      .join('\n') || '   aucune donnée';

    await showDialog({
      title: '📊 Statistiques Challivretou',
      message:
        `👥 Utilisateurs actifs (7 j) : ${a.actifs7 || 0}\n` +
        `📅 Actifs sur 30 j : ${a.actifs30 || 0}\n` +
        `🆕 Nouveaux cette semaine : ${a.nouveaux7 || 0}\n\n` +
        `📱 Appareils connus depuis le début : ${a.total || 0}\n\n` +
        `Répartition (30 j) :\n${plateformes}`,
      showCancel: false,
      okText: 'Fermer'
    });
  } catch {
    await showDialog({
      title: 'Statistiques indisponibles',
      message: 'Le serveur n’a pas répondu. Réessayez une fois en ligne.',
      showCancel: false,
      okText: 'Compris'
    });
  }
}

searchInput.addEventListener('input', (e) => {
  checkAdminCommand(e.target.value);
  renderList();
});

clearBtn.addEventListener('click', () => {
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

/* ------------------------------ démarrage ------------------------------- */

window.addEventListener('online', async () => {
  if (await flushOutbox()) await loadData({ silent: true });
});
window.addEventListener('offline', () => updateStatus());

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !navigator.onLine || !getAccessKey()) return;
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
  renderList();
  updateStatus();

  if (!getAccessKey()) {
    openGate('');
    return;
  }

  await flushOutbox();
  await loadData();
  trackDeviceInstallation();
})();
