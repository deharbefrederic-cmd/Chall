if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

let records = [];
let editingIndex = null;
let toastTimeout;
let deferredPrompt = null;
let filterRecentOnly = false;
let isSaving = false;

const searchInput = document.getElementById('searchInput');
const clearBtn = document.getElementById('clearBtn');
const codeList = document.getElementById('codeList');
const itemCount = document.getElementById('itemCount');
const syncStatus = document.getElementById('syncStatus');
const editModal = document.getElementById('editModal');
const modalAddress = document.getElementById('modalAddress');
const modalCode = document.getElementById('modalCode');
const modalTitle = document.getElementById('modalTitle');
const deleteBtn = document.getElementById('deleteBtn');
const hsToggleBtn = document.getElementById('hsToggleBtn');
const saveBtn = document.getElementById('saveModal');
const toast = document.getElementById('toast');
const installBtn = document.getElementById('installBtn');
const installPopupModal = document.getElementById('installPopupModal');
const confirmInstallPopup = document.getElementById('confirmInstallPopup');
const dismissInstallPopup = document.getElementById('dismissInstallPopup');
const filterRecentBtn = document.getElementById('filterRecentBtn');

// Gestion des suppressions réservées au créateur (24h)
function getMyCreatedIds() {
  try {
    return JSON.parse(localStorage.getItem('chall_my_creations') || '[]');
  } catch (e) {
    return [];
  }
}

function recordMyCreation(id) {
  const ids = getMyCreatedIds();
  ids.push(id);
  localStorage.setItem('chall_my_creations', JSON.stringify(ids));
}

function clean(str) {
  return (str || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Normalisation intelligente pour comparer les adresses
function standardizeAddress(str) {
  let s = clean(str);
  return s.replace(/\bav\b|\bave\b/g, 'avenue')
          .replace(/\bbd\b|\bblvd\b/g, 'boulevard')
          .replace(/\bche\b|\bch\b/g, 'chemin')
          .replace(/\br\b/g, 'rue')
          .replace(/\bst\b/g, 'saint')
          .replace(/\bste\b/g, 'sainte')
          .replace(/\bimp\b/g, 'impasse')
          .replace(/[^a-z0-9]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
}

// Calcul de la distance d'édition entre deux textes
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

// Détecteur de doublons
function findSimilarAddress(newAddr, currentIndex = null) {
  const stdNew = standardizeAddress(newAddr);
  const numbersNew = (stdNew.match(/\d+/g) || []).join('-');

  for (let i = 0; i < records.length; i++) {
    if (currentIndex !== null && i === currentIndex) continue;

    const existing = records[i];
    const stdExisting = standardizeAddress(existing.a);
    const numbersExisting = (stdExisting.match(/\d+/g) || []).join('-');

    // Si les numéros d'immeuble diffèrent (ex: 12 vs 14), ce ne sont pas des doublons
    if (numbersNew && numbersExisting && numbersNew !== numbersExisting) {
      continue;
    }

    // 1. Égalité parfaite après normalisation
    if (stdNew === stdExisting) {
      return existing;
    }

    // 2. Différence de quelques caractères (faute de frappe)
    const maxLen = Math.max(stdNew.length, stdExisting.length);
    if (maxLen > 4) {
      const dist = levenshtein(stdNew, stdExisting);
      const similarity = 1 - (dist / maxLen);
      if (dist <= 2 || similarity >= 0.82) {
        return existing;
      }
    }

    // 3. Inclusion de mots clés significatifs (ex: "12 miltat" vs "12 avenue miltat")
    const wordsNew = stdNew.split(' ').filter(w => w.length > 2);
    const wordsExisting = stdExisting.split(' ').filter(w => w.length > 2);
    if (wordsNew.length >= 2 && wordsExisting.length >= 2) {
      const common = wordsNew.filter(w => wordsExisting.includes(w));
      if (common.length >= Math.min(wordsNew.length, wordsExisting.length)) {
        return existing;
      }
    }
  }
  return null;
}

function formatUpdateDate(ts) {
  if (!ts) return null;
  const diffDays = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Aujourd'hui";
  if (diffDays === 1) return "Hier";
  if (diffDays < 7) return `Il y a ${diffDays} j`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

filterRecentBtn.addEventListener('click', () => {
  filterRecentOnly = !filterRecentOnly;
  filterRecentBtn.classList.toggle('active', filterRecentOnly);
  renderList();
});

// Installation PWA
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = 'inline-block';
  if (!localStorage.getItem('pwa_prompt_shown')) {
    localStorage.setItem('pwa_prompt_shown', 'true');
    installPopupModal.style.display = 'flex';
  }
});

confirmInstallPopup.addEventListener('click', async () => {
  installPopupModal.style.display = 'none';
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') installBtn.style.display = 'none';
  deferredPrompt = null;
});

dismissInstallPopup.addEventListener('click', () => {
  installPopupModal.style.display = 'none';
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') installBtn.style.display = 'none';
  deferredPrompt = null;
});

async function loadData() {
  try {
    const res = await fetch('/api/codes');
    records = await res.json();
    if (!Array.isArray(records)) records = [];
    syncStatus.textContent = "🟢 À jour";
  } catch (e) {
    syncStatus.textContent = "🔴 Hors ligne";
  }
  renderList();
}

async function syncToServer() {
  syncStatus.textContent = "⏳ Envoi...";
  try {
    await fetch('/api/codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(records)
    });
    syncStatus.textContent = "🟢 À jour";
  } catch (e) {
    syncStatus.textContent = "⚠️ Échec sync";
  }
  renderList();
}

function renderList() {
  const query = clean(searchInput.value);
  const terms = query.split(/\s+/).filter(Boolean);

  let filtered = records.filter(item => {
    if (filterRecentOnly && !item.u) return false;
    if (!terms.length) return true;
    const target = clean(item.a || '');
    return terms.every(t => target.includes(t));
  });

  if (filterRecentOnly) {
    filtered.sort((x, y) => (y.u || 0) - (x.u || 0));
  }

  itemCount.textContent = `${filtered.length} résultat(s)`;
  codeList.innerHTML = '';

  filtered.forEach(item => {
    const originalIdx = records.indexOf(item);
    const dateLabel = formatUpdateDate(item.u);
    const isRecent = item.u && (Date.now() - item.u < 7 * 24 * 60 * 60 * 1000);
    const isHS = Boolean(item.hs);

    const card = document.createElement('div');
    card.className = 'card' + (isHS ? ' is-hs' : '');
    card.innerHTML = `
      <div class="card-info">
        <div class="address">${item.a}</div>
        <div class="code-row">
          <div class="code-badge ${isHS ? 'hs' : ''}">${isHS ? '⚠️ ' + item.c : item.c}</div>
          ${isHS ? '<span class="badge-tag badge-hs-alert">Code HS</span>' : ''}
          ${isRecent ? '<span class="badge-tag badge-recent">MAJ</span>' : ''}
        </div>
        ${dateLabel ? `<div class="updated-date">🕒 Modifié : ${dateLabel}</div>` : ''}
      </div>
      <div class="actions">
        <button class="btn-action" onclick="copyCode('${(item.c || '').replace(/'/g, "\\'")}')">📋</button>
        <button class="btn-action" onclick="openEdit(${originalIdx})">✏️</button>
      </div>
    `;
    codeList.appendChild(card);
  });
}

window.copyCode = function(val) {
  navigator.clipboard.writeText(val);
  toast.textContent = 'Code copié : ' + val;
  toast.className = 'show';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { toast.className = ''; }, 1500);
};

window.openEdit = function(idx) {
  editingIndex = idx;
  const item = records[idx];
  modalTitle.textContent = "Modifier l'adresse";
  modalAddress.value = item.a;
  modalCode.value = item.c;

  const myCreations = getMyCreatedIds();
  const isMine = item.id && myCreations.includes(item.id);
  const isUnder24h = item.created && (Date.now() - item.created < 24 * 60 * 60 * 1000);
  deleteBtn.style.display = (isMine && isUnder24h) ? 'block' : 'none';

  hsToggleBtn.style.display = 'block';
  if (item.hs) {
    hsToggleBtn.textContent = '✅ Code valide';
    hsToggleBtn.style.background = '#059669';
  } else {
    hsToggleBtn.textContent = '⚠️ Signaler HS';
    hsToggleBtn.style.background = '#d97706';
  }

  editModal.style.display = 'flex';
};

document.getElementById('openAddModal').addEventListener('click', () => {
  editingIndex = null;
  modalTitle.textContent = "Ajouter un code";
  modalAddress.value = '';
  modalCode.value = '';
  deleteBtn.style.display = 'none';
  hsToggleBtn.style.display = 'none';
  editModal.style.display = 'flex';
});

document.getElementById('cancelModal').addEventListener('click', () => {
  editModal.style.display = 'none';
});

hsToggleBtn.addEventListener('click', async () => {
  if (editingIndex === null || isSaving) return;
  isSaving = true;
  const item = records[editingIndex];
  item.hs = !item.hs;
  editModal.style.display = 'none';
  await syncToServer();
  toast.textContent = item.hs ? 'Portail signalé HS' : 'Portail rétabli';
  toast.className = 'show';
  setTimeout(() => { toast.className = ''; }, 1500);
  isSaving = false;
});

deleteBtn.addEventListener('click', async () => {
  if (editingIndex === null || isSaving) return;
  const item = records[editingIndex];
  if (confirm(`Supprimer définitivement "${item.a}" ?`)) {
    isSaving = true;
    records.splice(editingIndex, 1);
    editModal.style.display = 'none';
    await syncToServer();
    toast.textContent = 'Adresse supprimée';
    toast.className = 'show';
    setTimeout(() => { toast.className = ''; }, 1500);
    isSaving = false;
  }
});

// Sauvegarde avec détection de doublons
saveBtn.addEventListener('click', async () => {
  if (isSaving) return;
  const a = modalAddress.value.trim();
  const c = modalCode.value.trim();
  if (!a || !c) return alert("Remplissez l'adresse et le code.");

  // Vérification de doublon potentiel
  const duplicate = findSimilarAddress(a, editingIndex);
  if (duplicate) {
    const confirmMessage = `⚠️ Doublon potentiel détecté !\n\nUne adresse très proche existe déjà :\n👉 "${duplicate.a}" (Code : ${duplicate.c})\n\nSouhaitez-vous quand même enregistrer "${a}" ?`;
    if (!confirm(confirmMessage)) {
      return; // Annule l'enregistrement si l'utilisateur refuse
    }
  }

  isSaving = true;
  saveBtn.disabled = true;
  const now = Date.now();

  if (editingIndex !== null) {
    const prev = records[editingIndex];
    const hasCodeChanged = (clean(prev.c) !== clean(c));
    
    records[editingIndex] = {
      ...prev,
      a,
      c,
      hs: hasCodeChanged ? false : Boolean(prev.hs),
      u: (prev.a !== a || hasCodeChanged) ? now : prev.u
    };
  } else {
    const newId = 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    recordMyCreation(newId);
    records.unshift({ 
      id: newId,
      a, 
      c, 
      u: now, 
      created: now,
      hs: false 
    });
  }

  editModal.style.display = 'none';
  await syncToServer();
  saveBtn.disabled = false;
  isSaving = false;
});

searchInput.addEventListener('input', renderList);
clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchInput.focus();
  renderList();
});

loadData();
