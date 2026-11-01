"use strict";
// Хранилище аккаунтов. С DATABASE_URL — Postgres (Neon), иначе аккаунты выключены
// (для тестов: ACCOUNTS_MEMORY=1 включает хранилище в памяти).
function MemStore() {
  const P = new Map(), K = new Map(), S = new Map(); let id = 0;
  const cp = o => JSON.parse(JSON.stringify(o));
  return {
    kind: "memory",
    async init() {},
    async byKey(k) { const i = K.get(k); return i ? cp(P.get(i)) : null; },
    async byId(i) { const r = P.get(i); return r ? cp(r) : null; },
    async create(key, name, pass, data) { if (K.has(key)) return null; const i = ++id; const r = { id: i, key, name, pass, data: cp(data), xp: 0, kills: 0, wb: 0 }; P.set(i, r); K.set(key, i); return cp(r); },
    async save(i, data, xp, kills, wb) { const r = P.get(i); if (r) { r.data = cp(data); r.xp = xp; r.kills = kills; r.wb = wb; } },
    async session(th, pid, exp) { S.set(th, { pid, exp }); },
    async sessionGet(th) { const s = S.get(th); if (!s || s.exp < Date.now()) { S.delete(th); return null; } return s.pid; },
    async sessionDel(th) { S.delete(th); },
    async top(n) { return [...P.values()].sort((a, b) => (b.xp | 0) - (a.xp | 0) || (b.kills | 0) - (a.kills | 0)).slice(0, n).map(r => cp({ name: r.name, xp: r.xp | 0, kills: r.kills | 0, wb: r.wb | 0, data: r.data })); },
  };
}
function PgStore(url) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  pool.on("error", e => console.error("pg:", e.message));
  const q = (t, p) => pool.query(t, p);
  return {
    kind: "postgres",
    async init() {
      await q("CREATE TABLE IF NOT EXISTS players(id SERIAL PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass TEXT NOT NULL, xp INT NOT NULL DEFAULT 0, kills INT NOT NULL DEFAULT 0, wb INT NOT NULL DEFAULT 0, data JSONB NOT NULL, created TIMESTAMPTZ NOT NULL DEFAULT now())");
      await q("CREATE TABLE IF NOT EXISTS sessions(th TEXT PRIMARY KEY, pid INT NOT NULL REFERENCES players(id) ON DELETE CASCADE, exp TIMESTAMPTZ NOT NULL)");
      await q("CREATE INDEX IF NOT EXISTS players_xp ON players(xp DESC)");
    },
    async byKey(k) { const r = await q("SELECT id,key,name,pass,data FROM players WHERE key=$1", [k]); return r.rows[0] || null; },
    async byId(i) { const r = await q("SELECT id,key,name,pass,data FROM players WHERE id=$1", [i]); return r.rows[0] || null; },
    async create(key, name, pass, data) {
      try { const r = await q("INSERT INTO players(key,name,pass,data) VALUES($1,$2,$3,$4) RETURNING id,key,name,pass,data", [key, name, pass, JSON.stringify(data)]); return r.rows[0]; }
      catch (e) { if (e.code === "23505") return null; throw e; }
    },
    async save(i, data, xp, kills, wb) { await q("UPDATE players SET data=$2,xp=$3,kills=$4,wb=$5 WHERE id=$1", [i, JSON.stringify(data), xp | 0, kills | 0, wb | 0]); },
    async session(th, pid, exp) { await q("INSERT INTO sessions(th,pid,exp) VALUES($1,$2,$3) ON CONFLICT (th) DO NOTHING", [th, pid, new Date(exp)]); },
    async sessionGet(th) { const r = await q("SELECT pid FROM sessions WHERE th=$1 AND exp>now()", [th]); return r.rows[0] ? r.rows[0].pid : null; },
    async sessionDel(th) { await q("DELETE FROM sessions WHERE th=$1", [th]); },
    async top(n) { const r = await q("SELECT name,xp,kills,wb,data FROM players ORDER BY xp DESC, kills DESC LIMIT $1", [n]); return r.rows; },
  };
}
module.exports = url => {
  if (url) { try { return PgStore(url); } catch (e) { console.error("Postgres недоступен (нужен пакет pg):", e.message); return null; } }
  return process.env.ACCOUNTS_MEMORY === "1" ? MemStore() : null;
};
