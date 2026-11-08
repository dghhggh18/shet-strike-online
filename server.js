"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const GM = require("./maps.js"), MP = GM.MAPS, WPN = GM.WPN, GRN = GM.GRN;
const A = require("./auth.js");   // аккаунты (работают только при DATABASE_URL)
A.notify = acc => { for (const q of pl.values()) if (q.acc && q.acc.id === acc.id) send(q.ws, { t: "prof", p: A.pub(acc) }); };   // игрок видит выданное сразу
const PORT = process.env.PORT || 3000, MAX = 12, NM = MP.length, RND = 180000, BRK = 8000;
const page = fs.readFileSync(path.join(__dirname, "index.html"));
const mapsJs = fs.readFileSync(path.join(__dirname, "maps.js"));
const pl = new Map(), OB = MP.map((_, i) => GM.genObs(i)), ROOMS = new Map(), ghosts = new Map();
let nid = 1;
const LAD = [3, 1, 0, 2, 4], GMS = ["ffa", "tdm", "arms", "ctf", "bomb"];   // лестница «Гонки вооружений»: пистолет, дробовик, винтовка, снайперка, нож
const types = { ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream" };

/* ---------- rooms: "0".."3" — публичные (все против всех), "P<КОД>" — приватные (команды) ---------- */
const free = (m, x, z) => !OB[m].some(o => x > o.x0 - 1 && x < o.x1 + 1 && z > o.z0 - 1 && z < o.z1 + 1);
const mkPk = i => {
  const r = GM.mkSr(MP[i].seed + 5), a = [], A = MP[i].A;
  for (let k = 0; a.length < 6 && k < 200; k++) {
    const x = (r() * 2 - 1) * (A - 3), z = (r() * 2 - 1) * (A - 3);
    if (free(i, x, z)) a.push({ x, z, k: a.length % 2 ? "a" : "h", on: true });
  }
  return a;
};
const mkFl = i => {   // базы и флаги: красные слева, синие справа
  const A = MP[i].A;
  return [0, 1].map(t => {
    const x = (t ? 1 : -1) * (A - 6); let z = 0;
    for (const dz of [0, 4, -4, 8, -8, 12, -12, 16, -16]) if (free(i, x, dz)) { z = dz; break; }
    return { x, z, hx: x, hz: z, c: 0, d: 0, dt: 0 };
  });
};
const flOut = R => R.fl.map(f => ({ x: f.x, z: f.z, hx: f.hx, hz: f.hz, c: f.c, d: f.d }));
/* ---------- режим «Бомба»: раунды без респавна, закупка, закладка/обезвреживание ---------- */
const BM = GM.BOMB, ITEMS = GM.ITEMS, PRIM = GM.PRIM, KILLR = GM.KILL;
const BOMB_AT = { id: 0, n: "💣 Бомба", k: 0, tm: -2, ws: null, acc: null };   // «убийца» при взрыве
function mkSites(mi) {   // два пункта закладки A (z<0) и B (z>0) на свободных местах карты
  const A = MP[mi].A, ok = (x, z) => free(mi, x, z) && [[3, 0], [-3, 0], [0, 3], [0, -3]].every(d => free(mi, x + d[0], z + d[1]));
  return [-1, 1].map(sg => {
    const zc = sg * A * 0.55;
    for (const dx of [0, 3, -3, 6, -6, 9, -9, 12, -12]) for (const dz of [0, 3, -3, 6, -6]) { const x = dx, z = zc + dz; if (Math.abs(z) < A - 4 && ok(x, z)) return { x, z }; }
    return { x: 0, z: sg * A * 0.5 };
  });
}
const noBm = () => ({ st: "none", c: 0, x: 0, z: 0, site: -1, t: 0 });
const mkBomb = mi => ({ ph: "wait", end: 0, rn: 0, sc: [0, 0], ls: [0, 0], sites: mkSites(mi), bm: noBm(), planted: 0, over: 0, ls1: -1 });
const bsOut = R => { const b = R.b; return { ph: b.ph, rn: b.rn, sc: b.sc, wins: BM.WINS, sites: b.sites.map(s => [s.x, s.z]), bm: { st: b.bm.st, x: b.bm.x, z: b.bm.z, site: b.bm.site } }; };
const bsend = R => room(R.k, Object.assign({ t: "bs" }, bsOut(R)));
const sendOwn = p => { const R = ROOMS.get(p.m); if (R && R.b) send(p.ws, { t: "own", w: p.own, g: p.g, ar: Math.round(p.ar), hl: p.hl, kit: p.kit, mo: p.mo, b: R.b.bm.st === "carried" && R.b.bm.c === p.id ? 1 : 0 }); };
const resetLoad = p => { p.own = [3, 4]; p.g = [0, 0, 0]; p.ar = 0; p.hl = 0; p.kit = 0; };
const addMo = (p, v) => { p.mo = Math.min(BM.CAP, p.mo + v); };
function dropBomb(R, p) { const bm = R.b.bm; if (bm.st === "carried" && bm.c === p.id) { bm.st = "dropped"; bm.c = 0; bm.x = p.x; bm.z = p.z; bsend(R); sendOwn(p); } }
function startRound(R, ps) {
  const b = R.b, now = Date.now(), ts = ps.filter(q => q.tm === 0);
  if (b.over) { b.over = 0; b.sc = [0, 0]; b.ls = [0, 0]; b.rn = 0; for (const q of ps) { q.mo = BM.MONEY0; resetLoad(q); } }
  b.rn++; b.ph = "buy"; b.end = now + BM.BUY; b.planted = 0; b.bm = noBm();
  if (ts.length) { b.bm.st = "carried"; b.bm.c = ts[Math.floor(Math.random() * ts.length)].id; }
  for (const q of ps) {
    q.a = true; q.hp = 100; q.inv = now + BM.BUY; q.act = null;
    send(q.ws, { t: "resp" }); room(R.k, { t: "alive", id: q.id }, q.ws);
  }
  bsend(R);
  for (const q of ps) sendOwn(q);
  sb(R.k);
}
function endRound(R, w, why, ps) {
  const b = R.b, now = Date.now();
  if (b.ph !== "live") return;
  b.ph = "post"; b.sc[w]++;
  b.over = b.sc[w] >= BM.WINS ? 1 : 0; b.end = now + (b.over ? 8000 : BM.POST);
  const lb = BM.LOSS + BM.STEP * Math.min(b.ls[1 - w], 4);   // бонус за серию поражений
  b.ls[1 - w]++; b.ls[w] = Math.max(0, b.ls[w] - 1);
  for (const q of ps) {
    let rw = q.tm === w ? BM.WIN : lb;
    if (q.tm === 0 && w === 1 && b.planted) rw += BM.PLT;
    addMo(q, rw); q.act = null;
    send(q.ws, { t: "rend", w, why, rw, sc: b.sc, m: b.over });
  }
  bsend(R);
  for (const q of ps) sendOwn(q);
}
function bombTick(R) {
  const b = R.b, now = Date.now(), ps = inRoom(R.k), T = ps.filter(q => q.tm === 0), C = ps.filter(q => q.tm === 1);
  if (b.ph === "wait") { if (T.length && C.length) startRound(R, ps); }
  else if (!T.length || !C.length) {   // одна из команд опустела — разминка до прихода игроков
    b.ph = "wait"; b.end = 0; b.bm = noBm(); b.planted = 0;
    for (const q of ps) { q.a = true; q.hp = 100; q.inv = now + 1500; q.act = null; send(q.ws, { t: "resp" }); room(R.k, { t: "alive", id: q.id }, q.ws); }
    bsend(R);
  }
  else if (b.ph === "buy") { if (now >= b.end) { b.ph = "live"; b.end = now + BM.LIVE; bsend(R); } }
  else if (b.ph === "post") { if (now >= b.end) startRound(R, ps); }
  else if (b.ph === "live") {
    for (const q of ps) {   // удержание E: закладка / обезвреживание
      const ac = q.act, bm = b.bm;
      if (!ac || b.ph !== "live") continue;
      const ok = q.a && Math.hypot(q.x - ac.px, q.z - ac.pz) < 0.9 && (ac.k === "plant" ? bm.st === "carried" && bm.c === q.id : bm.st === "planted");
      if (!ok) { q.act = null; send(q.ws, { t: "pr", p: -1 }); continue; }
      const pr = (now - ac.t0) / (ac.k === "plant" ? BM.PLANT : q.kit ? BM.DEFK : BM.DEF);
      if (pr < 1) { send(q.ws, { t: "pr", p: Math.round(pr * 100) / 100, k: ac.k }); continue; }
      q.act = null; send(q.ws, { t: "pr", p: -1 });
      if (ac.k === "plant") { bm.st = "planted"; bm.c = 0; bm.x = ac.px; bm.z = ac.pz; bm.site = ac.site; bm.t = now + BM.FUSE; b.planted = 1; b.end = bm.t; addMo(q, BM.PLB); bsend(R); sendOwn(q); }
      else { bm.st = "defused"; addMo(q, BM.DEFB); sendOwn(q); endRound(R, 1, "def", ps); }
    }
    if (b.ph === "live" && b.bm.st === "planted" && now >= b.bm.t) {   // взрыв
      const bm = b.bm; bm.st = "boom";
      for (const q of ps) if (q.a) { const d = Math.hypot(q.x - bm.x, q.z - bm.z); if (d < 16) { q.inv = 0; hurt(q, BOMB_AT, 700 * (1 - d / 16), false, -2); } }
      room(R.k, { t: "boom", x: bm.x, z: bm.z });
      endRound(R, 0, "boom", ps);
    }
    if (b.ph === "live") {
      const aT = T.filter(q => q.a).length, aC = C.filter(q => q.a).length, pln = b.bm.st === "planted";
      if (!aC) endRound(R, 0, "elim", ps);
      else if (!aT && !pln) endRound(R, 1, "elim", ps);
      else if (!pln && now >= b.end) endRound(R, 1, "time", ps);
    }
  }
  const sec = b.ph === "wait" ? 0 : Math.max(0, Math.ceil((b.end - now) / 1000));
  if (sec !== b.ls1) { b.ls1 = sec; room(R.k, { t: "tm", s: sec }); }
}
const getRoom = (k, mi, team, gm) => {
  let r = ROOMS.get(k);
  if (!r) { r = { k, mi, team, gm: gm || "ffa", rd: { end: Date.now() + RND, brk: 0 }, pk: mkPk(mi), idle: Date.now(), fl: gm === "ctf" ? mkFl(mi) : null, ts: [0, 0], win: 0, b: gm === "bomb" ? mkBomb(mi) : null }; ROOMS.set(k, r); }
  return r;
};
for (let i = 0; i < NM; i++) getRoom(String(i), i, false, "ffa");

const srv = http.createServer((q, r) => {
  if (q.url.startsWith("/api/")) { A.handle(q, r, q.url.split("?")[0]); return; }
  if (q.url.startsWith("/lobby")) {
    r.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    r.end(JSON.stringify({ m: MP.map((_, i) => inRoom(String(i)).length) })); return;
  }
  if (q.url === "/health") { r.end("ok"); return; }
  let pathname;
  try { pathname = new URL(q.url, "http://localhost").pathname; }
  catch (e) { r.writeHead(400); r.end("Bad request"); return; }
  if (pathname === "/maps.js") { r.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" }); r.end(mapsJs); return; }
  if (pathname.startsWith("/assets/")) {
    const root = path.resolve(__dirname, "assets"), fp = path.resolve(__dirname, "." + pathname);
    if (!fp.startsWith(root + path.sep)) { r.writeHead(403); r.end("Forbidden"); return; }
    fs.readFile(fp, (err, data) => {
      if (err) { r.writeHead(404); r.end("Not found"); return; }
      r.writeHead(200, { "Content-Type": types[path.extname(fp).toLowerCase()] || "application/octet-stream", "Cache-Control": "public, max-age=3600" });
      r.end(data);
    });
    return;
  }
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  r.end(page);
});
const wss = new WebSocketServer({ server: srv, maxPayload: 2048 });

/* ---------- helpers ---------- */
const send = (w, o) => { if (w && w.readyState === 1) w.send(JSON.stringify(o)); };
const inRoom = k => [...pl.values()].filter(q => q.j && q.m === k);
const room = (k, o, ex) => { for (const q of pl.values()) if (q.j && q.m === k && q.ws !== ex) send(q.ws, o); };
const sb = k => room(k, { t: "sb", l: inRoom(k).map(q => [q.n, q.k, q.d, q.id, q.tm, q.al | 0]) });
const flMsg = (R, i) => { const f = R.fl[i]; room(R.k, { t: "fl", i, x: f.x, z: f.z, c: f.c, d: f.d }); };
function dropFlag(R, p) { if (!R || !R.fl) return; R.fl.forEach((f, i) => { if (f.c === p.id) { f.c = 0; f.x = p.x; f.z = p.z; f.d = 1; f.dt = Date.now(); flMsg(R, i); } }); }
function ctfStep(R, p) {   // захват флага: подобрать вражеский, вернуть свой упавший, занести на базу
  if (p.tm < 0 || R.rd.brk) return;
  const my = R.fl[p.tm], en = R.fl[1 - p.tm];
  if (!en.c && Math.hypot(en.x - p.x, en.z - p.z) < 1.6) { en.c = p.id; en.d = 0; flMsg(R, 1 - p.tm); }
  else if (!my.c && my.d && Math.hypot(my.x - p.x, my.z - p.z) < 1.6) { my.x = my.hx; my.z = my.hz; my.d = 0; flMsg(R, p.tm); }
  if (en.c === p.id && !my.c && !my.d && Math.hypot(my.hx - p.x, my.hz - p.z) < 2.2) {
    R.ts[p.tm]++; en.c = 0; en.x = en.hx; en.z = en.hz; en.d = 0; flMsg(R, 1 - p.tm);
    room(R.k, { t: "cap", tm: p.tm, n: p.n }); room(R.k, { t: "ts", s: R.ts });
    if (R.ts[p.tm] >= 3) R.rd.end = Date.now();
  }
}
const num = (v, m) => Math.max(-m, Math.min(m, +v || 0));

/* ---------- урон: единственное место, где меняется HP ---------- */
function hurt(tg, at, d, hs, wi) {
  const R = ROOMS.get(tg.m), B = R.b;
  if (!tg.a || tg.inv > Date.now() || R.rd.brk) return;
  if (B && B.ph !== "live" && B.ph !== "wait") return;   // в закупку и перерыв урона нет
  if (R.team && tg !== at && tg.tm === at.tm) return;   // по своим не бьём
  if (B && tg.ar > 0 && (!hs || tg.hl)) { const ab = d * 0.5; tg.ar = Math.max(0, tg.ar - ab); d -= ab; }   // броня гасит половину урона (шлем — и от хедшота)
  tg.hp -= d;
  send(tg.ws, { t: "hp", hp: Math.max(0, Math.round(tg.hp)), f: at.id, ar: Math.round(tg.ar | 0) });
  if (tg.hp > 0) return;
  tg.a = false; at.k++; tg.d++;
  if (B) {
    if (at !== tg && at !== BOMB_AT && at.tm !== tg.tm) { addMo(at, KILLR[wi] === undefined ? 300 : KILLR[wi]); sendOwn(at); }
    resetLoad(tg); tg.act = null; dropBomb(R, tg);
  }
  if (at.acc && at !== tg) { const up = A.kill(at.acc, tg.acc ? "a" + tg.acc.id : "g" + tg.id, hs); send(at.ws, { t: "prof", p: A.pub(at.acc), up }); }   // награду выдаёт только сервер
  if (tg.acc) { A.death(tg.acc); send(tg.ws, { t: "prof", p: A.pub(tg.acc) }); }
  if (R.gm === "arms") {
    if (wi === 4 && tg.al > 0) { tg.al--; send(tg.ws, { t: "al", l: tg.al }); }
    if (wi === LAD[at.al] && !R.win) { if (at.al >= LAD.length - 1) { R.win = at.id; R.rd.end = Date.now(); } else { at.al++; send(at.ws, { t: "al", l: at.al }); } }
  }
  if (R.fl) dropFlag(R, tg);
  room(tg.m, { t: "kill", a: at.id, b: tg.id, an: at.n, bn: tg.n, h: hs ? 1 : 0 });
  sb(tg.m);
  setTimeout(() => {
    if (tg.a || !pl.has(tg.ws)) return;
    if (R.b && R.b.ph !== "wait") return;   // в раундах «Бомбы» воскрешение только в начале следующего
    tg.hp = 100; tg.a = true; tg.inv = Date.now() + 2000;
    send(tg.ws, { t: "resp" });
    room(tg.m, { t: "alive", id: tg.id }, tg.ws);
  }, 3000);
}

/* ---------- раунды: таймер, перерыв, сброс ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [k, R] of ROOMS) {
    const rd = R.rd, ps = inRoom(k);
    if (!ps.length) { rd.end = now + RND; rd.brk = 0; if (k[0] === "P" && now - R.idle > 10000) ROOMS.delete(k); continue; }
    R.idle = now;
    if (R.b) continue;
    if (R.fl) R.fl.forEach((f, i) => { if (f.d && now - f.dt > 15000) { f.x = f.hx; f.z = f.hz; f.d = 0; flMsg(R, i); } });
    if (rd.brk) {
      if (now > rd.brk) {
        rd.brk = 0; rd.end = now + RND;
        for (const q of ps) { q.k = q.d = 0; q.al = 0; if (R.gm === "arms") send(q.ws, { t: "al", l: 0 }); q.hp = 100; q.a = true; q.inv = now + 2000; send(q.ws, { t: "resp" }); room(k, { t: "alive", id: q.id }, q.ws); }
        R.win = 0; if (R.fl) { R.fl = mkFl(R.mi); R.ts = [0, 0]; room(k, { t: "ts", s: R.ts }); [0, 1].forEach(i => flMsg(R, i)); }
        sb(k);
      }
    } else if (now > rd.end) {
      rd.brk = now + BRK;
      const l = ps.sort(R.gm === "arms" ? (a, b) => (b.al | 0) - (a.al | 0) || b.k - a.k : (a, b) => b.k - a.k || a.d - b.d);
      let w = ((R.win && ps.find(q => q.id === R.win)) || l[0]).n, wt = -1;
      if (R.team) { const s = R.gm === "ctf" ? R.ts.slice() : [0, 0]; if (R.gm !== "ctf") for (const q of l) s[q.tm] += q.k; wt = s[0] === s[1] ? -1 : s[0] > s[1] ? 0 : 1; w = wt < 0 ? "НИЧЬЯ" : wt ? "СИНИЕ" : "КРАСНЫЕ"; }
      room(k, { t: "end", w, wt, wid: l[0].id, l: l.slice(0, 3).map(q => [q.n, q.k, q.d]) });
    } else room(k, { t: "tm", s: Math.ceil((rd.end - now) / 1000) });
  }
  for (const [t, g] of ghosts) if (now - g.t > 30000) ghosts.delete(t);
}, 1000);

setInterval(() => {
  for (const R of ROOMS.values()) {
    if (!R.b) continue;
    if (!inRoom(R.k).length) { if (R.b.rn || R.b.ph !== "wait") R.b = mkBomb(R.mi); continue; }
    try { bombTick(R); } catch (e) { console.error("bomb:", e); }
  }
}, 200);

/* ---------- соединения ---------- */
wss.on("connection", ws => {
  if (pl.size >= MAX * 40) { ws.close(); return; }
  const p = { id: nid++, n: "Игрок", m: "0", hp: 100, k: 0, d: 0, a: true, j: false, lh: {}, x: 0, y: 0, z: 0, inv: 0, tm: -1, ct: 0, gt: 0, al: 0, tok: "", ws, own: [3, 4], g: [0, 0, 0], ar: 0, hl: 0, kit: 0, mo: BM.MONEY0, act: null };
  pl.set(ws, p);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    if (m.t === "join" && !p.j && m.at && !m._a && A.on) {   // сначала проверяем вход в аккаунт
      A.byToken(String(m.at)).then(a => { p.acc = a || null; }).catch(() => {}).then(() => { m._a = 1; onMsg(m); });
      return;
    }
    onMsg(m);
  });
  const onMsg = m => {
    const now = Date.now();
    if (m.t === "join" && !p.j) {
      const code = String(m.rk || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      const mi = Math.max(0, Math.min(NM - 1, Math.floor(+m.m || 0))), gm0 = GMS.includes(m.gm) ? m.gm : (code ? "tdm" : "ffa"), key = code ? "P" + code : gm0 === "ffa" ? String(mi) : "G" + gm0 + mi;
      const R = getRoom(key, mi, gm0 === "tdm" || gm0 === "ctf" || gm0 === "bomb", gm0), ps = inRoom(key);
      if (ps.length >= MAX) { ws.close(); return; }
      p.m = key;
      p.n = String(m.n || "Игрок").replace(/[<>&]/g, "").slice(0, 12) || "Игрок";
      if (p.acc) p.n = p.acc.name;
      p.tok = String(m.tok || "").slice(0, 16);
      const g = ghosts.get(p.tok);                      // переподключение: возвращаем счёт и команду
      if (g && g.m === key && now - g.t < 30000) { p.k = g.k; p.d = g.d; p.tm = g.tm; p.al = g.al | 0; }
      else p.tm = R.team ? (ps.filter(q => q.tm === 0).length <= ps.filter(q => q.tm === 1).length ? 0 : 1) : -1;
      ghosts.delete(p.tok);
      if (R.b) { p.mo = BM.MONEY0; resetLoad(p); if (R.b.ph === "live" || R.b.ph === "post") p.a = false; }   // зашёл посреди раунда — ждёт следующего
      p.j = true; p.inv = now + 2000;
      send(ws, { t: "hello", id: p.id, tm: p.tm, mi: R.mi, rk: code, gm: R.gm, al: p.al | 0, ts: R.ts, fl: R.fl ? flOut(R) : null, p: ps.map(q => ({ id: q.id, n: q.n, a: q.a, tm: q.tm })), pk: R.pk.map(k => [k.x, k.z, k.k, k.on ? 1 : 0]), s: R.b ? (R.b.ph === "wait" ? 0 : Math.ceil(Math.max(0, R.b.end - now) / 1000)) : Math.ceil(Math.max(0, R.rd.end - now) / 1000), bs: R.b ? bsOut(R) : null });
      if (R.b) { sendOwn(p); if (!p.a) send(ws, { t: "spec" }); }
      if (p.acc) send(ws, { t: "prof", p: A.pub(p.acc) });
      room(key, { t: "j", id: p.id, n: p.n, tm: p.tm }, ws);
      sb(key);
    } else if (!p.j) {
      return;
    } else if (m.t === "s" && p.a) {
      p.x = num(m.x, 40); p.y = num(m.y, 10); p.z = num(m.z, 40);
      room(p.m, { t: "s", id: p.id, x: p.x, y: p.y, z: p.z, yaw: num(m.yaw, 50), c: m.c ? 1 : 0 }, ws);
      const R = ROOMS.get(p.m);
      if (R.fl) ctfStep(R, p);
      if (R.b && R.b.bm.st === "dropped" && p.tm === 0 && R.b.ph === "live" && Math.hypot(R.b.bm.x - p.x, R.b.bm.z - p.z) < 1.6) { R.b.bm.st = "carried"; R.b.bm.c = p.id; bsend(R); sendOwn(p); }
      R.pk.forEach((k, i) => {
        if (!k.on || Math.hypot(k.x - p.x, k.z - p.z) > 1.3 || (k.k === "h" && p.hp >= 100)) return;
        k.on = false;
        if (k.k === "h") { p.hp = Math.min(100, p.hp + 40); send(ws, { t: "heal", hp: Math.round(p.hp) }); } else send(ws, { t: "ammo" });
        room(p.m, { t: "pk", i, on: 0 });
        setTimeout(() => { k.on = true; room(p.m, { t: "pk", i, on: 1 }); }, 15000);
      });
    } else if (m.t === "shot" && p.a && Array.isArray(m.o) && Array.isArray(m.e) && m.o.length === 3 && m.e.length === 3) {
      room(p.m, { t: "shot", id: p.id, o: m.o.map(v => num(v, 200)), e: m.e.map(v => num(v, 200)) }, ws);
    } else if (m.t === "c") {
      const x = String(m.x || "").replace(/[<>]/g, "").trim().slice(0, 80);
      if (!x || now - p.ct < 700) return;
      p.ct = now; room(p.m, { t: "c", id: p.id, n: p.n, x, tm: p.tm });
    } else if (m.t === "gr" && p.a && ROOMS.get(p.m).gm !== "arms" && now - p.gt >= GRN.rate * 700 && Array.isArray(m.o) && Array.isArray(m.v) && m.o.length === 3 && m.v.length === 3) {
      const Rg = ROOMS.get(p.m), kg = (m.k | 0) % 3;
      if (Rg.b) { if ((Rg.b.ph !== "live" && Rg.b.ph !== "wait") || !(p.g[kg] > 0)) return; p.g[kg]--; }   // в «Бомбе» гранаты только купленные
      p.gt = now;
      room(p.m, { t: "gr", id: p.id, o: m.o.map(v => num(v, 60)), v: m.v.map(v => num(v, 30)), k: (m.k | 0) % 3 }, ws);
    } else if (m.t === "buy") {
      const R = ROOMS.get(p.m), it = ITEMS[m.i];
      if (!R.b || !it || !p.a || (R.b.ph !== "buy" && R.b.ph !== "wait")) return;
      const id = m.i, pr = GM.price(id, p);
      if (p.mo < pr) return;
      if (it.w !== undefined) { if (p.own.includes(it.w)) return; p.own = p.own.filter(w => !PRIM.includes(w)); p.own.push(it.w); }
      else if (id === "kev") { if (p.ar >= 100) return; p.ar = 100; }
      else if (id === "kevh") { if (p.ar >= 100 && p.hl) return; p.ar = 100; p.hl = 1; }
      else if (it.g !== undefined) { if (p.g[it.g] >= it.max) return; p.g[it.g]++; }
      else if (id === "kit") { if (p.tm !== 1 || p.kit) return; p.kit = 1; }
      p.mo -= pr; sendOwn(p);
    } else if (m.t === "act") {
      const R = ROOMS.get(p.m);
      if (!R.b) return;
      if (!m.on) { if (p.act) { p.act = null; send(ws, { t: "pr", p: -1 }); } return; }
      const b = R.b, bm = b.bm;
      if (b.ph !== "live" || !p.a || p.act) return;
      if (p.tm === 0 && bm.st === "carried" && bm.c === p.id) {
        const i = b.sites.findIndex(s => Math.hypot(s.x - p.x, s.z - p.z) < 3);
        if (i >= 0) p.act = { k: "plant", t0: now, site: i, px: p.x, pz: p.z };
      } else if (p.tm === 1 && bm.st === "planted" && Math.hypot(bm.x - p.x, bm.z - p.z) < 2.4) p.act = { k: "defuse", t0: now, site: bm.site, px: p.x, pz: p.z };
    } else if (m.t === "hit" && p.a && Array.isArray(m.h) && !ROOMS.get(p.m).rd.brk) {
      // Сервер сам знает оружие: лимит скорострельности, дальность и максимум урона берутся из таблиц WPN/GRN.
      const gw = m.w === -1, wi = gw ? -1 : m.w | 0, w = gw ? GRN : WPN[wi];
      const Rh = ROOMS.get(p.m);
      if (Rh.b && ((Rh.b.ph !== "live" && Rh.b.ph !== "wait") || (!gw && !p.own.includes(wi)))) return;   // стрелять можно только купленным
      if (!w || now - (p.lh[wi] || 0) < w.rate * 700) return;
      if (ROOMS.get(p.m).gm === "arms" && (gw || wi !== LAD[p.al | 0])) return;   // в гонке вооружений бьёт только оружие текущего уровня
      if (gw && (!p.gt || now - p.gt > 6000)) return;   // граната: только в течение 6 с после броска, один взрыв на бросок
      p.lh[wi] = now; if (gw) p.gt = 0;
      for (const e of m.h.slice(0, 12)) {
        if (!Array.isArray(e)) continue;
        const tg = inRoom(p.m).find(q => q.id === e[0]);
        if (!tg || tg === p || Math.hypot(tg.x - p.x, tg.z - p.z) > w.rng + 4) continue;
        hurt(tg, p, Math.max(0, Math.min(w.dmg * w.pel * (gw ? 1 : 2.5), +e[1] || 0)), e[2], wi);
      }
    }
  };

  ws.on("close", () => {
    pl.delete(ws);
    if (p.j) {
      dropFlag(ROOMS.get(p.m), p);
      { const Rc = ROOMS.get(p.m); if (Rc && Rc.b) dropBomb(Rc, p); }
      if (p.tok) ghosts.set(p.tok, { m: p.m, k: p.k, d: p.d, tm: p.tm, al: p.al, t: Date.now() });
      room(p.m, { t: "l", id: p.id }); sb(p.m);
    }
  });
});

setInterval(() => {
  for (const w of pl.keys()) {
    if (!w.isAlive) { w.terminate(); continue; }
    w.isAlive = false;
    w.ping();
  }
}, 25000);

srv.listen(PORT, () => console.log("ULTRA FPS online: порт " + PORT));

module.exports = { srv, A };
