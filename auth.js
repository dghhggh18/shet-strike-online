"use strict";
// Аккаунты: вход по нику и паролю, профиль на сервере, награды, ящики, таблица лидеров.
const crypto = require("crypto"), GM = require("./maps.js"), SH = GM.SHOP, WPN = GM.WPN;
const store = require("./db.js")(process.env.DATABASE_URL);
const A = { on: false, kind: store ? store.kind : "off", err: "" };
const cache = new Map(), dirty = new Set(), sess = new Map(), rl = new Map();
const NAME_RE = /^[\p{L}\p{N}_.-]{3,12}$/u;

const scrypt = (p, s) => new Promise((ok, no) => crypto.scrypt(p, s, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? no(e) : ok(k)));
async function hashPw(pw) { const s = crypto.randomBytes(16); return "s1$" + s.toString("hex") + "$" + (await scrypt(pw, s)).toString("hex"); }
async function checkPw(pw, h) {
  const [v, s, k] = String(h).split("$"); if (v !== "s1") return false;
  const d = await scrypt(pw, Buffer.from(s, "hex")), e = Buffer.from(k, "hex");
  return d.length === e.length && crypto.timingSafeEqual(d, e);
}
const th = t => crypto.createHash("sha256").update(String(t)).digest("hex");
const rnd = () => crypto.randomInt(0, 1e9) / 1e9;
const defProfile = name => { const own = {}, eq = {}; for (let w = 0; w < WPN.length; w++) { own[w + "_d"] = 1; eq[w] = w + "_d"; } return { name, xp: 0, coins: 150, free: 1, k: 0, d: 0, h: 0, wb: 0, own, eq, agent: 0, pw: 0, lw: 0 }; };
const pub = a => { const d = a.d; return { name: a.name, xp: d.xp, coins: d.coins, free: d.free, k: d.k, d: d.d, h: d.h, wb: d.wb, own: d.own, eq: d.eq, agent: d.agent, pw: d.pw }; };
A.pub = pub;
const mark = a => { dirty.add(a.id); };
const hit = (key, max, win) => { const n = Date.now(), r = rl.get(key); if (!r || n - r.t > win) { rl.set(key, { n: 1, t: n }); return true; } r.n++; return r.n <= max; };

async function load(id) {
  let c = cache.get(id); if (c) { c.t = Date.now(); return c; }
  const r = await store.byId(id); if (!r) return null;
  const d = Object.assign(defProfile(r.name), r.data || {});
  for (let w = 0; w < WPN.length; w++) { d.own[w + "_d"] = 1; if (!SH.SK[d.eq[w]] || !d.own[d.eq[w]]) d.eq[w] = w + "_d"; }
  c = { id, name: r.name, key: r.key, d, t: Date.now(), lastK: {} }; cache.set(id, c); return c;
}
async function newSession(a) { const tok = crypto.randomBytes(32).toString("hex"), exp = Date.now() + 30 * 864e5; sess.set(th(tok), { id: a.id, exp }); await store.session(th(tok), a.id, exp); return tok; }
A.byToken = async tok => {
  if (!A.on || !tok) return null; const h = th(tok); let s = sess.get(h);
  if (!s || s.exp < Date.now()) { const id = await store.sessionGet(h); if (!id) return null; s = { id, exp: Date.now() + 864e5 }; sess.set(h, s); }
  return load(s.id);
};
// Награда за убийство: решает сервер. Один и тот же противник не даёт награду чаще, чем раз в 20 секунд.
A.award = (a, o) => {
  const d = a.d, b = SH.lvl(d.xp)[0]; d.xp += o.xp | 0; d.coins += o.coins | 0; d.k += o.k | 0; d.h += o.h | 0; d.d += o.d | 0;
  const l = SH.lvl(d.xp)[0]; let up = null;
  if (l > b) { let c = 0, f = 0; for (let L = b + 1; L <= l; L++) { const r = SH.reward(L); c += r.c; f += r.f; } d.coins += c; d.free += f; up = { lv: l, c, f }; }
  mark(a); return up;
};
A.kill = (a, victimId, hs) => {
  const n = Date.now(); if (n - (a.lastK[victimId] || 0) < 20000) { a.d.k++; if (hs) a.d.h++; mark(a); return null; }
  a.lastK[victimId] = n; return A.award(a, { xp: hs ? 30 : 20, coins: hs ? 3 : 2, k: 1, h: hs ? 1 : 0 });
};
A.death = a => { a.d.d++; mark(a); };

async function flush() { const ids = [...dirty]; dirty.clear(); for (const id of ids) { const c = cache.get(id); if (!c) continue; try { await store.save(id, c.d, c.d.xp, c.d.k, c.d.wb); } catch (e) { dirty.add(id); console.error("не сохранилось:", e.message); } } }
A.flush = flush;
setInterval(() => { if (A.on) flush(); }, 5000).unref();
setInterval(() => { const n = Date.now(); for (const [id, c] of cache) if (n - c.t > 30 * 6e4 && !dirty.has(id)) cache.delete(id); for (const [k, r] of rl) if (n - r.t > 36e5) rl.delete(k); for (const [k, s] of sess) if (s.exp < n) sess.delete(k); }, 6e4).unref();

let topC = { t: 0, v: [] };
async function top() { if (Date.now() - topC.t < 30000) return topC.v; const rows = await store.top(20); topC = { t: Date.now(), v: rows.map(r => { const d = r.data || {}; return { name: r.name, lv: SH.lvl(r.xp)[0], xp: r.xp, k: r.kills, d: d.d | 0, wb: r.wb }; }) }; return topC.v; }

const out = (res, code, o) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
const body = req => new Promise((ok, no) => { let s = ""; req.on("data", c => { s += c; if (s.length > 4096) { no(new Error("big")); req.destroy(); } }); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }); req.on("error", no); });
const bearer = req => { const h = String(req.headers.authorization || ""); return h.startsWith("Bearer ") ? h.slice(7) : ""; };
const ip = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const int = (v, a, b) => { v = Math.floor(+v); return Number.isFinite(v) && v >= a && v <= b ? v : null; };

A.handle = async (req, res, path) => {
  if (!path.startsWith("/api/")) return false;
  try {
    if (path === "/api/status") { out(res, 200, { on: A.on }); return true; }
    if (!A.on) { out(res, 503, { error: "Аккаунты временно недоступны" }); return true; }
    if (path === "/api/top" && req.method === "GET") { out(res, 200, { top: await top() }); return true; }
    if (req.method !== "POST" && !(path === "/api/me" && req.method === "GET")) { out(res, 405, { error: "метод" }); return true; }
    const b = req.method === "POST" ? await body(req) : {};
    if (path.startsWith("/api/admin/")) {   // админка: только по секретному ключу ADMIN_KEY из настроек сервера
      const key = process.env.ADMIN_KEY || "";
      if (key.length < 8) { out(res, 404, { error: "Админ-панель выключена на сервере (нет ADMIN_KEY)" }); return true; }
      const g = Buffer.from(String(req.headers["x-admin-key"] || "")), k = Buffer.from(key);
      if (!(g.length === k.length && crypto.timingSafeEqual(g, k))) { out(res, hit("admf:" + ip(req), 5, 6e5) ? 403 : 429, { error: "Неверный ключ" }); return true; }
      const nm = String(b.name || "").trim().toLowerCase(), rec = nm ? await store.byKey(nm) : null;
      if (!rec) { out(res, 404, { error: "Игрок не найден" }); return true; }
      const t = await load(rec.id);
      if (path === "/api/admin/lookup") { out(res, 200, { me: pub(t) }); return true; }
      if (path === "/api/admin/give") {
        const num = (v, m) => v == null || v === "" ? 0 : int(v, -m, m), c = num(b.coins, 1e6), f = num(b.free, 1000);
        if (c === null || f === null || (c === 0 && f === 0)) { out(res, 400, { error: "Укажи монеты и/или ящики (число, можно со знаком −)" }); return true; }
        t.d.coins = Math.max(0, t.d.coins + c); t.d.free = Math.max(0, t.d.free + f); mark(t); await flush();
        console.log("ADMIN: игроку", t.name, "монеты", c, "ящики", f);
        if (A.notify) A.notify(t);
        out(res, 200, { me: pub(t) }); return true;
      }
      out(res, 404, { error: "нет такого" }); return true;
    }
    if (path === "/api/register" || path === "/api/login") {
      const name = String(b.name || "").trim(), pass = String(b.pass || ""), key = name.toLowerCase();
      if (!NAME_RE.test(name)) { out(res, 400, { error: "Ник: 3–12 символов (буквы, цифры, _ . -)" }); return true; }
      if (pass.length < 6 || pass.length > 64) { out(res, 400, { error: "Пароль: от 6 до 64 символов" }); return true; }
      if (path === "/api/register") {
        if (!hit("reg:" + ip(req), 5, 36e5)) { out(res, 429, { error: "Слишком много регистраций, попробуй позже" }); return true; }
        const r = await store.create(key, name, await hashPw(pass), defProfile(name));
        if (!r) { out(res, 409, { error: "Этот ник уже занят" }); return true; }
        const a = await load(r.id); out(res, 200, { token: await newSession(a), me: pub(a) }); return true;
      }
      if (!hit("lg:" + ip(req), 20, 6e5) || !hit("ln:" + key, 8, 6e5)) { out(res, 429, { error: "Слишком много попыток, подожди 10 минут" }); return true; }
      const r = await store.byKey(key);
      if (!r || !(await checkPw(pass, r.pass))) { out(res, 401, { error: "Неверный ник или пароль" }); return true; }
      const a = await load(r.id); out(res, 200, { token: await newSession(a), me: pub(a) }); return true;
    }
    const a = await A.byToken(bearer(req));
    if (!a) { out(res, 401, { error: "Нужно войти" }); return true; }
    const d = a.d;
    if (path === "/api/me") { out(res, 200, { me: pub(a) }); return true; }
    if (path === "/api/logout") { const h = th(bearer(req)); sess.delete(h); await store.sessionDel(h); out(res, 200, { ok: 1 }); return true; }
    if (path === "/api/equip") { const s = SH.SK[String(b.id)]; if (!s || !d.own[s.id]) { out(res, 400, { error: "Предмета нет" }); return true; } d.eq[s.w] = s.id; d.pw = s.w; mark(a); out(res, 200, { me: pub(a) }); return true; }
    if (path === "/api/agent") { const i = int(b.i, 0, SH.AGENTS.length - 1); if (i === null) { out(res, 400, { error: "цвет" }); return true; } d.agent = i; mark(a); out(res, 200, { me: pub(a) }); return true; }
    if (path === "/api/case") {
      const t = int(b.tier, 0, SH.CASES.length - 1); if (t === null) { out(res, 400, { error: "ящик" }); return true; }
      if (b.free) { if (d.free <= 0) { out(res, 400, { error: "Нет бесплатных ящиков" }); return true; } d.free--; }
      else { if (d.coins < SH.CASES[t].p) { out(res, 400, { error: "Не хватает монет" }); return true; } d.coins -= SH.CASES[t].p; }
      const it = SH.roll(t, rnd), dup = !!d.own[it.id]; if (dup) d.coins += SH.DUP[it.r]; else d.own[it.id] = 1;
      mark(a); out(res, 200, { item: { id: it.id, w: it.w, n: it.n, r: it.r }, dup, me: pub(a) }); return true;
    }
    if (path === "/api/wave") {   // волны считает клиент, поэтому награда ограничена и не чаще раза в 30 секунд
      const w = int(b.wave, 1, 60), k = int(b.kills, 0, 5000); if (w === null || k === null || k > w * w + 4 * w + 5) { out(res, 400, { error: "результат не принят" }); return true; }
      if (Date.now() - (d.lw || 0) < 30000) { out(res, 429, { error: "слишком часто" }); return true; }
      d.lw = Date.now(); d.wb = Math.max(d.wb, w);
      const up = A.award(a, { xp: Math.min(k, 200) * 8, coins: Math.min(k, 200) + w * 3, k, d: b.died ? 1 : 0 });
      out(res, 200, { me: pub(a), up }); return true;
    }
    out(res, 404, { error: "нет такого" }); return true;
  } catch (e) { console.error("api:", e.message); out(res, 500, { error: "Ошибка сервера" }); return true; }
};

(async () => {
  if (!store) { A.err = process.env.DATABASE_URL ? "pg" : "нет DATABASE_URL"; console.log("Аккаунты выключены:", A.err); return; }
  try { await store.init(); A.on = true; console.log("Аккаунты включены (" + store.kind + ")"); }
  catch (e) { A.err = e.message; console.error("Аккаунты выключены, база недоступна:", e.message); }
})();
const bye = () => { if (!A.on) process.exit(0); flush().finally(() => process.exit(0)); };
process.on("SIGTERM", bye); process.on("SIGINT", bye);
A._cache = cache;
module.exports = A;
