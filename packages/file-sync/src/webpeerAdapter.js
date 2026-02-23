function randomId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `peer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createBroadcastFallback({ namespace, room }) {
  const channel = new BroadcastChannel(`browser-sync-${namespace}-${room}`);
  const handlers = new Set();
  const peerId = randomId();

  channel.addEventListener('message', (event) => {
    handlers.forEach((handler) => handler(event.data));
  });

  return {
    type: 'broadcast-fallback',
    peerId,
    async send(data) {
      channel.postMessage(data);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async disconnect() {
      channel.close();
    }
  };
}

async function tryWebPeerClient({ WebPeer, namespace, room, signalingUrl, bootstrapUrl, token, iceServers }) {
  if (!WebPeer) return null;

  const options = {
    namespace,
    room,
    signalingUrl,
    bootstrapUrl,
    token,
    rtcConfig: {
      iceServers
    }
  };

  const handlers = new Set();

  if (typeof WebPeer.connect === 'function') {
    const client = await WebPeer.connect(options);
    const peerId = client.peerId || randomId();

    const emitMessage = (payload) => {
      handlers.forEach((handler) => handler(payload));
    };

    if (typeof client.on === 'function') {
      client.on('message', emitMessage);
      client.on('data', emitMessage);
    }

    return {
      type: 'webpeer',
      peerId,
      async send(data) {
        if (typeof client.broadcast === 'function') return client.broadcast(data);
        if (typeof client.send === 'function') return client.send(data);
        throw new Error('WebPEER client does not expose send/broadcast method.');
      },
      onMessage(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async disconnect() {
        if (typeof client.close === 'function') await client.close();
      }
    };
  }

  return null;
}

export async function createPeerTransport({
  namespace,
  room,
  signalingUrl,
  bootstrapUrl,
  token,
  createPeer,
  webPeerClient,
  iceServers = [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
}) {
  if (typeof createPeer === 'function') {
    return createPeer({
      namespace,
      room,
      signalingUrl,
      bootstrapUrl,
      token,
      iceServers
    });
  }

  const resolvedClient = webPeerClient || globalThis.WebPeer || globalThis.Webpeer || globalThis.webpeer;
  const webPeerTransport = await tryWebPeerClient({
    WebPeer: resolvedClient,
    namespace,
    room,
    signalingUrl,
    bootstrapUrl,
    token,
    iceServers
  });

  if (webPeerTransport) return webPeerTransport;
  return createBroadcastFallback({ namespace, room });
}
