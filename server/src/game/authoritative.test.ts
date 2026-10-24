import test from "node:test";
import assert from "node:assert/strict";
import { applyMovement, createPlayer, resolveShot, type ServerRoom } from "./authoritative.js";

test("movement clamps untrusted input and keeps player inside arena", () => {
  const p = createPlayer("p1", "r1", "tester", "T");
  const before = p.position.z;
  assert.equal(applyMovement(p, { forward: 999, strafe: 0, yaw: 0, pitch: 99, sprint: true }, p.lastInputAt + 50), true);
  assert.ok(p.position.x >= -48 && p.position.x <= 48);
  assert.ok(p.position.z >= -48 && p.position.z <= 48);
  assert.ok(Math.abs(p.pitch) <= 1.45);
  assert.notEqual(p.position.z, before);
  assert.equal(applyMovement(p, { forward: Number.NaN, strafe: 0, yaw: 0, pitch: 0 }, Date.now()), false);
});

test("server rejects a shot whose claimed origin is far from the player", () => {
  const a = createPlayer("a", "r", "a", "T"), b = createPlayer("b", "r", "b", "CT");
  const room: ServerRoom = { id: "r", mode: "deathmatch", createdAt: Date.now(), players: new Map([[a.id, a], [b.id, b]]), phase: "live", endsAt: Date.now()+120000, score: {T:0,CT:0}, bomb: { planted: false, site: null, position: null, plantedAt: null, explodesAt: null, defused: false } };
  const result = resolveShot(room, a, { weaponId: "rifle", origin: [100, 1.8, 100], direction: [-1, 0, 0] });
  assert.deepEqual(result, { ok: false, reason: "ORIGIN_TOO_FAR" });
});

test("valid ray shot damages enemy and enforces cooldown", () => {
  const a = createPlayer("a", "r", "a", "T"), b = createPlayer("b", "r", "b", "CT");
  a.position = { x: 0, y: 1.8, z: 0 }; a.yaw = Math.PI / 2; b.position = { x: -8, y: 1.8, z: 0 };
  const room: ServerRoom = { id: "r", mode: "deathmatch", createdAt: Date.now(), players: new Map([[a.id, a], [b.id, b]]), phase: "live", endsAt: Date.now()+120000, score: {T:0,CT:0}, bomb: { planted: false, site: null, position: null, plantedAt: null, explodesAt: null, defused: false } };
  const now = Date.now() + 1000;
  const result = resolveShot(room, a, { weaponId: "rifle", origin: [0, 1.8, 0], direction: [-1, 0, 0] }, now);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.hit, true);
  assert.equal(b.health, 72);
  const cooldown = resolveShot(room, a, { weaponId: "rifle", origin: [0, 1.8, 0], direction: [-1, 0, 0] }, now + 10);
  assert.deepEqual(cooldown, { ok: false, reason: "COOLDOWN" });
});

test("lethal server hit marks enemy dead and rewards the shooter", () => {
  const a = createPlayer("a", "r", "attacker", "T"), b = createPlayer("b", "r", "defender", "CT");
  a.position = { x: 0, y: 1.8, z: 0 }; a.yaw = Math.PI / 2; b.position = { x: -4, y: 1.8, z: 0 };
  const room: ServerRoom = { id: "r", mode: "deathmatch", createdAt: Date.now(), players: new Map([[a.id, a], [b.id, b]]), phase: "live", endsAt: Date.now()+120000, score: {T:0,CT:0}, bomb: { planted: false, site: null, position: null, plantedAt: null, explodesAt: null, defused: false } };
  let result = resolveShot(room, a, { weaponId: "rifle", origin: [0, 1.8, 0], direction: [-1, 0, 0] }, 1000);
  assert.equal(result.ok && result.hit, true);
  result = resolveShot(room, a, { weaponId: "rifle", origin: [0, 1.8, 0], direction: [-1, 0, 0] }, 1200);
  assert.equal(result.ok && result.hit, true);
  result = resolveShot(room, a, { weaponId: "rifle", origin: [0, 1.8, 0], direction: [-1, 0, 0] }, 1400);
  assert.equal(result.ok && result.hit, true);
  result = resolveShot(room, a, { weaponId: "rifle", origin: [0, 1.8, 0], direction: [-1, 0, 0] }, 1600);
  assert.equal(result.ok && result.hit, true);
  assert.equal(b.alive, false);
  assert.equal(b.deaths, 1);
  assert.equal(a.kills, 1);
  assert.equal(a.currency, 10);
});


test("server blocks hits through solid blockout walls", () => {
  const a = createPlayer("a", "r", "attacker", "T"), b = createPlayer("b", "r", "defender", "CT");
  a.position = { x: 0, y: 1.8, z: 0 }; a.yaw = Math.PI / 2; b.position = { x: -12, y: 1.8, z: 0 };
  const room: ServerRoom = { id: "r", mode: "deathmatch", createdAt: Date.now(), players: new Map([[a.id, a], [b.id, b]]), phase: "live", endsAt: Date.now()+120000, score: {T:0,CT:0}, bomb: { planted: false, site: null, position: null, plantedAt: null, explodesAt: null, defused: false } };
  const result = resolveShot(room, a, { weaponId: "rifle", origin: [0,1.8,0], direction: [-1,0,0] }, Date.now()+1000);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.hit, false);
  assert.equal(result.ok && "blocked" in result && result.blocked, true);
  assert.equal(b.health, 100);
});

test("round-ended rooms reject further shots", () => {
  const a = createPlayer("a", "r", "attacker", "T"), b = createPlayer("b", "r", "defender", "CT");
  const room: ServerRoom = { id: "r", mode: "deathmatch", createdAt: Date.now(), players: new Map([[a.id, a], [b.id, b]]), phase: "ended", endsAt: Date.now(), score: {T:10,CT:2}, winner: "T", bomb: { planted: false, site: null, position: null, plantedAt: null, explodesAt: null, defused: false } };
  const result = resolveShot(room, a, { weaponId: "rifle", origin: [a.position.x,a.position.y,a.position.z], direction: [-1,0,0] }, Date.now()+1000);
  assert.deepEqual(result, { ok: false, reason: "INVALID_SHOT" });
});


test("server rejects shots whose ray does not match server-held aim", () => {
  const a = createPlayer("a", "r", "attacker", "T"), b = createPlayer("b", "r", "defender", "CT");
  a.position = { x: 0, y: 1.8, z: 0 }; b.position = { x: -8, y: 1.8, z: 0 };
  const room: ServerRoom = { id: "r", mode: "deathmatch", createdAt: Date.now(), players: new Map([[a.id, a], [b.id, b]]), phase: "live", endsAt: Date.now()+120000, score: {T:0,CT:0}, bomb: { planted: false, site: null, position: null, plantedAt: null, explodesAt: null, defused: false } };
  const result = resolveShot(room, a, { weaponId: "rifle", origin: [0,1.8,0], direction: [-1,0,0] }, Date.now()+1000);
  assert.deepEqual(result, { ok: false, reason: "AIM_MISMATCH" });
});

test("server movement stops at solid blockout walls", () => {
  const p = createPlayer("p1", "r1", "tester", "T");
  p.position = { x: 6.8, y: 1.8, z: 0 };
  p.yaw = -Math.PI / 2;
  const startX = p.position.x;
  for (let i = 1; i <= 20; i++) applyMovement(p, { forward: 1, strafe: 0, yaw: -Math.PI / 2, pitch: 0 }, p.lastInputAt + i * 50);
  assert.ok(p.position.x >= startX - 0.01);
  assert.ok(p.position.x <= 7.08);
});


test("movement normalizes extreme yaw and clamps pitch", () => {
  const p = createPlayer("p1", "r1", "tester", "T");
  const now = p.lastInputAt + 50;
  assert.equal(applyMovement(p, { forward: 0, strafe: 0, yaw: 1e9, pitch: 99 }, now), true);
  assert.ok(p.yaw >= -Math.PI && p.yaw <= Math.PI);
  assert.equal(p.pitch, 1.45);
});
