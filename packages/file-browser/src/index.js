import { consumeDragPayload, registerDragPayload } from '../../shared/src/index.js';

const DRAG_MIME = 'application/x-browser-sync-drag-id';

function defaultCallbacks() {
  return {
    onReady: null,
    onError: null,
    onOperation: null,
    onEntriesChange: null,
    onSelectionChange: null
  };
}

function resolveContainer(container) {
  if (!container) {
    const created = document.createElement('div');
    document.body.appendChild(created);
    return created;
  }

  if (typeof container === 'string') {
    const queried = document.querySelector(container);
    if (!queried) {
      throw new Error(`Container not found: ${container}`);
    }

    return queried;
  }

  return container;
}

function asBlob(data) {
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Blob([data]);
  if (typeof data === 'string') return new Blob([data], { type: 'text/plain' });
  if (data instanceof Uint8Array) return new Blob([data.buffer]);
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

async function copyDirectoryRecursive(sourceDir, targetDir) {
  for await (const [entryName, entryHandle] of sourceDir.entries()) {
    if (entryHandle.kind === 'file') {
      const sourceFile = await entryHandle.getFile();
      const targetFileHandle = await targetDir.getFileHandle(entryName, { create: true });
      const writable = await targetFileHandle.createWritable();
      await writable.write(sourceFile);
      await writable.close();
      continue;
    }

    const nestedTarget = await targetDir.getDirectoryHandle(entryName, { create: true });
    await copyDirectoryRecursive(entryHandle, nestedTarget);
  }
}

export class FileBrowserPanel extends EventTarget {
  constructor(options = {}) {
    super();

    this.callbacks = { ...defaultCallbacks(), ...(options.callbacks || {}) };
    this.container = resolveContainer(options.container);
    this.mode = options.mode || 'panel';
    this.title = options.title || 'File Browser';

    this.state = {
      rootHandle: null,
      currentHandle: null,
      pathStack: [],
      entries: []
    };

    this._renderShell();
    this._bindEvents();
    this._emit('ready', { title: this.title });
  }

  on(eventName, handler) {
    const listener = (event) => handler(event.detail);
    this.addEventListener(eventName, listener);
    return () => this.removeEventListener(eventName, listener);
  }

  async requestAccess({ mode = 'readwrite' } = {}) {
    if (!window.showDirectoryPicker) {
      const err = new Error('File System Access API is not available in this browser.');
      this._emitError(err);
      throw err;
    }

    const handle = await window.showDirectoryPicker({ mode });
    await this.setRootHandle(handle);
    return handle;
  }

  async setRootHandle(handle, rootName = handle.name || 'Root') {
    this.state.rootHandle = handle;
    this.state.currentHandle = handle;
    this.state.pathStack = [{ name: rootName, handle }];
    await this.refresh();
  }

  getCurrentFolderHandle() {
    return this.state.currentHandle;
  }

  getCurrentFolderPath() {
    return this.state.pathStack.map((segment) => segment.name).join('/');
  }

  async refresh() {
    if (!this.state.currentHandle) {
      this._renderEmpty('Pick a folder to start.');
      return;
    }

    const entries = [];
    for await (const [name, handle] of this.state.currentHandle.entries()) {
      entries.push({
        name,
        kind: handle.kind,
        handle
      });
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    this.state.entries = entries;
    this._renderEntries();
    this._emit('entrieschange', {
      path: this.getCurrentFolderPath(),
      entries: entries.map((entry) => ({ name: entry.name, kind: entry.kind }))
    });
  }

  async openFolder(name) {
    const found = this.state.entries.find((entry) => entry.name === name && entry.kind === 'directory');
    if (!found) {
      throw new Error(`Folder not found: ${name}`);
    }

    this.state.currentHandle = found.handle;
    this.state.pathStack.push({ name: found.name, handle: found.handle });
    await this.refresh();
  }

  async goToPathIndex(index) {
    if (index < 0 || index >= this.state.pathStack.length) return;
    const target = this.state.pathStack[index];
    this.state.pathStack = this.state.pathStack.slice(0, index + 1);
    this.state.currentHandle = target.handle;
    await this.refresh();
  }

  async loadFile(fileName, { path = null, as = 'file' } = {}) {
    const directory = path ? await this._resolveDirectory(path) : this.state.currentHandle;
    const handle = await directory.getFileHandle(fileName);
    const file = await handle.getFile();

    if (as === 'text') return file.text();
    if (as === 'arrayBuffer') return file.arrayBuffer();
    return file;
  }

  async saveFile(fileName, data, { path = null } = {}) {
    const directory = path ? await this._resolveDirectory(path) : this.state.currentHandle;
    if (!directory) throw new Error('No active directory is selected.');

    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(asBlob(data));
    await writable.close();

    await this.refresh();
    this._emit('operation', {
      type: 'save',
      fileName,
      targetPath: path || this.getCurrentFolderPath()
    });
  }

  async importBrowserFile(file, { targetHandle = null } = {}) {
    const destination = targetHandle || this.state.currentHandle;
    const fileHandle = await destination.getFileHandle(file.name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file);
    await writable.close();
  }

  async getMetadata(fileName, { path = null } = {}) {
    const directory = path ? await this._resolveDirectory(path) : this.state.currentHandle;

    try {
      const fileHandle = await directory.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return {
        name: file.name,
        kind: 'file',
        size: file.size,
        type: file.type,
        lastModified: file.lastModified
      };
    } catch (_err) {
      const directoryHandle = await directory.getDirectoryHandle(fileName);
      return {
        name: directoryHandle.name,
        kind: 'directory'
      };
    }
  }

  async deleteEntry(name) {
    const entry = this.state.entries.find((item) => item.name === name);
    await this.state.currentHandle.removeEntry(name, { recursive: true });
    await this.refresh();
    this._emit('operation', {
      type: 'delete',
      entryName: name,
      entryKind: entry?.kind || 'unknown',
      currentPath: this.getCurrentFolderPath()
    });
  }

  async renameEntry(name, newName) {
    if (!newName || newName === name) return;

    const entry = this.state.entries.find((item) => item.name === name);
    if (!entry) throw new Error(`Entry not found: ${name}`);

    if (entry.kind === 'file') {
      const file = await entry.handle.getFile();
      const nextHandle = await this.state.currentHandle.getFileHandle(newName, { create: true });
      const writable = await nextHandle.createWritable();
      await writable.write(file);
      await writable.close();
    } else {
      const createdDir = await this.state.currentHandle.getDirectoryHandle(newName, { create: true });
      await copyDirectoryRecursive(entry.handle, createdDir);
    }

    await this.state.currentHandle.removeEntry(name, { recursive: true });
    await this.refresh();
    this._emit('operation', {
      type: 'rename',
      oldName: name,
      newName,
      currentPath: this.getCurrentFolderPath()
    });
  }

  async moveEntryToDirectory({ sourceName, sourceHandle, sourceParentHandle, targetDirectoryHandle }) {
    if (!sourceHandle || !sourceParentHandle || !targetDirectoryHandle) {
      throw new Error('moveEntryToDirectory requires source and target handles.');
    }

    if (sourceParentHandle === targetDirectoryHandle) return;

    if (sourceHandle.kind === 'file') {
      const file = await sourceHandle.getFile();
      const fileHandle = await targetDirectoryHandle.getFileHandle(sourceName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(file);
      await writable.close();
    } else {
      const folderHandle = await targetDirectoryHandle.getDirectoryHandle(sourceName, { create: true });
      await copyDirectoryRecursive(sourceHandle, folderHandle);
    }

    await sourceParentHandle.removeEntry(sourceName, { recursive: true });
    await this.refresh();

    this._emit('operation', {
      type: 'move',
      entryName: sourceName,
      targetPath: this.getCurrentFolderPath()
    });
  }

  destroy() {
    this.container.innerHTML = '';
  }

  _renderShell() {
    this.container.classList.add('bs-file-browser');
    this.container.classList.toggle('fullscreen', this.mode === 'fullscreen');
    this.container.innerHTML = `
      <div class="fb-header">
        <strong>${this.title}</strong>
        <button type="button" data-fb-action="pick">Pick Folder</button>
      </div>
      <div class="fb-toolbar">
        <div class="fb-breadcrumb" data-fb-breadcrumb></div>
        <div class="fb-status" data-fb-status>Awaiting permission</div>
      </div>
      <ul class="fb-list" data-fb-list></ul>
    `;

    this.elements = {
      pickButton: this.container.querySelector('[data-fb-action="pick"]'),
      breadcrumb: this.container.querySelector('[data-fb-breadcrumb]'),
      status: this.container.querySelector('[data-fb-status]'),
      list: this.container.querySelector('[data-fb-list]')
    };
  }

  _bindEvents() {
    this.elements.pickButton.addEventListener('click', async () => {
      try {
        await this.requestAccess();
      } catch (err) {
        this._emitError(err);
      }
    });

    this.elements.breadcrumb.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-index]');
      if (!button) return;
      await this.goToPathIndex(Number(button.dataset.index));
    });

    this.elements.list.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      const entryElement = event.target.closest('[data-entry-name]');
      if (!entryElement || !button) return;

      const name = entryElement.dataset.entryName;
      const action = button.dataset.action;

      try {
        if (action === 'open') {
          await this.openFolder(name);
        }

        if (action === 'rename') {
          const nextName = window.prompt('Rename entry', name);
          if (nextName) {
            await this.renameEntry(name, nextName);
          }
        }

        if (action === 'delete') {
          const accepted = window.confirm(`Delete ${name}?`);
          if (accepted) {
            await this.deleteEntry(name);
          }
        }
      } catch (err) {
        this._emitError(err);
      }
    });

    this.elements.list.addEventListener('dblclick', async (event) => {
      const entryElement = event.target.closest('[data-entry-name]');
      if (!entryElement) return;
      const name = entryElement.dataset.entryName;
      const kind = entryElement.dataset.entryKind;

      this._emit('selectionchange', {
        name,
        kind,
        path: this.getCurrentFolderPath()
      });

      if (kind === 'directory') {
        await this.openFolder(name);
      }
    });

    this.elements.list.addEventListener('dragstart', (event) => {
      const entryElement = event.target.closest('[data-entry-name]');
      if (!entryElement) return;

      const entry = this.state.entries.find((item) => item.name === entryElement.dataset.entryName);
      if (!entry) return;

      const dragId = registerDragPayload({
        source: 'file-browser',
        panel: this,
        sourceName: entry.name,
        sourceKind: entry.kind,
        sourceHandle: entry.handle,
        sourceParentHandle: this.state.currentHandle,
        sourcePath: `${this.getCurrentFolderPath()}/${entry.name}`
      });

      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(DRAG_MIME, dragId);
      event.dataTransfer.setData('text/plain', entry.name);
    });

    this.elements.list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const row = event.target.closest('[data-entry-kind="directory"]');
      this._clearDropHints();
      if (row) row.classList.add('drop-target');
    });

    this.elements.list.addEventListener('dragleave', (event) => {
      if (event.target === this.elements.list) {
        this._clearDropHints();
      }
    });

    this.elements.list.addEventListener('drop', async (event) => {
      event.preventDefault();
      this._clearDropHints();

      const row = event.target.closest('[data-entry-kind="directory"]');
      const destination = row
        ? this.state.entries.find((item) => item.name === row.dataset.entryName)?.handle
        : this.state.currentHandle;

      try {
        await this._handleDrop(event, destination);
      } catch (err) {
        this._emitError(err);
      }
    });
  }

  _renderEntries() {
    this._renderBreadcrumb();
    this.elements.status.textContent = `${this.state.entries.length} item(s)`;

    if (!this.state.entries.length) {
      this._renderEmpty('No files or folders in this directory.');
      return;
    }

    this.elements.list.innerHTML = this.state.entries
      .map((entry) => {
        const icon = entry.kind === 'directory' ? '📁' : '📄';

        return `
          <li
            class="fb-entry ${entry.kind === 'directory' ? 'folder' : 'file'}"
            data-entry-name="${entry.name}"
            data-entry-kind="${entry.kind}"
            draggable="true"
          >
            <span class="fb-name">${icon} ${entry.name}</span>
            <span class="fb-entry-actions">
              ${entry.kind === 'directory' ? '<button type="button" data-action="open">Open</button>' : ''}
              <button type="button" data-action="rename">Rename</button>
              <button type="button" class="danger" data-action="delete">Delete</button>
            </span>
          </li>
        `;
      })
      .join('');
  }

  _renderBreadcrumb() {
    this.elements.breadcrumb.innerHTML = this.state.pathStack
      .map((segment, index) => {
        const active = index === this.state.pathStack.length - 1;
        return `<button type="button" data-index="${index}" class="${active ? 'active' : ''}">${segment.name}</button>`;
      })
      .join('');
  }

  _renderEmpty(message) {
    this._renderBreadcrumb();
    this.elements.list.innerHTML = `<li class="fb-empty">${message}</li>`;
    this.elements.status.textContent = message;
  }

  _clearDropHints() {
    this.elements.list.querySelectorAll('.drop-target').forEach((node) => node.classList.remove('drop-target'));
  }

  async _handleDrop(event, destinationHandle) {
    if (!destinationHandle) {
      throw new Error('Drop destination is missing.');
    }

    const files = [...(event.dataTransfer.files || [])];
    if (files.length > 0) {
      for (const file of files) {
        await this.importBrowserFile(file, { targetHandle: destinationHandle });
      }

      await this.refresh();
      this._emit('operation', {
        type: 'import-browser-files',
        count: files.length,
        targetPath: this.getCurrentFolderPath()
      });
      return;
    }

    const dragId = event.dataTransfer.getData(DRAG_MIME);
    if (!dragId) return;

    const payload = consumeDragPayload(dragId);
    if (!payload) return;

    if (payload.source === 'file-browser') {
      await payload.panel.moveEntryToDirectory({
        sourceName: payload.sourceName,
        sourceHandle: payload.sourceHandle,
        sourceParentHandle: payload.sourceParentHandle,
        targetDirectoryHandle: destinationHandle
      });

      if (payload.panel !== this) {
        await this.refresh();
      }

      return;
    }

    if (payload.source === 'file-sync') {
      const file = await payload.panel.exportFile(payload.fileId);
      await this.importBrowserFile(file, { targetHandle: destinationHandle });
      await this.refresh();

      this._emit('operation', {
        type: 'copy-from-sync',
        fileName: file.name,
        targetPath: this.getCurrentFolderPath()
      });
    }
  }

  async _resolveDirectory(path) {
    if (!path || path === '.') return this.state.currentHandle;

    const tokens = path.split('/').filter(Boolean);
    let current = path.startsWith('/') ? this.state.rootHandle : this.state.currentHandle;

    for (const token of tokens) {
      current = await current.getDirectoryHandle(token);
    }

    return current;
  }

  _emit(eventName, detail) {
    this.dispatchEvent(new CustomEvent(eventName, { detail }));

    const callbackMap = {
      ready: 'onReady',
      error: 'onError',
      operation: 'onOperation',
      entrieschange: 'onEntriesChange',
      selectionchange: 'onSelectionChange'
    };

    const callback = this.callbacks[callbackMap[eventName]];
    if (typeof callback === 'function') {
      callback(detail);
    }
  }

  _emitError(err) {
    this._emit('error', {
      message: err.message,
      cause: err
    });
  }
}

export default FileBrowserPanel;
