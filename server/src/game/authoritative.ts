/**
 * Small authoritative match simulation.
 * The server owns positions, health, weapon cooldowns and match rewards.
 * TODO: replace the simple flat arena bounds with Rapier server-side collision.
 */
import type { Socket } from "socket.io";

export type MatchMode = "deathmatch" | "defusal";
export type ServerWeapon = "rifle" | "shotgun" | "pistol" | "knife";
export interface Vec3 { x: number; y: number; z: number }
export interface ServerPlayer {
  id: string; nickname: string; roomId: string; team: "T" | "CT";
  position: Vec3; yaw: number; pitch: number; health: number; armor: number;
  currency: number; kills: number; deaths: number; lastInputAt: number;
  lastShotAt: Partial<Record<ServerWeapon, number>>; alive: boolean;
}
export type RoundPhase = "live" | "ended";
export interface BombState { planted: boolean; site: "A" | "B" | null; position: Vec3 | null; plantedAt: number | null; explodesAt: number | null; defused: boolean; }
export interface ServerRoom { id: string; mode: MatchMode; createdAt: number; players: Map<string, ServerPlayer>; phase: RoundPhase; endsAt: number; score: { T: number; CT: number }; winner?: "T" | "CT" | "DRAW"; bomb: BombState }
export interface MoveInput { forward: number; strafe: number; yaw: number; pitch: number; sprint?: boolean; crouch?: boolean; }
export interface ShotInput { weaponId: ServerWeapon; origin: [number, number, number]; direction: [number, number, number] }

const ARENA = { minX: -24.4, maxX: 24.4, minZ: -24.4, maxZ: 24.4 };
const PLAYER_RADIUS = 0.42;
// Server-side copies of solid map blockout AABBs. A shot cannot pass through these.
const WALLS = [
  {x:0,z:-25,w:52,d:1,h:4,y:2},{x:-25,z:0,w:1,d:52,h:4,y:2},{x:25,z:0,w:1,d:52,h:4,y:2},{x:0,z:25,w:52,d:1,h:4,y:2},
  {x:-8,z:-1,w:1,d:23,h:3.4,y:1.7},{x:8,z:1,w:1,d:23,h:3.4,y:1.7},{x:0,z:-9,w:14,d:.8,h:3.2,y:1.6},
  {x:-14,z:8,w:10,d:.8,h:3,y:1.5},{x:14,z:8,w:10,d:.8,h:3,y:1.5},{x:-13,z:-14,w:1,d:13,h:3.6,y:1.8},
  {x:13,z:-14,w:1,d:13,h:3.6,y:1.8},{x:-19,z:-17,w:9,d:.8,h:3,y:1.5},{x:19,z:-10,w:9,d:.8,h:3,y:1.5},
  {x:-4,z:17,w:12,d:.8,h:2.8,y:1.4},{x:4,z:-19,w:12,d:.8,h:2.8,y:1.4},
  ...[[-4,5],[4,-4],[17,-10],[-16,12],[-12,-16],[12,-17],[18,1]].map(([x,z])=>({x,z,w:2.1,d:2.1,h:1.4,y:.7}))
];
const FIRE_DELAY: Record<ServerWeapon, number> = { rifle: 105, shotgun: 700, pistol: 240, knife: 450 };
const DAMAGE: Record<ServerWeapon, number> = { rifle: 28, shotgun: 13, pistol: 34, knife: 55 };
const MAX_RANGE: Record<ServerWeapon, number> = { rifle: 80, shotgun: 22, pistol: 55, knife: 2.4 };
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function createPlayer(id: string, roomId: string, nickname: string, team: "T" | "CT"): ServerPlayer {
  return { id, roomId, nickname: nickname.slice(0, 18), team,
    position: { x: team === "T" ? 12 : -12, y: 1.8, z: 0 }, yaw: 0, pitch: 0,
    health: 100, armor: 0, currency: 0, kills: 0, deaths: 0, lastInputAt: Date.now(),
    lastShotAt: {}, alive: true };
}

/** Sanitize input and integrate bounded movement; never accept a client position. */
export function applyMovement(player: ServerPlayer, input: MoveInput, now = Date.now()): boolean {
  if (![input.forward, input.strafe, input.yaw, input.pitch].every(finite)) return false;
  const dt = clamp((now - player.lastInputAt) / 1000, 0, 0.05);
  player.lastInputAt = now;
  if (!player.alive) return false;
  const forward = clamp(input.forward, -1, 1), strafe = clamp(input.strafe, -1, 1);
  const magnitude = Math.hypot(forward, strafe) || 1;
  const speed = input.crouch ? 2.0 : input.sprint ? 6.2 : 4.5;
  const f = forward / magnitude * speed * dt, s = strafe / magnitude * speed * dt;
  const sin = Math.sin(input.yaw), cos = Math.cos(input.yaw);
  const dx = -sin * f + cos * s, dz = -cos * f - sin * s;
  const canOccupy = (x: number, z: number) => {
    if (x < ARENA.minX || x > ARENA.maxX || z < ARENA.minZ || z > ARENA.maxZ) return false;
    return !WALLS.some(w => Math.abs(x - w.x) < w.w / 2 + PLAYER_RADIUS && Math.abs(z - w.z) < w.d / 2 + PLAYER_RADIUS);
  };
  // Resolve axes separately so the player can slide along a wall instead of sticking.
  const nextX = clamp(player.position.x + dx, ARENA.minX, ARENA.maxX);
  if (canOccupy(nextX, player.position.z)) player.position.x = nextX;
  const nextZ = clamp(player.position.z + dz, ARENA.minZ, ARENA.maxZ);
  if (canOccupy(player.position.x, nextZ)) player.position.z = nextZ;
  // Keep angles bounded so malformed but finite values cannot accumulate
  // into surprising client/server aim differences.
  player.yaw = Math.atan2(Math.sin(input.yaw), Math.cos(input.yaw));
  player.pitch = clamp(input.pitch, -1.45, 1.45);
  return true;
}

function rayBox(origin: Vec3, direction: Vec3, box: {x:number;z:number;w:number;d:number;h:number;y:number}): number | null {
  let near = 0, far = Infinity;
  const mins = [box.x-box.w/2, 0, box.z-box.d/2];
  const maxs = [box.x+box.w/2, box.y+box.h/2, box.z+box.d/2];
  const origins = [origin.x, origin.y, origin.z], dirs = [direction.x, direction.y, direction.z];
  for (let i=0;i<3;i++) {
    if (Math.abs(dirs[i]) < 1e-8) { if (origins[i] < mins[i] || origins[i] > maxs[i]) return null; continue; }
    let a=(mins[i]-origins[i])/dirs[i], b=(maxs[i]-origins[i])/dirs[i];
    if (a>b) [a,b]=[b,a]; near=Math.max(near,a); far=Math.min(far,b); if (near>far) return null;
  }
  return far >= 0 ? near : null;
}

function raySphere(origin: Vec3, direction: Vec3, center: Vec3, radius: number): number | null {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

/** Validates cooldown, origin proximity and ray intersection before applying damage. */
export function resolveShot(room: ServerRoom, shooter: ServerPlayer, shot: ShotInput, now = Date.now()) {
  if (room.phase !== "live" || !shooter.alive || !["rifle", "shotgun", "pistol", "knife"].includes(shot.weaponId)) return { ok: false as const, reason: "INVALID_SHOT" };
  if (!Array.isArray(shot.origin) || !Array.isArray(shot.direction) || shot.origin.length !== 3 || shot.direction.length !== 3 || ![...shot.origin, ...shot.direction].every(finite)) return { ok: false as const, reason: "INVALID_VECTOR" };
  const last = shooter.lastShotAt[shot.weaponId] ?? 0;
  if (now - last < FIRE_DELAY[shot.weaponId]) return { ok: false as const, reason: "COOLDOWN" };
  const origin: Vec3 = { x: shot.origin[0], y: shot.origin[1], z: shot.origin[2] };
  const dx = origin.x - shooter.position.x, dy = origin.y - shooter.position.y, dz = origin.z - shooter.position.z;
  if (Math.hypot(dx, dy, dz) > 3.0) return { ok: false as const, reason: "ORIGIN_TOO_FAR" };
  const len = Math.hypot(...shot.direction);
  if (len < 0.9 || len > 1.1) return { ok: false as const, reason: "INVALID_DIRECTION" };
  const direction = { x: shot.direction[0] / len, y: shot.direction[1] / len, z: shot.direction[2] / len };
  // Aim is checked against server-held yaw/pitch to prevent clients from spoofing arbitrary ray directions.
  const cosPitch = Math.cos(shooter.pitch);
  const expected = { x: -Math.sin(shooter.yaw) * cosPitch, y: Math.sin(shooter.pitch), z: -Math.cos(shooter.yaw) * cosPitch };
  const aimDot = direction.x * expected.x + direction.y * expected.y + direction.z * expected.z;
  if (aimDot < 0.82) return { ok: false as const, reason: "AIM_MISMATCH" };
  shooter.lastShotAt[shot.weaponId] = now;
  let target: ServerPlayer | undefined, best = MAX_RANGE[shot.weaponId];
  for (const candidate of room.players.values()) {
    if (candidate.id === shooter.id || candidate.team === shooter.team || !candidate.alive) continue;
    const hit = raySphere(origin, direction, { ...candidate.position, y: candidate.position.y - 0.7 }, shot.weaponId === "knife" ? 0.9 : 0.85);
    if (hit !== null && hit <= best) { best = hit; target = candidate; }
  }
  if (!target) return { ok: true as const, hit: false as const };
  const wallHit = WALLS.some(w => { const t = rayBox(origin, direction, w); return t !== null && t < best - 0.2; });
  if (wallHit) return { ok: true as const, hit: false as const, blocked: true as const };
  const rawDamage = DAMAGE[shot.weaponId] * (shot.weaponId === "shotgun" ? 1 : 1);
  const absorbed = Math.min(target.armor, rawDamage * 0.5);
  target.armor -= absorbed;
  target.health = Math.max(0, Math.round(target.health - (rawDamage - absorbed)));
  if (target.health <= 0) {
    target.alive = false; target.deaths += 1; shooter.kills += 1; shooter.currency += 10;
    return { ok: true as const, hit: true as const, targetId: target.id, damage: rawDamage - absorbed, killed: true as const };
  }
  return { ok: true as const, hit: true as const, targetId: target.id, damage: rawDamage - absorbed, killed: false as const };
}

export function publicState(room: ServerRoom) {
  return { id: room.id, mode: room.mode, phase: room.phase, endsAt: room.endsAt, score: room.score, winner: room.winner, bomb: room.bomb, players: [...room.players.values()].map(p => ({
    id: p.id, nickname: p.nickname, team: p.team, position: p.position, yaw: p.yaw,
    health: p.health, armor: p.armor, kills: p.kills, deaths: p.deaths, alive: p.alive,
  })) };
}

export function socketNickname(socket: Socket, candidate: unknown): string {
  const nickname = typeof candidate === "string" ? candidate.trim() : "";
  return (nickname || `Player-${socket.id.slice(0, 4)}`).slice(0, 18).replace(/[<>\u0000-\u001f]/g, "");
}
