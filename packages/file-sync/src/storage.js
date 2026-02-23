function encodeSegment(input) {
  return input.replace(/[^a-zA-Z0-9-_]/g, '_');
}

class OPFSStorage {
  constructor(namespace, room) {
    this.namespace = namespace;
    this.room = room;
    this.indexFileName = '.sync-index.json';
    this.index = new Map();
  }

  async init() {
    const root = await navigator.storage.getDirectory();
    const appDir = await root.getDirectoryHandle('browser-sync-opfs', { create: true });
    const nsDir = await appDir.getDirectoryHandle(encodeSegment(this.namespace), { create: true });
    this.roomDir = await nsDir.getDirectoryHandle(encodeSegment(this.room), { create: true });
    await this.#readIndex();
  }

  async putFile(record) {
    const fileName = `${record.id}.bin`;
    const handle = await this.roomDir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(record.blob);
    await writable.close();

    this.index.set(record.id, {
      id: record.id,
      name: record.name,
      type: record.type,
      size: record.blob.size,
      updatedAt: record.updatedAt,
      checksum: record.checksum,
      fileName
    });

    await this.#writeIndex();
    return this.index.get(record.id);
  }

  async getFile(id) {
    const metadata = this.index.get(id);
    if (!metadata) return null;

    const handle = await this.roomDir.getFileHandle(metadata.fileName);
    const file = await handle.getFile();

    return new File([file], metadata.name, {
      type: metadata.type || file.type,
      lastModified: metadata.updatedAt
    });
  }

  async listFiles() {
    return [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getMetadata(id) {
    return this.index.get(id) || null;
  }

  async deleteFile(id) {
    const metadata = this.index.get(id);
    if (!metadata) return false;

    await this.roomDir.removeEntry(metadata.fileName);
    this.index.delete(id);
    await this.#writeIndex();
    return true;
  }

  async clear() {
    for (const metadata of this.index.values()) {
      await this.roomDir.removeEntry(metadata.fileName);
    }

    this.index.clear();
    await this.#writeIndex();
  }

  async #readIndex() {
    try {
      const handle = await this.roomDir.getFileHandle(this.indexFileName);
      const file = await handle.getFile();
      const content = await file.text();
      const parsed = JSON.parse(content);
      this.index = new Map(parsed.map((entry) => [entry.id, entry]));
    } catch (_err) {
      this.index = new Map();
      await this.#writeIndex();
    }
  }

  async #writeIndex() {
    const handle = await this.roomDir.getFileHandle(this.indexFileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify([...this.index.values()], null, 2));
    await writable.close();
  }
}

class IDBStorage {
  constructor(namespace, room) {
    this.namespace = namespace;
    this.room = room;
    this.dbName = `browser-sync-idb-${namespace}-${room}`;
    this.storeName = 'files';
  }

  async init() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(this.storeName, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async putFile(record) {
    const next = {
      id: record.id,
      name: record.name,
      type: record.type,
      size: record.blob.size,
      updatedAt: record.updatedAt,
      checksum: record.checksum,
      blob: record.blob
    };

    await this.#run('readwrite', (store) => store.put(next));
    return next;
  }

  async getFile(id) {
    const record = await this.#run('readonly', (store) => store.get(id));
    if (!record) return null;

    return new File([record.blob], record.name, {
      type: record.type,
      lastModified: record.updatedAt
    });
  }

  async listFiles() {
    const records = await this.#run('readonly', (store) => store.getAll());
    return records
      .map((record) => ({
        id: record.id,
        name: record.name,
        type: record.type,
        size: record.size,
        updatedAt: record.updatedAt,
        checksum: record.checksum
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getMetadata(id) {
    const record = await this.#run('readonly', (store) => store.get(id));
    if (!record) return null;

    return {
      id: record.id,
      name: record.name,
      type: record.type,
      size: record.size,
      updatedAt: record.updatedAt,
      checksum: record.checksum
    };
  }

  async deleteFile(id) {
    await this.#run('readwrite', (store) => store.delete(id));
    return true;
  }

  async clear() {
    await this.#run('readwrite', (store) => store.clear());
  }

  #run(mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, mode);
      const store = tx.objectStore(this.storeName);
      const request = operation(store);

      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error || request.error);
      tx.onabort = () => reject(tx.error || request.error);
    });
  }
}

export async function createFileStorage(namespace, room) {
  if (navigator.storage?.getDirectory) {
    const opfsStorage = new OPFSStorage(namespace, room);
    await opfsStorage.init();
    return {
      engine: 'opfs',
      api: opfsStorage
    };
  }

  const idbStorage = new IDBStorage(namespace, room);
  await idbStorage.init();
  return {
    engine: 'indexeddb',
    api: idbStorage
  };
}
