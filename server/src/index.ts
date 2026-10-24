/** Socket.IO transport and room lifecycle for the SHATKI FPS prototype. */
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createGuest, equipProfileSkin, getProfileByToken, incrementProfile, leaderboard, loginAccount, openProfileCase, unequipProfileSkin, updateProfile, upgradeGuestAccount } from "./profiles.js";
import { Server, type Socket } from "socket.io";
import { applyMovement, createPlayer, publicState, resolveShot, socketNickname, type MatchMode, type ServerRoom, type ShotInput, type MoveInput } from "./game/authoritative.js";

const app = express();
const configuredOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
  .split(",").map(value => value.trim()).filter(Boolean);
// Render serves the client and API from one origin. In production, allow the
// deployed origin (same-origin requests do not need CORS); local dev remains restricted.
const corsOrigin = process.env.NODE_ENV === "production"
  ? true
  : (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || configuredOrigins.includes(origin)) callback(null, true);
      else callback(new Error("Origin not allowed by CORS"));
    };
app.use(cors({ origin: corsOrigin }));
// Lightweight baseline hardening; TLS is provided by Render in production.
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(express.json({ limit: "16kb", strict: true }));

// Per-process API limiter. This is useful for a single Render instance, but
// should be replaced by a shared Redis limiter before horizontal scaling.
type LimitEntry = { count: number; resetAt: number };
const apiLimits = new Map<string, LimitEntry>();
function rateLimit(bucket: string, max: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${bucket}:${req.ip || "unknown"}`;
    const now = Date.now();
    let entry = apiLimits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      apiLimits.set(key, entry);
    }
    entry.count += 1;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      res.status(429).json({ error: "RATE_LIMITED" });
      return;
    }
    next();
  };
}
// Periodically discard expired buckets so the map does not grow forever.
const apiLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of apiLimits) if (entry.resetAt <= now) apiLimits.delete(key);
}, 60_000);
apiLimitCleanup.unref();
app.get("/health", (_req, res) => res.json({ ok: true, service: "shatki-fps-server", stage: "profile-persistence-prototype", websocket: "socket.io" }));
app.post("/api/guest", rateLimit("guest", 12, 60_000), (req, res) => {
  const created = createGuest(req.body?.nickname);
  res.status(201).json(created);
});
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
function allowLoginAttempt(key: string) {
  const now = Date.now(); const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) { loginAttempts.set(key, { count: 1, resetAt: now + 60_000 }); return true; }
  if (entry.count >= 10) return false;
  entry.count += 1; return true;
}
app.post("/api/account/login", (req, res) => {
  const key = req.ip || "unknown";
  if (!allowLoginAttempt(key)) { res.status(429).json({ error: "TOO_MANY_ATTEMPTS" }); return; }
  const result = loginAccount(req.body?.username, req.body?.password);
  if (!result.ok) { res.status(401).json({ error: result.error }); return; }
  loginAttempts.delete(key);
  res.json(result);
});
app.post("/api/account/upgrade", rateLimit("account-upgrade", 8, 60_000), (req, res) => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const result = upgradeGuestAccount(token, req.body?.username, req.body?.password);
  if (!result.ok) {
    const status = result.error === "INVALID_TOKEN" ? 401 : result.error === "USERNAME_TAKEN" ? 409 : 400;
    res.status(status).json({ error: result.error }); return;
  }
  res.json({ profile: result.profile });
});
app.get("/api/me", (req, res) => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const profile = getProfileByToken(token);
  if (!profile) { res.status(401).json({ error: "INVALID_TOKEN" }); return; }
  res.json({ profile });
});
app.patch("/api/me", (req, res) => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const profile = getProfileByToken(token);
  if (!profile) { res.status(401).json({ error: "INVALID_TOKEN" }); return; }
  if (typeof req.body?.nickname !== "string") { res.status(400).json({ error: "NICKNAME_REQUIRED" }); return; }
  const updated = updateProfile(profile.id, { nickname: req.body.nickname });
  res.json({ profile: updated });
});
app.post("/api/me/equip", rateLimit("equip", 30, 60_000), (req, res) => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const profile = getProfileByToken(token);
  if (!profile) { res.status(401).json({ error: "INVALID_TOKEN" }); return; }
  const result = equipProfileSkin(profile.id, req.body?.skinId);
  if (!result.ok) { res.status(result.error === "SKIN_NOT_OWNED" ? 400 : 404).json({ error: result.error }); return; }
  res.json({ profile: result.profile, skin: result.skin });
});
app.post("/api/me/unequip", rateLimit("unequip", 30, 60_000), (req, res) => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const profile = getProfileByToken(token);
  if (!profile) { res.status(401).json({ error: "INVALID_TOKEN" }); return; }
  const result = unequipProfileSkin(profile.id, req.body?.weaponId);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  res.json({ profile: result.profile });
});
app.post("/api/cases/open", rateLimit("case-open", 20, 60_000), (req, res) => {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const profile = getProfileByToken(token);
  if (!profile) { res.status(401).json({ error: "INVALID_TOKEN" }); return; }
  const result = openProfileCase(profile.id);
  if (!result.ok) { res.status(result.error === "INSUFFICIENT_FUNDS" ? 409 : 404).json({ error: result.error }); return; }
  res.json({ profile: result.profile, item: result.item });
});
app.get("/api/leaderboard", (_req, res) => res.json({ players: leaderboard() }));
// In production Render runs one web service for both the Vite build and Socket.IO.
// In development Vite serves the UI separately on port 5173.
if (process.env.NODE_ENV === "production") {
  const { default: path } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "../../dist");
  app.use(express.static(distDir, { index: false, maxAge: "1h" }));
  app.get("*", (req, res, next) => {
    // Leave Engine.IO requests untouched so Socket.IO can handle WebSocket upgrades
    // and its polling fallback on the same HTTP server.
    if (req.path.startsWith("/socket.io/")) return;
    if (!req.accepts("html")) return next();
    res.sendFile(path.join(distDir, "index.html"), error => { if (error) next(error); });
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: corsOrigin } });
const rooms = new Map<string, ServerRoom>();
const playerRoom = new Map<string, string>();
const bombActions = new Map<string, ReturnType<typeof setTimeout>>();
function cancelBombAction(socketId: string) { const timer = bombActions.get(socketId); if (timer) clearTimeout(timer); bombActions.delete(socketId); }

function roomFor(socket: Socket) { const id = playerRoom.get(socket.id); return id ? rooms.get(id) : undefined; }
function publish(room: ServerRoom) { io.to(room.id).emit("match:state", publicState(room)); }
function publishRoomList() {
  const summary = [...rooms.values()].map(r => ({ id: r.id, mode: r.mode, players: r.players.size, createdAt: r.createdAt, phase: r.phase, score: r.score }));
  io.emit("room:list-updated", summary);
}
function endRound(room: ServerRoom, winner: "T" | "CT" | "DRAW", reason: string) {
  if (room.phase === "ended") return;
  room.phase = "ended"; room.winner = winner;
  if (winner !== "DRAW" && reason !== "SCORE_LIMIT") room.score[winner] += 1;
  if (winner !== "DRAW") for (const player of room.players.values()) {
    if (player.team === winner) {
      const connected = io.sockets.sockets.get(player.id);
      const profile = connected?.data.profile as ReturnType<typeof getProfileByToken>;
      if (profile) {
        const saved = incrementProfile(profile.id, { wins: 1 });
        if (saved) connected?.emit("profile:update", saved);
      }
    }
  }
  io.to(room.id).emit("match:round-end", { winner, reason, score: room.score, at: Date.now() });
  publish(room);
  publishRoomList();
  // Both modes continue in the same room after a short result screen. Deathmatch
  // starts a fresh score race; Defusal preserves the round score and resets the bomb.
  const roomId = room.id;
  setTimeout(() => {
    const current = rooms.get(roomId);
    if (current !== room || current.phase !== "ended" || current.players.size === 0) return;
    current.phase = "live";
    current.winner = undefined;
    current.endsAt = Date.now() + 120_000;
    if (current.mode === "deathmatch") current.score = { T: 0, CT: 0 };
    current.bomb = { planted: false, site: null, position: null, plantedAt: null, explodesAt: null, defused: false };
    for (const player of current.players.values()) {
      player.alive = true; player.health = 100; player.armor = 0;
      player.position = { x: player.team === "T" ? 12 : -12, y: 1.8, z: 0 };
      player.yaw = player.team === "T" ? 0 : Math.PI; player.pitch = 0;
      player.lastShotAt = {}; player.lastInputAt = Date.now();
    }
    io.to(current.id).emit("match:round-start", { endsAt: current.endsAt, score: current.score });
    publish(current);
    publishRoomList();
  }, 5000);
}
function respawnPlayer(roomId: string, playerId: string) {
  const room = rooms.get(roomId), player = room?.players.get(playerId);
  if (!room || room.phase !== "live" || !player || player.alive) return;
  player.health = 100; player.armor = 0; player.alive = true;
  // Alternate spawn sides to reduce instant repeated spawn kills.
  const side = player.deaths % 2 === 0 ? 12 : -12;
  player.position = { x: player.team === "T" ? side : -side, y: 1.8, z: player.deaths % 2 === 0 ? 0 : 8 };
  player.yaw = player.team === "T" ? 0 : Math.PI;
  player.pitch = 0; player.lastInputAt = Date.now();
  publish(room);
}
const MAX_PLAYERS_PER_ROOM = 10;
function createRoom(mode: MatchMode): ServerRoom {
  const id = `room-${randomUUID().slice(0, 8)}`;
  const room: ServerRoom = { id, mode, createdAt: Date.now(), players: new Map(), phase: "live", endsAt: Date.now() + 120_000, score: { T: 0, CT: 0 }, bomb: { planted: false, site: null, position: null, plantedAt: null, explodesAt: null, defused: false } };
  rooms.set(id, room);
  return room;
}
function addSocketToRoom(socket: Socket, room: ServerRoom, candidateNickname?: unknown) {
  const teamT = [...room.players.values()].filter(p => p.team === "T").length;
  const teamCT = [...room.players.values()].filter(p => p.team === "CT").length;
  const team = teamT <= teamCT ? "T" : "CT";
  const profile = socket.data.profile as ReturnType<typeof getProfileByToken>;
  const player = createPlayer(socket.id, room.id, profile?.nickname ?? socketNickname(socket, candidateNickname), team);
  if (profile) { player.currency = profile.currency; player.kills = profile.kills; player.deaths = profile.deaths; }
  room.players.set(socket.id, player);
  playerRoom.set(socket.id, room.id);
  socket.join(room.id);
  publish(room);
  publishRoomList();
  return player;
}
function leaveRoom(socket: Socket) {
  cancelBombAction(socket.id);
  const id = playerRoom.get(socket.id); if (!id) return;
  const room = rooms.get(id); playerRoom.delete(socket.id); socket.leave(id);
  if (room) { room.players.delete(socket.id); if (!room.players.size) rooms.delete(id); else publish(room); }
  publishRoomList();
}

io.use((socket, next) => {
  const profile = getProfileByToken(socket.handshake.auth?.token);
  socket.data.profile = profile;
  next();
});
io.on("connection", socket => {
  const eventWindows = new Map<string, { count: number; resetAt: number }>();
  socket.use(([eventName], next) => {
    const now = Date.now();
    const bucket = eventName === "player:input" ? "movement" : eventName === "combat:shoot" ? "shoot" : "general";
    const max = bucket === "movement" ? 90 : bucket === "shoot" ? 15 : 60;
    const windowMs = 1000;
    let entry = eventWindows.get(bucket);
    if (!entry || entry.resetAt <= now) { entry = { count: 0, resetAt: now + windowMs }; eventWindows.set(bucket, entry); }
    entry.count += 1;
    if (entry.count > max) return next(new Error("RATE_LIMITED"));
    next();
  });
  socket.emit("server:hello", { id: socket.id, serverTime: Date.now(), protocol: 1 });
  socket.on("room:list", (ack?: (data: unknown) => void) => ack?.([...rooms.values()].map(r => ({ id: r.id, mode: r.mode, players: r.players.size, createdAt: r.createdAt, phase: r.phase, score: r.score }))));
  socket.on("room:create", (payload: { mode?: MatchMode; nickname?: string } = {}, ack?: (data: unknown) => void) => {
    leaveRoom(socket);
    const mode: MatchMode = payload.mode === "defusal" ? "defusal" : "deathmatch";
    const room = createRoom(mode);
    addSocketToRoom(socket, room, payload.nickname);
    ack?.({ ok: true, room: { id: room.id, mode: room.mode, players: room.players.size, capacity: MAX_PLAYERS_PER_ROOM }, state: publicState(room) });
  });
  // Quick matchmaking fills the oldest compatible room first. Once it reaches
  // 10 players, the next player is placed into a new independent match.
  socket.on("room:quick-join", (payload: { mode?: MatchMode; nickname?: string } = {}, ack?: (data: unknown) => void) => {
    const mode: MatchMode = payload.mode === "defusal" ? "defusal" : "deathmatch";
    leaveRoom(socket);
    let room = [...rooms.values()]
      .filter(candidate => candidate.mode === mode && candidate.phase === "live" && candidate.players.size < MAX_PLAYERS_PER_ROOM)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!room) room = createRoom(mode);
    addSocketToRoom(socket, room, payload.nickname);
    ack?.({ ok: true, room: { id: room.id, mode: room.mode, players: room.players.size, capacity: MAX_PLAYERS_PER_ROOM, created: room.players.size === 1 }, state: publicState(room) });
  });
  socket.on("room:join", (roomId: unknown, payload: { nickname?: string } = {}, ack?: (data: unknown) => void) => {
    if (typeof roomId !== "string") { ack?.({ ok: false, error: "INVALID_ROOM_ID" }); return; }
    const room = rooms.get(roomId); if (!room) { ack?.({ ok: false, error: "ROOM_NOT_FOUND" }); return; }
    if (playerRoom.get(socket.id) === roomId) { ack?.({ ok: true, room: { id: room.id, mode: room.mode, players: room.players.size, capacity: MAX_PLAYERS_PER_ROOM }, state: publicState(room) }); return; }
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) { ack?.({ ok: false, error: "ROOM_FULL" }); return; }
    leaveRoom(socket);
    addSocketToRoom(socket, room, payload.nickname);
    ack?.({ ok: true, room: { id: room.id, mode: room.mode, players: room.players.size, capacity: MAX_PLAYERS_PER_ROOM }, state: publicState(room) });
  });
  socket.on("player:input", (input: MoveInput) => {
    const room = roomFor(socket), player = room?.players.get(socket.id);
    // Freeze movement during result screens; the client cannot keep walking
    // while the round is ended and then carry that position into the next round.
    if (!room || room.phase !== "live" || !player || !input || typeof input !== "object") return;
    if (applyMovement(player, input)) publish(room);
  });
  socket.on("combat:shoot", (shot: ShotInput, ack?: (data: unknown) => void) => {
    const room = roomFor(socket), player = room?.players.get(socket.id); if (!room || !player) { ack?.({ ok: false, reason: "NOT_IN_ROOM" }); return; }
    const result = resolveShot(room, player, shot);
    ack?.(result);
    if (result.ok && result.hit) {
      io.to(room.id).emit("combat:hit", { shooterId: player.id, ...result });
      if (result.killed && result.targetId) {
        const victim = room.players.get(result.targetId);
        const killerProfile = socket.data.profile as ReturnType<typeof getProfileByToken>;
        const victimSocket = io.sockets.sockets.get(result.targetId);
        const victimProfile = victimSocket?.data.profile as ReturnType<typeof getProfileByToken>;
        if (killerProfile) {
          const saved = updateProfile(killerProfile.id, { kills: player.kills, currency: player.currency });
          if (saved) socket.emit("profile:update", saved);
        }
        if (victimProfile) {
          const saved = updateProfile(victimProfile.id, { deaths: victim?.deaths ?? victimProfile.deaths + 1 });
          if (saved) victimSocket?.emit("profile:update", saved);
        }
        io.to(room.id).emit("match:killfeed", { id: randomUUID(), killer: player.nickname, victim: victim?.nickname ?? "Player", weapon: shot.weaponId, at: Date.now() });
        if (room.mode === "deathmatch") {
          room.score[player.team] += 1;
          if (room.score[player.team] >= 10) endRound(room, player.team, "SCORE_LIMIT");
        } else {
          const livingEnemies = [...room.players.values()].filter(p => p.team !== player.team && p.alive).length;
          if (livingEnemies === 0 && !room.bomb.planted) endRound(room, player.team, "TEAM_ELIMINATED");
          // Once planted, T wins if CT are eliminated; if T are eliminated, CT
          // must still complete the defuse, so the round remains live.
          else if (livingEnemies === 0 && room.bomb.planted && player.team === "T") endRound(room, "T", "CT_ELIMINATED_AFTER_PLANT");
        }
        // Keep the dead player in the room for the death animation/scoreboard, then respawn if live.
        setTimeout(() => respawnPlayer(room.id, result.targetId!), 3000);
      }
    }
    if (result.ok) publish(room);
  });
  socket.on("bomb:action-start", (ack?: (data: unknown) => void) => {
    const room = roomFor(socket), player = room?.players.get(socket.id);
    if (!room || !player) { ack?.({ ok: false, reason: "NOT_IN_ROOM" }); return; }
    if (room.mode !== "defusal") { ack?.({ ok: false, reason: "NOT_DEFUSAL_MODE" }); return; }
    if (room.phase !== "live" || !player.alive) { ack?.({ ok: false, reason: "ROUND_NOT_ACTIVE" }); return; }
    if (bombActions.has(socket.id)) { ack?.({ ok: true, action: room.bomb.planted ? "DEFUSING" : "PLANTING", durationMs: room.bomb.planted ? 5000 : 3000 }); return; }
    const near = (x: number, z: number, radius: number) => Math.hypot(player.position.x - x, player.position.z - z) <= radius;
    let action: "PLANTING" | "DEFUSING";
    let durationMs: number;
    let site: "A" | "B" | null = null;
    if (!room.bomb.planted) {
      if (player.team !== "T") { ack?.({ ok: false, reason: "T_ONLY_CAN_PLANT" }); return; }
      site = near(-14, 0, 3.5) ? "A" : near(14, 0, 3.5) ? "B" : null;
      if (!site) { ack?.({ ok: false, reason: "MOVE_TO_SITE_A_OR_B" }); return; }
      action = "PLANTING"; durationMs = 3000;
    } else {
      if (player.team !== "CT") { ack?.({ ok: false, reason: "CT_ONLY_CAN_DEFUSE" }); return; }
      if (room.bomb.defused || !room.bomb.position) { ack?.({ ok: false, reason: "NO_BOMB_TO_DEFUSE" }); return; }
      if (!near(room.bomb.position.x, room.bomb.position.z, 3.0)) { ack?.({ ok: false, reason: "MOVE_NEAR_BOMB" }); return; }
      action = "DEFUSING"; durationMs = 5000;
    }
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      bombActions.delete(socket.id);
      const currentRoom = roomFor(socket), currentPlayer = currentRoom?.players.get(socket.id);
      if (!currentRoom || currentRoom !== room || !currentPlayer || !currentPlayer.alive || currentRoom.phase !== "live") return;
      const stillNear = (x: number, z: number, radius: number) => Math.hypot(currentPlayer.position.x - x, currentPlayer.position.z - z) <= radius;
      if (action === "PLANTING") {
        const x = site === "A" ? -14 : 14;
        if (currentRoom.bomb.planted || !stillNear(x, 0, 3.5) || Date.now() - startedAt < durationMs) return;
        const position = { x, y: 0.25, z: 0 };
        currentRoom.bomb = { planted: true, site, position, plantedAt: Date.now(), explodesAt: Date.now() + 35_000, defused: false };
        io.to(currentRoom.id).emit("bomb:planted", { site, position, explodesAt: currentRoom.bomb.explodesAt, player: currentPlayer.nickname });
        publish(currentRoom);
      } else {
        const pos = currentRoom.bomb.position;
        if (!pos || currentRoom.bomb.defused || !stillNear(pos.x, pos.z, 3.0) || Date.now() - startedAt < durationMs) return;
        currentRoom.bomb.defused = true;
        io.to(currentRoom.id).emit("bomb:defused", { player: currentPlayer.nickname, site: currentRoom.bomb.site });
        endRound(currentRoom, "CT", "BOMB_DEFUSED");
      }
    }, durationMs);
    bombActions.set(socket.id, timer);
    ack?.({ ok: true, action, durationMs });
  });
  socket.on("bomb:action-cancel", () => cancelBombAction(socket.id));
  // Compatibility for older clients; current clients use the hold-to-interact protocol.
  socket.on("bomb:interact", (ack?: (data: unknown) => void) => ack?.({ ok: false, reason: "HOLD_E_TO_INTERACT" }));
  socket.on("room:leave", (ack?: (data: unknown) => void) => { leaveRoom(socket); ack?.({ok:true}); });
  socket.on("disconnect", () => leaveRoom(socket));
});

// Lightweight authoritative round clock. It deliberately does not run per-frame physics.
const roundClock = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === "live" && now >= room.endsAt) {
      const winner = room.score.T === room.score.CT ? "DRAW" : room.score.T > room.score.CT ? "T" : "CT";
      endRound(room, winner, "TIME_LIMIT");
    }
    if (room.phase === "live" && room.mode === "defusal" && room.bomb.planted && !room.bomb.defused && room.bomb.explodesAt !== null && now >= room.bomb.explodesAt) {
      io.to(room.id).emit("bomb:exploded", { site: room.bomb.site });
      endRound(room, "T", "BOMB_EXPLODED");
    }
    if (room.players.size) io.to(room.id).emit("match:clock", { phase: room.phase, remainingMs: Math.max(0, room.endsAt-now), score: room.score, winner: room.winner });
  }
}, 1000);
httpServer.on("close", () => { clearInterval(roundClock); clearInterval(apiLimitCleanup); });

// Render sends SIGTERM during deploys/restarts. Close sockets and the HTTP
// listener cleanly so a deploy does not leave active handles behind.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down SHATKI FPS`);
  clearInterval(roundClock);
  clearInterval(apiLimitCleanup);
  for (const timer of bombActions.values()) clearTimeout(timer);
  io.close(() => httpServer.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const port = Number(process.env.PORT ?? 3001);
httpServer.listen(port, () => console.log(`SHATKI FPS authoritative prototype listening on :${port}`));
