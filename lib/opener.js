// lib/opener.js — opencode serve lifecycle manager + DB copy
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ENDPOINTS } = require('./api-config');

const OPCODE_PORT = 4097;
const HEALTH_CHECK_TIMEOUT = 30_000;  // 30s max wait for health
const HEALTH_CHECK_INTERVAL = 1_000;  // poll every 1s
const MAX_RESTARTS = 3;
const RESTART_DELAYS = [1000, 3000, 8000]; // exponential backoff (ms)
const SHUTDOWN_TIMEOUT = 5_000; // 5s wait for graceful shutdown

// ─── DB paths ────────────────────────────────────────────────────────────
const RELAY_DATA_DIR = path.resolve(__dirname, '..', 'relay-data');
const RELAY_DB_PATH   = path.join(RELAY_DATA_DIR, 'relay.db');
const DESKTOP_DB_PATH  = path.join(
  os.homedir(), '.local', 'share', 'opencode', 'opencode.db'
);

// ─── DB lifecycle ────────────────────────────────────────────────────────

// Ensure relay-data/ and relay-data/logs/ directories exist
function ensureRelayDataDir() {
  fs.mkdirSync(RELAY_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(RELAY_DATA_DIR, 'logs'), { recursive: true });
}

// Remove old relay.db and associated WAL/SHM files if they exist
function cleanupOldDB() {
  ['', '-wal', '-shm'].forEach(suffix => {
    const p = RELAY_DB_PATH + suffix;
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  });
  console.log('[db] Cleaned up old relay database files');
}

// Copy Desktop opencode.db → relay-data/relay.db
// Desktop DB uses WAL mode, so we must also copy the WAL file to avoid
// "PRAGMA wal_checkpoint(PASSIVE)" errors when opencode serve opens the copy.
// Returns true if copy succeeded, false if Desktop DB not found
function copyDesktopDB() {
  console.log('[db] Copying Desktop opencode.db → relay-data/relay.db');

  if (!fs.existsSync(DESKTOP_DB_PATH)) {
    console.warn('[db] Desktop opencode.db not found, starting with empty DB');
    return false;
  }

  const stat = fs.statSync(DESKTOP_DB_PATH);
  console.log(`[db] Desktop DB size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  const startTime = Date.now();

  // 1. Copy main DB file
  fs.copyFileSync(DESKTOP_DB_PATH, RELAY_DB_PATH);

  // 2. Copy WAL file if it exists — needed for WAL mode consistency
  //    If Desktop is actively writing, the WAL file may be locked; this is
  //    non-fatal — opencode serve will handle a partial/missing WAL gracefully
  //    (it will just miss the most recent uncheckpointed writes).
  const desktopWal = DESKTOP_DB_PATH + '-wal';
  const relayWal = RELAY_DB_PATH + '-wal';
  if (fs.existsSync(desktopWal)) {
    try {
      fs.copyFileSync(desktopWal, relayWal);
      console.log(`[db] Copied WAL file (${(fs.statSync(desktopWal).size / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.warn(`[db] WAL copy failed (${err.message}), continuing without WAL`);
    }
  }

  console.log(`[db] Copy complete (${Date.now() - startTime}ms)`);
  return true;
}

// Remove relay.db and associated files on shutdown
function removeRelayDB() {
  ['', '-wal', '-shm'].forEach(suffix => {
    const p = RELAY_DB_PATH + suffix;
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  });
  console.log('[db] Removed relay database files');
}

// ─── opencode serve process management ────────────────────────────────────

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
  removeTokenFile,
  RELAY_DATA_DIR, RELAY_DB_PATH, OPCODE_PORT
};
