// server.js — OpenCode Relay v2 main entry point
// Manages DB copy, opencode serve lifecycle, HTTP routing, and graceful shutdown

const http = require('http');
const os = require('os');
const path = require('path');

// ─── 1. Early signal capture (before anything else) ───────────────────────
let shutdown = () => process.exit(0);
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

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

  // ─── 10. Override shutdown with full cleanup ────────────────────────────
  shutdown = async () => {
    console.log('\n[relay] Shutting down...');
    server.close();
    await opener.stopOpencode(opencodeProc).catch(() => {});
    opener.removeRelayDB();
    opener.removeTokenFile();
    console.log('[relay] Goodbye');
    process.exit(0);
  };
}

// ─── Boot ─────────────────────────────────────────────────────────────────
startup().catch(err => {
  console.error('[relay] Fatal startup error:', err.message);
  process.exit(1);
});
