'use strict';

const http = require('node:http');
const path = require('node:path');

const { Bank, seed: seedState } = require('./bank');
const { Store } = require('./store');
const { RateBoard } = require('./rates');
const { staticHandler, RateLimiter, json } = require('./http');
const { buildRouter, handleRequest, Sessions } = require('./api');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createServer({ dataFile = null, rates = new RateBoard(), now = undefined, rateLimit = { limit: 600, windowMs: 60_000 } } = {}) {
  const store = dataFile ? new Store(dataFile, seedState()) : null;
  const bank = new Bank({ store, state: store ? store.data : null, rates, now });
  const sessions = new Sessions();
  const router = buildRouter(bank, sessions);
  const serveStatic = staticHandler(PUBLIC_DIR);
  const limiter = new RateLimiter(rateLimit);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    res.setHeader('x-powered-by', 'VaivaiBank Buryatia');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');

    if (url.pathname.startsWith('/api/')) {
      const key = req.socket.remoteAddress || 'unknown';
      const check = limiter.check(key);
      if (!check.ok) {
        res.setHeader('retry-after', String(check.retryAfter));
        json(res, 429, { error: 'rate_limited', message: 'Too many requests — give the tellers a moment' });
        return;
      }
      const handled = await handleRequest(bank, sessions, router, req, res, url);
      if (!handled) json(res, 404, { error: 'not_found', message: `No route for ${req.method} ${url.pathname}` });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(req, res, url.pathname)) return;
      // Unknown path: hand back the app shell, but only for page-like requests.
      // A missing asset or an API-shaped path must fail honestly instead of
      // returning HTML that the caller will try to parse as JSON or script.
      const isAsset = /\.[a-z0-9]+$/i.test(url.pathname);
      const isApiShaped = url.pathname.includes('/api/');
      if (!isAsset && !isApiShaped && serveStatic(req, res, '/')) return;
    }

    json(res, 404, { error: 'not_found', message: 'Nothing here' });
  });

  server.on('close', () => store?.close());
  return { server, bank, sessions, store };
}

function start({ port = Number(process.env.PORT) || 4173, host = process.env.HOST || '127.0.0.1', dataFile } = {}) {
  const file = dataFile !== undefined ? dataFile : (process.env.VVB_DATA || path.join(__dirname, '..', 'data', 'bank.json'));
  const created = createServer({ dataFile: file });
  created.server.listen(port, host, () => {
    const address = created.server.address();
    process.stdout.write(
      `\n  VaivaiBank Buryatia · Ваивай Банк Буряад\n` +
      `  ---------------------------------------\n` +
      `  Branch open at http://${host}:${address.port}\n` +
      (host === '127.0.0.1' || host === 'localhost'
        ? `  (this machine only — set HOST=0.0.0.0 to reach it from elsewhere)\n`
        : '') +
      `  Ledger: ${file || 'in memory only'}\n` +
      `  Health: http://${host}:${address.port}/api/health\n\n`,
    );
  });

  const shutdown = (signal) => {
    process.stdout.write(`\n  ${signal} — closing the branch, flushing the ledger.\n`);
    created.store?.close();
    created.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return created;
}

if (require.main === module) start();

module.exports = { createServer, start, PUBLIC_DIR };
