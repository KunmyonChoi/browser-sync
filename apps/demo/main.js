import { FileBrowserPanel } from '../../packages/file-browser/src/index.js';
import { FileSyncPanel } from '../../packages/file-sync/src/index.js';

const DEFAULT_SIGNAL_URL = 'ws://localhost:8787/signal';

const logBox = document.querySelector('[data-demo-log]');
const modeSelect = document.querySelector('[data-demo-sync-mode]');
const signalUrlInput = document.querySelector('[data-demo-signal-url]');
const signalTokenInput = document.querySelector('[data-demo-signal-token]');
const applyModeButton = document.querySelector('[data-demo-apply-mode]');
const modeHint = document.querySelector('[data-demo-mode-hint]');
const syncContainer = document.querySelector('[data-demo-sync]');

function log(message, payload) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  const body = payload ? `${line}\n${JSON.stringify(payload, null, 2)}` : line;

  const div = document.createElement('div');
  div.textContent = body;
  logBox.prepend(div);
}

function createPeerId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `peer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeSignalUrl(url) {
  const next = new URL(url || DEFAULT_SIGNAL_URL, window.location.origin);
  if (next.protocol === 'http:') next.protocol = 'ws:';
  if (next.protocol === 'https:') next.protocol = 'wss:';
  return next;
}

function sanitizeUrlForLog(url) {
  const next = new URL(url.toString());
  next.search = '';
  next.hash = '';
  return next.toString();
}

function httpHealthUrlFromWs(wsUrl) {
  const next = new URL(wsUrl.toString());
  if (next.protocol === 'ws:') next.protocol = 'http:';
  if (next.protocol === 'wss:') next.protocol = 'https:';
  next.pathname = '/health';
  next.search = '';
  next.hash = '';
  return next;
}

async function probeSignalingHealth(wsUrl) {
  const healthUrl = httpHealthUrlFromWs(wsUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1800);

  try {
    const response = await fetch(healthUrl.toString(), {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    return {
      healthUrl: healthUrl.toString(),
      reachable: true,
      status: response.status
    };
  } catch (err) {
    return {
      healthUrl: healthUrl.toString(),
      reachable: false,
      status: null,
      error: err.message
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function closeCodeHint(code) {
  if (code === 1008) return 'Policy/auth rejection (possibly invalid or missing token).';
  if (code === 1006) return 'Abnormal close (server unreachable, handshake rejected, or network blocked).';
  if (code === 1011) return 'Server-side internal error.';
  if (code === 1000) return 'Normal close.';
  if (!code) return 'No close code reported.';
  return `Close code ${code}.`;
}

async function createSignalingTransport({ namespace, room, signalingUrl, token }) {
  const handlers = new Set();
  let peerId = createPeerId();

  const wsUrl = normalizeSignalUrl(signalingUrl || DEFAULT_SIGNAL_URL);
  wsUrl.searchParams.set('namespace', namespace);
  wsUrl.searchParams.set('room', room);
  wsUrl.searchParams.set('peerId', peerId);
  if (token) wsUrl.searchParams.set('token', token);

  const ws = new WebSocket(wsUrl.toString());

  await new Promise((resolve, reject) => {
    let settled = false;
    let opened = false;
    let sawError = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };

    const failWithDiagnostics = async ({ stage, closeEvent = null }) => {
      if (settled) return;
      settled = true;
      cleanup();

      const healthProbe = await probeSignalingHealth(wsUrl);
      const mixedContentBlocked = window.location.protocol === 'https:' && wsUrl.protocol === 'ws:';
      const details = {
        stage,
        signalingUrl: sanitizeUrlForLog(wsUrl),
        closeCode: closeEvent?.code || null,
        closeReason: closeEvent?.reason || null,
        sawError,
        tokenProvided: Boolean(token),
        mixedContentBlocked,
        healthProbe,
        closeCodeHint: closeCodeHint(closeEvent?.code)
      };

      log('signaling connect failed', details);

      let message = `Unable to connect signaling (${details.closeCodeHint})`;
      if (mixedContentBlocked) {
        message += ' HTTPS page cannot use ws://. Use wss://.';
      } else if (!healthProbe.reachable) {
        message += ' Signaling server appears unreachable.';
      } else if (!token) {
        message += ' If server requires auth, provide a token.';
      }

      const err = new Error(message);
      err.details = details;
      reject(err);
    };

    const onOpen = () => {
      if (settled) return;
      settled = true;
      opened = true;
      cleanup();
      resolve();
    };

    const onError = () => {
      sawError = true;
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        void failWithDiagnostics({ stage: 'error' });
      }
    };

    const onClose = (event) => {
      if (opened || settled) return;
      void failWithDiagnostics({ stage: 'close', closeEvent: event });
    };

    const timeoutId = setTimeout(() => {
      void failWithDiagnostics({ stage: 'timeout' });
    }, 8000);

    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose, { once: true });
  });

  ws.addEventListener('message', (event) => {
    let parsed;
    try {
      parsed = JSON.parse(String(event.data));
    } catch (_err) {
      return;
    }

    if (parsed.type === 'welcome' && parsed.peerId) {
      peerId = parsed.peerId;
      return;
    }

    handlers.forEach((handler) => handler(parsed));
  });

  return {
    type: 'signaling-websocket',
    get peerId() {
      return peerId;
    },
    async send(data) {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error('Signaling socket is not open.');
      }

      ws.send(JSON.stringify(data));
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async disconnect() {
      if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        return;
      }

      await new Promise((resolve) => {
        ws.addEventListener('close', resolve, { once: true });
        ws.close();
      });
    }
  };
}

function setModeHint(mode) {
  if (mode === 'signaling') {
    modeHint.textContent = `Current mode: Actual signaling (${signalUrlInput.value.trim() || DEFAULT_SIGNAL_URL})`;
    return;
  }

  modeHint.textContent = 'Current mode: Local fallback (BroadcastChannel)';
}

function toggleSignalInputs(mode) {
  const isSignaling = mode === 'signaling';
  signalUrlInput.disabled = !isSignaling;
  signalTokenInput.disabled = !isSignaling;
}

let syncPanel = null;

async function mirrorBrowserDeleteToSync(detail) {
  if (!syncPanel) return;
  if (detail?.type !== 'delete') return;
  if (detail?.entryKind !== 'file') return;

  try {
    const removedCount = await syncPanel.removeFilesByName(detail.entryName);
    log('sync delete mirrored from browser', {
      entryName: detail.entryName,
      removedCount
    });
  } catch (err) {
    log('sync delete mirror error', {
      entryName: detail.entryName,
      message: err.message
    });
  }
}

const browserPanel = new FileBrowserPanel({
  container: document.querySelector('[data-demo-browser]'),
  title: 'Local File Browser',
  callbacks: {
    onOperation: (detail) => {
      log('browser operation', detail);
      mirrorBrowserDeleteToSync(detail);
    },
    onError: (detail) => log('browser error', detail)
  }
});

function createSyncCallbacks() {
  return {
    onSync: (detail) => log('sync event', detail),
    onStateChange: (detail) => log('sync state', detail),
    onError: (detail) =>
      log('sync error', {
        message: detail?.message || 'unknown error',
        details: detail?.cause?.details || null
      })
  };
}

function mountSyncPanel() {
  const mode = modeSelect.value;
  const signalingUrl = signalUrlInput.value.trim() || DEFAULT_SIGNAL_URL;
  const token = signalTokenInput.value.trim() || null;

  if (syncPanel) {
    syncPanel.destroy();
  }

  const options = {
    container: syncContainer,
    title: 'Room Sync Panel',
    namespace: 'globalroom',
    room: 'public',
    signalingUrl,
    token,
    callbacks: createSyncCallbacks()
  };

  if (mode === 'signaling') {
    options.createPeer = (config) =>
      createSignalingTransport({
        ...config,
        signalingUrl,
        token
      });
  }

  syncPanel = new FileSyncPanel(options);
  toggleSignalInputs(mode);
  setModeHint(mode);
  log('sync mode applied', {
    mode,
    signalingUrl: mode === 'signaling' ? signalingUrl : null
  });
}

applyModeButton.addEventListener('click', () => {
  mountSyncPanel();
});

modeSelect.addEventListener('change', () => {
  toggleSignalInputs(modeSelect.value);
  setModeHint(modeSelect.value);
});

toggleSignalInputs(modeSelect.value);
setModeHint(modeSelect.value);
mountSyncPanel();

window.demo = {
  browserPanel,
  get syncPanel() {
    return syncPanel;
  },
  mountSyncPanel
};
