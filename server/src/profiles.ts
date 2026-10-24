import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type WeaponId = "rifle" | "shotgun" | "pistol" | "knife";
export type Rarity = "common" | "uncommon" | "rare" | "mythical" | "legendary" | "ancient";
export interface Skin { id: string; weaponId: WeaponId; name: string; rarity: Rarity; wear: number; patternSeed: number; acquiredAt: number; }
export interface Profile { id: string; nickname: string; currency: number; kills: number; deaths: number; wins: number; createdAt: number; inventory: Skin[]; equipped: Partial<Record<WeaponId, string>>; hasAccount?: boolean; }
type StoredProfile = Profile & { tokenHash: string; accountUsername?: string; passwordSalt?: string; passwordHash?: string };
const file = resolve(process.env.SHATKI_DATA_FILE ?? "./data/profiles.json");
const CASE_COST = 150;
const catalog: Record<Rarity, Array<Pick<Skin, "weaponId" | "name">>> = {
  common: [{ weaponId: "rifle", name: "Sandline" }, { weaponId: "pistol", name: "Dustmark" }, { weaponId: "shotgun", name: "Dry Creek" }],
  uncommon: [{ weaponId: "rifle", name: "Dune Circuit" }, { weaponId: "knife", name: "Copper Edge" }],
  rare: [{ weaponId: "rifle", name: "Mirage Grid" }, { weaponId: "pistol", name: "Cinder" }],
  mythical: [{ weaponId: "shotgun", name: "Red Horizon" }, { weaponId: "rifle", name: "Night Signal" }],
  legendary: [{ weaponId: "rifle", name: "Solar Flare" }, { weaponId: "knife", name: "Obsidian Fang" }],
  ancient: [{ weaponId: "rifle", name: "SHATKI // ZERO" }],
};
const odds: Array<{ rarity: Rarity; weight: number }> = [
  { rarity: "common", weight: 60 }, { rarity: "uncommon", weight: 25 }, { rarity: "rare", weight: 10 },
  { rarity: "mythical", weight: 4 }, { rarity: "legendary", weight: 0.9 }, { rarity: "ancient", weight: 0.1 },
];
let profiles: StoredProfile[] = [];
try {
  if (existsSync(file)) {
    const loaded = JSON.parse(readFileSync(file, "utf8")) as Array<StoredProfile & { inventory?: Skin[]; equipped?: Partial<Record<WeaponId, string>> }>;
    profiles = loaded.map(p => ({ ...p, inventory: Array.isArray(p.inventory) ? p.inventory : [], equipped: p.equipped && typeof p.equipped === "object" ? p.equipped : {} }));
  }
} catch (error) { console.error("Could not read profile store; starting empty:", error); }
function persist() {
  // Write a complete snapshot to a sibling temp file and atomically rename it.
  // This avoids leaving a truncated profiles.json if the process stops mid-write.
  mkdirSync(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(profiles, null, 2), { mode: 0o600 });
  renameSync(tempFile, file);
}
function hash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function cleanNickname(value: unknown) { const raw = typeof value === "string" ? value.trim() : ""; return (raw || `Guest-${randomBytes(2).toString("hex")}`).replace(/[<>\u0000-\u001f]/g, "").slice(0, 18); }
function publicProfile(p: StoredProfile): Profile {
  const { tokenHash: _token, accountUsername: _username, passwordSalt: _salt, passwordHash: _password, ...safe } = p;
  return { ...structuredClone(safe), hasAccount: Boolean(p.accountUsername && p.passwordHash && p.passwordSalt) };
}
function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().toLowerCase();
  return /^[a-z0-9_]{3,20}$/.test(username) ? username : null;
}
function validPassword(value: unknown): value is string { return typeof value === "string" && value.length >= 10 && value.length <= 128; }
function passwordDigest(password: string, salt: string) { return scryptSync(password, salt, 64).toString("hex"); }
function equalHex(a: string, b: string) {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b) || a.length !== b.length || a.length % 2 !== 0) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function issueToken(p: StoredProfile) { const token = randomBytes(32).toString("base64url"); p.tokenHash = hash(token); persist(); return token; }
export function upgradeGuestAccount(tokenValue: unknown, usernameValue: unknown, password: unknown): { ok: true; profile: Profile } | { ok: false; error: "INVALID_TOKEN" | "INVALID_USERNAME" | "INVALID_PASSWORD" | "USERNAME_TAKEN" | "ACCOUNT_EXISTS" } {
  if (typeof tokenValue !== "string") return { ok: false, error: "INVALID_TOKEN" };
  const p = profiles.find(x => x.tokenHash === hash(tokenValue));
  if (!p) return { ok: false, error: "INVALID_TOKEN" };
  if (p.accountUsername) return { ok: false, error: "ACCOUNT_EXISTS" };
  const username = normalizeUsername(usernameValue);
  if (!username) return { ok: false, error: "INVALID_USERNAME" };
  if (!validPassword(password)) return { ok: false, error: "INVALID_PASSWORD" };
  if (profiles.some(x => x.accountUsername === username)) return { ok: false, error: "USERNAME_TAKEN" };
  const salt = randomBytes(16).toString("hex");
  p.accountUsername = username; p.passwordSalt = salt; p.passwordHash = passwordDigest(password, salt);
  persist(); return { ok: true, profile: publicProfile(p) };
}
export function loginAccount(usernameValue: unknown, password: unknown): { ok: true; token: string; profile: Profile } | { ok: false; error: "INVALID_CREDENTIALS" | "INVALID_USERNAME" } {
  const username = normalizeUsername(usernameValue);
  if (!username || typeof password !== "string" || password.length > 128) return { ok: false, error: "INVALID_USERNAME" };
  const p = profiles.find(x => x.accountUsername === username);
  // Perform a same-size scrypt operation for unknown users to reduce username timing leaks.
  const salt = p?.passwordSalt ?? "00112233445566778899aabbccddeeff";
  const expected = p?.passwordHash ?? "0".repeat(128);
  const actual = passwordDigest(password, salt);
  if (!p || !p.passwordHash || !equalHex(actual, expected)) return { ok: false, error: "INVALID_CREDENTIALS" };
  const token = issueToken(p);
  return { ok: true, token, profile: publicProfile(p) };
}
export function createGuest(nickname?: unknown) {
  const token = randomBytes(32).toString("base64url");
  const profile: StoredProfile = { id: randomUUID(), nickname: cleanNickname(nickname), currency: 500, kills: 0, deaths: 0, wins: 0, createdAt: Date.now(), inventory: [], equipped: {}, tokenHash: hash(token) };
  profiles.push(profile); persist(); return { token, profile: publicProfile(profile) };
}
export function getProfileByToken(token: unknown): Profile | null {
  if (typeof token !== "string" || token.length < 20 || token.length > 256) return null;
  const p = profiles.find(x => x.tokenHash === hash(token)); return p ? publicProfile(p) : null;
}
export function updateProfile(id: string, patch: Partial<Pick<Profile, "nickname" | "currency" | "kills" | "deaths" | "wins">>) {
  const p = profiles.find(x => x.id === id); if (!p) return null;
  if (typeof patch.nickname === "string") p.nickname = cleanNickname(patch.nickname);
  for (const key of ["currency", "kills", "deaths", "wins"] as const) if (typeof patch[key] === "number" && Number.isFinite(patch[key])) p[key] = Math.max(0, Math.floor(patch[key]!));
  persist(); return publicProfile(p);
}
export function openProfileCase(id: string): { ok: true; profile: Profile; item: Skin } | { ok: false; error: "PROFILE_NOT_FOUND" | "INSUFFICIENT_FUNDS" } {
  const p = profiles.find(x => x.id === id);
  if (!p) return { ok: false, error: "PROFILE_NOT_FOUND" };
  if (p.currency < CASE_COST) return { ok: false, error: "INSUFFICIENT_FUNDS" };
  // Use integer cryptographic randomness on the server; the client cannot choose the rarity.
  const roll = randomInt(0, 1000) / 10;
  let cumulative = 0;
  let rarity: Rarity = "common";
  for (const entry of odds) { cumulative += entry.weight; if (roll < cumulative) { rarity = entry.rarity; break; } }
  const choices = catalog[rarity];
  const chosen = choices[randomInt(0, choices.length)];
  const item: Skin = { id: randomUUID(), weaponId: chosen.weaponId, name: chosen.name, rarity, wear: Math.round(randomInt(0, 1001) / 1000 * 100) / 100, patternSeed: randomInt(0, 2_147_483_647), acquiredAt: Date.now() };
  p.currency -= CASE_COST;
  p.inventory.push(item);
  persist();
  return { ok: true, profile: publicProfile(p), item };
}

export function equipProfileSkin(profileId: string, skinId: unknown): { ok: true; profile: Profile; skin: Skin } | { ok: false; error: "PROFILE_NOT_FOUND" | "SKIN_NOT_OWNED" } {
  const p = profiles.find(x => x.id === profileId);
  if (!p) return { ok: false, error: "PROFILE_NOT_FOUND" };
  if (typeof skinId !== "string" || skinId.length > 128) return { ok: false, error: "SKIN_NOT_OWNED" };
  const skin = p.inventory.find(item => item.id === skinId);
  if (!skin) return { ok: false, error: "SKIN_NOT_OWNED" };
  p.equipped[skin.weaponId] = skin.id;
  persist();
  return { ok: true, profile: publicProfile(p), skin: structuredClone(skin) };
}

export function unequipProfileSkin(profileId: string, weaponId: unknown) {
  const p = profiles.find(x => x.id === profileId);
  if (!p) return { ok: false as const, error: "PROFILE_NOT_FOUND" as const };
  if (typeof weaponId !== "string" || !["rifle", "shotgun", "pistol", "knife"].includes(weaponId)) return { ok: false as const, error: "INVALID_WEAPON" as const };
  delete p.equipped[weaponId as WeaponId];
  persist();
  return { ok: true as const, profile: publicProfile(p) };
}

export function leaderboard() { return profiles.map(publicProfile).sort((a,b) => b.kills-a.kills || b.wins-a.wins).slice(0, 20).map(({ inventory: _inventory, equipped: _equipped, ...p }) => p); }
export function incrementProfile(id: string, delta: Partial<Pick<Profile, "kills" | "deaths" | "wins" | "currency">>) {
  const p = profiles.find(x => x.id === id); if (!p) return null;
  for (const key of ["kills", "deaths", "wins", "currency"] as const) {
    const amount = delta[key];
    if (typeof amount === "number" && Number.isFinite(amount)) p[key] = Math.max(0, Math.floor(p[key] + amount));
  }
  persist(); return publicProfile(p);
}
