// lib/auth.js — Token-based authentication module
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Generated once at module load
const TOKEN = crypto.randomBytes(32).toString('hex');
const OPCODE_PASSWORD = crypto.randomBytes(16).toString('hex');

// Persist token to relay-data/logs/token.txt
const tokenDir = path.resolve(__dirname, '..', 'relay-data', 'logs');
fs.mkdirSync(tokenDir, { recursive: true });
fs.writeFileSync(path.join(tokenDir, 'token.txt'), TOKEN + '\n');

// Verify incoming request token (constant-time comparison with length pre-check)
function authenticate(req) {
  const token = req.headers['x-auth-token'] ||
                new URL(req.url, 'http://x').searchParams.get('token');
  if (!token) return false;

  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(TOKEN);

  // P2 fix: length pre-check to avoid crash on different-length buffers
  if (tokenBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

// Get Basic Auth header for proxy-to-opencode-serve requests
// opencode serve requires username 'opencode' (not empty)
function getBasicAuthHeader() {
  return 'Basic ' + Buffer.from('opencode:' + OPCODE_PASSWORD).toString('base64');
}

module.exports = { TOKEN, OPCODE_PASSWORD, authenticate, getBasicAuthHeader };
