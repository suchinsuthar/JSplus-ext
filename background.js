let isMonitoring = false;
let targetPatterns = [];
let requestWriteQueue = Promise.resolve();
const MAX_CONTENT_CHARS = 120000;
const FETCH_TIMEOUT_MS = 15000;
const AI_TIMEOUT_MS = 90000;

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

const PROVIDER_DEFAULT_MODELS = {
  gemini: 'gemini-3-flash-preview',
  openai: 'gpt-4o',
  anthropic: 'claude-3-5-sonnet',
  deepseek: 'deepseek-coder'
};

const GITHUB_REPO = 'suchinsuthar/jsplus-ext';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

chrome.storage.local.get(['isMonitoring', 'targetPatterns', 'requests'], (result) => {
  isMonitoring = result.isMonitoring || false;
  targetPatterns = result.targetPatterns || [];

  const existingRequests = result.requests || [];
  const cleanedRequests = dedupeRequests(existingRequests);
  if (cleanedRequests.length !== existingRequests.length) {
    chrome.storage.local.set({ requests: cleanedRequests });
  }
  
  console.log('[Tracker] Service worker started. Monitoring:', isMonitoring, 'Patterns:', targetPatterns);
  
  if (isMonitoring && targetPatterns.length > 0) {
    startMonitoring();
    console.log('[Tracker] Monitoring resumed after restart');
  }

  checkForUpdates();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startMonitoring') {
    isMonitoring = true;
    targetPatterns = message.patterns;
    chrome.storage.local.set({ isMonitoring: true, targetPatterns: message.patterns });
    startMonitoring();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'stopMonitoring') {
    isMonitoring = false;
    chrome.storage.local.set({ isMonitoring: false });
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'getStatus') {
    sendResponse({ success: true, isMonitoring, targetPatterns });
    return false;
  }

  if (message.action === 'scanRequestWithAI') {
    scanRequestWithAI(message.scanId || message.requestId)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'getStoredScanResult') {
    getStoredScanResult(message.scanId)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'testAiConnection') {
    testAiConnection()
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'listScanIds') {
    listScanIds()
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === 'getUpdateInfo') {
    getStorageData(['updateInfo']).then(({ updateInfo = {} }) => {
      sendResponse({ success: true, updateInfo });
    });
    return true;
  }

  if (message.action === 'checkForUpdates') {
    chrome.storage.local.remove('updateInfo', () => {
      checkForUpdates()
        .then(() => getStorageData(['updateInfo']))
        .then(({ updateInfo = {} }) => sendResponse({ success: true, updateInfo }))
        .catch(() => sendResponse({ success: false }));
    });
    return true;
  }

  if (message.action === 'getScanRequest') {
    const scanId = message.scanId;
    getStorageData(['requests']).then(({ requests = [] }) => {
      const request = requests.find(r => (r.scanId || r.id) === scanId);
      if (request) {
        sendResponse({ success: true, request });
      } else {
        sendResponse({ success: false, error: 'Request not found' });
      }
    });
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'settings-keepalive') {
    return;
  }

  if (port.name !== 'ai-stream') {
    return;
  }

  port.onMessage.addListener(async (message) => {
    const operationId = message.operationId;

    if (message.action === 'testAiConnectionLive') {
      await runLiveOperation(port, operationId, async (emitProgress) => {
        emitProgress('Loading AI settings...');
        const { aiScannerSettings = {} } = await getStorageData(['aiScannerSettings']);
        if (!aiScannerSettings.apiKey) {
          throw new Error('Missing API key. Configure it in settings first.');
        }

        const provider = aiScannerSettings.provider || 'gemini';
        const model = PROVIDER_DEFAULT_MODELS[provider];
        emitProgress(`Testing ${provider} connection with ${model}...`);

        const output = await executeAiPrompt(provider, aiScannerSettings.apiKey, model, 'Reply exactly with: OK');
        return {
          provider,
          output
        };
      });
      return;
    }

    if (message.action === 'scanRequestWithAILive') {
      await runLiveOperation(port, operationId, async (emitProgress) => {
        const scanId = message.scanId;
        if (!scanId) {
          throw new Error('Missing scan ID');
        }

        emitProgress(`Loading request for ${scanId}...`);
        const { requests = [], aiScannerSettings = {}, scanResultsById = {} } = await getStorageData(['requests', 'aiScannerSettings', 'scanResultsById']);
        const matchedRequest = requests.find((entry) => (entry.scanId || entry.id) === scanId);

        if (!matchedRequest) {
          throw new Error('Request not found in captured list');
        }

        if (!aiScannerSettings.apiKey) {
          throw new Error('Missing API key. Configure it in settings first.');
        }

        emitProgress('Fetching source content...');
        const sourceContent = await fetchRequestContent(matchedRequest.url);
        const provider = aiScannerSettings.provider || 'gemini';
        const model = PROVIDER_DEFAULT_MODELS[provider];
        const promptTemplate = aiScannerSettings.promptTemplate || DEFAULT_PROMPT_TEMPLATE;
        const finalPrompt = promptTemplate.replace('{content}', sourceContent);

        emitProgress(`Analyzing with ${provider} (${model})...`);
        const output = await executeAiPrompt(provider, aiScannerSettings.apiKey, model, finalPrompt);

        scanResultsById[scanId] = {
          scanId,
          url: matchedRequest.url,
          output,
          provider,
          updatedAt: new Date().toISOString()
        };

        emitProgress('Saving scan result...');
        await setStorageData({ scanResultsById });

        return {
          output,
          url: matchedRequest.url,
          scanId,
          updatedAt: scanResultsById[scanId].updatedAt
        };
      });
    }
  });
});

async function runLiveOperation(port, operationId, task) {
  const emitProgress = (message) => {
    safePostPort(port, {
      operationId,
      type: 'progress',
      message
    });
  };

  try {
    const result = await task(emitProgress);
    safePostPort(port, {
      operationId,
      type: 'result',
      result
    });
  } catch (error) {
    safePostPort(port, {
      operationId,
      type: 'error',
      error: error.message || 'Unknown error'
    });
  }
}

function safePostPort(port, payload) {
  try {
    port.postMessage(payload);
    return true;
  } catch (error) {
    return false;
  }
}

async function scanRequestWithAI(scanId) {
  if (!scanId) {
    throw new Error('Missing scan ID');
  }

  const { requests = [], aiScannerSettings = {}, scanResultsById = {} } = await getStorageData(['requests', 'aiScannerSettings', 'scanResultsById']);
  const matchedRequest = requests.find((entry) => (entry.scanId || entry.id) === scanId);

  if (!matchedRequest) {
    throw new Error('Request not found in captured list');
  }

  if (!aiScannerSettings.apiKey) {
    throw new Error('Missing API key. Configure it in settings first.');
  }

  const sourceContent = await fetchRequestContent(matchedRequest.url);
  const provider = aiScannerSettings.provider || 'gemini';
  const model = aiScannerSettings.model || PROVIDER_DEFAULT_MODELS[provider];
  const promptTemplate = aiScannerSettings.promptTemplate || DEFAULT_PROMPT_TEMPLATE;
  const finalPrompt = promptTemplate.replace('{content}', sourceContent);
  const output = await executeAiPrompt(provider, aiScannerSettings.apiKey, model, finalPrompt);

  scanResultsById[scanId] = {
    scanId,
    url: matchedRequest.url,
    output,
    provider,
    updatedAt: new Date().toISOString()
  };

  await setStorageData({ scanResultsById });

  return {
    output,
    url: matchedRequest.url,
    scanId,
    updatedAt: scanResultsById[scanId].updatedAt
  };
}

async function getStoredScanResult(scanId) {
  if (!scanId) {
    throw new Error('Missing scan ID');
  }

  const { scanResultsById = {} } = await getStorageData(['scanResultsById']);
  const found = scanResultsById[scanId];

  if (!found) {
    return { found: false };
  }

  return {
    found: true,
    result: found
  };
}

async function listScanIds() {
  const { scanResultsById = {} } = await getStorageData(['scanResultsById']);

  const items = Object.keys(scanResultsById).map((scanId) => ({
    scanId: scanId,
    url: scanResultsById[scanId].url || 'Unknown',
    timestamp: scanResultsById[scanId].updatedAt || ''
  }));

  return { items };
}

async function testAiConnection() {
  const { aiScannerSettings = {} } = await getStorageData(['aiScannerSettings']);
  if (!aiScannerSettings.apiKey) {
    throw new Error('Missing API key. Configure it in settings first.');
  }

  const provider = aiScannerSettings.provider || 'gemini';
  const model = aiScannerSettings.model || PROVIDER_DEFAULT_MODELS[provider];
  const output = await executeAiPrompt(provider, aiScannerSettings.apiKey, model, 'Reply exactly with: OK');

  return {
    provider,
    output
  };
}

async function fetchRequestContent(url) {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store'
  }, FETCH_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(`Could not fetch target content (${response.status})`);
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error('Target content is empty');
  }

  if (text.length > MAX_CONTENT_CHARS) {
    return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n/* Truncated to ${MAX_CONTENT_CHARS} characters */`;
  }

  return text;
}

async function executeAiPrompt(provider, apiKey, model, prompt) {
  if (!PROVIDER_DEFAULT_MODELS[provider]) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  if (provider === 'gemini') {
    return runGemini(apiKey, model, prompt);
  }

  if (provider === 'openai') {
    return runOpenAiCompatible('https://api.openai.com/v1/chat/completions', apiKey, model, prompt);
  }

  if (provider === 'deepseek') {
    return runOpenAiCompatible('https://api.deepseek.com/chat/completions', apiKey, model, prompt);
  }

  if (provider === 'anthropic') {
    return runAnthropic(apiKey, model, prompt);
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

async function runGemini(apiKey, model, prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.1
      }
    })
  }, AI_TIMEOUT_MS);

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || 'Gemini API request failed');
  }

  const output = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('\n');
  if (!output) {
    throw new Error('Gemini returned an empty response');
  }

  return output.trim();
}

async function runOpenAiCompatible(endpoint, apiKey, model, prompt) {
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  }, AI_TIMEOUT_MS);

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || 'AI API request failed');
  }

  const output = payload?.choices?.[0]?.message?.content;
  if (!output) {
    throw new Error('AI provider returned an empty response');
  }

  return output.trim();
}

async function runAnthropic(apiKey, model, prompt) {
  const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0.1,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  }, AI_TIMEOUT_MS);

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || 'Anthropic API request failed');
  }

  const output = (payload?.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

  if (!output) {
    throw new Error('Anthropic returned an empty response');
  }

  return output.trim();
}


async function checkForUpdates() {
  try {
    const { updateInfo = {} } = await getStorageData(['updateInfo']);
    const now = Date.now();

    if (updateInfo.checkedAt && (now - updateInfo.checkedAt) < UPDATE_CHECK_INTERVAL_MS) {
      return;
    }

    const currentVersion = chrome.runtime.getManifest().version;
    const response = await fetchWithTimeout(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { method: 'GET', headers: { Accept: 'application/vnd.github.v3+json' } },
      10000
    );

    if (!response.ok) return;

    const data = await response.json();
    const latestVersion = (data.tag_name || '').replace(/^v/i, '');
    const hasUpdate = isNewerVersion(latestVersion, currentVersion);

    await setStorageData({
      updateInfo: {
        currentVersion,
        latestVersion,
        releaseUrl: data.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
        releaseNotes: (data.body || '').slice(0, 500),
        hasUpdate,
        checkedAt: now
      }
    });
  } catch (_e) {
  }
}

function isNewerVersion(latest, current) {
  const parse = (v) => String(v).split('.').map((p) => parseInt(p, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function getStorageData(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result));
  });
}

function setStorageData(payload) {
  return new Promise((resolve) => {
    chrome.storage.local.set(payload, () => resolve());
  });
}

function startMonitoring() {
  if (chrome.webRequest.onCompleted.hasListener(handleRequest)) {
    chrome.webRequest.onCompleted.removeListener(handleRequest);
  }
  
  chrome.webRequest.onCompleted.addListener(
    handleRequest,
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
}

function handleRequest(details) {
  if (!isMonitoring) return;

  if (!details || !details.url) {
    return;
  }

  let url;
  try {
    url = new URL(details.url);
  } catch (error) {
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }
  
  if (!isJsOrJsonFile(details.url, details.responseHeaders)) {
    return;
  }
  
  if (!matchesPattern(url.hostname)) {
    return;
  }
  
  const normalizedUrl = normalizeRequestUrl(details.url);
  const scanId = createScanId(normalizedUrl);
  const request = {
    url: details.url,
    domain: url.hostname,
    path: url.pathname,
    timestamp: new Date().toISOString(),
    type: getFileType(details.url, details.responseHeaders),
    method: details.method,
    statusCode: details.statusCode,
    id: scanId,
    scanId
  };
  
  enqueueRequestWrite(async () => {
    const { requests = [] } = await getStorageData(['requests']);
    const deduped = dedupeRequests([request, ...requests]);

    if (deduped.length > 1000) {
      deduped.length = 1000;
    }

    await setStorageData({ requests: deduped });
  });
}

function enqueueRequestWrite(task) {
  requestWriteQueue = requestWriteQueue
    .then(() => task())
    .catch((error) => {
      console.error('[Tracker] Request write failed:', error);
    });

  return requestWriteQueue;
}

function normalizeRequestUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (error) {
    return rawUrl;
  }
}

function dedupeRequests(requests) {
  const seenByScanId = new Set();
  const seenByUrl = new Set();
  const output = [];

  for (const item of requests) {
    const normalizedUrl = normalizeRequestUrl(item.url || '');
    const stableId = item.scanId || item.id || createScanId(normalizedUrl);

    if (seenByScanId.has(stableId) || seenByUrl.has(normalizedUrl)) {
      continue;
    }

    seenByScanId.add(stableId);
    seenByUrl.add(normalizedUrl);
    output.push({
      ...item,
      id: stableId,
      scanId: stableId
    });
  }

  return output;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function createScanId(input) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(index);
    hash |= 0;
  }
  return `scan_${Math.abs(hash).toString(36)}`;
}

function isJsOrJsonFile(url, headers) {
  if (url.match(/\.(js|jsx|ts|tsx|json)(\?|$)/i)) {
    return true;
  }
  
  return false;
}

function getFileType(url, headers) {
  if (url.match(/\.json(\?|$)/i)) return 'json';
  if (url.match(/\.tsx(\?|$)/i)) return 'tsx';
  if (url.match(/\.ts(\?|$)/i)) return 'ts';
  if (url.match(/\.jsx(\?|$)/i)) return 'jsx';
  if (url.match(/\.js(\?|$)/i)) return 'js';
  
  return 'unknown';
}

function matchesPattern(hostname) {
  if (targetPatterns.length === 0) return false;
  
  return targetPatterns.some(pattern => {
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*');
    
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(hostname);
  });
}
