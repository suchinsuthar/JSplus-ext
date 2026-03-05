let isMonitoring = false;
let targetPatterns = [];
let requests = [];
let filteredRequests = [];
let lastRequestsHash = '';
let searchTerm = '';
let useRegex = false;
let invertSearch = false;
let favoriteUrls = [];
let showFavoritesOnly = false;
let scannedIds = {};

const patternInput = document.getElementById('patternInput');
const addPatternBtn = document.getElementById('addPatternBtn');
const patternsList = document.getElementById('patternsList');
const toggleMonitorBtn = document.getElementById('toggleMonitorBtn');
const clearBtn = document.getElementById('clearBtn');
const exportBtn = document.getElementById('exportBtn');
const exportUrlsBtn = document.getElementById('exportUrlsBtn');
const fullPageBtn = document.getElementById('fullPageBtn');
const statusBadge = document.getElementById('statusBadge');
const requestsContainer = document.getElementById('requestsContainer');
const capturedCount = document.getElementById('capturedCount');
const searchInput = document.getElementById('searchInput');
const regexToggle = document.getElementById('regexToggle');
const invertToggle = document.getElementById('invertToggle');
const favoritesToggle = document.getElementById('favoritesToggle');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const filterCount = document.getElementById('filterCount');
const openSettingsBtn = document.getElementById('openSettingsBtn');

document.addEventListener('DOMContentLoaded', () => {
  loadData();
  setupEventListeners();
  checkAndShowUpdate();

  setInterval(() => {
    if (isMonitoring) {
      loadRequests();
    }
  }, 2000);
});

function checkAndShowUpdate() {
  chrome.runtime.sendMessage({ action: 'getUpdateInfo' }, (response) => {
    if (chrome.runtime.lastError) return;
    const info = response && response.updateInfo;
    if (!info || !info.hasUpdate) return;

    chrome.storage.local.get(['updateDismissed'], ({ updateDismissed }) => {
      if (updateDismissed === info.latestVersion) return;

      const banner      = document.getElementById('updateBanner');
      const versionSpan = document.getElementById('updateVersion');
      const link        = document.getElementById('updateLink');
      const dismissBtn  = document.getElementById('dismissUpdateBtn');
      if (!banner) return;

      versionSpan.textContent = `v${info.latestVersion}`;
      link.href = info.releaseUrl;
      banner.style.display = 'flex';

      dismissBtn.addEventListener('click', () => {
        chrome.storage.local.set({ updateDismissed: info.latestVersion });
        banner.style.display = 'none';
      });
    });
  });
}

function setupEventListeners() {
  addPatternBtn.addEventListener('click', addPattern);
  patternInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addPattern();
    }
  });
  
  toggleMonitorBtn.addEventListener('click', toggleMonitoring);
const clearBtn = document.getElementById('clearBtn');
let confirmState = false;

clearBtn.addEventListener('click', () => {

  if (!confirmState) {
    confirmState = true;

    clearBtn.querySelector(".btn-text").textContent = "CONFIRM";

    clearBtn.style.backgroundColor = "#dc3545";

    setTimeout(() => {
      confirmState = false;
      clearBtn.querySelector(".btn-text").textContent = "CLEAR";
      clearBtn.style.backgroundColor = "";
    }, 4000);

    return;
  }

  clearAllData();

});
  exportBtn.addEventListener('click', exportData);
  exportUrlsBtn.addEventListener('click', exportUrlsOnly);
  fullPageBtn.addEventListener('click', openCapturedRequestsPage);
  openSettingsBtn.addEventListener('click', openSettings);
  
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
    searchInput.value = '';
    searchTerm = '';
    applyFilter();
  });
}

function loadData() {
  chrome.storage.local.get(['targetPatterns', 'isMonitoring', 'requests', 'favoriteUrls', 'scanResultsById'], (result) => {
    targetPatterns = result.targetPatterns || [];
    isMonitoring = result.isMonitoring || false;
    const rawRequests = result.requests || [];
    requests = dedupePopupRequests(rawRequests);
    favoriteUrls = result.favoriteUrls || [];
    scannedIds = result.scanResultsById || {};

    if (requests.length !== rawRequests.length) {
      chrome.storage.local.set({ requests });
    }
    lastRequestsHash = JSON.stringify(requests.map(r => `${r.id}:${r.timestamp}:${r.statusCode}`));
    
    renderPatterns();
    updateStatus();
    applyFilter();
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

function addPattern() {
  const pattern = patternInput.value.trim();
  
  if (!pattern) {
    return;
  }
  
  if (targetPatterns.includes(pattern)) {
    alert('Pattern already exists!');
    return;
  }
  
  targetPatterns.push(pattern);
  chrome.storage.local.set({ targetPatterns });
  
  patternInput.value = '';
  renderPatterns();
  
  if (isMonitoring) {
    chrome.runtime.sendMessage({
      action: 'startMonitoring',
      patterns: targetPatterns
    });
  }
}

function removePattern(pattern) {
  targetPatterns = targetPatterns.filter(p => p !== pattern);
  chrome.storage.local.set({ targetPatterns });
  renderPatterns();
  
  if (isMonitoring) {
    if (targetPatterns.length === 0) {
      stopMonitoring();
    } else {
      chrome.runtime.sendMessage({
        action: 'startMonitoring',
        patterns: targetPatterns
      });
    }
  }
}

function renderPatterns() {
  if (targetPatterns.length === 0) {
    patternsList.innerHTML = '';
    return;
  }
  
  patternsList.innerHTML = targetPatterns.map(pattern => `
    <div class="pattern-item">
      <span class="pattern-text">${escapeHtml(pattern)}</span>
      <button class="pattern-remove" data-pattern="${escapeHtml(pattern)}">×</button>
    </div>
  `).join('');
  
  document.querySelectorAll('.pattern-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      removePattern(e.target.dataset.pattern);
    });
  });
}

function toggleMonitoring() {
  if (isMonitoring) {
    stopMonitoring();
  } else {
    startMonitoring();
  }
}

function startMonitoring() {
  if (targetPatterns.length === 0) {
    alert('Please add at least one target pattern!');
    return;
  }
  
  chrome.runtime.sendMessage({
    action: 'startMonitoring',
    patterns: targetPatterns
  }, (response) => {
    if (response && response.success) {
      isMonitoring = true;
      updateStatus();
    }
  });
}

function stopMonitoring() {
  chrome.runtime.sendMessage({
    action: 'stopMonitoring'
  }, (response) => {
    if (response && response.success) {
      isMonitoring = false;
      updateStatus();
    }
  });
}

function updateStatus() {
  const statusText = statusBadge.querySelector('.status-text');
  const btnIcon = toggleMonitorBtn.querySelector('.btn-icon');
  const btnText = toggleMonitorBtn.querySelector('.btn-text');
  
  if (isMonitoring) {
    statusBadge.classList.add('active');
    statusText.textContent = 'ONLINE';
    toggleMonitorBtn.classList.add('active');
    btnIcon.innerHTML = '<img style="width: 15px;" src="icons/pause-b.svg">';
    btnText.textContent = 'STOP_MONITORING';
  } else {
    statusBadge.classList.remove('active');
    statusText.textContent = 'OFFLINE';
    toggleMonitorBtn.classList.remove('active');
    btnIcon.innerHTML = '<img style="width: 15px;" src="icons/play-b.svg">';
    btnText.textContent = 'START_MONITORING';
  }
  
  capturedCount.textContent = requests.length;
}

function renderRequests() {
  if (filteredRequests.length === 0) {
    if (requests.length === 0) {
      requestsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><img style="width: 18px;" src="icons/mailbox.svg"></div>
          <div class="empty-text">No requests captured yet</div>
          <div class="empty-hint">Configure targets and start monitoring</div>
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
          <button class="btn btn-remove-request" data-scan-id="${escapeHtml(scanId)}" title="Remove"><img style="width: 9px;" src="icons/x.svg"></button>
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

      openSettingsForScan(scanId, alreadyScanned);
    });
  });

  document.querySelectorAll('.btn-remove-request').forEach(button => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const scanId = button.dataset.scanId;
      removeRequest(scanId);
    });
  });
}

function updateStats() {
  capturedCount.textContent = requests.length;
  
  if (searchTerm || showFavoritesOnly) {
    filterCount.textContent = `${filteredRequests.length} / ${requests.length}`;
    filterCount.style.display = 'inline';
  } else {
    filterCount.style.display = 'none';
  }
}

function clearAllData() {
  if (!confirm('Clear all captured requests?\n(Scan results will be preserved)')) {
    return;
  }
  
  requests = [];
  filteredRequests = [];
  lastRequestsHash = '';
  searchInput.value = '';
  searchTerm = '';
  
  chrome.storage.local.set({ requests: [] }, () => {
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
    targetPatterns: targetPatterns,
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

function openSettings() {
  const settingsUrl = chrome.runtime.getURL('settings.html');
  chrome.tabs.create({ url: settingsUrl });
}

function openCapturedRequestsPage() {
  const pageUrl = chrome.runtime.getURL('captured-requests.html');
  chrome.tabs.create({ url: pageUrl });
}

function openSettingsForScan(requestId, alreadyScanned = false) {
  const base = `settings.html?scanId=${encodeURIComponent(requestId)}`;
  const settingsUrl = chrome.runtime.getURL(alreadyScanned ? base : `${base}&autoScan=1`);
  chrome.tabs.create({ url: settingsUrl });
}

function toggleFavorite(requestUrl) {
  if (isFavorite(requestUrl)) {
    favoriteUrls = favoriteUrls.filter((url) => url !== requestUrl);
  } else {
    favoriteUrls.push(requestUrl);
  }

  chrome.storage.local.set({ favoriteUrls }, () => {
    applyFilter();
  });
}

function isFavorite(requestUrl) {
  return favoriteUrls.includes(requestUrl);
}

function dedupePopupRequests(inputRequests) {
  const seenIds = new Set();
  const seenUrls = new Set();
  const output = [];

  for (const request of inputRequests) {
    const normalizedUrl = normalizeUrlForPopup(request.url || '');
    const stableId = request.scanId || request.id || normalizedUrl;

    if (seenIds.has(stableId) || seenUrls.has(normalizedUrl)) {
      continue;
    }

    seenIds.add(stableId);
    seenUrls.add(normalizedUrl);
    output.push({
      ...request,
      id: stableId,
      scanId: stableId
    });
  }

  return output;
}

function normalizeUrlForPopup(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (error) {
    return rawUrl;
  }
}

function removeRequest(scanId) {
  requests = requests.filter((request) => (request.scanId || request.id) !== scanId);
  lastRequestsHash = JSON.stringify(requests.map(r => `${r.id}:${r.timestamp}:${r.statusCode}`));

  chrome.storage.local.set({ requests }, () => {
    applyFilter();
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sendMessageAsync(message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
