# Browser Sync Workspace

Two browser libraries are included and designed to work together with drag-and-drop move semantics:

1. `@browser-sync/file-browser`
2. `@browser-sync/file-sync`

## Packages

### `@browser-sync/file-browser`
A web file explorer panel backed by the File System Access API.

Features:
- Folder permission via `showDirectoryPicker`
- File/folder list, open folder, rename, delete
- Drag & drop move support:
  - within file browser
  - from file browser -> sync panel
  - from sync panel -> file browser
- API for load/save and metadata
- Event + callback integration for host apps
- Responsive layout (panel/fullscreen)

### `@browser-sync/file-sync`
A room/namespace-based sync panel for browser peers.

Features:
- Drag files into panel and sync to peers in same `namespace/room`
- Chunked transport progress UI per file (upload/download %, speed, ETA, retry state)
- Local persistence with OPFS (or IndexedDB fallback)
- WebPEER-aware transport adapter (with BroadcastChannel fallback for local testing)
- Drag & drop move support with file browser
- API to add/export/remove files + metadata
- Event + callback integration
- Default STUN: `stun:stun.l.google.com:19302`

## Quick Start

```bash
npm install
npm run start:demo
```

Open `http://localhost:4173/apps/demo/index.html`

## Demo

- Left: local file browser panel
- Right: sync room panel
- Header controls: choose sync mode
  - `Local Fallback (BroadcastChannel)` for same-browser testing
  - `Actual Signaling (WebSocket Server)` for real signaling path (`ws://localhost:8787/signal`)
- Drag files left->right to copy local files into synced room storage
- Drag files right->left to copy synced files to local folder
- In demo integration, explicit delete from either panel removes from sync room

## API Snapshot

### FileBrowserPanel

```js
import { FileBrowserPanel } from '/packages/file-browser/src/index.js';

const browser = new FileBrowserPanel({
  container: '#browser',
  callbacks: {
    onOperation: console.log,
    onError: console.error
  }
});

await browser.requestAccess();
await browser.saveFile('hello.txt', 'hello');
const text = await browser.loadFile('hello.txt', { as: 'text' });
const metadata = await browser.getMetadata('hello.txt');
```

Events:
- `ready`
- `error`
- `operation`
- `entrieschange`
- `selectionchange`

### FileSyncPanel

```js
import { FileSyncPanel } from '/packages/file-sync/src/index.js';

const sync = new FileSyncPanel({
  container: '#sync',
  namespace: 'globalroom',
  room: 'public',
  signalingUrl: 'wss://signal.example.com/signal',
  bootstrapUrl: 'https://signal.example.com/bootstrap'
});

await sync.connect({ namespace: 'invite', room: 'ABCD-1234', token: 'signed-token' });
```

`webpeer.js` integration example (`https://webpeer.js.org`):

```js
import * as WebPeer from 'https://cdn.jsdelivr.net/npm/webpeer/+esm';

const sync = new FileSyncPanel({
  container: '#sync',
  namespace: 'globalroom',
  room: 'public',
  webPeerClient: WebPeer,
  signalingUrl: 'wss://signal.example.com/signal',
  bootstrapUrl: 'https://signal.example.com/bootstrap'
});
```

Events:
- `ready`
- `error`
- `statechange`
- `fileschange`
- `sync`

## Production Infra / Service Design

See:
- `docs/architecture.md`
- `server/bootstrap-signaling/src/server.js`
- `server/bootstrap-signaling/src/rendezvous.js`
- `infra/turn/turnserver.conf`
- `infra/k8s/*.yaml`

Includes:
- Bootstrap + signaling server (auth, rate-limit, telemetry, metrics)
- Room/namespace model (`global` public room + invite room)
- TURN (coturn) deployment examples
- Discovery via rendezvous registry (libp2p concept mapping)
- Monitoring metrics for ICE success/failure, relay usage, region/carrier

## Notes

- File browser requires File System Access API capable browsers.
- WebPEER transport adapter is pluggable: provide actual WebPEER client or `createPeer` factory for production.
- This workspace is intentionally minimal and framework-agnostic.
