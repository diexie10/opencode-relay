// server.js — OpenCode Relay v2 main entry point
// Manages DB lifecycle, opencode serve lifecycle, HTTP routing, and graceful shutdown
// Plan A: independent persistent DB + project import/export

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

// --- 1. Module-level refs for signal handler ---
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

// --- 2. Banner ---
console.log('');
console.log('  OpenCode Relay v2');
console.log('  ──────────────────────────────────');

// --- 3. Modules ---
const auth = require('./lib/auth');
const { proxyRequest } = require('./lib/proxy');
const { handleSSE } = require('./lib/sse-tunnel');
const { serveStatic } = require('./lib/static');
const opener = require('./lib/opener');

const PORT = process.env.PORT || 3456;

// --- Project import helpers ---

// Directories to exclude when importing a project
const IMPORT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
  'target', '__pycache__', '.cache', '.vscode', '.idea',
  '.gradle', 'vendor', 'Pods', '.swiftpm',
]);
const IMPORT_EXCLUDE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.npmrc', '.env.local',
]);

// Filter function for fs.cpSync — excludes heavy/unnecessary dirs and files
function importFilter(src) {
  const basename = path.basename(src);
  // Exclude by directory name (checked against path segments)
  if (IMPORT_EXCLUDE_DIRS.has(basename)) return false;
  // Exclude by file name
  if (IMPORT_EXCLUDE_FILES.has(basename)) return false;
  // Exclude log files
  if (basename.endsWith('.log')) return false;
  // Exclude .pyc files
  if (basename.endsWith('.pyc')) return false;
  return true;
}

// System directories that should never be imported
const SYSTEM_DIRS = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
  'C:\\ProgramData', 'C:\\System Volume Information',
];

// Validate that a path is safe to import
function validateImportPath(srcPath) {
  // Must be absolute
  if (!path.isAbsolute(srcPath)) {
    return { ok: false, error: '路径必须是绝对路径' };
  }
  // Must exist and be a directory
  try {
    const stat = fs.statSync(srcPath);
    if (!stat.isDirectory()) {
      return { ok: false, error: '路径不是目录' };
    }
  } catch {
    return { ok: false, error: '路径不存在' };
  }
  // Must not be a system directory or inside one
  const resolved = path.resolve(srcPath);
  for (const sysDir of SYSTEM_DIRS) {
    if (resolved === sysDir || resolved.startsWith(sysDir + path.sep)) {
      return { ok: false, error: '不能导入系统目录' };
    }
  }
  // Must not be inside relay-data (prevent self-import)
  const relayDataDir = path.resolve(opener.RELAY_DATA_DIR);
  if (resolved === relayDataDir || resolved.startsWith(relayDataDir + path.sep)) {
    return { ok: false, error: '不能导入 relay-data 目录' };
  }
  return { ok: true };
}

// List imported projects in relay-data/projects/
function listImportedProjects() {
  const projectsDir = opener.PROJECTS_DIR;
  const result = [];
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const fullPath = path.join(projectsDir, e.name);
        result.push({ name: e.name, path: fullPath });
      }
    }
  } catch {}
  return result;
}

// --- 4-6. Startup sequence ---
async function startup() {
  // 4. Ensure relay-data/ exists (includes projects/ subdir)
  opener.ensureRelayDataDir();
  opener.cleanupOldDB();
  opener.copyDesktopDB();

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

  // --- Auth middleware ---
  function authMiddleware(req, res) {
    if (!auth.authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return false;
    }
    return true;
  }

  // --- Helper: read JSON body from request ---
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('invalid_json')); }
      });
      req.on('error', reject);
    });
  }

  // --- 7. HTTP server ---
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

      // Workspace — returns the fixed mobile workspace path
      if (urlPath === '/api/workspace' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: opener.PROJECTS_DIR }));
        return;
      }

      // Directory scan — auth required, scans Desktop for import candidates only
      // (does NOT include the mobile workspace or imported projects)
      if (urlPath === '/api/scan-directories' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
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

      // --- Project import endpoints (Plan A) ---

      // List imported projects
      if (urlPath === '/api/project/imported' && req.method === 'GET') {
        if (!authMiddleware(req, res)) return;
        const projects = listImportedProjects();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(projects));
        return;
      }

      // Import a project: copy source directory to relay-data/projects/<name>/
      if (urlPath === '/api/project/import' && req.method === 'POST') {
        if (!authMiddleware(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const srcPath = body.path;
          if (!srcPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '缺少 path 参数' }));
            return;
          }
          // Validate path
          const validation = validateImportPath(srcPath);
          if (!validation.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: validation.error }));
            return;
          }
          // Determine target directory name
          const projectName = path.basename(path.resolve(srcPath));
          // Sanitize: remove invalid characters
          const safeName = projectName.replace(/[<>:"/\\|?*]/g, '_');
          if (!safeName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '无效的项目名称' }));
            return;
          }
          const targetPath = path.join(opener.PROJECTS_DIR, safeName);
          // Check if target already exists
          if (fs.existsSync(targetPath)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '项目已存在: ' + safeName, name: safeName, path: targetPath }));
            return;
          }
          // Copy the directory with exclusions
          console.log('[import] Copying ' + srcPath + ' -> ' + targetPath);
          const startTime = Date.now();
          fs.cpSync(srcPath, targetPath, {
            recursive: true,
            filter: importFilter,
          });
          const elapsed = Date.now() - startTime;
          // Count files copied
          let fileCount = 0;
          function countFiles(dir) {
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const e of entries) {
                if (e.isDirectory()) countFiles(path.join(dir, e.name));
                else fileCount++;
              }
            } catch {}
          }
          countFiles(targetPath);
          console.log('[import] Done: ' + fileCount + ' files in ' + elapsed + 'ms');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            name: safeName,
            path: targetPath,
            files: fileCount,
            elapsed_ms: elapsed,
          }));
        } catch (err) {
          console.error('[import] Error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '导入失败: ' + err.message }));
        }
        return;
      }

      // Delete an imported project
      // URL pattern: /api/project/imported/:name
      if (urlPath.startsWith('/api/project/imported/') && req.method === 'DELETE') {
        if (!authMiddleware(req, res)) return;
        const projectName = decodeURIComponent(urlPath.slice('/api/project/imported/'.length));
        // Validate name: no path separators, no ".."
        if (!projectName || projectName.includes('/') || projectName.includes('\\') || projectName.includes('..')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '无效的项目名称' }));
          return;
        }
        const targetPath = path.join(opener.PROJECTS_DIR, projectName);
        // Security: ensure target is inside projects dir
        const projectsDir = path.resolve(opener.PROJECTS_DIR);
        const resolved = path.resolve(targetPath);
        if (!resolved.startsWith(projectsDir + path.sep) && resolved !== projectsDir) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '禁止访问' }));
          return;
        }
        if (!fs.existsSync(targetPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '项目不存在' }));
          return;
        }
        try {
          fs.rmSync(targetPath, { recursive: true, force: true });
          console.log('[import] Deleted project: ' + projectName);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, name: projectName }));
        } catch (err) {
          console.error('[import] Delete error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '删除失败: ' + err.message }));
        }
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

  // --- 8. Listen ---
  server.listen(PORT, '0.0.0.0', () => {
    console.log('  Server:    http://0.0.0.0:' + PORT);
    console.log('  Token:     ' + auth.TOKEN);
    console.log('');

    // Detect network interfaces and print URLs
    const nets = os.networkInterfaces();
    const addresses = [];

    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push({ name, address: net.address });
          const tokenUrl = 'http://' + net.address + ':' + PORT + '?token=' + auth.TOKEN;
          console.log('  ' + name.padEnd(14) + ' ' + tokenUrl);
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
        ? addresses.find(a => a.address.startsWith('100.'))
          || addresses[0].address
        : '127.0.0.1';
      const qrUrl = 'http://' + primaryIP + ':' + PORT + '?token=' + auth.TOKEN;
      qrcode.generate(qrUrl, { small: true });
      console.log('');
    } catch {
      // qrcode-terminal not available
    }
  });
}

// --- Boot ---
startup().catch(err => {
  console.error('[relay] Fatal startup error:', err.message);
  process.exit(1);
});
