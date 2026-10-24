import type { WeaponDefinition, Rarity } from "./types";
/** Central balancing constants. All distances use metres and seconds. */
export const GAME_CONFIG = {
  player: { radius: 0.38, height: 1.8, eyeHeight: 1.62, walkSpeed: 5.2, sprintMultiplier: 1.35, crouchSpeed: 2.2, jumpVelocity: 5.5, gravity: 16 },
  world: { halfSize: 24, fogNear: 35, fogFar: 115 },
  economy: { killReward: 10, roundWinReward: 50, matchReward: 100, dailyReward: 25, caseCost: 150 },
  caseOdds: [
    { rarity: "common" as Rarity, weight: 60 }, { rarity: "uncommon" as Rarity, weight: 25 },
    { rarity: "rare" as Rarity, weight: 10 }, { rarity: "mythical" as Rarity, weight: 4 },
    { rarity: "legendary" as Rarity, weight: 0.9 }, { rarity: "ancient" as Rarity, weight: 0.1 },
  ],
} as const;
export const WEAPONS: Record<string, WeaponDefinition> = {
  rifle: { id:"rifle", name:"Rifle", damage:34, magazine:30, reserve:90, fireDelayMs:105, reloadMs:2200, spread:0.012, kind:"hitscan" },
  shotgun: { id:"shotgun", name:"Shotgun", damage:12, magazine:8, reserve:32, fireDelayMs:720, reloadMs:2600, spread:0.095, kind:"hitscan" },
  pistol: { id:"pistol", name:"Pistol", damage:26, magazine:12, reserve:48, fireDelayMs:260, reloadMs:1500, spread:0.018, kind:"hitscan" },
  knife: { id:"knife", name:"Knife", damage:55, magazine:0, reserve:0, fireDelayMs:500, reloadMs:0, spread:0, kind:"melee" },
};
export const CALLOUTS = [
  { name:"T Spawn", x:17, z:17, teamHint:"T" }, { name:"Top Mid", x:0, z:9, teamHint:"both" },
  { name:"Underpass", x:0, z:2, teamHint:"both" }, { name:"Alley", x:16, z:7, teamHint:"T" },
  { name:"Apartments", x:17, z:-3, teamHint:"T" }, { name:"Palace", x:15, z:-14, teamHint:"T" },
  { name:"Ramp", x:10, z:-11, teamHint:"T" }, { name:"Mid", x:0, z:0, teamHint:"both" },
  { name:"Window", x:-5, z:-2, teamHint:"both" }, { name:"Short", x:4, z:-1, teamHint:"both" },
  { name:"Connector", x:-7, z:-7, teamHint:"both" }, { name:"Catwalk", x:6, z:3, teamHint:"both" },
  { name:"Jungle", x:-10, z:-11, teamHint:"CT" }, { name:"A Site", x:-14, z:-16, teamHint:"both" },
  { name:"Default", x:-14, z:-18, teamHint:"both" }, { name:"Tetris", x:-9, z:-15, teamHint:"both" },
  { name:"Firebox", x:-18, z:-15, teamHint:"both" }, { name:"Ninja", x:-19, z:-19, teamHint:"both" },
  { name:"Stairs", x:-7, z:-19, teamHint:"CT" }, { name:"CT Spawn", x:-18, z:-4, teamHint:"CT" },
  { name:"B Site", x:17, z:-8, teamHint:"both" }, { name:"Market", x:10, z:-5, teamHint:"CT" },
  { name:"Kitchen", x:12, z:-2, teamHint:"CT" }, { name:"Van", x:20, z:-9, teamHint:"both" },
  { name:"Bench", x:19, z:-12, teamHint:"both" },
] as const;