const DEFAULT_PROMPT_TEMPLATE = `You are an elite bug bounty researcher specializing in JavaScript security analysis. Analyze the JS content below for medium-to-critical severity issues only.

Scan for and report:
- Hardcoded secrets: API keys, tokens, passwords, private keys, JWTs
- Sensitive endpoints: internal APIs, admin routes, debug/test routes
- Extracted URLs: third-party services, S3 buckets, cloud storage
- Auth flaws: insecure token storage (localStorage/sessionStorage), weak auth checks
- DOM XSS / open redirects / prototype pollution / dangerous eval usage
- CORS misconfigs, postMessage without origin check
- Exposed PII patterns: emails, phone numbers, SSNs in hardcoded strings

Output rules:
- If minified JS: deobfuscate/reformat first, then analyze
- Always include exact line number next to each finding
- Group output strictly under these headers (omit empty sections):
  ==[Extracted URLs]==
  ==[APIs/Tokens]==
  ==[Endpoints]==
  ==[Auth Issues]==
  ==[Vulnerabilities]==
  ==[Exposed PII]==
- If nothing found: output exactly -> [Clean]

Content:\n{content}`;

let pendingScanId = null;
let autoScan = false;

const PROVIDER_DEFAULT_MODELS = {
  gemini:    'gemini-3-flash-preview',
  openai:    'gpt-4o',
  anthropic: 'claude-3-5-sonnet',
  deepseek:  'deepseek-coder'
};

let providerSelect;
let modelInput;
let apiKeyInput;
let promptInput;
let saveSettingsBtn;
let testConnectionBtn;
let resetPromptBtn;
let runScanBtn;
let saveResultBtn;
let scanIdSelect;
let loadScanByIdBtn;
let scanOutput;
let scanMeta;
let toggleApiKeyBtn;
let connectionStatus;
let keepAlivePort;

document.addEventListener('DOMContentLoaded', () => {
  providerSelect   = document.getElementById('providerSelect');
  modelInput       = document.getElementById('modelInput');
  apiKeyInput      = document.getElementById('apiKeyInput');

  providerSelect.addEventListener('change', () => {
    const currentModel = modelInput.value.trim();
    const isKnownDefault = Object.values(PROVIDER_DEFAULT_MODELS).includes(currentModel) || !currentModel;
    if (isKnownDefault) {
      modelInput.value = PROVIDER_DEFAULT_MODELS[providerSelect.value] || '';
    }
  });
  promptInput      = document.getElementById('promptInput');
  saveSettingsBtn  = document.getElementById('saveSettingsBtn');
  testConnectionBtn = document.getElementById('testConnectionBtn');
  resetPromptBtn   = document.getElementById('resetPromptBtn');
  runScanBtn       = document.getElementById('runScanBtn');
  saveResultBtn    = document.getElementById('saveResultBtn');
  scanIdSelect     = document.getElementById('scanIdSelect');
  loadScanByIdBtn  = document.getElementById('loadScanByIdBtn');
  scanOutput       = document.getElementById('scanOutput');
  scanMeta         = document.getElementById('scanMeta');
  toggleApiKeyBtn  = document.getElementById('toggleApiKeyBtn');
  connectionStatus = document.getElementById('connectionStatus');

  try {
    keepAlivePort = chrome.runtime.connect({ name: 'settings-keepalive' });
  } catch (_e) {
  }

  init();
});

function init() {
  const params = new URLSearchParams(window.location.search);
  pendingScanId = params.get('scanId');
  autoScan = params.get('autoScan') === '1';

  loadSettings(() => {
    warmupBackground();
    refreshScanIdOptions(() => {
      if (pendingScanId) {
        setSelectedScanId(pendingScanId);
        loadStoredResult(pendingScanId, autoScan);
      }
    });
  });

  saveSettingsBtn.addEventListener('click', () => {
    persistSettings().then(() => {
      setConnectionStatus('Settings saved.', 'ok');
      setConsole('Settings saved. Ready to scan.', 'ok');
    });
  });
  testConnectionBtn.addEventListener('click', testConnection);
  resetPromptBtn.addEventListener('click', resetPromptTemplate);
  runScanBtn.addEventListener('click', runScan);

  if (toggleApiKeyBtn) {
    toggleApiKeyBtn.addEventListener('click', () => {
      const isPassword = apiKeyInput.type === 'password';
      apiKeyInput.type = isPassword ? 'text' : 'password';
      toggleApiKeyBtn.innerHTML = isPassword ? '<img style="width: 18px;" src="icons/eye-off.svg">' : '<img style="width: 18px;" src="icons/eye.svg">';
    });
  }
  if (saveResultBtn) {
    saveResultBtn.addEventListener('click', saveResult);
  }

  loadUpdateSection();
  document.getElementById('checkUpdateBtn').addEventListener('click', forceCheckUpdate);

  loadScanByIdBtn.addEventListener('click', () => {
    const scanId = scanIdSelect.value.trim();
    if (!scanId) {
      setConsole('Select a scan ID first.', 'warn');
      return;
    }
    pendingScanId = scanId;
    loadStoredResult(scanId, false);
  });
}

const LEGACY_PROMPT_SIGNATURES = [
  'You are a strict client-side security triager',
  'As a top bug bounty researcher'
];

function isLegacyPrompt(text) {
  return !text || LEGACY_PROMPT_SIGNATURES.some((sig) => text.startsWith(sig));
}

function loadSettings(callback) {
  chrome.storage.local.get(['aiScannerSettings'], (result) => {
    const settings = result.aiScannerSettings || {};
    const savedProvider = settings.provider || 'gemini';
    providerSelect.value = savedProvider;
    modelInput.value = settings.model || PROVIDER_DEFAULT_MODELS[savedProvider] || '';
    apiKeyInput.value = settings.apiKey || '';

    const storedPrompt = settings.promptTemplate || '';
    const useDefault = isLegacyPrompt(storedPrompt);
    promptInput.value = useDefault ? DEFAULT_PROMPT_TEMPLATE : storedPrompt;

    if (useDefault) {
      chrome.storage.local.set({
        aiScannerSettings: { ...settings, promptTemplate: DEFAULT_PROMPT_TEMPLATE }
      });
    }

    callback();
  });
}

function persistSettings() {
  const payload = {
    provider: providerSelect.value,
    model: modelInput.value.trim() || PROVIDER_DEFAULT_MODELS[providerSelect.value] || '',
    apiKey: apiKeyInput.value.trim(),
    promptTemplate: promptInput.value.trim() || DEFAULT_PROMPT_TEMPLATE
  };

  return new Promise((resolve) => {
    chrome.storage.local.set({ aiScannerSettings: payload }, () => {
      resolve();
    });
  });
}

function resetPromptTemplate() {
  promptInput.value = DEFAULT_PROMPT_TEMPLATE;
  setConsole('Prompt reset to default bug bounty triage prompt.', 'ok');
}

async function runScan() {
  const selectedScanId = scanIdSelect.value.trim() || pendingScanId;
  if (!selectedScanId) {
    setConsole('No request selected. Open this page from a Scan button in the popup.', 'warn');
    return;
  }

  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setConsole('ERROR: API key is empty. Configure it in SCANNER_SETTINGS first.', 'error');
    return;
  }

  pendingScanId = selectedScanId;
  setSelectedScanId(selectedScanId);

  await persistSettings();

  runScanBtn.disabled = true;
  runScanBtn.querySelector('.btn-text').textContent = 'SCANNING...';

  scanMeta.textContent = `Scanning: ${selectedScanId}`;
  setConsole('Fetching target file and sending to AI...\nThis may take 10-30 seconds.', 'running');

  try {
    const response = await sendMessageAsync({ action: 'scanRequestWithAI', scanId: selectedScanId }, 160000);
    if (!response || !response.success) {
      setConsole(`Scan failed: ${response?.error || 'No response from background'}`, 'error');
      return;
    }
    scanMeta.textContent = `Scan complete | ID: ${selectedScanId} | URL: ${response.url}`;
    setConsole(response.output || '[Not Vulnerable]', 'ok');
    refreshScanIdOptions();
  } catch (error) {
    setConsole(`Scan failed: ${error.message}`, 'error');
  } finally {
    runScanBtn.disabled = false;
    runScanBtn.querySelector('.btn-text').textContent = 'RUN_SCAN';
  }
}

async function testConnection() {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setConnectionStatus('API key is empty — paste your key above.', 'error');
    setConsole('ERROR: API key is empty.\nPaste your provider API key in the API_KEY field above.', 'error');
    return;
  }

  await persistSettings();
  setConnectionStatus('Testing connection...', 'running');
  setConsole(`Testing ${providerSelect.value} connection...\nSending test prompt to AI, please wait.`, 'running');

  try {
    const response = await sendMessageAsync({ action: 'testAiConnection' }, 40000);
    if (!response || !response.success) {
      setConnectionStatus(`Failed: ${response?.error || 'no response'}`, 'error');
      setConsole(`Connection FAILED\n\nReason: ${response?.error || 'No response received from background'}`, 'error');
      return;
    }
    setConnectionStatus(`Connected — ${response.provider}`, 'ok');
    setConsole(`Connection OK — Provider: ${response.provider}\n\nAI replied: ${response.output}`, 'ok');
  } catch (error) {
    setConnectionStatus(`Failed: ${error.message.split('\n')[0]}`, 'error');
    setConsole(`Connection FAILED\n\nReason: ${error.message}`, 'error');
  }
}

function loadStoredResult(scanId, runIfMissing) {
  scanMeta.textContent = `Loading stored result for ID: ${scanId}`;
  setConsole('Looking up stored scan result...', 'running');

  chrome.runtime.sendMessage({
    action: 'getStoredScanResult',
    scanId
  }, (response) => {
    if (chrome.runtime.lastError) {
      setConsole(`Runtime error: ${chrome.runtime.lastError.message}`, 'error');
      return;
    }

    if (!response || !response.success) {
      const message = response && response.error ? response.error : 'Lookup failed';
      setConsole(`Lookup failed: ${message}`, 'error');
      return;
    }

    if (response.found && response.result) {
      const result = response.result;
      scanMeta.textContent = `Loaded stored result | ID: ${result.scanId} | URL: ${result.url} | Updated: ${formatTimestamp(result.updatedAt)}`;
      setConsole(result.output || '[Not Vulnerable]', 'ok');
      return;
    }

    if (runIfMissing) {
      runScan();
      return;
    }

    scanMeta.textContent = `No stored result found for ID: ${scanId}`;
    setConsole('No cached result found for this ID. Click RUN_SCAN to generate one.', 'warn');
  });
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function setConnectionStatus(message, level) {
  if (!connectionStatus) return;
  connectionStatus.textContent = message;
  connectionStatus.className = 'connection-status';
  if (level) connectionStatus.classList.add(`cs-${level}`);
}

function setConsole(message, level) {
  scanOutput.textContent = message;
  scanOutput.classList.remove('state-ok', 'state-warn', 'state-error', 'state-running');

  if (level === 'ok') {
    scanOutput.classList.add('state-ok');
  } else if (level === 'warn') {
    scanOutput.classList.add('state-warn');
  } else if (level === 'error') {
    scanOutput.classList.add('state-error');
  } else if (level === 'running') {
    scanOutput.classList.add('state-running');
  }

  if (saveResultBtn) {
    const hasContent = message &&
      message !== 'Awaiting scan request...' &&
      message !== 'Looking up stored scan result...' &&
      !message.startsWith('Fetching target file') &&
      level !== 'running';
    saveResultBtn.disabled = !hasContent;
  }
}

function saveResult() {
  const content = scanOutput.textContent.trim();
  if (!content || content === 'Awaiting scan request...') {
    return;
  }

  const metaText = scanMeta.textContent || 'scan-result';
  const idMatch   = metaText.match(/ID:\s*(\S+)/);
  const urlMatch  = metaText.match(/URL:\s*(\S+)/);
  const filenamePart = idMatch  ? idMatch[1]  : `scan-${Date.now()}`;
  const scannedUrl   = urlMatch ? urlMatch[1] : 'unknown';
  const filename = `scan-result-${filenamePart}.md`;

  const fullContent = [
    `# Scan Report`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Scan ID** | \`${filenamePart}\` |`,
    `| **URL** | ${scannedUrl} |`,
    `| **Saved** | ${new Date().toLocaleString()} |`,
    ``,
    `---`,
    ``,
    `## Findings`,
    ``,
    content
  ].join('\n');

  const blob = new Blob([fullContent], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function appendConsole(message, level) {
  const current = scanOutput.textContent.trim();
  if (!current || current === 'Awaiting scan request...') {
    setConsole(message, level);
    return;
  }

  scanOutput.textContent = `${current}\n${message}`;
  scanOutput.classList.remove('state-ok', 'state-warn', 'state-error', 'state-running');
  if (level === 'running') {
    scanOutput.classList.add('state-running');
  }
}

function refreshScanIdOptions(callback) {
  chrome.runtime.sendMessage({ action: 'listScanIds' }, (response) => {
    if (chrome.runtime.lastError) {
      if (typeof callback === 'function') callback();
      return;
    }
    const previousValue = (scanIdSelect && scanIdSelect.value) || pendingScanId || '';
    const items = response && response.success && Array.isArray(response.items) ? response.items : [];

    scanIdSelect.innerHTML = '<option value="">Select scan ID...</option>';
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.scanId;
      option.textContent = `${item.scanId} | ${item.url}`;
      scanIdSelect.appendChild(option);
    }

    if (previousValue) {
      setSelectedScanId(previousValue);
    }

    if (typeof callback === 'function') {
      callback();
    }
  });
}

function setSelectedScanId(scanId) {
  let option = Array.from(scanIdSelect.options).find((candidate) => candidate.value === scanId);
  if (!option) {
    option = document.createElement('option');
    option.value = scanId;
    option.textContent = `${scanId} | (current)`;
    scanIdSelect.appendChild(option);
  }
  scanIdSelect.value = scanId;
}

function warmupBackground() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, () => {
    void chrome.runtime.lastError;
  });
}

function loadUpdateSection() {
  chrome.runtime.sendMessage({ action: 'getUpdateInfo' }, (response) => {
    void chrome.runtime.lastError;
    const info = response && response.updateInfo;
    renderUpdateInfo(info, false);
  });
}

function forceCheckUpdate() {
  const checkBtn = document.getElementById('checkUpdateBtn');
  const statusEl = document.getElementById('updateCheckStatus');
  checkBtn.disabled = true;
  checkBtn.querySelector('.btn-text').textContent = 'CHECKING...';
  statusEl.textContent = '';
  statusEl.className = 'connection-status';

  chrome.runtime.sendMessage({ action: 'checkForUpdates' }, (response) => {
    void chrome.runtime.lastError;
    checkBtn.disabled = false;
    checkBtn.querySelector('.btn-text').textContent = 'CHECK_FOR_UPDATES';
    const info = response && response.updateInfo;
    renderUpdateInfo(info, true);
  });
}

function renderUpdateInfo(info, showStatus) {
  const currentEl   = document.getElementById('currentVersionDisplay');
  const latestEl    = document.getElementById('latestVersionDisplay');
  const statusBlock = document.getElementById('updateStatusBlock');
  const downloadBtn = document.getElementById('downloadUpdateBtn');
  const statusEl    = document.getElementById('updateCheckStatus');

  if (!info || !info.currentVersion) {
    if (currentEl) currentEl.textContent = chrome.runtime.getManifest().version;
    if (latestEl)  latestEl.textContent  = '—';
    if (statusBlock) statusBlock.innerHTML = '';
    if (showStatus && statusEl) {
      statusEl.textContent = 'Could not reach GitHub. Check internet connection.';
      statusEl.className = 'connection-status cs-error';
    }
    return;
  }

  if (currentEl) currentEl.textContent = `v${info.currentVersion}`;
  if (latestEl)  latestEl.textContent  = `v${info.latestVersion}`;

  if (info.hasUpdate) {
    if (statusBlock) statusBlock.innerHTML =
      `<span class="update-badge update-badge-new">\u2b06 UPDATE AVAILABLE</span>`;
    if (downloadBtn) {
      downloadBtn.href = info.releaseUrl;
      downloadBtn.style.display = 'flex';
    }
    if (showStatus && statusEl) {
      statusEl.textContent = `v${info.latestVersion} is available on GitHub.`;
      statusEl.className = 'connection-status cs-ok';
    }
  } else {
    if (statusBlock) statusBlock.innerHTML =
      `<span class="update-badge update-badge-ok">\u2713 UP TO DATE</span>`;
    if (downloadBtn) downloadBtn.style.display = 'none';
    if (showStatus && statusEl) {
      statusEl.textContent = `You are on the latest version (v${info.currentVersion}).`;
      statusEl.className = 'connection-status cs-ok';
    }
  }
}

function sendMessageAsync(message, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `Operation timed out after ${Math.round(timeoutMs / 1000)}s.\n` +
        'The AI API may be slow or unreachable. Check your internet connection and try again.'
      ));
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
