import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { RendezvousRegistry } from './rendezvous.js';

const PORT = Number(process.env.PORT || 8787);
const SHARED_TOKEN_HASH = process.env.SIGNAL_TOKEN_SHA256 || '';
const MAX_MESSAGES_PER_MINUTE = Number(process.env.RATE_LIMIT_MESSAGES_PER_MINUTE || 300);
const MAX_CONNECTIONS_PER_IP = Number(process.env.RATE_LIMIT_CONNECTIONS_PER_IP || 12);

const rooms = new Map();
const peers = new Map();
const rendezvous = new RendezvousRegistry();

const metrics = {
  wsConnectionsTotal: 0,
  wsActiveConnections: 0,
  wsMessagesTotal: 0,
  wsAuthFailuresTotal: 0,
  wsRateLimitedTotal: 0,
  relayUsageTotal: 0,
  iceState: new Map(),
  failureReason: new Map(),
  byRegionCarrier: new Map()
};

const rateLimitByIp = new Map();
const connectionsByIp = new Map();

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function nowIso() {
  return new Date().toISOString();
}

function log(level, message, fields = {}) {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ts: nowIso(),
      level,
      message,
      ...fields
    })
  );
}

function metricMapInc(map, key, value = 1) {
  map.set(key, (map.get(key) || 0) + value);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function validateToken(rawToken) {
  if (!SHARED_TOKEN_HASH) return true;
  if (!rawToken) return false;

  const hashed = hashToken(rawToken);
  const a = Buffer.from(hashed, 'utf8');
  const b = Buffer.from(SHARED_TOKEN_HASH, 'utf8');

  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseAuthToken(request) {
  const auth = request.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  return url.searchParams.get('token') || '';
}

function ipOf(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }

  return request.socket.remoteAddress || 'unknown';
}

function allowMessage(ip) {
  const now = Date.now();
  let bucket = rateLimitByIp.get(ip);
  if (!bucket || now >= bucket.windowStart + 60_000) {
    bucket = { windowStart: now, count: 0 };
    rateLimitByIp.set(ip, bucket);
  }

  if (bucket.count >= MAX_MESSAGES_PER_MINUTE) {
    metrics.wsRateLimitedTotal += 1;
    return false;
  }

  bucket.count += 1;
  return true;
}

function allowConnection(ip) {
  const next = (connectionsByIp.get(ip) || 0) + 1;
  if (next > MAX_CONNECTIONS_PER_IP) {
    metrics.wsRateLimitedTotal += 1;
    return false;
  }

  connectionsByIp.set(ip, next);
  return true;
}

function decrementConnection(ip) {
  const value = (connectionsByIp.get(ip) || 1) - 1;
  if (value <= 0) {
    connectionsByIp.delete(ip);
    return;
  }

  connectionsByIp.set(ip, value);
}

function roomKey(namespace, room) {
  return `${namespace}::${room}`;
}

function ensureRoom(namespace, room) {
  const key = roomKey(namespace, room);
  if (!rooms.has(key)) {
    rooms.set(key, new Set());
  }

  return rooms.get(key);
}

function relayToRoom({ namespace, room, senderId, payload }) {
  const members = rooms.get(roomKey(namespace, room));
  if (!members) return;

  for (const ws of members.values()) {
    if (ws.readyState !== ws.OPEN || ws.peerId === senderId) continue;
    ws.send(JSON.stringify(payload));
  }
}

function formatPromMetric(name, value, labels = null) {
  if (!labels) return `${name} ${value}`;
  const labelString = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replaceAll('"', '\\"')}"`)
    .join(',');

  return `${name}{${labelString}} ${value}`;
}

function renderMetrics() {
  const lines = [
    '# HELP bs_ws_connections_total Total websocket connections since start',
    '# TYPE bs_ws_connections_total counter',
    formatPromMetric('bs_ws_connections_total', metrics.wsConnectionsTotal),
    '# HELP bs_ws_active_connections Current active websocket connections',
    '# TYPE bs_ws_active_connections gauge',
    formatPromMetric('bs_ws_active_connections', metrics.wsActiveConnections),
    '# HELP bs_ws_messages_total Total websocket messages processed',
    '# TYPE bs_ws_messages_total counter',
    formatPromMetric('bs_ws_messages_total', metrics.wsMessagesTotal),
    '# HELP bs_ws_auth_failures_total Rejected websocket auth attempts',
    '# TYPE bs_ws_auth_failures_total counter',
    formatPromMetric('bs_ws_auth_failures_total', metrics.wsAuthFailuresTotal),
    '# HELP bs_ws_rate_limited_total Rejected messages/connections by rate limiting',
    '# TYPE bs_ws_rate_limited_total counter',
    formatPromMetric('bs_ws_rate_limited_total', metrics.wsRateLimitedTotal),
    '# HELP bs_relay_usage_total Total sessions that reported TURN relay usage',
    '# TYPE bs_relay_usage_total counter',
    formatPromMetric('bs_relay_usage_total', metrics.relayUsageTotal)
  ];

  for (const [iceState, value] of metrics.iceState.entries()) {
    lines.push(formatPromMetric('bs_ice_state_total', value, { ice_state: iceState }));
  }

  for (const [reason, value] of metrics.failureReason.entries()) {
    lines.push(formatPromMetric('bs_failure_reason_total', value, { reason }));
  }

  for (const [key, value] of metrics.byRegionCarrier.entries()) {
    const [region, carrier] = key.split('::');
    lines.push(formatPromMetric('bs_region_carrier_total', value, { region, carrier }));
  }

  return `${lines.join('\n')}\n`;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, now: nowIso() }));
    return;
  }

  if (url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(renderMetrics());
    return;
  }

  if (url.pathname === '/bootstrap' && req.method === 'GET') {
    const namespace = url.searchParams.get('namespace') || 'global';
    const room = url.searchParams.get('room') || 'public';
    const key = roomKey(namespace, room);

    const peersInRoom = (rooms.get(key) || new Set()).size;

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        namespace,
        room,
        peers: peersInRoom,
        signalingUrl: process.env.PUBLIC_SIGNALING_URL || 'wss://example.com/signal'
      })
    );
    return;
  }

  if (url.pathname === '/rendezvous/register' && req.method === 'POST') {
    const token = parseAuthToken(req);
    if (!validateToken(token)) {
      metrics.wsAuthFailuresTotal += 1;
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const record = rendezvous.register({
        namespace: body.namespace || 'global',
        room: body.room || 'public',
        peerId: body.peerId,
        addresses: body.addresses || [],
        ttlMs: Number(body.ttlMs || 60_000),
        metadata: body.metadata || {}
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(record));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }

    return;
  }

  if (url.pathname === '/rendezvous/discover' && req.method === 'GET') {
    const namespace = url.searchParams.get('namespace') || 'global';
    const room = url.searchParams.get('room') || 'public';
    const limit = Number(url.searchParams.get('limit') || 32);

    const records = rendezvous.discover({ namespace, room, limit });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ namespace, room, peers: records }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, request, context) => {
  const { namespace, room, clientIp, peerId } = context;

  ws.peerId = peerId;
  ws.namespace = namespace;
  ws.room = room;

  ensureRoom(namespace, room).add(ws);
  peers.set(peerId, ws);

  metrics.wsConnectionsTotal += 1;
  metrics.wsActiveConnections += 1;

  rendezvous.register({
    namespace,
    room,
    peerId,
    addresses: [clientIp],
    ttlMs: 60_000,
    metadata: {
      transport: 'websocket'
    }
  });

  log('info', 'peer.connected', {
    peerId,
    namespace,
    room,
    clientIp
  });

  ws.send(
    JSON.stringify({
      type: 'welcome',
      peerId,
      namespace,
      room,
      now: nowIso()
    })
  );

  ws.on('message', (raw) => {
    if (!allowMessage(clientIp)) {
      ws.send(JSON.stringify({ type: 'error', code: 'rate_limited' }));
      return;
    }

    metrics.wsMessagesTotal += 1;

    let message;
    try {
      message = JSON.parse(String(raw));
    } catch (_err) {
      ws.send(JSON.stringify({ type: 'error', code: 'invalid_json' }));
      return;
    }

    if (message.type === 'heartbeat') {
      ws.send(JSON.stringify({ type: 'heartbeat-ack', now: nowIso() }));
      return;
    }

    if (message.type === 'telemetry') {
      const iceState = message.iceState || 'unknown';
      metricMapInc(metrics.iceState, iceState, 1);

      if (message.failureReason) {
        metricMapInc(metrics.failureReason, message.failureReason, 1);
      }

      if (message.relayUsed) {
        metrics.relayUsageTotal += 1;
      }

      if (message.region || message.carrier) {
        metricMapInc(metrics.byRegionCarrier, `${message.region || 'unknown'}::${message.carrier || 'unknown'}`, 1);
      }

      return;
    }

    const relayPayload = {
      ...message,
      sourcePeerId: peerId,
      namespace,
      room,
      receivedAt: nowIso()
    };

    relayToRoom({
      namespace,
      room,
      senderId: peerId,
      payload: relayPayload
    });
  });

  ws.on('close', () => {
    const members = rooms.get(roomKey(namespace, room));
    if (members) {
      members.delete(ws);
      if (members.size === 0) {
        rooms.delete(roomKey(namespace, room));
      }
    }

    peers.delete(peerId);
    rendezvous.removePeer({ namespace, room, peerId });

    decrementConnection(clientIp);
    metrics.wsActiveConnections = Math.max(0, metrics.wsActiveConnections - 1);

    log('info', 'peer.disconnected', {
      peerId,
      namespace,
      room,
      clientIp
    });
  });
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname !== '/signal') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const clientIp = ipOf(request);
  if (!allowConnection(clientIp)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    log('warn', 'peer.connection_rate_limited', { clientIp });
    socket.destroy();
    return;
  }

  const token = parseAuthToken(request);
  if (!validateToken(token)) {
    metrics.wsAuthFailuresTotal += 1;
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    log('warn', 'peer.auth_failed', { clientIp });
    socket.destroy();
    return;
  }

  const namespace = url.searchParams.get('namespace') || 'global';
  const room = url.searchParams.get('room') || 'public';
  const peerId = url.searchParams.get('peerId') || `peer-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, {
      namespace,
      room,
      clientIp,
      peerId
    });
  });
});

setInterval(() => {
  rendezvous.pruneExpired();
}, 30_000).unref();

server.listen(PORT, () => {
  log('info', 'bootstrap-signaling.started', {
    port: PORT,
    signalingPath: '/signal',
    bootstrapPath: '/bootstrap',
    rendezvousDiscoverPath: '/rendezvous/discover'
  });
});
