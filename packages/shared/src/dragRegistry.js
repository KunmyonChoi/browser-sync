const dragStore = new Map();

function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `drag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function registerDragPayload(payload, ttlMs = 5 * 60 * 1000) {
  const id = createId();
  const expiresAt = Date.now() + ttlMs;

  dragStore.set(id, {
    payload,
    expiresAt
  });

  return id;
}

export function getDragPayload(id) {
  const entry = dragStore.get(id);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    dragStore.delete(id);
    return null;
  }

  return entry.payload;
}

export function consumeDragPayload(id) {
  const payload = getDragPayload(id);
  dragStore.delete(id);
  return payload;
}

export function pruneDragPayloads() {
  const now = Date.now();

  for (const [id, value] of dragStore.entries()) {
    if (now > value.expiresAt) {
      dragStore.delete(id);
    }
  }
}
