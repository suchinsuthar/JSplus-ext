let requests = [];
let filteredRequests = [];
let lastRequestsHash = '';
let searchTerm = '';
let useRegex = false;
let invertSearch = false;
let favoriteUrls = [];
let showFavoritesOnly = false;
let scannedIds = {};

const backBtn = document.getElementById('backBtn');
const totalCount = document.getElementById('totalCount');
const searchInput = document.getElementById('searchInput');
const regexToggle = document.getElementById('regexToggle');
const invertToggle = document.getElementById('invertToggle');
const favoritesToggle = document.getElementById('favoritesToggle');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const filterCount = document.getElementById('filterCount');
const requestsContainer = document.getElementById('requestsContainer');
const exportBtn = document.getElementById('exportBtn');
const exportUrlsBtn = document.getElementById('exportUrlsBtn');

document.addEventListener('DOMContentLoaded', () => {
  loadData();
  setupEventListeners();
  setInterval(loadRequests, 2000);
});

function setupEventListeners() {
  backBtn.addEventListener('click', () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.close();
    }
  });

  searchInput.addEventListener('input', (e) => {
    searchTerm = e.target.value;
    applyFilter();
  });

  regexToggle.addEventListener('click', () => {
    useRegex = !useRegex;
    regexToggle.classList.toggle('active', useRegex);
    applyFilter();
  });

  invertToggle.addEventListener('click', () => {
    invertSearch = !invertSearch;
    invertToggle.classList.toggle('active', invertSearch);
    applyFilter();
  });

  favoritesToggle.addEventListener('click', () => {
    showFavoritesOnly = !showFavoritesOnly;
    favoritesToggle.classList.toggle('active', showFavoritesOnly);
    applyFilter();
  });

  clearSearchBtn.addEventListener('click', () => {
    searchTerm = '';
    searchInput.value = '';
    applyFilter();
  });

  exportBtn.addEventListener('click', exportData);
  exportUrlsBtn.addEventListener('click', exportUrlsOnly);
}

function loadData() {
  loadRequests();
  chrome.storage.local.get(['favoriteUrls', 'scanResultsById'], (result) => {
    favoriteUrls = result.favoriteUrls || [];
    scannedIds = result.scanResultsById || {};
  });
}

function loadRequests() {
  chrome.storage.local.get(['requests', 'favoriteUrls', 'scanResultsById'], (result) => {
    const newRequests = dedupePopupRequests(result.requests || []);
    favoriteUrls = result.favoriteUrls || [];
    scannedIds = result.scanResultsById || {};

    const newHash = JSON.stringify(newRequests.map(r => `${r.id}:${r.timestamp}:${r.statusCode}`));

    if (newHash !== lastRequestsHash) {
      const scrollPosition = requestsContainer.scrollTop;

      requests = newRequests;
      lastRequestsHash = newHash;
      applyFilter();

      setTimeout(() => {
        requestsContainer.scrollTop = scrollPosition;
      }, 10);
    }
  });
}

function dedupePopupRequests(requestList) {
  const seen = {};
  return requestList.filter(request => {
    const key = `${request.id}:${request.url}`;
    if (seen[key]) {
      return false;
    }
    seen[key] = true;
    return true;
  });
}

function applyFilter() {
  let baseRequests = [...requests];

  if (showFavoritesOnly) {
    baseRequests = baseRequests.filter((request) => isFavorite(request.url));
  }

  if (!searchTerm) {
    filteredRequests = baseRequests;
  } else {
    filteredRequests = baseRequests.filter(request => {
      const searchIn = `${request.domain} ${request.path} ${request.url}`.toLowerCase();

      let matches;
      if (useRegex) {
        try {
          const regex = new RegExp(searchTerm, 'i');
          matches = regex.test(searchIn);
        } catch (e) {
          matches = searchIn.includes(searchTerm.toLowerCase());
        }
      } else {
        matches = searchIn.includes(searchTerm.toLowerCase());
      }

      return invertSearch ? !matches : matches;
    });
  }

  renderRequests();
  updateStats();
}

function renderRequests() {
  if (filteredRequests.length === 0) {
    if (requests.length === 0) {
      requestsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><img style="width: 18px;" src="icons/mailbox.svg"></div>
          <div class="empty-text">No requests captured yet</div>
          <div class="empty-hint">Configure targets in the main popup and start monitoring</div>
        </div>
      `;
    } else {
      requestsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><img style="width: 18px;" src="icons/search.svg"></div>
          <div class="empty-text">No matching requests</div>
          <div class="empty-hint">Try adjusting your search filter</div>
        </div>
      `;
    }
    return;
  }

  requestsContainer.innerHTML = filteredRequests.map(request => {
    const scanId = request.scanId || request.id;
    const favoriteClass = isFavorite(request.url) ? 'active' : '';
    const hasBeenScanned = !!scannedIds[scanId];
    const scanBtnLabel = hasBeenScanned ? escapeHtml(scanId) : 'SCAN';
    const scanBtnClass = `btn btn-scan-request${hasBeenScanned ? ' scanned' : ''}`;
    const scanBtnTitle = hasBeenScanned ? `View scan result: ${scanId}` : 'Scan this file with AI';
    return `
    <div class="request-item" data-url="${encodeURIComponent(request.url)}">
      <div class="request-header">
        <button class="btn btn-favorite-request ${favoriteClass}" data-request-url="${encodeURIComponent(request.url)}" title="Toggle favorite"><img style="width: 9px;" src="icons/star.svg"></button>
        <div class="request-domain">${escapeHtml(request.domain)}</div>
        <div class="request-actions">
          <span class="request-type ${request.type}">${request.type.toUpperCase()}</span>
          <button class="${scanBtnClass}" data-scan-id="${escapeHtml(scanId)}" data-scanned="${hasBeenScanned}" title="${scanBtnTitle}">${scanBtnLabel}</button>
          <button class="btn btn-remove-request" data-scan-id="${escapeHtml(scanId)}" title="Remove"><img style="width: 10px;" src="icons/x.svg"></button>
        </div>
      </div>
      <div class="request-path">${escapeHtml(request.path)}</div>
      <div class="request-meta">
        <span class="request-time">${formatTime(request.timestamp)}</span>
        <span class="request-status status-${request.statusCode >= 400 ? 'error' : 'ok'}">${request.statusCode}</span>
        ${hasBeenScanned ? `<span class="request-scanned-badge">SCANNED</span>` : ''}
      </div>
    </div>
  `;
  }).join('');

  document.querySelectorAll('.request-item').forEach(item => {
    item.addEventListener('click', (event) => {
      if (event.target.closest('.btn-scan-request')) {
        return;
      }
      if (event.target.closest('.btn-favorite-request')) {
        return;
      }
      if (event.target.closest('.btn-remove-request')) {
        return;
      }
      const url = decodeURIComponent(item.dataset.url);
      chrome.tabs.create({ url: url });
    });
  });

  document.querySelectorAll('.btn-favorite-request').forEach(button => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const requestUrl = decodeURIComponent(button.dataset.requestUrl);
      toggleFavorite(requestUrl);
    });
  });

  document.querySelectorAll('.btn-scan-request').forEach(button => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const scanId = button.dataset.scanId;
      const alreadyScanned = button.dataset.scanned === 'true';

      chrome.runtime.sendMessage({
        action: 'getScanRequest',
        scanId: scanId,
      }, (response) => {
        void chrome.runtime.lastError;
        if (response && response.request) {
          const url = response.request.url;
          const base = `settings.html?scanId=${encodeURIComponent(scanId)}`;
          const settingsUrl = chrome.runtime.getURL(base);
          chrome.tabs.create({ url: settingsUrl });
          if (!alreadyScanned) {
            setTimeout(() => {
              chrome.storage.local.set({ 
                redirectScanId: scanId,
                redirectScanUrl: url,
                redirectAutoScan: true
              });
            }, 500);
          }
        }
      });
    });
  });

  document.querySelectorAll('.btn-remove-request').forEach(button => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const scanId = button.dataset.scanId;
      if (confirm('Remove this request?')) {
        removeRequest(scanId);
      }
    });
  });
}

function updateStats() {
  totalCount.textContent = requests.length;
  if (filteredRequests.length !== requests.length) {
    filterCount.style.display = 'inline-block';
    filterCount.textContent = `${filteredRequests.length} / ${requests.length}`;
  } else {
    filterCount.style.display = 'none';
  }
}

function isFavorite(requestUrl) {
  return favoriteUrls.includes(requestUrl);
}

function toggleFavorite(requestUrl) {
  const index = favoriteUrls.indexOf(requestUrl);
  if (index > -1) {
    favoriteUrls.splice(index, 1);
  } else {
    favoriteUrls.push(requestUrl);
  }
  chrome.storage.local.set({ favoriteUrls }, () => {
    applyFilter();
  });
}

function removeRequest(scanId) {
  // Remove request from captured list, but preserve scanResultsById so users can view previous scan results
  requests = requests.filter(request => {
    const id = request.scanId || request.id;
    return id !== scanId;
  });
  chrome.storage.local.set({ requests }, () => {
    applyFilter();
  });
}

function exportData() {
  if (requests.length === 0) {
    alert('No requests to export!');
    return;
  }

  const data = {
    exportDate: new Date().toISOString(),
    totalRequests: requests.length,
    requests: requests
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `request-tracker-export-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportUrlsOnly() {
  if (requests.length === 0) {
    alert('No requests to export!');
    return;
  }

  const urls = requests.map(request => request.url).join('\n');

  const blob = new Blob([urls], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `urls-export-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) {
    return 'just now';
  } else if (diff < 3600000) {
    return `${Math.floor(diff / 60000)}m ago`;
  } else if (diff < 86400000) {
    return `${Math.floor(diff / 3600000)}h ago`;
  } else {
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  }
}

function escapeHtml(unsafeStr) {
  return unsafeStr
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
