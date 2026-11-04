/* Mareas · simulación pura (sin DOM, sin sonido, sin dibujo).
 * La usan IGUAL el cliente (modo offline) y el servidor (modo online).
 * - Determinista: todo el azar sale de g.rs (semilla), así misma semilla = misma partida.
 * - Todo lo que "se ve u oye" sale como eventos en g.ev; quien la use los lee con Sim.drain(g).
 * - Equipo 0 = abajo (y grande), equipo 1 = arriba. La vista de cada jugador la gira el cliente.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

/* ================= Datos del juego ================= */
const W = 18, H = 28;                 // tablero lógico
const ZY = [0, 10, 18, 28];           // límites de las 3 zonas en el eje y
const ZONE_N = 3;
const SK = ['agua', 'fuego', 'hielo'];
const EL = { viento: '#9be7d6', planta: '#7fcf5a', fuego: '#ff7a45', hielo: '#a9e6ff', rayo: '#ffe45c' };
// multiplicador de daño/velocidad según el estado de la zona donde está la criatura
const AFF = {
  fuego:  { agua: .65, fuego: 1.4,  hielo: .8  },
  hielo:  { agua: 1,   fuego: .65,  hielo: 1.4 },
  planta: { agua: 1.35, fuego: .7,  hielo: .9  },
  viento: { agua: 1,   fuego: 1.3,  hielo: .8  },
  rayo:   { agua: 1.4, fuego: 1,    hielo: .85 }
};
const CARDS = [
  { id: 'brisca',   name: 'Brisca',   el: 'viento', cost: 3, hp: 280, dmg: 36, spd: 3.3, range: 1.1, aps: 1.0, info: 'Rápida. Empuja.' },
  { id: 'musgo',    name: 'Musgo',    el: 'planta', cost: 4, hp: 640, dmg: 40, spd: 1.5, range: 1.2, aps: .75, info: 'Tanque. Cura.' },
  { id: 'cinder',   name: 'Cinder',   el: 'fuego',  cost: 4, hp: 310, dmg: 62, spd: 2.1, range: 3.4, aps: .7,  info: 'Daño en área.' },
  { id: 'glaciar',  name: 'Glaciar',  el: 'hielo',  cost: 3, hp: 390, dmg: 30, spd: 1.9, range: 3.0, aps: 1.0, info: 'Ralentiza.' },
  { id: 'tormenta', name: 'Tormenta', el: 'rayo',   cost: 5, hp: 350, dmg: 50, spd: 2.0, range: 3.2, aps: .8,  info: 'Salta a otro.' }
];
const ALL_CARDS = [0, 1, 2, 3, 4];
const TEAM_COL = ['#35d6ff', '#ff4fa3'];
const TOWER_HP = 2800, TOWER_RANGE = 6.2, TOWER_DMG = 58, TOWER_APS = .9;
const MATCH = 180, OT = 60, TIDE_EVERY = 30, TIDE_WARN = 6, SPAWN_DELAY = .8, AGGRO = 5.5;
// Dificultades del bot: regenera energía más despacio en Fácil/Normal y reacciona más lento
const DIFF = {
  facil:   { name: 'Fácil',   regen: .62, start: 3, think: [2.2, 4.0], aware: .35, pushEn: 8,   cap: 4, noise: .8 },
  normal:  { name: 'Normal',  regen: .82, start: 4, think: [1.6, 3.2], aware: .65, pushEn: 7,   cap: 5, noise: .5 },
  dificil: { name: 'Difícil', regen: .92, start: 5, think: [1.2, 2.7], aware: .85, pushEn: 6.5, cap: 6, noise: .3 }
};

/* ================= Utilidades ================= */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const zoneOf = y => y < ZY[1] ? 0 : y < ZY[2] ? 1 : 2;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Estado "actual": cada función pública fija G al entrar. Es seguro porque todo es síncrono.
let G = null;
function rand(){                      // mulberry32 sobre G.rs
  const a = G.rs = (G.rs + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rnd = (a, b) => a + rand() * (b - a);
function shuffle(a){ for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const emit = e => G.ev.push(e);
const fx = (k, o) => G.ev.push(Object.assign({ k }, o));

function randTide(prev){
  return [0, 1, 2].map(z => {
    const opts = prev ? SK.filter(s => s !== prev[z]) : SK;
    return opts[Math.floor(rand() * opts.length)];
  });
}
const multU = u => AFF[u.c.el][G.tide.cur[zoneOf(u.y)]];
const aliveTeam = team => G.towers.filter(t => t.team === team && t.hp > 0);
const hpTowers = () => [0, 1].map(tm => aliveTeam(tm).reduce((s, t) => s + t.hp, 0));

/* ================= Crear partida ================= */
// opts: { seed, bot: 'facil'|'normal'|'dificil'|null }.  Sin bot = 1v1 entre dos jugadores.
function create(opts){
  opts = opts || {};
  const bot = opts.bot && DIFF[opts.bot] ? opts.bot : null;
  const g = {
    rs: (opts.seed != null ? opts.seed : 1) | 0,
    t: 0, uid: 0, units: [], towers: [], ev: [],
    over: false, winner: null,
    timeLeft: MATCH, overtime: false, otLeft: OT, otBase: [2, 2],
    bot, botT: 4,
    en: [5, bot ? DIFF[bot].start : 5],
    hands: [null, null], queues: [null, null],       // el bot no usa mano
    tide: null, kills: [0, 0], stat: { dep: [0, 0] }
  };
  G = g;
  const tw = (team, x, y) => ({ team, x, y, hp: TOWER_HP, max: TOWER_HP, cd: rnd(0, .5), tower: true, r: 1.2 });
  g.towers = [tw(0, 5, 25), tw(0, 13, 25), tw(1, 5, 3), tw(1, 13, 3)];
  g.tide = { cur: randTide(null), next: null, t: TIDE_EVERY };
  g.tide.next = randTide(g.tide.cur);
  for (const team of [0, 1]){
    if (team === 1 && bot) continue;
    const q = shuffle(ALL_CARDS.slice());
    g.hands[team] = q.splice(0, 4); g.queues[team] = q;
  }
  emit({ k: 'start' });
  return g;
}

/* ================= Acciones del jugador ================= */
// Zona donde cada equipo puede soltar (equipo 1 es el espejo del 0)
function validSpot(team, x, y){
  if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return false;
  if (x < .8 || x > W - .8) return false;
  return team === 0 ? (y >= 15 && y <= 27.2) : (y >= H - 27.2 && y <= H - 15);
}
function spawn(team, ci, x, y){
  const c = CARDS[ci];
  G.units.push({ id: ++G.uid, team, ci, c, x, y, hp: c.hp, max: c.hp, cd: .3, slow: 0, fuse: 0, fuseCd: 0, heal: 1, born: G.t });
  fx('ring', { x, y, r: 1.6, col: EL[c.el], life: .5, max: .5 });
  G.stat.dep[team]++;
  emit({ k: 'spawn', team, ci });
}
// Soltar la carta de la ranura `slot` de la mano de `team` en (x,y). Devuelve { ok, reason }.
function play(g, team, slot, x, y){
  G = g;
  if (g.over) return { ok: false, reason: 'over' };
  const hand = g.hands[team];
  if (!hand) return { ok: false, reason: 'nohand' };
  if (!Number.isInteger(slot) || slot < 0 || slot >= hand.length) return { ok: false, reason: 'slot' };
  if (!validSpot(team, x, y)) return { ok: false, reason: 'zone' };
  const ci = hand[slot], c = CARDS[ci];
  if (g.en[team] < c.cost) return { ok: false, reason: 'energy' };
  g.en[team] -= c.cost;
  spawn(team, ci, x, y);
  g.queues[team].push(ci); hand[slot] = g.queues[team].shift();
  return { ok: true };
}

/* ================= Combate ================= */
function hurt(t, amount, col){
  if (t.hp <= 0) return;
  t.hp -= amount;
  fx('num', { x: t.x, y: t.y - (t.tower ? 1.4 : .8), txt: String(Math.round(amount)), col: col || '#fff', life: .7, max: .7 });
  if (t.hp <= 0){
    t.hp = 0;
    fx('ring', { x: t.x, y: t.y, r: t.tower ? 3.2 : 1.6, col: '#fff', life: .6, max: .6 });
    if (t.tower) emit({ k: 'towerDown', team: t.team });
    else if (t.team === 1) G.kills[0]++;
  }
}
const foes = team => G.units.filter(u => u.team !== team && u.hp > 0);
function nearest(from, list, maxd){
  maxd = maxd == null ? 1e9 : maxd;
  let b = null, bd = maxd;
  for (const e of list){ const d = dist(from, e); if (d < bd){ bd = d; b = e; } }
  return b ? { e: b, d: bd } : null;
}
function attack(u, tgt, dmg, m){
  const c = u.c, col = m >= 1.25 ? '#ffe45c' : m <= .75 ? '#ff9a9a' : '#fff';
  fx('line', { a: [u.x, u.y], b: [tgt.x, tgt.y], col: EL[c.el], life: .14, max: .14 });
  hurt(tgt, dmg, col);
  if (c.id === 'cinder'){
    for (const e of foes(u.team)) if (e !== tgt && dist(e, tgt) < 1.7) hurt(e, dmg * .5, col);
    fx('ring', { x: tgt.x, y: tgt.y, r: 1.7, col: EL.fuego, life: .35, max: .35 });
  }
  if (c.id === 'tormenta'){
    const o = nearest(tgt, foes(u.team).filter(e => e !== tgt), 3.4);
    if (o){ fx('line', { a: [tgt.x, tgt.y], b: [o.e.x, o.e.y], col: EL.rayo, life: .14, max: .14 }); hurt(o.e, dmg * .6, col); }
  }
  if (c.id === 'glaciar' && !tgt.tower) tgt.slow = 1.6;
  if (c.id === 'brisca' && !tgt.tower){
    const d = Math.max(.01, dist(u, tgt)), nx = (tgt.x - u.x) / d, ny = (tgt.y - u.y) / d;
    tgt.x = clamp(tgt.x + nx * .8, .5, W - .5); tgt.y = clamp(tgt.y + ny * .8, .5, H - .5);
  }
}

/* ================= Bot ================= */
// IA estratégica: sirve para el bot (equipo 1) y para simular a un jugador en pruebas.
// Trabaja en "perspectiva propia": mi torre está en y'=3, el centro en y'=14.
function planInner(team, avail, prm){
  const me = team, op = 1 - team, en = G.en[team];
  const fy = y => team === 1 ? y : H - y;
  const own = G.units.filter(u => u.team === me && u.hp > 0);
  const foe = G.units.filter(u => u.team === op && u.hp > 0);
  const th = foe.filter(u => fy(u.y) < 15);                  // enemigos que ya han cruzado hacia mi lado
  const tide = G.tide.t < TIDE_WARN + 3 ? G.tide.next : G.tide.cur;
  const afford = avail.filter(ci => CARDS[ci].cost <= en);
  if (!afford.length) return null;
  const defend = th.length > 0 && rand() < prm.aware;
  if (!defend){
    if (own.length >= prm.cap) return null;                  // no acumular tropas sin sentido
    if (en < prm.pushEn) return null;                        // ahorrar para un empuje decidido
  }
  let best = -1, bs = -1e9;
  for (const ci of afford){
    const c = CARDS[ci]; let sc;
    if (defend){
      const zy = th.reduce((a, u) => a + u.y, 0) / th.length;
      sc = AFF[c.el][tide[zoneOf(zy)]];
      if (c.id === 'cinder' && th.length >= 3) sc += .6;
      if (c.id === 'glaciar' && th.length >= 2) sc += .25;
      if (c.id === 'tormenta' && th.length >= 2) sc += .3;
      if (c.id === 'musgo' && own.length >= 1) sc += .2;
      sc -= c.cost * .03;
    } else {
      sc = (AFF[c.el][tide[1]] + AFF[c.el][tide[team === 1 ? 2 : 0]]) / 2;
      if (c.id === 'musgo' && own.length === 0) sc += .3;
      if (own.some(u => u.c.el === c.el)) sc += .15;         // posible fusión
    }
    sc += rand() * prm.noise;
    if (sc > bs){ bs = sc; best = ci; }
  }
  let x, yp;
  if (defend){
    const ty = Math.min(...th.map(u => fy(u.y)));
    x = clamp(th.reduce((a, u) => a + u.x, 0) / th.length + rnd(-1.3, 1.3), 1, W - 1);
    yp = clamp(ty - 3, 5, 11);                               // entre mi torre y el enemigo, bajo el fuego de mi torre
  } else {
    const wk = aliveTeam(op).sort((a, b) => a.hp - b.hp)[0];
    x = wk && rand() < .65 ? clamp(wk.x + rnd(-2, 2), 1, W - 1) : rnd(2, 16);
    yp = rnd(5, 9);
  }
  return { ci: best, x, y: fy(yp) };
}
function plan(g, team, avail, prm){ G = g; return planInner(team, avail, prm); }
function botThink(dt){
  G.botT -= dt;
  if (G.botT > 0) return;
  const prm = DIFF[G.bot];
  const r = planInner(1, ALL_CARDS, prm);
  if (!r){ G.botT = .5; return; }
  G.en[1] -= CARDS[r.ci].cost;
  spawn(1, r.ci, r.x, r.y);
  G.botT = rnd(prm.think[0], prm.think[1]);
}

/* ================= Paso de simulación ================= */
function step(g, dt){
  G = g;
  if (G.over) return;
  G.t += dt;

  // reloj
  if (!G.overtime){
    G.timeLeft -= dt;
    if (G.timeLeft <= 0){ G.timeLeft = 0; endRegular(); }
  } else {
    G.otLeft -= dt;
    if (G.otLeft <= 0){ G.otLeft = 0; const h = hpTowers(); finish(h[0] > h[1] ? 0 : h[1] > h[0] ? 1 : -1); }
  }
  if (G.over) return;
  // marea
  G.tide.t -= dt;
  if (G.tide.t <= 0){
    G.tide.cur = G.tide.next; G.tide.next = randTide(G.tide.cur); G.tide.t = TIDE_EVERY;
    emit({ k: 'tide' });
  }
  // energía
  const rate = (G.overtime ? 2 : 1) / 1.4;
  G.en[0] = Math.min(10, G.en[0] + rate * dt);
  G.en[1] = Math.min(10, G.en[1] + rate * dt * (G.bot ? DIFF[G.bot].regen : 1));
  if (G.bot) botThink(dt);

  const units = G.units;
  // fusión: dos criaturas del mismo elemento y zona, juntas
  for (let i = 0; i < units.length; i++){
    const a = units[i]; if (a.hp <= 0) continue;
    a.fuse = Math.max(0, a.fuse - dt); a.fuseCd = Math.max(0, a.fuseCd - dt); a.slow = Math.max(0, a.slow - dt);
    if (G.t < a.born + SPAWN_DELAY || a.fuse > 0 || a.fuseCd > 0) continue;
    for (let j = i + 1; j < units.length; j++){
      const b = units[j];
      if (b.hp <= 0 || b.team !== a.team || b.c.el !== a.c.el || b.fuse > 0 || b.fuseCd > 0 || G.t < b.born + SPAWN_DELAY) continue;
      if (dist(a, b) < 2.2 && zoneOf(a.y) === zoneOf(b.y)){
        a.fuse = b.fuse = 6; a.fuseCd = b.fuseCd = 14;
        fx('ring', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: 2.4, col: '#fff', life: .6, max: .6 });
        emit({ k: 'fuse', team: a.team });
        break;
      }
    }
  }
  // unidades
  for (const u of units){
    if (u.hp <= 0 || G.t < u.born + SPAWN_DELAY) continue;
    const c = u.c, m = multU(u);
    const spd = c.spd * (1 + (m - 1) * .5) * (u.slow > 0 ? .55 : 1) * (u.fuse > 0 ? 1.1 : 1);
    const dmg = c.dmg * m * (u.fuse > 0 ? 1.4 : 1);
    u.cd -= dt;
    if (c.id === 'musgo'){
      u.heal -= dt;
      if (u.heal <= 0){
        u.heal = 1.6;
        let any = false;
        for (const a of units) if (a.team === u.team && a.hp > 0 && a.hp < a.max && dist(a, u) < 3.2){ a.hp = Math.min(a.max, a.hp + 22 * m); any = true; }
        if (any) fx('ring', { x: u.x, y: u.y, r: 3.2, col: EL.planta, life: .4, max: .4 });
      }
    }
    let tgt = null, td = 1e9;
    const n = nearest(u, foes(u.team), AGGRO);
    if (n){ tgt = n.e; td = n.d; }
    else {
      const t = nearest(u, aliveTeam(1 - u.team));
      if (t){ tgt = t.e; td = t.d; }
    }
    if (!tgt) continue;
    const reach = c.range + (tgt.tower ? tgt.r : .45);
    if (td <= reach){
      if (u.cd <= 0){ u.cd = 1 / c.aps; attack(u, tgt, dmg, m); }
    } else {
      const k = spd * dt / td;
      u.x = clamp(u.x + (tgt.x - u.x) * k, .5, W - .5);
      u.y = clamp(u.y + (tgt.y - u.y) * k, .5, H - .5);
    }
  }
  // separación
  for (let i = 0; i < units.length; i++){
    const a = units[i]; if (a.hp <= 0) continue;
    for (let j = i + 1; j < units.length; j++){
      const b = units[j]; if (b.hp <= 0) continue;
      const d = dist(a, b);
      if (d < .9 && d > .001){
        const p = (.9 - d) * .25, nx = (a.x - b.x) / d, ny = (a.y - b.y) / d;
        a.x += nx * p; a.y += ny * p; b.x -= nx * p; b.y -= ny * p;
      }
    }
  }
  // torres
  for (const t of G.towers){
    if (t.hp <= 0) continue;
    t.cd -= dt;
    if (t.cd > 0) continue;
    const n = nearest(t, foes(t.team), TOWER_RANGE);
    if (n){
      t.cd = 1 / TOWER_APS;
      fx('line', { a: [t.x, t.y], b: [n.e.x, n.e.y], col: TEAM_COL[t.team], life: .14, max: .14 });
      hurt(n.e, TOWER_DMG, '#fff');
    }
  }
  G.units = units.filter(u => u.hp > 0);

  // fin de partida
  const a0 = aliveTeam(0).length, a1 = aliveTeam(1).length;
  if (a0 === 0 || a1 === 0){ finish(a1 === 0 && a0 > 0 ? 0 : a0 === 0 && a1 > 0 ? 1 : -1); }
  else if (G.overtime && (a0 < G.otBase[0] || a1 < G.otBase[1])){
    finish(a0 > a1 ? 0 : a1 > a0 ? 1 : (hpTowers()[0] >= hpTowers()[1] ? 0 : 1));
  }
}
function endRegular(){
  const h = hpTowers();
  if (Math.abs(h[0] - h[1]) > .5) finish(h[0] > h[1] ? 0 : 1);
  else { G.overtime = true; G.otLeft = OT; G.otBase = [aliveTeam(0).length, aliveTeam(1).length]; emit({ k: 'overtime' }); }
}
function finish(w){
  if (G.over) return;
  G.over = true; G.winner = w;
  emit({ k: 'end', winner: w });
}

/* ================= API pública ================= */
function drain(g){ const e = g.ev; g.ev = []; return e; }
// Un jugador abandona o se desconecta demasiado tiempo: gana el otro
function forfeit(g, loser){ G = g; finish(1 - loser); }

return {
  W, H, ZY, ZONE_N, SK, EL, AFF, CARDS, ALL_CARDS, TEAM_COL, DIFF,
  TOWER_HP, TOWER_RANGE, MATCH, OT, TIDE_EVERY, TIDE_WARN, SPAWN_DELAY,
  zoneOf, validSpot, create, step, play, drain, plan, forfeit,
  mult: (g, u) => AFF[u.c.el][g.tide.cur[zoneOf(u.y)]],
  aliveT: (g, team) => g.towers.filter(t => t.team === team && t.hp > 0),
  towerHp: g => [0, 1].map(tm => g.towers.filter(t => t.team === tm && t.hp > 0).reduce((s, t) => s + t.hp, 0)),
  randTide: (prev) => { G = { rs: (Math.random() * 4294967296) | 0 }; return randTide(prev); }
};
});
