'use strict';
/* Mareas · servidor online.
 * - Sirve el juego (carpeta ../client) y acepta partidas 1v1 por WebSocket en /ws.
 * - Autoritativo: aquí corre TODA la simulación (client/sim.js). El cliente solo envía
 *   {t:'play', slot, x, y} y recibe el estado; no puede hacer trampas con la lógica.
 * - Cada jugador recibe el tablero "desde su punto de vista" (siempre abajo), así que
 *   el cliente es idéntico para los dos equipos.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Sim = require('../client/sim.js');

const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
const TICK = 0.05;              // 20 ticks/s de simulación
const SNAP_EVERY = 2;           // snapshot cada 2 ticks = 10/s (ahorra datos móviles; el cliente interpola)
const DC_GRACE = 20000;         // ms para reconectar antes de perder
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.apk': 'application/vnd.android.package-archive' };

/* ---------- Vista de cada jugador ---------- */
function view(g, team){
  const flip = team === 1, m = t => (t === team ? 0 : 1), W = Sim.W, H = Sim.H;
  const fx = x => (flip ? W - x : x), fy = y => (flip ? H - y : y);
  const r1 = n => Math.round(n * 10) / 10, r2 = n => Math.round(n * 100) / 100;
  const rev = a => (flip ? a.slice().reverse() : a.slice());   // las zonas también se espejan
  return {
    t: r2(g.t), tl: r1(g.timeLeft), ot: g.overtime ? 1 : 0, otl: r1(g.otLeft),
    tide: { cur: rev(g.tide.cur), next: rev(g.tide.next), t: r1(g.tide.t) },
    en: r1(g.en[team]), hand: g.hands[team], nx: g.queues[team][0], dep: g.stat.dep[team],
    u: g.units.map(u => [u.id, m(u.team), u.ci, r2(fx(u.x)), r2(fy(u.y)), Math.round(u.hp), (u.slow > 0 ? 1 : 0) | (u.fuse > 0 ? 2 : 0), r2(u.born)]),
    tw: g.towers.map(t => [m(t.team), r2(fx(t.x)), r2(fy(t.y)), Math.round(t.hp)]),
    over: g.over ? 1 : 0, w: g.over ? (g.winner === -1 ? -1 : m(g.winner)) : null
  };
}
function mapEvents(evs, team){
  const flip = team === 1, W = Sim.W, H = Sim.H, m = t => (t === team ? 0 : 1);
  const fx = x => (flip ? W - x : x), fy = y => (flip ? H - y : y);
  return evs.map(e => {
    const o = Object.assign({}, e);
    if (e.team !== undefined) o.team = m(e.team);
    if (e.x !== undefined){ o.x = Math.round(fx(e.x) * 100) / 100; o.y = Math.round(fy(e.y) * 100) / 100; }
    if (e.a){ o.a = [fx(e.a[0]), fy(e.a[1])]; o.b = [fx(e.b[0]), fy(e.b[1])]; }
    if (e.k === 'end') o.winner = e.winner === -1 ? -1 : m(e.winner);
    return o;
  });
}

function start(opts){
  opts = opts || {};
  const port = opts.port != null ? opts.port : (process.env.PORT || 8080);
  const timeScale = opts.timeScale || 1;                 // solo para pruebas (acelera el reloj)
  const queue = [];                                       // sockets esperando rival
  const matches = new Set();
  const byToken = new Map();                              // token -> { match, team }
  let online = 0;

  /* ---------- HTTP: juego estático + salud ---------- */
  const server = http.createServer((req, res) => {
    let url;
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e){ res.writeHead(400); return res.end(); }
    if (url === '/health'){ res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (url === '/stats'){ res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ online, queue: queue.length, matches: matches.size })); }
    if (url.endsWith('/')) url += 'index.html';
    const file = path.normalize(path.join(CLIENT_DIR, url));
    if (!file.startsWith(CLIENT_DIR + path.sep)){ res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err){ res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('No encontrado'); }
      const ext = path.extname(file).toLowerCase();
      const h = { 'content-type': MIME[ext] || 'application/octet-stream' };
      h['cache-control'] = (ext === '.html' || ext === '.js' || ext === '.webmanifest') ? 'no-cache' : 'public, max-age=3600';
      res.writeHead(200, h); res.end(buf);
    });
  });

  /* ---------- WebSocket ---------- */
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
  const send = (ws, o) => { if (ws && ws.readyState === 1 && ws.bufferedAmount < 1e6) ws.send(JSON.stringify(o)); };

  function removeFromQueue(ws){ const i = queue.indexOf(ws); if (i >= 0) queue.splice(i, 1); }

  function tryMatch(){
    while (queue.length >= 2){
      const a = queue.shift(), b = queue.shift();
      if (a.readyState !== 1){ if (b.readyState === 1) queue.unshift(b); continue; }
      if (b.readyState !== 1){ queue.unshift(a); continue; }
      const g = Sim.create({ seed: crypto.randomBytes(4).readUInt32LE(0), bot: null });
      const match = { g, acc: 0, tick: 0, over: false, endAt: 0, players: [] };
      [a, b].forEach((ws, team) => {
        const token = crypto.randomBytes(12).toString('hex');
        match.players[team] = { ws, token, connected: true, dcAt: 0 };
        byToken.set(token, { match, team });
        ws.match = match; ws.team = team;
        send(ws, { t: 'match', token, team });
      });
      matches.add(match);
      pushState(match, true);
    }
  }

  function pushState(match, force){
    const evs = Sim.drain(match.g);
    match.players.forEach((p, team) => {
      if (!p.connected) return;
      send(p.ws, { t: 's', s: view(match.g, team), e: mapEvents(evs, team) });
    });
  }

  function endMatch(match){
    match.over = true; match.endAt = Date.now() + 4000;
  }
  function dispose(match){
    matches.delete(match);
    match.players.forEach(p => { byToken.delete(p.token); if (p.ws && p.ws.match === match) p.ws.match = null; });
  }
  function forfeit(match, team){
    if (match.over || match.g.over) return;
    Sim.forfeit(match.g, team);
    pushState(match, true); endMatch(match);
  }

  wss.on('connection', ws => {
    online++;
    ws.isAlive = true; ws.match = null; ws.team = 0; ws.tokens = 30; ws.lastRefill = Date.now();
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', data => {
      // límite de mensajes (anti-spam): 30 de golpe, +20 por segundo
      const now = Date.now();
      ws.tokens = Math.min(30, ws.tokens + (now - ws.lastRefill) / 50); ws.lastRefill = now;
      if (--ws.tokens < 0) return;
      let m; try { m = JSON.parse(data.toString()); } catch (e){ return; }
      if (!m || typeof m.t !== 'string') return;
      switch (m.t){
        case 'queue':
          if (ws.match) return;
          removeFromQueue(ws); queue.push(ws); send(ws, { t: 'queued' }); tryMatch(); break;
        case 'cancel': removeFromQueue(ws); break;
        case 'ping': send(ws, { t: 'pong', c: m.c }); break;
        case 'play': {
          const match = ws.match; if (!match || match.over) return;
          let x = +m.x, y = +m.y; const slot = m.slot;
          if (!isFinite(x) || !isFinite(y)) return;
          if (ws.team === 1){ x = Sim.W - x; y = Sim.H - y; }      // el cliente manda coordenadas desde su vista
          const r = Sim.play(match.g, ws.team, slot, x, y);
          if (!r.ok) send(ws, { t: 'deny', reason: r.reason });
          break;
        }
        case 'leave':
          removeFromQueue(ws);
          if (ws.match){ const mt = ws.match, tm = ws.team; ws.match = null; forfeit(mt, tm); }
          break;
        case 'rejoin': {
          const ref = typeof m.token === 'string' ? byToken.get(m.token) : null;
          if (!ref || ref.match.over){ send(ws, { t: 'norejoin' }); return; }
          const p = ref.match.players[ref.team];
          if (p.ws && p.ws !== ws && p.ws.readyState === 1){ p.ws.match = null; p.ws.close(); }
          p.ws = ws; p.connected = true; ws.match = ref.match; ws.team = ref.team;
          send(ws, { t: 'match', token: m.token, team: ref.team, resume: true });
          send(ws, { t: 's', s: view(ref.match.g, ref.team), e: [] });
          break;
        }
      }
    });
    ws.on('close', () => {
      online--; removeFromQueue(ws);
      const match = ws.match;
      if (match && !match.over){
        const p = match.players[ws.team];
        if (p.ws === ws){ p.connected = false; p.dcAt = Date.now(); }
      }
    });
    ws.on('error', () => {});
  });

  /* ---------- Bucle de simulación ---------- */
  let last = Date.now();
  const loop = setInterval(() => {
    const now = Date.now(), dt = Math.min(.25, (now - last) / 1000) * timeScale; last = now;
    for (const match of matches){
      if (match.over){ if (now > match.endAt) dispose(match); continue; }
      match.acc += dt;
      let steps = 0;
      while (match.acc >= TICK && steps++ < 400 && !match.g.over){
        match.acc -= TICK; Sim.step(match.g, TICK); match.tick++;
        if (match.tick % SNAP_EVERY === 0 && !match.g.over) pushState(match);
      }
      if (match.g.over){ pushState(match, true); endMatch(match); continue; }
      // desconexiones largas = derrota
      match.players.forEach((p, team) => { if (!p.connected && now - p.dcAt > DC_GRACE) forfeit(match, team); });
    }
  }, TICK * 1000);
  const beat = setInterval(() => {
    for (const ws of wss.clients){ if (!ws.isAlive){ ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} }
  }, 25000);

  return new Promise(resolve => {
    server.listen(port, () => {
      const addr = server.address();
      console.log(`Mareas escuchando en el puerto ${addr.port} · cliente: ${CLIENT_DIR}`);
      resolve({ port: addr.port, matches, queue, close: () => { clearInterval(loop); clearInterval(beat); for (const c of wss.clients) c.terminate(); server.close(); } });
    });
  });
}

module.exports = { start, view, mapEvents };
if (require.main === module) start();
