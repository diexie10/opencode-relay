// lib/opener.js — opencode serve lifecycle manager + DB copy
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ENDPOINTS } = require('./api-config');

// Use a different port than Desktop OpenCode app (which uses 4097)
const OPCODE_PORT = 4098;
const HEALTH_CHECK_TIMEOUT = 30_000;  // 30s max wait for health
const HEALTH_CHECK_INTERVAL = 1_000;  // poll every 1s
const MAX_RESTARTS = 3;
const RESTART_DELAYS = [1000, 3000, 8000]; // exponential backoff (ms)
const SHUTDOWN_TIMEOUT = 5_000; // 5s wait for graceful shutdown

// ─── DB paths ────────────────────────────────────────────────────────────
const RELAY_DATA_DIR = path.resolve(__dirname, '..', 'relay-data');
const RELAY_DB_PATH   = path.join(RELAY_DATA_DIR, 'relay.db');
const PROJECTS_DIR    = path.join(RELAY_DATA_DIR, 'projects');
const DESKTOP_DB_PATH  = path.join(
  os.homedir(), '.local', 'share', 'opencode', 'opencode.db'
);

// ─── DB lifecycle ────────────────────────────────────────────────────────

// Ensure relay-data/, logs/, and projects/ directories exist
function ensureRelayDataDir() {
  fs.mkdirSync(RELAY_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(RELAY_DATA_DIR, 'logs'), { recursive: true });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

// Remove old relay.db WAL/SHM files if they exist.
// Preserve relay.db itself for persistence across restarts.
// Set OC_RELAY_RESET_DB=1 to also delete relay.db for a clean slate.
function cleanupOldDB() {
  const resetDB = !!(process.env.OC_RELAY_RESET_DB);
  let removed = 0;

  // Always clean WAL/SHM (stale from unclean shutdowns)
  ['-wal', '-shm'].forEach(suffix => {
    const p = RELAY_DB_PATH + suffix;
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed++;
      }
    } catch (err) {
      if (err.code === 'EBUSY') {
        console.warn(`[db] Could not remove ${path.basename(p)} (locked by another process, continuing)`);
      } else {
        throw err;
      }
    }
  });

  // Only delete relay.db itself if OC_RELAY_RESET_DB=1
  if (resetDB) {
    try {
      if (fs.existsSync(RELAY_DB_PATH)) {
        fs.unlinkSync(RELAY_DB_PATH);
        removed++;
        console.log('[db] OC_RELAY_RESET_DB=1 — removed relay.db for clean slate');
      }
    } catch (err) {
      if (err.code === 'EBUSY') {
        console.warn(`[db] Could not remove relay.db (locked by opencode serve, continuing)`);
      } else {
        throw err;
      }
    }
  }

  if (removed > 0) console.log(`[db] Cleaned up ${removed} file(s)`);
}

// Copy Desktop opencode.db → relay-data/relay.db
// Desktop DB uses WAL mode and is actively written by the Desktop app,
// making raw copyFileSync produce inconsistent snapshots. We skip the
// copy and let opencode serve create a fresh DB instead.
// Returns true if no Desktop DB found (start with empty DB), false if
// Desktop DB exists but we deliberately skip it.
function copyDesktopDB() {
  if (!fs.existsSync(DESKTOP_DB_PATH)) {
    console.log('[db] Desktop opencode.db not found, starting with fresh DB');
    return false;
  }

  const stat = fs.statSync(DESKTOP_DB_PATH);
  console.log(`[db] Desktop DB size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  console.log('[db] Skipping copy — Desktop DB is WAL-mode and actively used');
  console.log('[db] Starting with fresh database (sessions from Desktop not carried over)');
  return false;
}

// Clean up WAL/SHM files on shutdown, preserving relay.db for next startup
function removeRelayDB() {
  let cleaned = 0;
  ['-wal', '-shm'].forEach(suffix => {
    const p = RELAY_DB_PATH + suffix;
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        cleaned++;
      }
    } catch {}
  });
  if (cleaned > 0) console.log(`[db] Cleaned ${cleaned} WAL/SHM file(s), relay.db preserved`);
}

// ─── opencode serve process management ────────────────────────────────────

// Check if opencode serve is already running on the target port
// (Desktop OpenCode app may already have one running)
async function isOpencodeRunning() {
  try {
    const net = require('net');
    return await new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(1000);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(OPCODE_PORT, '127.0.0.1');
    });
  } catch { return false; }
}

// Check health of an already-running opencode serve
async function checkExistingServe(password) {
  const authHeader = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  try {
    const res = await fetch(`http://127.0.0.1:${OPCODE_PORT}/health`, {
      headers: { 'Authorization': authHeader },
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) return true;
    // Try without password (Desktop app may have no password)
    const res2 = await fetch(`http://127.0.0.1:${OPCODE_PORT}/health`, {
      signal: AbortSignal.timeout(3000)
    });
    return res2.ok;
  } catch { return false; }
}

// Spawn opencode serve subprocess with isolated DB and environment
function startOpencode(password) {
  const isWindows = os.platform() === 'win32';

  console.log(`[opener] Starting opencode serve on 127.0.0.1:${OPCODE_PORT} (shell: ${isWindows})`);

  const proc = spawn('opencode', [
    'serve',
    '--port', String(OPCODE_PORT),
    '--hostname', '127.0.0.1'
  ], {
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DB: RELAY_DB_PATH       // isolated DB — Desktop untouched
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows                     // Windows: find opencode via PATH
  });

  // Pipe stdout/stderr to relay-data/logs/opencode.log (append mode)
  const logStream = fs.createWriteStream(
    path.join(RELAY_DATA_DIR, 'logs', 'opencode.log'),
    { flags: 'a' }
  );
  proc.stdout.pipe(logStream);
  proc.stderr.pipe(logStream);

  proc.on('error', (err) => {
    console.error('[opener] Failed to start opencode serve:', err.message);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[opener] opencode serve exited (code: ${code}, signal: ${signal})`);
  });

  return proc;
}

// Poll /global/health until opencode serve is ready
async function waitForReady(password, timeout = HEALTH_CHECK_TIMEOUT) {
  // opencode serve requires username 'opencode' (not empty)
  const authHeader = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  const healthPath = ENDPOINTS.HEALTH;
  const deadline = Date.now() + timeout;

  console.log('[opener] Waiting for opencode serve to be ready...');

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${OPCODE_PORT}${healthPath}`, {
        headers: { 'Authorization': authHeader },
        signal: AbortSignal.timeout(2000)
      });
      if (res.ok) {
        console.log('[opener] opencode serve is ready');
        return true;
      }
      if (res.status === 401) {
        throw new Error('opencode serve auth failed — wrong password?');
      }
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL));
  }

  throw new Error(`opencode serve did not become ready within ${timeout}ms`);
}

// Stop opencode serve (Windows-compatible)
async function stopOpencode(proc) {
  if (!proc || proc.killed) return;

  return new Promise((resolve) => {
    proc.on('exit', () => resolve());

    const isWindows = os.platform() === 'win32';

    if (isWindows) {
      // Windows: use taskkill /F /PID /T to kill process tree
      console.log('[opener] Stopping opencode serve (taskkill)...');
      exec(`taskkill /F /PID ${proc.pid} /T`, (err) => {
        if (err) {
          console.warn('[opener] taskkill failed, fallback to proc.kill()');
          proc.kill();
        }
      });
    } else {
      // Unix: graceful SIGTERM → 5s → SIGKILL
      console.log('[opener] Stopping opencode serve (SIGTERM)...');
      proc.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        if (!proc.killed) {
          console.log('[opener] Force killing opencode serve (SIGKILL)...');
          proc.kill('SIGKILL');
        }
      }, SHUTDOWN_TIMEOUT);
      proc.on('exit', () => clearTimeout(forceKill));
    }
  });
}

// Restart opencode serve with exponential backoff
async function restartOpencode(password, attempt = 0) {
  if (attempt >= MAX_RESTARTS) {
    throw new Error('Max restart attempts exceeded');
  }

  const delay = RESTART_DELAYS[attempt] || RESTART_DELAYS[RESTART_DELAYS.length - 1];
  console.log(`[opener] Restarting opencode serve in ${delay}ms (attempt ${attempt + 1}/${MAX_RESTARTS})`);
  await new Promise(r => setTimeout(r, delay));

  const proc = startOpencode(password);
  await waitForReady(password);
  return proc;
}

function removeTokenFile() {
  const tokenPath = path.resolve(__dirname, '..', 'relay-data', 'logs', 'token.txt');
  try {
    if (fs.existsSync(tokenPath)) {
      fs.unlinkSync(tokenPath);
      console.log('[opener] Token file removed');
    }
  } catch (err) {
    console.warn('[opener] Failed to remove token file:', err.message);
  }
}

module.exports = {
  ensureRelayDataDir, cleanupOldDB, copyDesktopDB, removeRelayDB,
  startOpencode, waitForReady, stopOpencode, restartOpencode,
  removeTokenFile, isOpencodeRunning, checkExistingServe,
  RELAY_DATA_DIR, RELAY_DB_PATH, PROJECTS_DIR, OPCODE_PORT
};
