'use strict';
// KI-Autopilot – Startpunkt. In der Cloud läuft er hinter Caddy (HTTPS), lokal auf http://localhost:4747.
const http = require('node:http');
const path = require('node:path');
const { Engine } = require('./src/engine');
const { Scheduler } = require('./src/scheduler');
const { createHandler } = require('./src/api');

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error('KI-Autopilot braucht Node.js 20 oder neuer. Installiert ist ' + process.versions.node);
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

const engine = new Engine({ dataDir: DATA });
const scheduler = new Scheduler(engine);
if (!loopback && !engine.cfg.auth.passwordHash) {
  console.error('Kein Passwort gesetzt. Starte mit APP_PASSWORD=… – ohne Passwort bleibt die App gesperrt.');
}
const server = http.createServer(createHandler(engine, scheduler, { open: loopback }));
server.requestTimeout = 0;

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} ist belegt.` : e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`KI-Autopilot läuft auf http://${HOST}:${PORT} · Daten: ${DATA} · ${engine.cfg.dryRun ? 'Trockenlauf' : 'LIVE'}`);
  engine.log('info', 'KI-Autopilot gestartet');
  engine.start();
  scheduler.start();
});

const shutdown = () => {
  scheduler.stop();
  try { engine.store.flush(); engine.cfgStore.flush(); } catch { /* egal */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
