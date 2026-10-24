import { create } from "zustand";
import type { WeaponId, Skin, Rarity } from "../shared/types";
import { GAME_CONFIG, WEAPONS } from "../shared/config";
interface GameState {
  nickname: string; currency: number; health: number; armor: number; weapon: WeaponId;
  ammo: Record<WeaponId, number>; reserve: Record<WeaponId, number>; kills: number; deaths: number;
  inventory: Skin[]; equippedSkins: Partial<Record<WeaponId, Skin>>; notice: string; setNotice: (v:string)=>void; setHealth:(v:number)=>void;
  setAmmo:(w:WeaponId,v:number)=>void; setWeapon:(w:WeaponId)=>void; addKill:()=>void;
  spend:(amount:number)=>boolean; addCurrency:(amount:number)=>void; addSkin:(skin:Skin)=>void;
  setNickname:(name:string)=>void; setEquippedSkins:(skins:Partial<Record<WeaponId,Skin>>)=>void; resetMatch:()=>void;
}
const starterSkins: Skin[] = [{id:"skin-rifle-default",weaponId:"rifle",name:"Sandline",rarity:"common",wear:0.18,patternSeed:3}];
export const useGameStore = create<GameState>((set,get)=>({
  nickname:"Guest_042", currency:500, health:100, armor:0, weapon:"rifle",
  ammo:{rifle:WEAPONS.rifle.magazine,shotgun:WEAPONS.shotgun.magazine,pistol:WEAPONS.pistol.magazine,knife:0},
  reserve:{rifle:WEAPONS.rifle.reserve,shotgun:WEAPONS.shotgun.reserve,pistol:WEAPONS.pistol.reserve,knife:0},
  kills:0,deaths:0,inventory:starterSkins,equippedSkins:{},notice:"Добро пожаловать на тестовый полигон",
  setNotice:(notice)=>set({notice}), setHealth:(health)=>set({health:Math.max(0,health)}),
  setAmmo:(weapon,value)=>set(s=>({ammo:{...s.ammo,[weapon]:value}})),
  setWeapon:(weapon)=>set({weapon,notice:`Выбрано оружие: ${WEAPONS[weapon].name}`}),
  addKill:()=>set(s=>({kills:s.kills+1,currency:s.currency+GAME_CONFIG.economy.killReward,notice:`+${GAME_CONFIG.economy.killReward} Шэток за устранение`})),
  spend:(amount)=>{if(get().currency<amount){set({notice:"Недостаточно Шэток"});return false;}set(s=>({currency:s.currency-amount}));return true;},
  addCurrency:(amount)=>set(s=>({currency:s.currency+amount})),
  addSkin:(skin)=>set(s=>({inventory:[...s.inventory,skin]})),
  setEquippedSkins:(equippedSkins)=>set({equippedSkins}),
  setNickname:(nickname)=>set({nickname:nickname.trim().slice(0,18)||"Guest"}),
  resetMatch:()=>set({health:100,armor:0,kills:0,deaths:0,ammo:{rifle:30,shotgun:8,pistol:12,knife:0},reserve:{rifle:90,shotgun:32,pistol:48,knife:0}}),
}));
export function rollRarity(): Rarity {
  const roll=Math.random()*100; let sum=0;
  for(const entry of GAME_CONFIG.caseOdds){sum+=entry.weight;if(roll<sum)return entry.rarity;}
  return "ancient";
}