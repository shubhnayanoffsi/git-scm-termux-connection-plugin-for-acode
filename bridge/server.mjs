import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 8768;
const GIT_BIN = '/data/data/com.termux/files/usr/bin/git';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'termux-git-bridge');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token');
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const BLOCKED_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token',
  'Access-Control-Allow-Private-Network': 'true',
};

function loadOrCreateToken() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  if (fs.existsSync(TOKEN_FILE)) {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing.length > 0) {
      fs.chmodSync(TOKEN_FILE, 0o600);
      return existing;
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
  return token;
}

const BRIDGE_TOKEN = loadOrCreateToken();

function isAuthorized(req) {
  const header = req.headers['x-bridge-token'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided !== 'string' || provided.length === 0) {
    return false;
  }

  const expectedBuf = Buffer.from(BRIDGE_TOKEN, 'utf8');
  const providedBuf = Buffer.from(provided.trim(), 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function normalizeCwd(rawCwd) {
  if (typeof rawCwd !== 'string') {
    return undefined;
  }

  let normalized = rawCwd.trim();
  if (!normalized) {
    return undefined;
  }

  if (/^file:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^file:\/\/(?:localhost)?/i, '');
  }

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep original string if URI decoding fails on literal '%' sequences.
  }

  if (normalized === '/sdcard' || normalized.startsWith('/sdcard/')) {
    normalized = '/storage/emulated/0' + normalized.slice('/sdcard'.length);
  } else if (normalized.startsWith('/data/data/com.termux/files/home/storage/shared')) {
    normalized = '/storage/emulated/0' + normalized.slice('/data/data/com.termux/files/home/storage/shared'.length);
  } else if (normalized.startsWith('/data/user/0/com.termux/files/home/storage/shared')) {
    normalized = '/storage/emulated/0' + normalized.slice('/data/user/0/com.termux/files/home/storage/shared'.length);
  } else if (normalized === '/home') {
    normalized = os.homedir();
  }

  return normalized;
}

function buildEnv(customEnv) {
  const env = { ...process.env };

  if (customEnv && typeof customEnv === 'object' && !Array.isArray(customEnv)) {
    for (const [key, value] of Object.entries(customEnv)) {
      if (
        typeof key === 'string' &&
        typeof value === 'string' &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
        !BLOCKED_ENV_KEYS.has(key)
      ) {
        env[key] = value;
      }
    }
  }

  // Never allow git to hang waiting on a non-existent TTY prompt.
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function spawnGit(args, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const cwd = normalizeCwd(options.cwd) || os.homedir();
    const env = buildEnv(options.env);

    let proc;
    try {
      proc = spawn(GIT_BIN, args, {
        cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({
        stdoutBase64: '',
        stderrBase64: Buffer.from(err?.message || String(err), 'utf8').toString('base64'),
        exitCode: 127,
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];

    proc.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    proc.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

    proc.stdin.on('error', () => {
      // Ignore EPIPE when git exits before consuming stdin.
    });

    if (typeof options.stdinBase64 === 'string' && options.stdinBase64.length > 0) {
      proc.stdin.write(Buffer.from(options.stdinBase64, 'base64'));
    }
    proc.stdin.end();

    proc.on('error', (err) => {
      finish({
        stdoutBase64: Buffer.concat(stdoutChunks).toString('base64'),
        stderrBase64: Buffer.from(err?.message || String(err), 'utf8').toString('base64'),
        exitCode: 127,
      });
    });

    proc.on('close', (code) => {
      finish({
        stdoutBase64: Buffer.concat(stdoutChunks).toString('base64'),
        stderrBase64: Buffer.concat(stderrChunks).toString('base64'),
        exitCode: typeof code === 'number' ? code : -1,
      });
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  const pathname = new URL(req.url || '/', `http://${HOST}:${PORT}`).pathname;

  if (req.method === 'GET' && pathname === '/health') {
    const result = await spawnGit(['--version']);
    const rawVersion = Buffer.from(result.stdoutBase64, 'base64').toString('utf8').trim();
    const stderr = Buffer.from(result.stderrBase64, 'base64').toString('utf8').trim();

    if (result.exitCode !== 0) {
      console.error(`[bridge] GET /health failed exit=${result.exitCode}: ${stderr}`);
      sendJson(res, 500, {
        ok: false,
        error: stderr || 'Failed to run git --version',
        exitCode: result.exitCode,
      });
      return;
    }

    const version = rawVersion.replace(/^git version\s+/i, '').trim();
    console.log(`[bridge] GET /health -> 200 (${rawVersion})`);
    sendJson(res, 200, {
      ok: true,
      git: rawVersion,
      version,
      gitPath: GIT_BIN,
      home: os.homedir(),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/git') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const status = err.message === 'Payload too large' ? 413 : 400;
      sendJson(res, status, { error: err.message });
      return;
    }

    if (!body || !Array.isArray(body.args) || !body.args.every((arg) => typeof arg === 'string')) {
      sendJson(res, 400, { error: 'Request body must include args: string[]' });
      return;
    }

    if (body.cwd !== undefined && typeof body.cwd !== 'string') {
      sendJson(res, 400, { error: 'cwd must be a string when provided' });
      return;
    }

    if (body.stdinBase64 !== undefined && typeof body.stdinBase64 !== 'string') {
      sendJson(res, 400, { error: 'stdinBase64 must be a string when provided' });
      return;
    }

    const result = await spawnGit(body.args, {
      cwd: body.cwd,
      stdinBase64: body.stdinBase64,
      env: body.env,
    });
    console.log(`[bridge] POST /git cwd=${body.cwd ?? ''} args=${JSON.stringify(body.args)} -> exit=${result.exitCode}`);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Termux Git Bridge listening on http://${HOST}:${PORT}`);
  console.log(`Bridge token (${TOKEN_FILE}): ${BRIDGE_TOKEN}`);
});
