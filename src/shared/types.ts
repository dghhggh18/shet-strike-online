/** Shared game and inventory contracts. Keep client/server message shapes here. */
export type WeaponId = "rifle" | "shotgun" | "pistol" | "knife";
export type Rarity = "common" | "uncommon" | "rare" | "mythical" | "legendary" | "ancient";
export interface WeaponDefinition {
  id: WeaponId; name: string; damage: number; magazine: number; reserve: number;
  fireDelayMs: number; reloadMs: number; spread: number; kind: "hitscan" | "melee";
}
export interface Skin {
  id: string; weaponId: WeaponId; name: string; rarity: Rarity; wear: number; patternSeed: number;
}
export interface InventoryItem {
  instanceId: string; skinId: string; acquiredAt: number; isEquipped: boolean;
}
export interface PlayerProfile {
  id: string; nickname: string; currency: number; inventory: InventoryItem[];
  equipped: Record<WeaponId, string | null>;
}
export interface PlayerInput {
  seq: number; forward: number; strafe: number; yaw: number; pitch: number;
  sprint: boolean; jump: boolean; crouch: boolean; timestamp: number;
}
export interface ShotRequest { weaponId: WeaponId; origin: [number,number,number]; direction: [number,number,number]; timestamp: number; }
export interface NetworkPlayer { id: string; nickname: string; position: [number,number,number]; yaw: number; health: number; team: "T"|"CT"; }
export interface KillEvent { id: string; killer: string; victim: string; weapon: WeaponId; at: number; }
