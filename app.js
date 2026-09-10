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

// --- Système de dialogue intégré SANS mention d'URL ---
function showCustomDialog({ title, message, showCancel = true, okText = "OK", cancelText = "Annuler" }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('dialogModal');
    const titleEl = document.getElementById('dialogTitle');
    const msgEl = document.getElementById('dialogMessage');
    const cancelBtn = document.getElementById('dialogCancelBtn');
    const okBtn = document.getElementById('dialogOkBtn');

    titleEl.textContent = title || '';
    msgEl.textContent = message || '';
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

// --- Suivi des installations et utilisateurs Web ---
async function trackDeviceInstallation() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const ua = navigator.userAgent || '';

  if (isStandalone) {
    if (!localStorage.getItem('chall_installed_reported')) {
      const platform = /android/i.test(ua) ? 'android' : (/iphone|ipad|ipod/i.test(ua) ? 'ios' : null);
      if (platform) {
        try {
          await fetch('/api/stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'install', platform })
          });
          localStorage.setItem('chall_installed_reported', 'true');
        } catch (e) {}
      }
    }
  } else {
    if (!localStorage.getItem('chall_web_reported') && !localStorage.getItem('chall_installed_reported')) {
      try {
        await fetch('/api/stats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'web' })
        });
        localStorage.setItem('chall_web_reported', 'true');
      } catch (e) {}
    }
  }
}

trackDeviceInstallation();

window.addEventListener('appinstalled', async () => {
  installBtn.style.display = 'none';
  installPopupModal.style.display = 'none';
  deferredPrompt = null;

  if (!localStorage.getItem('chall_installed_reported')) {
    try {
      await fetch('/api/stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'install', platform: 'android' })
      });
      localStorage.setItem('chall_installed_reported', 'true');
    } catch (e) {}
  }
});

// Commande admin #stats sans URL
async function checkAdminStatsCommand(val) {
  if (val.trim().toLowerCase() === '#stats') {
    searchInput.value = '';
    renderList();
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();
      const android = data.android || 0;
      const ios = data.ios || 0;
      const web = data.web || 0;
      const totalInstalls = android + ios;
      const totalGlobal = totalInstalls + web;

      await showCustomDialog({
        title: "📊 Statistiques Challivretou",
        message: `🤖 Appli Android : ${android}\n🍏 Appli Apple : ${ios}\n📱 Sous-total installés : ${totalInstalls}\n\n🌐 Navigateur URL : ${web}\n\n👥 Total utilisateurs uniques : ${totalGlobal}`,
        showCancel: false,
        okText: "Fermer"
      });
    } catch (e) {
      await showCustomDialog({
        title: "Erreur",
        message: "Impossible de charger les statistiques.",
        showCancel: false
      });
    }
  }
}

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

function extractCoreAddress(str) {
  let s = clean(str);
  s = s.replace(/\b(avenue|ave|av|boulevard|bd|blvd|rue|r|chemin|che|ch|impasse|imp|route|rte|traverse|allee|place|cours|montee|vieux chemin)\b/g, ' ');
  s = s.replace(/[^a-z0-9]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function findSimilarAddress(newAddr, currentIndex = null) {
  const coreNew = extractCoreAddress(newAddr);
  const numNew = (coreNew.match(/\d+/) || [''])[0];
  const wordsNew = coreNew.split(' ').filter(w => w !== numNew && w.length >= 2);

  for (let i = 0; i < records.length; i++) {
    if (currentIndex !== null && i === currentIndex) continue;

    const existing = records[i];
    const coreExisting = extractCoreAddress(existing.a);
    const numExisting = (coreExisting.match(/\d+/) || [''])[0];

    if (numNew && numExisting && numNew !== numExisting) continue;

    if (coreNew === coreExisting) {
      return { item: existing, index: i };
    }

    const wordsExisting = coreExisting.split(' ').filter(w => w !== numExisting && w.length >= 2);
    if (numNew && numNew === numExisting && wordsNew.length > 0 && wordsExisting.length > 0) {
      const match = wordsNew.some(w => wordsExisting.includes(w));
      if (match) return { item: existing, index: i };
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
  } else {
    filtered.sort((x, y) => (x.a || '').localeCompare(y.a || '', 'fr', { numeric: true, sensitivity: 'base' }));
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

// Suppression avec dialogue propre
deleteBtn.addEventListener('click', async () => {
  if (editingIndex === null || isSaving) return;
  const item = records[editingIndex];

  const confirmed = await showCustomDialog({
    title: "Confirmer la suppression",
    message: `Voulez-vous vraiment supprimer définitivement "${item.a}" ?`,
    okText: "Supprimer",
    cancelText: "Annuler"
  });

  if (confirmed) {
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

// Sauvegarde avec fusion et dialogue propre SANS URL
saveBtn.addEventListener('click', async () => {
  if (isSaving) return;
  const a = modalAddress.value.trim();
  const c = modalCode.value.trim();

  if (!a || !c) {
    await showCustomDialog({
      title: "Champs incomplets",
      message: "Veuillez renseigner à la fois l'adresse et le code.",
      showCancel: false,
      okText: "Compris"
    });
    return;
  }

  const now = Date.now();

  if (editingIndex === null) {
    const match = findSimilarAddress(a);
    if (match) {
      const existing = match.item;
      const shouldUpdate = await showCustomDialog({
        title: "⚠️ Adresse similaire trouvée",
        message: `"${existing.a}" existe déjà avec le code : ${existing.c}\n\nSouhaitez-vous METTRE À JOUR son code avec "${c}" plutôt que de créer un doublon ?`,
        okText: "Mettre à jour",
        cancelText: "Créer à part"
      });

      if (shouldUpdate) {
        isSaving = true;
        saveBtn.disabled = true;
        existing.c = c;
        existing.u = now;
        existing.hs = false;
        editModal.style.display = 'none';
        await syncToServer();
        saveBtn.disabled = false;
        isSaving = false;
        toast.textContent = 'Fiche existante mise à jour !';
        toast.className = 'show';
        setTimeout(() => { toast.className = ''; }, 1500);
        return;
      }
    }
  }

  isSaving = true;
  saveBtn.disabled = true;

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
    records.push({ 
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

searchInput.addEventListener('input', (e) => {
  checkAdminStatsCommand(e.target.value);
  renderList();
});

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchInput.focus();
  renderList();
});

loadData();
