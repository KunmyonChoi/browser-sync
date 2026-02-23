function roomKey(namespace, room) {
  return `${namespace}::${room}`;
}

export class RendezvousRegistry {
  constructor() {
    this.rooms = new Map();
  }

  register({ namespace, room, peerId, addresses = [], ttlMs = 60_000, metadata = {} }) {
    const key = roomKey(namespace, room);
    const now = Date.now();
    const expiresAt = now + ttlMs;

    let roomMap = this.rooms.get(key);
    if (!roomMap) {
      roomMap = new Map();
      this.rooms.set(key, roomMap);
    }

    roomMap.set(peerId, {
      peerId,
      namespace,
      room,
      addresses,
      metadata,
      seenAt: now,
      expiresAt
    });

    return roomMap.get(peerId);
  }

  discover({ namespace, room, limit = 32 }) {
    this.pruneExpired();
    const key = roomKey(namespace, room);
    const roomMap = this.rooms.get(key);
    if (!roomMap) return [];

    return [...roomMap.values()]
      .sort((a, b) => b.seenAt - a.seenAt)
      .slice(0, limit);
  }

  removePeer({ namespace, room, peerId }) {
    const key = roomKey(namespace, room);
    const roomMap = this.rooms.get(key);
    if (!roomMap) return false;

    const removed = roomMap.delete(peerId);
    if (roomMap.size === 0) {
      this.rooms.delete(key);
    }

    return removed;
  }

  pruneExpired(now = Date.now()) {
    for (const [key, roomMap] of this.rooms.entries()) {
      for (const [peerId, record] of roomMap.entries()) {
        if (record.expiresAt <= now) {
          roomMap.delete(peerId);
        }
      }

      if (roomMap.size === 0) {
        this.rooms.delete(key);
      }
    }
  }
}
