// server.js — OpenCode Relay v2 main entry point
// Manages DB copy, opencode serve lifecycle, HTTP routing, and graceful shutdown

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── 1. Module-level refs for signal handler ───────────────────────────────
// Set up the handler immediately with null refs; refs are populated as
// startup() progresses, so no "unprotected window" exists.
let procRef = null;
let serverRef = null;

process.on('SIGINT', async () => {
  console.log('\n[relay] Shutting down...');
  if (serverRef) serverRef.close();
  if (procRef) await opener.stopOpencode(procRef).catch(() => {});
  opener.removeRelayDB(); // cleans WAL/SHM, preserves relay.db
  opener.removeTokenFile();
  console.log('[relay] Goodbye');
  process.exit(0);
});
process.on('SIGTERM', () => process.emit('SIGINT'));

// ─── 2. Banner ───────────────────────────────────────────────────────────
console.log('');
console.log('  OpenCode Relay v2');
console.log('  ──────────────────────────────────');

// ─── 3. Modules ──────────────────────────────────────────────────────────
const auth = require('./lib/auth');
const { proxyRequest } = require('./lib/proxy');
const { handleSSE } = require('./lib/sse-tunnel');
const { serveStatic } = require('./lib/static');
const opener = require('./lib/opener');
const { PROJECTS_DIR, RELAY_DATA_DIR } = opener;

const PORT = process.env.PORT || 3456;

// ─── 4-6. Startup sequence ────────────────────────────────────────────────
async function startup() {
  // 4. Ensure relay-data/ exists, clean WAL/SHM, prepare projects/ dir
  opener.ensureRelayDataDir();
  opener.cleanupOldDB();

  // 5. Start opencode serve subprocess
  console.log('[relay] Starting opencode serve on 127.0.0.1:' + opener.OPCODE_PORT + '...');
  let opencodeProc;
  try {
    opencodeProc = opener.startOpencode(auth.OPCODE_PASSWORD);
    procRef = opencodeProc;
  } catch (err) {
    console.error('[relay] Failed to spawn opencode serve:', err.message);
    process.exit(1);
  }

  // 6. Wait for health check
  try {
    await opener.waitForReady(auth.OPCODE_PASSWORD);
  } catch (err) {
    console.error('[relay] opencode serve health check failed:', err.message);
    if (opencodeProc) opener.stopOpencode(opencodeProc).catch(() => {});
    process.exit(1);
  }

  // ─── Auth middleware ────────────────────────────────────────────────────
  function authMiddleware(req, res) {
    if (!auth.authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return false;
    }
    return true;
  }

  // ─── Project import filter ──────────────────────────────────────────────
  const IMPORT_EXCLUDE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
    'target', '__pycache__', '.cache', '.vscode', '.idea',
    '.gradle', 'vendor', 'Pods', '.swiftpm',
  ]);
  const IMPORT_EXCLUDE_FILES = new Set([
    '.DS_Store', 'Thumbs.db', '.npmrc', '.env.local',
  ]);

  function validateImportPath(srcPath) {
    if (!path.isAbsolute(srcPath)) return '路径必须是绝对路径';
    if (!fs.existsSync(srcPath)) return '路径不存在';
    if (!fs.statSync(srcPath).isDirectory()) return '路径必须是目录';
    // System directory blacklist
    const sysDirs = [
      'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
      'C:\\ProgramData', 'C:\\Users\\All Users',
    ];
    const resolved = path.resolve(srcPath);
    for (const sd of sysDirs) {
      if (resolved.toLowerCase().startsWith(sd.toLowerCase() + path.sep) || resolved.toLowerCase() === sd.toLowerCase()) {
        return '禁止导入系统目录';
      }
    }
    // Prevent self-referencing relay-data
    const relayDataResolved = path.resolve(RELAY_DATA_DIR);
    if (resolved === relayDataResolved || resolved.startsWith(relayDataResolved + path.sep)) {
      return '禁止导入 relay-data 目录';
    }
    return null;
  }

  function sanitizeProjectName(srcPath) {
    const name = path.basename(path.resolve(srcPath));
    // Remove Windows illegal filename characters
    return name.replace(/[<>:"/\\|?*]/g, '_');
  }

  function countFiles(dir) {
    let count = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (IMPORT_EXCLUDE_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          count += countFiles(full);
        } else if (e.isFile()) {
          if (IMPORT_EXCLUDE_FILES.has(e.name)) continue;
          const ext = path.extname(e.name).toLowerCase();
          if (ext === '.log' || ext === '.pyc') continue;
          count++;
        }
      }
    } catch {}
    return count;
  }

  function copyFiltered(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const e of entries) {
      if (IMPORT_EXCLUDE_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) {
        copyFiltered(s, d);
      } else if (e.isFile()) {
        if (IMPORT_EXCLUDE_FILES.has(e.name)) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (ext === '.log' || ext === '.pyc') continue;
        fs.cpSync(s, d, { recursive: false });
      }
    }
  }

  // ─── 7. HTTP server ─────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = req.url.split('?')[0];

      // Health check — no auth required
      if (urlPath === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, opencode: 'healthy' }));
        return;
      }

      // Setup API — set password via web UI (no auth required, only once)
      if (urlPath === '/api/setup/status' && req.method === 'GET') {
        const { loadConfig } = require('./lib/config');
        const configured = !!(process.env.OC_RELAY_PASSWORD || loadConfig().password);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured }));
        return;
      }

      if (urlPath === '/api/setup' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { password } = JSON.parse(body);
            if (!password || password.length < 4) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'password_min_length' }));
              return;
            }
            const { saveConfig } = require('./lib/config');
            saveConfig({ password });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: '密码已保存，请重启 Relay' }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
          }
        });
        return;
      }

      // Login API — validate password, return token (no auth required)
      if (urlPath === '/api/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const { password } = JSON.parse(body);
            if (!password) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'password_required' }));
              return;
            }
            const { loadConfig } = require('./lib/config');
            const { deriveToken } = require('./lib/auth');
            const expectedPassword = process.env.OC_RELAY_PASSWORD || loadConfig().password;
            if (!expectedPassword) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'not_configured' }));
              return;
            }
            if (password !== expectedPassword) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_password' }));
              return;
            }
            const token = deriveToken(password);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, token }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
          }
        });
        return;
      }

      // Models config endpoint — auth required
      if (urlPath === '/api/models' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const { getCapabilities } = require('./lib/models');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(await getCapabilities()));
        return;
      }

      // Relay status — auth required, comprehensive health snapshot
      if (urlPath === '/api/relay/status' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const { collectStatus } = require('./lib/status');
        const status = await collectStatus(procRef);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status, null, 2));
        return;
      }

      // ─── Project import API ─────────────────────────────────────────────
      // POST /api/project/import — import a project directory
      if (urlPath === '/api/project/import' && req.method === 'POST') {
        if (!authMiddleware(req, res)) return;
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const { path: srcPath } = JSON.parse(body);
            const err = validateImportPath(srcPath);
            if (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err }));
              return;
            }
            const name = sanitizeProjectName(srcPath);
            const dest = path.join(PROJECTS_DIR, name);
            if (fs.existsSync(dest)) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: '项目已存在: ' + name, name, path: dest }));
              return;
            }
            const t0 = Date.now();
            copyFiltered(srcPath, dest);
            const fileCount = countFiles(dest);
            const elapsed = Date.now() - t0;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, name, path: dest, files: fileCount, elapsed_ms: elapsed }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '导入失败: ' + e.message }));
          }
        });
        return;
      }

      // GET /api/project/imported — list imported projects
      if (urlPath === '/api/project/imported' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const list = [];
        try {
          const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) {
              list.push({ name: e.name, path: path.join(PROJECTS_DIR, e.name) });
            }
          }
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }

      // DELETE /api/project/imported/:name — delete an imported project
      const importDelMatch = urlPath.match(/^\/api\/project\/imported\/([^/]+)$/);
      if (importDelMatch && req.method === 'DELETE') {
        if (!authMiddleware(req, res)) return;
        let name = importDelMatch[1];
        // Security: prevent path traversal
        if (name.includes('/') || name.includes('\\') || name.includes('..')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '无效的项目名称' }));
          return;
        }
        const target = path.resolve(path.join(PROJECTS_DIR, name));
        if (!target.startsWith(PROJECTS_DIR + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '禁止访问' }));
          return;
        }
        if (!fs.existsSync(target)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '项目不存在' }));
          return;
        }
        try {
          fs.rmSync(target, { recursive: true, force: true });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '删除失败: ' + e.message }));
        }
        return;
      }

      // Directory scan — auth required, scans Desktop + imported projects
      if (urlPath === '/api/scan-directories' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const scanned = [];
        // Scan Desktop: find directories that ARE projects (have opencode.jsonc)
        function scanDir(dir, depth) {
          if (depth > 3) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              if (!e.isDirectory()) continue;
              if (e.name.startsWith('.')) continue;
              if (e.name === 'node_modules' || e.name === 'relay-data' || e.name === '.git') continue;
              const full = path.join(dir, e.name);
              if (fs.existsSync(path.join(full, 'opencode.jsonc')) || fs.existsSync(path.join(full, '.opencode.jsonc'))) {
                scanned.push(full);
                continue;
              }
              try {
                const children = fs.readdirSync(full, { withFileTypes: true });
                const hasProjectChild = children.some(c =>
                  c.isDirectory() && (
                    fs.existsSync(path.join(full, c.name, 'opencode.jsonc')) ||
                    fs.existsSync(path.join(full, c.name, '.opencode.jsonc'))
                  )
                );
                if (hasProjectChild) {
                  scanned.push(full);
                  continue;
                }
              } catch {}
              scanDir(full, depth + 1);
            }
          } catch {}
        }
        scanDir(path.join(os.homedir(), 'Desktop'), 0);
        // Desktop itself
        const desktopPath = path.join(os.homedir(), 'Desktop');
        if (!scanned.includes(desktopPath)) scanned.push(desktopPath);
        // Imported projects
        try {
          const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) {
              scanned.push(path.join(PROJECTS_DIR, e.name));
            }
          }
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(scanned));
        return;
      }

      // API proxy — auth required
      if (req.url.startsWith('/api/')) {
        if (!authMiddleware(req, res)) return;
        await proxyRequest(req, res);
        return;
      }

      // SSE tunnel — auth required
      if (req.url.startsWith('/sse/')) {
        if (!authMiddleware(req, res)) return;
        handleSSE(req, res);
        return;
      }

      // Static files (SPA fallback handled inside)
      serveStatic(req, res);
    } catch (err) {
      console.error('[relay] Request error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    }
  });
  serverRef = server;

  // ─── 8. Listen ──────────────────────────────────────────────────────────
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`  Server:    http://0.0.0.0:${PORT}`);
    console.log(`  Token:     ${auth.TOKEN}`);
    console.log('');

    // Detect network interfaces and print URLs
    const nets = os.networkInterfaces();
    const addresses = [];

    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push({ name, address: net.address });
          const tokenUrl = `http://${net.address}:${PORT}?token=${auth.TOKEN}`;
          console.log(`  ${name.padEnd(14)} ${tokenUrl}`);
        }
      }
    }

    console.log('  ──────────────────────────────────');
    console.log('  Open this URL on your mobile device');
    console.log('');

    // QR code
    try {
      const qrcode = require('qrcode-terminal');
      const primaryIP = addresses.length > 0
        ? addresses.find(a => a.address.startsWith('100.'))  // Tailscale preferred
          || addresses[0].address
        : '127.0.0.1';
      const qrUrl = `http://${primaryIP}:${PORT}?token=${auth.TOKEN}`;
      qrcode.generate(qrUrl, { small: true });
      console.log('');
    } catch {
      // qrcode-terminal not available
    }
  });

  // Signal handler already set up at module level (see §1)
}

// ─── Boot ─────────────────────────────────────────────────────────────────
startup().catch(err => {
  console.error('[relay] Fatal startup error:', err.message);
  process.exit(1);
});
