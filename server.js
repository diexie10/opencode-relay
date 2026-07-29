// server.js — OpenCode Relay v2 main entry point
// Manages DB copy, opencode serve lifecycle, HTTP routing, and graceful shutdown

const http = require('http');
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
  opener.removeRelayDB();
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

const PORT = process.env.PORT || 3456;

// ─── 4-6. Startup sequence ────────────────────────────────────────────────
async function startup() {
  // 4. Ensure relay-data/ exists, clean old DB, copy Desktop DB
  opener.ensureRelayDataDir();
  opener.cleanupOldDB();
  opener.copyDesktopDB();

  // 5. Start opencode serve subprocess
  console.log('[relay] Starting opencode serve...');
  let opencodeProc;
  try {
    opencodeProc = opener.startOpencode(auth.OPCODE_PASSWORD);
    procRef = opencodeProc;  // expose to signal handler
  } catch (err) {
    console.error('[relay] Failed to spawn opencode serve:', err.message);
    process.exit(1);
  }

  // 6. Wait for health check
  try {
    await opener.waitForReady(auth.OPCODE_PASSWORD);
  } catch (err) {
    console.error('[relay] opencode serve health check failed:', err.message);
    opener.stopOpencode(opencodeProc).catch(() => {});
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

  // ─── 7. HTTP server ─────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    try {
      // Health check — no auth required
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, opencode: 'healthy' }));
        return;
      }

      // Setup API — set password via web UI (no auth required, only once)
      if (req.url === '/api/setup/status' && req.method === 'GET') {
        const { loadConfig } = require('./lib/config');
        const configured = !!(process.env.OC_RELAY_PASSWORD || loadConfig().password);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configured }));
        return;
      }

      if (req.url === '/api/setup' && req.method === 'POST') {
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
      if (req.url === '/api/login' && req.method === 'POST') {
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
      if (req.url === '/api/models' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const { getCapabilities } = require('./lib/models');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getCapabilities()));
        return;
      }

      // Directory scan — auth required, scans Desktop for opencode.jsonc
      if (req.url === '/api/scan-directories' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const fs = require('fs');
        const scanned = [];
        // Scan Desktop: find directories that ARE projects (have opencode.jsonc)
        // or directories that CONTAIN projects (backup containers like opencode还原点)
        function scanDir(dir, depth) {
          if (depth > 3) return;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              if (!e.isDirectory()) continue;
              if (e.name.startsWith('.')) continue;
              if (e.name === 'node_modules' || e.name === 'relay-data' || e.name === '.git') continue;
              const full = path.join(dir, e.name);
              // Direct project: has opencode.jsonc
              if (fs.existsSync(path.join(full, 'opencode.jsonc')) || fs.existsSync(path.join(full, '.opencode.jsonc'))) {
                scanned.push(full);
                // Don't recurse into actual projects
                continue;
              }
              // Container: check if any immediate child is a project
              try {
                const children = fs.readdirSync(full, { withFileTypes: true });
                const hasProjectChild = children.some(c =>
                  c.isDirectory() && (
                    fs.existsSync(path.join(full, c.name, 'opencode.jsonc')) ||
                    fs.existsSync(path.join(full, c.name, '.opencode.jsonc'))
                  )
                );
                if (hasProjectChild) {
                  // This dir is a project container — list it, don't recurse further
                  scanned.push(full);
                  continue;
                }
              } catch {}
              // Otherwise recurse deeper
              scanDir(full, depth + 1);
            }
          } catch {}
        }
        scanDir(path.join(os.homedir(), 'Desktop'), 0);
        // Also add Desktop itself if it's a project
        const desktopPath = path.join(os.homedir(), 'Desktop');
        if (!scanned.includes(desktopPath)) {
          scanned.push(desktopPath);
        }
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
