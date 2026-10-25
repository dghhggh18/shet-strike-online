"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");
const PORT = process.env.PORT || 3000, MAX = 12, MAPS = 4;
const page = fs.readFileSync(path.join(__dirname, "index.html"));
const pl = new Map();
let nid = 1;

const srv = http.createServer((q, r) => {
  if (q.url.startsWith("/lobby")) {
    const m = new Array(MAPS).fill(0);
    for (const p of pl.values()) if (p.j) m[p.m]++;
    r.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    r.end(JSON.stringify({ m }));
    return;
  }
  if (q.url === "/health") { r.end("ok"); return; }
  // Статические игровые ресурсы (например, 3D-модели .glb)
  let pathname;
  try { pathname = decodeURIComponent(new URL(q.url, "http://localhost").pathname); }
  catch (e) { r.writeHead(400); r.end("Bad request"); return; }
  if (pathname.startsWith("/assets/")) {
    const root = path.resolve(__dirname, "assets");
    const file = path.resolve(__dirname, "." + pathname);
    if (!file.startsWith(root + path.sep)) { r.writeHead(403); r.end("Forbidden"); return; }
    fs.readFile(file, (err, data) => {
      if (err) { r.writeHead(err.code === "ENOENT" ? 404 : 500); r.end("Not found"); return; }
      const ext = path.extname(file).toLowerCase();
      const types = { ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream" };
      r.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "public, max-age=3600" });
      r.end(data);
    });
    return;
  }
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  r.end(page);
});
const wss = new WebSocketServer({ server: srv, maxPayload: 2048 });

const send = (w, o) => { if (w.readyState === 1) w.send(JSON.stringify(o)); };
// рассылка только внутри комнаты (карты) игрока p
const room = (p, o, ex) => { for (const q of pl.values()) if (q.j && q.m === p.m && q.ws !== ex) send(q.ws, o); };
const sb = p => room(p, { t: "sb", l: [...pl.values()].filter(q => q.j && q.m === p.m).map(q => [q.n, q.k, q.d, q.id]) });
const num = (v, m) => Math.max(-m, Math.min(m, +v || 0));

wss.on("connection", ws => {
  if (pl.size >= MAX * MAPS) { ws.close(); return; }
  const p = { id: nid++, n: "Игрок", m: 0, hp: 100, k: 0, d: 0, a: true, j: false, lh: 0, ws };
  pl.set(ws, p);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === "join" && !p.j) {
      const mi = Math.max(0, Math.min(MAPS - 1, Math.floor(+m.m || 0)));
      let cnt = 0;
      for (const q of pl.values()) if (q.j && q.m === mi) cnt++;
      if (cnt >= MAX) { ws.close(); return; }
      p.m = mi;
      p.n = String(m.n || "Игрок").replace(/[<>&]/g, "").slice(0, 12) || "Игрок";
      p.j = true;
      send(ws, { t: "hello", id: p.id, p: [...pl.values()].filter(q => q.j && q.m === p.m && q !== p).map(q => ({ id: q.id, n: q.n, a: q.a })) });
      room(p, { t: "j", id: p.id, n: p.n }, ws);
      sb(p);
    } else if (!p.j) {
      return;
    } else if (m.t === "s" && p.a) {
      room(p, { t: "s", id: p.id, x: num(m.x, 40), y: num(m.y, 10), z: num(m.z, 40), yaw: num(m.yaw, 50) }, ws);
    } else if (m.t === "shot" && p.a && Array.isArray(m.o) && Array.isArray(m.e) && m.o.length === 3 && m.e.length === 3) {
      room(p, { t: "shot", id: p.id, o: m.o.map(v => num(v, 200)), e: m.e.map(v => num(v, 200)) }, ws);
    } else if (m.t === "hit" && p.a) {
      const now = Date.now();
      if (now - p.lh < 40) return;
      p.lh = now;
      let tg = null;
      for (const q of pl.values()) if (q.j && q.m === p.m && q.id === m.id) tg = q;
      if (!tg || !tg.a || tg === p) return;
      tg.hp -= Math.max(0, Math.min(90, +m.d || 0));
      send(tg.ws, { t: "hp", hp: Math.max(0, Math.round(tg.hp)) });
      if (tg.hp <= 0) {
        tg.a = false; p.k++; tg.d++;
        room(p, { t: "kill", a: p.id, b: tg.id, an: p.n, bn: tg.n });
        sb(p);
        setTimeout(() => {
          if (!pl.has(tg.ws)) return;
          tg.hp = 100; tg.a = true;
          send(tg.ws, { t: "resp" });
          room(tg, { t: "alive", id: tg.id }, tg.ws);
        }, 3000);
      }
    }
  });

  ws.on("close", () => {
    pl.delete(ws);
    if (p.j) { room(p, { t: "l", id: p.id }); sb(p); }
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
