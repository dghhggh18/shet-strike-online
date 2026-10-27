"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const GM = require("./maps.js"), MP = GM.MAPS, WPN = GM.WPN;
const PORT = process.env.PORT || 3000, MAX = 12, NM = MP.length, RND = 180000, BRK = 8000;
const page = fs.readFileSync(path.join(__dirname, "index.html"));
const mapsJs = fs.readFileSync(path.join(__dirname, "maps.js"));
const pl = new Map(), OB = MP.map((_, i) => GM.genObs(i));
let nid = 1;
const types = { ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream" };

const srv = http.createServer((q, r) => {
  if (q.url.startsWith("/lobby")) {
    const m = new Array(NM).fill(0);
    for (const p of pl.values()) if (p.j) m[p.m]++;
    r.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    r.end(JSON.stringify({ m })); return;
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
const all = () => [...pl.values()];
const inRoom = m => all().filter(q => q.j && q.m === m);
const hum = m => [...pl.values()].filter(q => q.j && q.m === m).length;
const room = (m, o, ex) => { for (const q of pl.values()) if (q.j && q.m === m && q.ws !== ex) send(q.ws, o); };
const sb = m => room(m, { t: "sb", l: inRoom(m).map(q => [q.n, q.k, q.d, q.id]) });
const num = (v, m) => Math.max(-m, Math.min(m, +v || 0));
const free = (m, x, z) => !OB[m].some(o => x > o.x0 - 1 && x < o.x1 + 1 && z > o.z0 - 1 && z < o.z1 + 1);
/* ---------- pickups: 3 аптечки + 3 патроны на карту ---------- */
const PK = MP.map((M, i) => {
  const r = GM.mkSr(M.seed + 5), a = [];
  for (let k = 0; a.length < 6 && k < 200; k++) {
    const x = (r() * 2 - 1) * (M.A - 3), z = (r() * 2 - 1) * (M.A - 3);
    if (free(i, x, z)) a.push({ x, z, k: a.length % 2 ? "a" : "h", on: true });
  }
  return a;
});

/* ---------- rounds ---------- */
const RD = MP.map(() => ({ end: Date.now() + RND, brk: 0 }));

/* ---------- урон: единственное место, где меняется HP ---------- */
function hurt(tg, at, d, hs) {
  if (!tg.a || tg.inv > Date.now() || RD[tg.m].brk) return;
  tg.hp -= d;
  send(tg.ws, { t: "hp", hp: Math.max(0, Math.round(tg.hp)), f: at.id });
  if (tg.hp > 0) return;
  tg.a = false; at.k++; tg.d++;
  room(tg.m, { t: "kill", a: at.id, b: tg.id, an: at.n, bn: tg.n, h: hs ? 1 : 0 });
  sb(tg.m);
  setTimeout(() => {
    if (tg.a || !pl.has(tg.ws)) return;
    tg.hp = 100; tg.a = true; tg.inv = Date.now() + 2000;
    send(tg.ws, { t: "resp" });
    room(tg.m, { t: "alive", id: tg.id }, tg.ws);
  }, 3000);
}

/* ---------- раунды: таймер, перерыв, сброс ---------- */
setInterval(() => {
  const now = Date.now();
  for (let m = 0; m < NM; m++) {
    const R = RD[m];
    if (!hum(m)) { R.end = now + RND; R.brk = 0; continue; }
    if (R.brk) {
      if (now > R.brk) {
        R.brk = 0; R.end = now + RND;
        for (const q of inRoom(m)) {
          q.k = q.d = 0; q.hp = 100; q.a = true; q.inv = now + 2000;
          send(q.ws, { t: "resp" });
          room(m, { t: "alive", id: q.id }, q.ws);
        }
        sb(m);
      }
    } else if (now > R.end) {
      R.brk = now + BRK;
      const l = inRoom(m).sort((a, b) => b.k - a.k || a.d - b.d);
      room(m, { t: "end", w: l[0] ? l[0].n : "", l: l.slice(0, 3).map(q => [q.n, q.k, q.d]) });
    } else room(m, { t: "tm", s: Math.ceil((R.end - now) / 1000) });
  }
}, 1000);

/* ---------- соединения ---------- */
wss.on("connection", ws => {
  if (pl.size >= MAX * NM) { ws.close(); return; }
  const p = { id: nid++, n: "Игрок", m: 0, hp: 100, k: 0, d: 0, a: true, j: false, lh: {}, x: 0, y: 0, z: 0, inv: 0, ws };
  pl.set(ws, p);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    if (m.t === "join" && !p.j) {
      const mi = Math.max(0, Math.min(NM - 1, Math.floor(+m.m || 0)));
      if (hum(mi) >= MAX) { ws.close(); return; }
      p.m = mi;
      p.n = String(m.n || "Игрок").replace(/[<>&]/g, "").slice(0, 12) || "Игрок";
      p.j = true; p.inv = Date.now() + 2000;
      send(ws, { t: "hello", id: p.id, p: inRoom(mi).filter(q => q !== p).map(q => ({ id: q.id, n: q.n, a: q.a })), pk: PK[mi].map(k => [k.x, k.z, k.k, k.on ? 1 : 0]), s: Math.ceil(Math.max(0, RD[mi].end - Date.now()) / 1000) });
      room(mi, { t: "j", id: p.id, n: p.n }, ws);
      sb(mi);
    } else if (!p.j) {
      return;
    } else if (m.t === "s" && p.a) {
      p.x = num(m.x, 40); p.y = num(m.y, 10); p.z = num(m.z, 40);
      room(p.m, { t: "s", id: p.id, x: p.x, y: p.y, z: p.z, yaw: num(m.yaw, 50) }, ws);
      PK[p.m].forEach((k, i) => {
        if (!k.on || Math.hypot(k.x - p.x, k.z - p.z) > 1.3 || (k.k === "h" && p.hp >= 100)) return;
        k.on = false;
        if (k.k === "h") { p.hp = Math.min(100, p.hp + 40); send(ws, { t: "heal", hp: Math.round(p.hp) }); } else send(ws, { t: "ammo" });
        room(p.m, { t: "pk", i, on: 0 });
        setTimeout(() => { k.on = true; room(p.m, { t: "pk", i, on: 1 }); }, 15000);
      });
    } else if (m.t === "shot" && p.a && Array.isArray(m.o) && Array.isArray(m.e) && m.o.length === 3 && m.e.length === 3) {
      room(p.m, { t: "shot", id: p.id, o: m.o.map(v => num(v, 200)), e: m.e.map(v => num(v, 200)) }, ws);
    } else if (m.t === "hit" && p.a && Array.isArray(m.h) && !RD[p.m].brk) {
      // Сервер сам знает оружие: лимит скорострельности, дальность и максимум урона берутся из таблицы WPN.
      const wi = m.w | 0, w = WPN[wi], now = Date.now();
      if (!w || now - (p.lh[wi] || 0) < w.rate * 700) return;
      p.lh[wi] = now;
      for (const e of m.h.slice(0, 12)) {
        if (!Array.isArray(e)) continue;
        const tg = all().find(q => q.j && q.m === p.m && q.id === e[0]);
        if (!tg || tg === p || Math.hypot(tg.x - p.x, tg.z - p.z) > w.rng + 4) continue;
        hurt(tg, p, Math.max(0, Math.min(w.dmg * w.pel * 2.5, +e[1] || 0)), e[2]);
      }
    }
  });

  ws.on("close", () => {
    pl.delete(ws);
    if (p.j) { room(p.m, { t: "l", id: p.id }); sb(p.m); }
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
