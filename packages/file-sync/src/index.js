import { consumeDragPayload, registerDragPayload } from '../../shared/src/index.js';
import { createFileStorage } from './storage.js';
import { createPeerTransport } from './webpeerAdapter.js';

const DRAG_MIME = 'application/x-browser-sync-drag-id';
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_TRANSFER_RETRY_LIMIT = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;

function callbacksTemplate() {
  return {
    onReady: null,
    onError: null,
    onStateChange: null,
    onFilesChange: null,
    onSync: null
  };
}

function resolveContainer(container) {
  if (!container) {
    const node = document.createElement('div');
    document.body.appendChild(node);
    return node;
  }

  if (typeof container === 'string') {
    const found = document.querySelector(container);
    if (!found) throw new Error(`Container not found: ${container}`);
    return found;
  }

  return container;
}

function readableSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function readableSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0 || !Number.isFinite(bytesPerSecond)) return '-';
  if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
}

function readableEta(etaSec) {
  if (!Number.isFinite(etaSec) || etaSec < 0) return '-';
  if (etaSec < 1) return '0s';

  const total = Math.ceil(etaSec);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function createTransferId(fileId) {
  if (crypto?.randomUUID) {
    return `${fileId}-${crypto.randomUUID()}`;
  }

  return `${fileId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toBase64(arrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

function concatArrayBuffers(chunks) {
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  return merged.buffer;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return {
    checksum: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''),
    dataBuffer: buffer
  };
}

export class FileSyncPanel extends EventTarget {
  constructor(options = {}) {
    super();

    this.container = resolveContainer(options.container);
    this.title = options.title || 'File Sync';
    this.mode = options.mode || 'panel';
    this.callbacks = { ...callbacksTemplate(), ...(options.callbacks || {}) };

    this.namespace = options.namespace || 'global';
    this.room = options.room || 'public';
    this.signalingUrl = options.signalingUrl || 'wss://signal.example.com/ws';
    this.bootstrapUrl = options.bootstrapUrl || 'https://bootstrap.example.com';
    this.token = options.token || null;
    this.turnServers = options.turnServers || [];

    this.createPeer = options.createPeer;
    this.webPeerClient = options.webPeerClient;
    this.chunkBytes = Math.max(8 * 1024, Number(options.chunkBytes || DEFAULT_CHUNK_BYTES));
    this.transferRetryLimit = Math.max(1, Number(options.transferRetryLimit || DEFAULT_TRANSFER_RETRY_LIMIT));
    this.retryBaseDelayMs = Math.max(100, Number(options.retryBaseDelayMs || DEFAULT_RETRY_BASE_DELAY_MS));

    this.storage = null;
    this.storageEngine = null;
    this.transport = null;
    this.unsubscribeMessage = null;

    this.files = new Map();
    this.transfers = new Map();
    this.incomingTransfers = new Map();
    this.incomingTransferTimeouts = new Map();

    this._renderShell();
    this._bindEvents();
    this._init().catch((err) => this._emitError(err));
  }

  on(eventName, handler) {
    const listener = (event) => handler(event.detail);
    this.addEventListener(eventName, listener);
    return () => this.removeEventListener(eventName, listener);
  }

  async connect({ namespace, room, token } = {}) {
    if (namespace) this.namespace = namespace;
    if (room) this.room = room;
    if (token) this.token = token;

    this.elements.namespace.value = this.namespace;
    this.elements.room.value = this.room;

    await this._setupStorage();

    if (this.transport) {
      if (this.unsubscribeMessage) this.unsubscribeMessage();
      await this.transport.disconnect();
    }

    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      ...this.turnServers
    ];

    this.transport = await createPeerTransport({
      namespace: this.namespace,
      room: this.room,
      signalingUrl: this.signalingUrl,
      bootstrapUrl: this.bootstrapUrl,
      token: this.token,
      createPeer: this.createPeer,
      webPeerClient: this.webPeerClient,
      iceServers
    });

    this.unsubscribeMessage = this.transport.onMessage((message) => {
      this._handleIncomingMessage(message).catch((err) => this._emitError(err));
    });

    this._setStatus(`Connected: ${this.transport.type} (${this.namespace}/${this.room})`);
    this._emit('statechange', {
      connected: true,
      transport: this.transport.type,
      peerId: this.transport.peerId,
      namespace: this.namespace,
      room: this.room
    });
  }

  async disconnect() {
    if (!this.transport) return;
    if (this.unsubscribeMessage) this.unsubscribeMessage();
    await this.transport.disconnect();
    this.transport = null;
    this._setStatus('Disconnected');

    this._emit('statechange', {
      connected: false,
      namespace: this.namespace,
      room: this.room
    });
  }

  async addFile(file, { broadcast = true } = {}) {
    const { checksum, dataBuffer } = await hashFile(file);
    const id = checksum;
    const updatedAt = Date.now();

    const metadata = await this.storage.putFile({
      id,
      name: file.name,
      type: file.type || 'application/octet-stream',
      blob: file,
      updatedAt,
      checksum
    });

    this.files.set(id, metadata);
    this._renderFiles();

    if (broadcast && this.transport) {
      await this._broadcastFileInChunks({
        id,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        updatedAt,
        checksum,
        dataBuffer
      });
    }

    this._emit('sync', {
      action: 'upsert-local',
      id,
      name: file.name,
      checksum
    });

    this._emitFilesChange();
    return metadata;
  }

  async addBlob({ name, blob, type = 'application/octet-stream', lastModified = Date.now() }, options = {}) {
    const file = new File([blob], name, { type, lastModified });
    return this.addFile(file, options);
  }

  async exportFile(id) {
    const file = await this.storage.getFile(id);
    if (!file) throw new Error(`File not found: ${id}`);
    return file;
  }

  async removeFile(id, { broadcast = true } = {}) {
    const metadata = this.files.get(id) || (await this.storage.getMetadata(id));
    await this.storage.deleteFile(id);
    this.files.delete(id);
    this._renderFiles();

    if (broadcast && this.transport) {
      await this._sendRoomMessage('file-delete', { id });
    }

    this._emit('sync', {
      action: 'delete-local',
      id,
      name: metadata?.name || null
    });

    this._emitFilesChange();
  }

  async removeFilesByName(name, { broadcast = true } = {}) {
    if (!name) return 0;

    let removedCount = 0;
    const matches = [...this.files.values()].filter((item) => item.name === name);

    for (const match of matches) {
      await this.removeFile(match.id, { broadcast });
      removedCount += 1;
    }

    return removedCount;
  }

  async retryTransfer(transferId) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new Error(`Transfer not found: ${transferId}`);
    }

    if (transfer.direction === 'upload') {
      await this._retryUploadTransfer(transferId);
      return;
    }

    await this._retryDownloadTransfer(transferId);
  }

  async _retryUploadTransfer(transferId) {
    const transfer = this.transfers.get(transferId);
    if (!transfer?.fileId) {
      throw new Error('Upload retry requires file ID.');
    }

    const metadata = this.files.get(transfer.fileId) || (await this.storage.getMetadata(transfer.fileId));
    const file = await this.storage.getFile(transfer.fileId);
    if (!file) throw new Error(`Cannot retry upload. File is missing: ${transfer.fileId}`);

    const updatedAt = metadata?.updatedAt || Date.now();
    const checksum = metadata?.checksum || transfer.fileId;
    const dataBuffer = await file.arrayBuffer();

    const nextRetryCount = (transfer.retryCount || 0) + 1;
    this._upsertTransfer({
      transferId,
      fileId: transfer.fileId,
      name: file.name,
      direction: 'upload',
      progress: 0,
      status: 'retrying',
      size: file.size,
      bytesTransferred: 0,
      retryCount: nextRetryCount,
      maxRetries: this.transferRetryLimit,
      canRetry: true,
      errorMessage: 'Manual retry started'
    });

    await this._broadcastFileInChunks({
      id: transfer.fileId,
      name: file.name,
      mime: file.type || metadata?.type || 'application/octet-stream',
      size: file.size,
      updatedAt,
      checksum,
      dataBuffer,
      forcedTransferId: transferId,
      initialRetryCount: nextRetryCount
    });
  }

  async _retryDownloadTransfer(transferId) {
    const transfer = this.transfers.get(transferId);
    if (!transfer?.fileId) {
      throw new Error('Download retry requires file ID.');
    }

    if (!transfer.sourcePeerId) {
      throw new Error('Missing source peer information for download retry.');
    }

    const nextRetryCount = (transfer.retryCount || 0) + 1;
    this._clearIncomingTransferTimeout(transferId);
    this.incomingTransfers.delete(transferId);
    this._upsertTransfer({
      transferId,
      fileId: transfer.fileId,
      name: transfer.name,
      direction: 'download',
      progress: 0,
      status: 'retrying',
      size: transfer.size || 0,
      bytesTransferred: 0,
      retryCount: nextRetryCount,
      maxRetries: this.transferRetryLimit,
      canRetry: true,
      errorMessage: 'Retry requested'
    });

    await this._sendRoomMessage('file-transfer-retry-request', {
      fileId: transfer.fileId,
      failedTransferId: transferId,
      targetPeerId: transfer.sourcePeerId
    });

    this._emit('sync', {
      action: 'download-retry-requested',
      transferId,
      id: transfer.fileId,
      name: transfer.name,
      targetPeerId: transfer.sourcePeerId,
      retryCount: nextRetryCount
    });
  }

  async _rebroadcastStoredFile(fileId, { retryOfTransferId = null } = {}) {
    const metadata = this.files.get(fileId) || (await this.storage.getMetadata(fileId));
    const file = await this.storage.getFile(fileId);
    if (!metadata || !file) return;

    await this._broadcastFileInChunks({
      id: metadata.id,
      name: metadata.name,
      mime: metadata.type || file.type || 'application/octet-stream',
      size: metadata.size ?? file.size,
      updatedAt: metadata.updatedAt || Date.now(),
      checksum: metadata.checksum || metadata.id,
      dataBuffer: await file.arrayBuffer(),
      retryOfTransferId
    });
  }

  async _sendRoomMessage(type, payload) {
    if (!this.transport) return;

    await this.transport.send({
      type,
      sourcePeerId: this.transport.peerId,
      namespace: this.namespace,
      room: this.room,
      payload
    });
  }

  _upsertTransfer({
    transferId,
    fileId,
    name,
    direction,
    progress,
    status,
    size = undefined,
    bytesTransferred = undefined,
    retryCount = undefined,
    maxRetries = undefined,
    canRetry = undefined,
    errorMessage = undefined,
    sourcePeerId = undefined,
    etaSec = undefined
  }) {
    const now = Date.now();
    const prev = this.transfers.get(transferId);
    const next = {
      transferId,
      fileId: fileId ?? prev?.fileId ?? null,
      name: name ?? prev?.name ?? 'unknown',
      direction: direction ?? prev?.direction ?? 'upload',
      size: size ?? prev?.size ?? 0,
      progress: Math.max(0, Math.min(100, Math.round(progress ?? prev?.progress ?? 0))),
      status: status ?? prev?.status ?? 'sending',
      retryCount: retryCount ?? prev?.retryCount ?? 0,
      maxRetries: maxRetries ?? prev?.maxRetries ?? this.transferRetryLimit,
      canRetry: canRetry ?? prev?.canRetry ?? false,
      errorMessage: errorMessage ?? prev?.errorMessage ?? null,
      sourcePeerId: sourcePeerId ?? prev?.sourcePeerId ?? null,
      updatedAt: now,
      startedAt: prev?.startedAt ?? now,
      speedBps: prev?.speedBps ?? 0,
      etaSec: etaSec ?? prev?.etaSec ?? null,
      bytesTransferred: prev?.bytesTransferred ?? 0,
      lastByteUpdateAt: prev?.lastByteUpdateAt ?? now,
      lastEmittedProgress: prev?.lastEmittedProgress ?? -5,
      cleanupTimer: prev?.cleanupTimer || null
    };

    if (typeof bytesTransferred === 'number') {
      const previousBytes = prev?.bytesTransferred ?? 0;
      const previousAt = prev?.lastByteUpdateAt ?? now;
      const deltaBytes = bytesTransferred - previousBytes;
      const deltaMs = Math.max(1, now - previousAt);

      let nextSpeed = prev?.speedBps ?? 0;
      if (deltaBytes >= 0) {
        const sampleSpeed = (deltaBytes / deltaMs) * 1000;
        nextSpeed = nextSpeed > 0 ? nextSpeed * 0.7 + sampleSpeed * 0.3 : sampleSpeed;
      }

      next.bytesTransferred = bytesTransferred;
      next.lastByteUpdateAt = now;
      next.speedBps = nextSpeed;
    }

    if (next.size > 0 && next.speedBps > 0 && next.bytesTransferred < next.size) {
      next.etaSec = (next.size - next.bytesTransferred) / next.speedBps;
    } else if (next.progress >= 100 || next.status === 'done') {
      next.etaSec = 0;
    }

    this.transfers.set(transferId, next);
    this._renderFiles();
  }

  _completeTransfer(transferId) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;

    if (transfer.cleanupTimer) {
      clearTimeout(transfer.cleanupTimer);
    }

    const timerId = setTimeout(() => {
      const current = this.transfers.get(transferId);
      if (!current || current.status !== 'done') return;
      this.transfers.delete(transferId);
      this._renderFiles();
    }, 2500);

    this.transfers.set(transferId, {
      ...transfer,
      bytesTransferred: transfer.size || transfer.bytesTransferred,
      progress: 100,
      status: 'done',
      canRetry: false,
      errorMessage: null,
      etaSec: 0,
      updatedAt: Date.now(),
      cleanupTimer: timerId
    });
    this._renderFiles();
  }

  _markTransferFailed(transferId, errorMessage, { canRetry = true } = {}) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;

    if (transfer.cleanupTimer) {
      clearTimeout(transfer.cleanupTimer);
    }

    this.transfers.set(transferId, {
      ...transfer,
      status: 'failed',
      canRetry,
      errorMessage,
      etaSec: null,
      cleanupTimer: null,
      updatedAt: Date.now()
    });
    this._renderFiles();
  }

  _emitProgressIfNeeded({ action, transferId, name, progress, sourcePeerId = null }) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;

    const rounded = Math.max(0, Math.min(100, Math.round(progress)));
    const shouldEmit =
      rounded === 0 ||
      rounded === 100 ||
      rounded - transfer.lastEmittedProgress >= 5;

    if (!shouldEmit) return;

    this.transfers.set(transferId, {
      ...transfer,
      lastEmittedProgress: rounded
    });

    this._emit('sync', {
      action,
      transferId,
      name,
      progress: rounded,
      sourcePeerId,
      speedBps: transfer.speedBps || 0,
      etaSec: transfer.etaSec ?? null,
      retryCount: transfer.retryCount || 0,
      status: transfer.status
    });
  }

  async _sendTransferMessageWithRetry({
    type,
    payload,
    transferId,
    transferName,
    allowRetry = true
  }) {
    let attempt = 0;
    const maxAttempts = allowRetry ? this.transferRetryLimit : 1;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        await this._sendRoomMessage(type, payload);
        return;
      } catch (err) {
        if (attempt >= maxAttempts) {
          this._markTransferFailed(transferId, `Transport send failed: ${err.message}`, {
            canRetry: true
          });
          this._emit('sync', {
            action: 'transfer-failed',
            transferId,
            name: transferName,
            reason: err.message,
            direction: 'upload'
          });
          throw err;
        }

        const transfer = this.transfers.get(transferId);
        const nextRetryCount = (transfer?.retryCount || 0) + 1;
        this._upsertTransfer({
          transferId,
          fileId: transfer?.fileId,
          name: transferName,
          direction: 'upload',
          progress: transfer?.progress ?? 0,
          status: 'retrying',
          size: transfer?.size ?? 0,
          bytesTransferred: transfer?.bytesTransferred ?? 0,
          retryCount: nextRetryCount,
          maxRetries: this.transferRetryLimit,
          canRetry: true,
          errorMessage: `Retry ${nextRetryCount}/${this.transferRetryLimit} after send failure`
        });

        this._emit('sync', {
          action: 'upload-retry',
          transferId,
          name: transferName,
          retryCount: nextRetryCount,
          error: err.message
        });

        await sleep(this.retryBaseDelayMs * attempt);
      }
    }
  }

  async _broadcastFileInChunks({
    id,
    name,
    mime,
    size,
    updatedAt,
    checksum,
    dataBuffer,
    forcedTransferId = null,
    retryOfTransferId = null,
    initialRetryCount = 0
  }) {
    const transferId = forcedTransferId || createTransferId(id);
    const totalChunks = Math.max(1, Math.ceil(dataBuffer.byteLength / this.chunkBytes));

    this._upsertTransfer({
      transferId,
      fileId: id,
      name,
      direction: 'upload',
      progress: 0,
      status: 'sending',
      size,
      bytesTransferred: 0,
      retryCount: initialRetryCount,
      maxRetries: this.transferRetryLimit,
      canRetry: true,
      errorMessage: null
    });
    this._emitProgressIfNeeded({
      action: 'upload-progress',
      transferId,
      name,
      progress: 0
    });

    await this._sendTransferMessageWithRetry({
      type: 'file-transfer-start',
      transferId,
      transferName: name,
      allowRetry: false,
      payload: {
        transferId,
        id,
        name,
        mime,
        size,
        updatedAt,
        checksum,
        totalChunks,
        retryOfTransferId
      }
    });

    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * this.chunkBytes;
      const end = Math.min(start + this.chunkBytes, dataBuffer.byteLength);
      const chunkBuffer = dataBuffer.slice(start, end);

      await this._sendTransferMessageWithRetry({
        type: 'file-chunk',
        transferId,
        transferName: name,
        payload: {
          transferId,
          id,
          chunkIndex: index,
          totalChunks,
          data: toBase64(chunkBuffer)
        }
      });

      const progress = ((index + 1) / totalChunks) * 100;
      this._upsertTransfer({
        transferId,
        fileId: id,
        name,
        direction: 'upload',
        progress,
        status: 'sending',
        size,
        bytesTransferred: end,
        maxRetries: this.transferRetryLimit,
        canRetry: true,
        errorMessage: null
      });
      this._emitProgressIfNeeded({
        action: 'upload-progress',
        transferId,
        name,
        progress
      });
    }

    await this._sendTransferMessageWithRetry({
      type: 'file-transfer-complete',
      transferId,
      transferName: name,
      allowRetry: false,
      payload: {
        transferId,
        id,
        checksum,
        updatedAt
      }
    });

    this._completeTransfer(transferId);
    this._emit('sync', {
      action: 'upload-complete',
      transferId,
      id,
      name,
      checksum
    });

    return transferId;
  }

  _clearIncomingTransferTimeout(transferId) {
    const timerId = this.incomingTransferTimeouts.get(transferId);
    if (timerId) {
      clearTimeout(timerId);
      this.incomingTransferTimeouts.delete(transferId);
    }
  }

  _touchIncomingTransferTimeout(transferId, timeoutMs = 10_000) {
    this._clearIncomingTransferTimeout(transferId);
    const timerId = setTimeout(() => {
      this.incomingTransferTimeouts.delete(transferId);
      const transfer = this.incomingTransfers.get(transferId);
      if (!transfer || transfer.finalized) return;

      this._markTransferFailed(
        transfer.transferId,
        'No chunks received recently (timeout).',
        { canRetry: true }
      );
      this._emit('sync', {
        action: 'transfer-failed',
        transferId: transfer.transferId,
        id: transfer.fileId,
        name: transfer.name,
        reason: 'timeout',
        direction: 'download',
        sourcePeerId: transfer.sourcePeerId
      });
    }, timeoutMs);

    this.incomingTransferTimeouts.set(transferId, timerId);
  }

  async getFileMetadata(id) {
    return this.storage.getMetadata(id);
  }

  async listMetadata() {
    return this.storage.listFiles();
  }

  async moveFileToBrowser(fileBrowserPanel, id, { path = null, removeAfterMove = true } = {}) {
    const file = await this.exportFile(id);
    await fileBrowserPanel.saveFile(file.name, file, { path });
    if (removeAfterMove) {
      await this.removeFile(id);
    }
  }

  destroy() {
    for (const transfer of this.transfers.values()) {
      if (transfer.cleanupTimer) {
        clearTimeout(transfer.cleanupTimer);
      }
    }
    for (const timerId of this.incomingTransferTimeouts.values()) {
      clearTimeout(timerId);
    }
    this.transfers.clear();
    this.incomingTransfers.clear();
    this.incomingTransferTimeouts.clear();
    this.disconnect().catch(() => null);
    this.container.innerHTML = '';
  }

  async _init() {
    await this._setupStorage();
    await this.connect({ namespace: this.namespace, room: this.room, token: this.token });
    this._emit('ready', {
      namespace: this.namespace,
      room: this.room,
      storage: this.storageEngine
    });
  }

  async _setupStorage() {
    const { engine, api } = await createFileStorage(this.namespace, this.room);
    this.storageEngine = engine;
    this.storage = api;

    const listed = await this.storage.listFiles();
    this.files = new Map(listed.map((entry) => [entry.id, entry]));
    for (const transfer of this.transfers.values()) {
      if (transfer.cleanupTimer) {
        clearTimeout(transfer.cleanupTimer);
      }
    }
    for (const timerId of this.incomingTransferTimeouts.values()) {
      clearTimeout(timerId);
    }
    this.transfers.clear();
    this.incomingTransfers.clear();
    this.incomingTransferTimeouts.clear();
    this._renderFiles();

    this._setStatus(`Storage engine: ${engine}`);
  }

  async _handleIncomingMessage(message) {
    if (!message || !message.type) return;

    if (message.namespace !== this.namespace || message.room !== this.room) {
      return;
    }

    if (this.transport && message.sourcePeerId === this.transport.peerId) {
      return;
    }

    if (message.type === 'file-transfer-retry-request') {
      const payload = message.payload || {};
      if (payload.targetPeerId && this.transport?.peerId !== payload.targetPeerId) {
        return;
      }

      await this._rebroadcastStoredFile(payload.fileId, {
        retryOfTransferId: payload.failedTransferId || null
      });

      this._emit('sync', {
        action: 'retry-request-received',
        fileId: payload.fileId,
        requestedByPeerId: message.sourcePeerId,
        failedTransferId: payload.failedTransferId || null
      });
      return;
    }

    if (message.type === 'file-transfer-start') {
      const payload = message.payload;
      const retriedTransfer = payload.retryOfTransferId
        ? this.transfers.get(payload.retryOfTransferId)
        : null;
      const inheritedRetryCount = retriedTransfer?.retryCount || 0;

      if (payload.retryOfTransferId && this.transfers.has(payload.retryOfTransferId)) {
        const stale = this.transfers.get(payload.retryOfTransferId);
        if (stale?.cleanupTimer) {
          clearTimeout(stale.cleanupTimer);
        }
        this.transfers.delete(payload.retryOfTransferId);
        this._clearIncomingTransferTimeout(payload.retryOfTransferId);
        this.incomingTransfers.delete(payload.retryOfTransferId);
      }

      const incoming = {
        transferId: payload.transferId,
        fileId: payload.id,
        name: payload.name,
        mime: payload.mime || 'application/octet-stream',
        size: payload.size || 0,
        updatedAt: payload.updatedAt || Date.now(),
        checksum: payload.checksum,
        totalChunks: Math.max(1, Number(payload.totalChunks || 1)),
        chunks: new Array(Math.max(1, Number(payload.totalChunks || 1))),
        receivedChunks: 0,
        bytesReceived: 0,
        sourcePeerId: message.sourcePeerId,
        finalized: false
      };

      this.incomingTransfers.set(payload.transferId, incoming);
      this._upsertTransfer({
        transferId: payload.transferId,
        fileId: payload.id,
        name: payload.name,
        direction: 'download',
        progress: 0,
        status: 'receiving',
        size: payload.size || 0,
        bytesTransferred: 0,
        retryCount: inheritedRetryCount,
        maxRetries: this.transferRetryLimit,
        canRetry: true,
        errorMessage: null,
        sourcePeerId: message.sourcePeerId
      });
      this._emitProgressIfNeeded({
        action: 'download-progress',
        transferId: payload.transferId,
        name: payload.name,
        progress: 0,
        sourcePeerId: message.sourcePeerId
      });
      this._touchIncomingTransferTimeout(payload.transferId);
      return;
    }

    if (message.type === 'file-chunk') {
      const payload = message.payload;
      const transfer = this.incomingTransfers.get(payload.transferId);
      if (!transfer || transfer.finalized) return;

      const index = Number(payload.chunkIndex);
      if (Number.isNaN(index) || index < 0 || index >= transfer.totalChunks) {
        return;
      }

      if (!transfer.chunks[index]) {
        const decoded = fromBase64(payload.data || '');
        transfer.chunks[index] = decoded;
        transfer.receivedChunks += 1;
        transfer.bytesReceived += decoded.byteLength;
      }

      const progress = (transfer.receivedChunks / transfer.totalChunks) * 100;
      this._upsertTransfer({
        transferId: transfer.transferId,
        fileId: transfer.fileId,
        name: transfer.name,
        direction: 'download',
        progress,
        status: 'receiving',
        size: transfer.size,
        bytesTransferred: transfer.bytesReceived,
        maxRetries: this.transferRetryLimit,
        canRetry: true,
        sourcePeerId: transfer.sourcePeerId
      });
      this._emitProgressIfNeeded({
        action: 'download-progress',
        transferId: transfer.transferId,
        name: transfer.name,
        progress,
        sourcePeerId: transfer.sourcePeerId
      });
      this._touchIncomingTransferTimeout(transfer.transferId);

      if (transfer.receivedChunks === transfer.totalChunks) {
        await this._finalizeIncomingTransfer(transfer);
      }

      return;
    }

    if (message.type === 'file-transfer-complete') {
      const payload = message.payload;
      const transfer = this.incomingTransfers.get(payload.transferId);
      if (!transfer || transfer.finalized) return;

      if (transfer.receivedChunks === transfer.totalChunks) {
        await this._finalizeIncomingTransfer(transfer);
      } else {
        this._clearIncomingTransferTimeout(transfer.transferId);
        this._markTransferFailed(
          transfer.transferId,
          `Missing chunks (${transfer.receivedChunks}/${transfer.totalChunks})`,
          { canRetry: true }
        );
        this._emit('sync', {
          action: 'transfer-failed',
          transferId: transfer.transferId,
          id: transfer.fileId,
          name: transfer.name,
          reason: 'missing_chunks',
          direction: 'download',
          sourcePeerId: transfer.sourcePeerId
        });
      }
      return;
    }

    if (message.type === 'file-upsert') {
      const payload = message.payload;
      const buffer = fromBase64(payload.data);
      const file = new File([buffer], payload.name, {
        type: payload.mime,
        lastModified: payload.updatedAt
      });

      const metadata = await this.storage.putFile({
        id: payload.id,
        name: payload.name,
        type: payload.mime,
        blob: file,
        updatedAt: payload.updatedAt,
        checksum: payload.checksum
      });

      this.files.set(payload.id, metadata);
      this._renderFiles();

      this._emit('sync', {
        action: 'upsert-remote',
        id: payload.id,
        name: payload.name,
        sourcePeerId: message.sourcePeerId
      });

      this._emitFilesChange();
      return;
    }

    if (message.type === 'file-delete') {
      const { id } = message.payload;
      await this.storage.deleteFile(id);
      this.files.delete(id);
      this._renderFiles();

      this._emit('sync', {
        action: 'delete-remote',
        id,
        sourcePeerId: message.sourcePeerId
      });

      this._emitFilesChange();
    }
  }

  async _finalizeIncomingTransfer(transfer) {
    if (transfer.finalized) return;
    transfer.finalized = true;

    if (transfer.receivedChunks !== transfer.totalChunks) {
      transfer.finalized = false;
      return;
    }
    this._clearIncomingTransferTimeout(transfer.transferId);

    const mergedBuffer = concatArrayBuffers(transfer.chunks);
    const file = new File([mergedBuffer], transfer.name, {
      type: transfer.mime,
      lastModified: transfer.updatedAt
    });

    let metadata;
    try {
      metadata = await this.storage.putFile({
        id: transfer.fileId,
        name: transfer.name,
        type: transfer.mime,
        blob: file,
        updatedAt: transfer.updatedAt,
        checksum: transfer.checksum
      });
    } catch (err) {
      transfer.finalized = false;
      this._markTransferFailed(transfer.transferId, `Failed to save file: ${err.message}`, {
        canRetry: true
      });
      throw err;
    }

    this.files.set(transfer.fileId, metadata);
    this._renderFiles();
    this._upsertTransfer({
      transferId: transfer.transferId,
      fileId: transfer.fileId,
      name: transfer.name,
      direction: 'download',
      progress: 100,
      status: 'receiving',
      size: transfer.size || mergedBuffer.byteLength,
      bytesTransferred: transfer.bytesReceived || mergedBuffer.byteLength,
      maxRetries: this.transferRetryLimit,
      canRetry: true,
      sourcePeerId: transfer.sourcePeerId
    });
    this._emitProgressIfNeeded({
      action: 'download-progress',
      transferId: transfer.transferId,
      name: transfer.name,
      progress: 100,
      sourcePeerId: transfer.sourcePeerId
    });
    this._completeTransfer(transfer.transferId);

    this._emit('sync', {
      action: 'upsert-remote',
      id: transfer.fileId,
      name: transfer.name,
      sourcePeerId: transfer.sourcePeerId
    });
    this._emit('sync', {
      action: 'download-complete',
      transferId: transfer.transferId,
      id: transfer.fileId,
      name: transfer.name,
      sourcePeerId: transfer.sourcePeerId
    });

    this._emitFilesChange();
    this.incomingTransfers.delete(transfer.transferId);
  }

  _renderShell() {
    this.container.classList.add('bs-file-sync');
    this.container.classList.toggle('fullscreen', this.mode === 'fullscreen');

    this.container.innerHTML = `
      <div class="fs-header">
        <strong>${this.title}</strong>
        <span class="fs-status" data-fs-status>Initializing...</span>
      </div>
      <div class="fs-controls">
        <label>
          Namespace
          <input type="text" data-fs-namespace value="${this.namespace}" />
        </label>
        <label>
          Room
          <input type="text" data-fs-room value="${this.room}" />
        </label>
        <button type="button" data-fs-action="connect">Reconnect</button>
      </div>
      <div class="fs-dropzone" data-fs-dropzone>
        Drag files here to sync with peers in the same namespace/room.
      </div>
      <ul class="fs-list" data-fs-list></ul>
    `;

    this.elements = {
      status: this.container.querySelector('[data-fs-status]'),
      namespace: this.container.querySelector('[data-fs-namespace]'),
      room: this.container.querySelector('[data-fs-room]'),
      reconnect: this.container.querySelector('[data-fs-action="connect"]'),
      dropzone: this.container.querySelector('[data-fs-dropzone]'),
      list: this.container.querySelector('[data-fs-list]')
    };
  }

  _bindEvents() {
    this.elements.reconnect.addEventListener('click', async () => {
      try {
        await this.connect({
          namespace: this.elements.namespace.value.trim() || 'global',
          room: this.elements.room.value.trim() || 'public'
        });
      } catch (err) {
        this._emitError(err);
      }
    });

    this.elements.dropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.elements.dropzone.classList.add('drag-active');
    });

    this.elements.dropzone.addEventListener('dragleave', () => {
      this.elements.dropzone.classList.remove('drag-active');
    });

    this.elements.dropzone.addEventListener('drop', async (event) => {
      event.preventDefault();
      this.elements.dropzone.classList.remove('drag-active');

      try {
        await this._handleDrop(event);
      } catch (err) {
        this._emitError(err);
      }
    });

    this.elements.list.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.dataset.action;

      try {
        if (action === 'retry-transfer') {
          const transferRow = event.target.closest('[data-transfer-id]');
          if (!transferRow) return;
          await this.retryTransfer(transferRow.dataset.transferId);
          return;
        }

        const row = event.target.closest('[data-id]');
        if (!row) return;
        const id = row.dataset.id;

        if (action === 'delete') {
          const accepted = window.confirm('Delete this file from the sync room and local storage?');
          if (accepted) {
            await this.removeFile(id);
          }
        }

        if (action === 'download') {
          const file = await this.exportFile(id);
          const url = URL.createObjectURL(file);
          const link = document.createElement('a');
          link.href = url;
          link.download = file.name;
          link.click();
          URL.revokeObjectURL(url);
        }
      } catch (err) {
        this._emitError(err);
      }
    });

    this.elements.list.addEventListener('dragstart', (event) => {
      const row = event.target.closest('[data-id]');
      if (!row) return;

      const metadata = this.files.get(row.dataset.id);
      if (!metadata) return;

      const dragId = registerDragPayload({
        source: 'file-sync',
        panel: this,
        fileId: metadata.id,
        fileName: metadata.name
      });

      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(DRAG_MIME, dragId);
      event.dataTransfer.setData('text/plain', metadata.name);
    });
  }

  async _handleDrop(event) {
    const nativeFiles = [...(event.dataTransfer.files || [])];
    if (nativeFiles.length) {
      for (const file of nativeFiles) {
        await this.addFile(file);
      }

      return;
    }

    const dragId = event.dataTransfer.getData(DRAG_MIME);
    if (!dragId) return;

    const payload = consumeDragPayload(dragId);
    if (!payload) return;

    if (payload.source === 'file-browser') {
      if (payload.sourceKind !== 'file') {
        throw new Error('Only files can be copied from file browser to file sync panel.');
      }

      const file = await payload.sourceHandle.getFile();
      await this.addFile(file);
      // Browser -> sync is copy semantics: keep the original file in file browser.
      await payload.panel.refresh();

      this._emit('sync', {
        action: 'copy-from-browser',
        name: file.name,
        sourcePath: payload.sourcePath
      });
      return;
    }

    if (payload.source === 'file-sync') {
      const file = await payload.panel.exportFile(payload.fileId);
      await this.addFile(file);
      await payload.panel.removeFile(payload.fileId);

      this._emit('sync', {
        action: 'move-between-sync-panels',
        name: file.name
      });
    }
  }

  _transferStatusLabel(transfer) {
    if (transfer.status === 'failed') return 'Failed';
    if (transfer.status === 'done') return 'Completed';
    if (transfer.status === 'retrying') return transfer.direction === 'upload' ? 'Retrying Upload' : 'Retrying Download';
    if (transfer.direction === 'upload') return 'Uploading';
    return 'Downloading';
  }

  _setStatus(text) {
    this.elements.status.textContent = text;
  }

  _emitFilesChange() {
    this._emit('fileschange', {
      namespace: this.namespace,
      room: this.room,
      count: this.files.size,
      files: [...this.files.values()]
    });
  }

  _renderFiles() {
    const files = [...this.files.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    const transfers = [...this.transfers.values()].sort((a, b) => b.updatedAt - a.updatedAt);

    if (!files.length && !transfers.length) {
      this.elements.list.innerHTML = '<li class="fs-empty">No synced files in this room yet.</li>';
      return;
    }

    const transferMarkup = transfers
      .map((transfer) => {
        const statusLabel = this._transferStatusLabel(transfer);
        const speed = readableSpeed(transfer.speedBps || 0);
        const eta = readableEta(transfer.etaSec ?? NaN);
        const retryText = `${transfer.retryCount || 0}/${transfer.maxRetries || this.transferRetryLimit}`;
        const failedClass = transfer.status === 'failed' ? 'failed' : '';
        return `
          <li class="fs-item fs-transfer ${transfer.direction} ${failedClass}" data-transfer-id="${transfer.transferId}">
            <div class="fs-meta">
              <div class="fs-name">${transfer.name}</div>
              <div class="fs-detail">
                ${statusLabel} · ${transfer.progress}% · ${readableSize(transfer.size || 0)}
                · ${speed} · ETA ${eta} · Retry ${retryText}
              </div>
              ${transfer.errorMessage ? `<div class="fs-error">${transfer.errorMessage}</div>` : ''}
              <div class="fs-progress-track">
                <div class="fs-progress-fill" style="width: ${transfer.progress}%"></div>
              </div>
            </div>
            <div class="fs-actions">
              ${transfer.status === 'failed' && transfer.canRetry ? '<button type="button" data-action="retry-transfer">Retry</button>' : ''}
            </div>
          </li>
        `;
      })
      .join('');

    const fileMarkup = files
      .map((file) => {
        return `
          <li class="fs-item" data-id="${file.id}" draggable="true">
            <div class="fs-meta">
              <div class="fs-name">${file.name}</div>
              <div class="fs-detail">${readableSize(file.size)} · ${new Date(file.updatedAt).toLocaleString()}</div>
            </div>
            <div class="fs-actions">
              <button type="button" data-action="download">Download</button>
              <button type="button" class="danger" data-action="delete">Delete</button>
            </div>
          </li>
        `;
      })
      .join('');

    this.elements.list.innerHTML = `${transferMarkup}${fileMarkup}`;
  }

  _emit(eventName, detail) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));

    const callbackMap = {
      ready: 'onReady',
      error: 'onError',
      statechange: 'onStateChange',
      fileschange: 'onFilesChange',
      sync: 'onSync'
    };

    const callback = this.callbacks[callbackMap[eventName]];
    if (typeof callback === 'function') callback(detail);
  }

  _emitError(err) {
    this._emit('error', {
      message: err.message,
      cause: err
    });
  }
}

export default FileSyncPanel;
