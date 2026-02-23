import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '../..');

const mimeMap = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  const urlPath = req.url === '/' ? '/apps/demo/index.html' : req.url;
  const filePath = path.normalize(path.join(workspaceRoot, urlPath));

  if (!filePath.startsWith(workspaceRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = mimeMap[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (_err) {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const port = Number(process.env.PORT || 4173);
server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Demo server running at http://localhost:${port}`);
});
