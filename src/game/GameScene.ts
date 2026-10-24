import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Socket } from "socket.io-client";
import { GAME_CONFIG, WEAPONS, CALLOUTS } from "../shared/config";
import type { Skin, Rarity } from "../shared/types";
import { useGameStore, rollRarity } from "../store/gameStore";

interface Target { mesh: THREE.Group; hp: number; nextMove: number; direction: THREE.Vector3; }
const rarityNames: Record<Rarity,string> = {common:"Common",uncommon:"Uncommon",rare:"Rare",mythical:"Mythical",legendary:"Legendary",ancient:"Ancient"};

/**
 * Runtime for the playable single-player vertical slice.
 * Input: host canvas element + pointer-lock state callback. Output: Three.js scene.
 * Physics is initialized with Rapier; visual props have matching fixed colliders.
 * TODO: replace training targets with server-replicated player entities and lag compensation.
 */
export class GameScene {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(76,1,0.1,250);
  private renderer: THREE.WebGLRenderer;
  private controls: PointerLockControls;
  private clock = new THREE.Clock();
  private world!: RAPIER.World;
  private playerBody!: RAPIER.RigidBody;
  private readonly keys = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly direction = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly targets: Target[] = [];
  private readonly remotePlayers = new Map<string, THREE.Group>();
  private readonly remoteTargets = new Map<string, { x: number; z: number; yaw: number }>();
  private localServerTarget: { x: number; z: number } | null = null;
  private lastNetworkInput = 0;
  private syncedInitialPosition = false;
  private wasLocalAlive = true;
  private attachedSocket: Socket|null = null;
  private readonly onMatchState = (data: { id: string; players: Array<{ id: string; nickname: string; team: "T"|"CT"; position: {x:number;y:number;z:number}; yaw: number; health: number; alive: boolean }> }) => this.syncRemotePlayers(data);
  private readonly onKillfeed = (event: { killer?: string; victim?: string; weapon?: string }) => {
    if (!event?.killer || !event?.victim) return;
    useGameStore.getState().setNotice(`${event.killer}  ☠  ${event.victim} · ${(event.weapon || "weapon").toUpperCase()}`);
  };
  private readonly onBombEvent = (event: { site?: string; player?: string }) => {
    const message = event?.site ? `БОМБА · SITE ${event.site}${event.player ? ` · ${event.player}` : ""}` : "БОМБА";
    useGameStore.getState().setNotice(message);
  };
  private readonly onRoundEnd = (event: { winner?: string; reason?: string; score?: {T:number;CT:number} }) => {
    const result = event?.winner === "DRAW" ? "НИЧЬЯ" : event?.winner === "T" ? "ПОБЕДА T" : event?.winner === "CT" ? "ПОБЕДА CT" : "РАУНД ЗАВЕРШЁН";
    useGameStore.getState().setNotice(`${result} · T ${event?.score?.T ?? 0}:${event?.score?.CT ?? 0} CT`);
  };
  private readonly colliders: THREE.Mesh[] = [];
  private readonly props: THREE.Object3D[] = [];
  private weaponSkinMaterial: THREE.MeshStandardMaterial | null = null;
  private unsubscribeSkin: (() => void) | null = null;
  private frameId = 0; private disposed = false; private lastShot = 0;
  private reloading = false; private reloadTimer = 0; private jumpQueued = false;
  private mobileActive = false;
  private lastCallout = ""; private recoil = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly onMouseDown = (e:MouseEvent) => { if(e.button===0 && this.controls.isLocked) this.fire(); };
  private readonly onContextMenu = (e:Event) => e.preventDefault();
  private bombHoldStarted = false;
  private readonly onCaseRequest = () => this.openCase();

  constructor(private host:HTMLElement, private onLockChange:(locked:boolean)=>void, private getSocket:()=>Socket|null = () => null) {
    this.unsubscribeSkin = useGameStore.subscribe((next, previous) => {
      if (next.equippedSkins !== previous.equippedSkins || next.weapon !== previous.weapon) this.applyEquippedSkin(next.equippedSkins[next.weapon] ?? null);
    });
    this.renderer = new THREE.WebGLRenderer({antialias:true,powerPreference:"high-performance"});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));
    this.renderer.setSize(host.clientWidth,host.clientHeight);
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    host.appendChild(this.renderer.domElement);
    this.camera.position.set(0,GAME_CONFIG.player.eyeHeight,15);
    this.controls=new PointerLockControls(this.camera,this.renderer.domElement);
    this.controls.pointerSpeed=0.72;
    this.controls.addEventListener("lock",()=>{this.onLockChange(true);});
    this.controls.addEventListener("unlock",()=>{this.onLockChange(false);if(this.bombHoldStarted){this.bombHoldStarted=false;this.getSocket()?.emit("bomb:action-cancel");}});
    this.renderer.domElement.addEventListener("mousedown",this.onMouseDown);
    this.renderer.domElement.addEventListener("contextmenu",this.onContextMenu);
    window.addEventListener("shatki-open-case-request",this.onCaseRequest);
    window.addEventListener("keydown",this.onKeyDown);window.addEventListener("keyup",this.onKeyUp);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(host);
    void this.initialize();
  }
  private async initialize():Promise<void>{
    await RAPIER.init();
    if(this.disposed)return;
    this.world=new RAPIER.World({x:0,y:-GAME_CONFIG.player.gravity,z:0});
    this.createWorld();
    const bodyDesc=RAPIER.RigidBodyDesc.dynamic().setTranslation(0,1,15).lockRotations();
    this.playerBody=this.world.createRigidBody(bodyDesc);
    this.world.createCollider(RAPIER.ColliderDesc.capsule(0.55,GAME_CONFIG.player.radius).setFriction(0),this.playerBody);
    this.spawnTargets();this.animate();
  }
  public lockPointer():void{
    const mobile = window.matchMedia("(pointer: coarse)").matches || ("ontouchstart" in window);
    if(mobile){this.mobileActive=true;this.onLockChange(true);return;}
    this.controls.lock();
  }
  public setTouchKey(code:string, pressed:boolean):void{if(pressed)this.keys.add(code);else this.keys.delete(code);}
  public touchLook(dx:number,dy:number):void{
    if(!this.mobileActive)return;
    this.camera.rotation.order="YXZ";
    this.camera.rotation.y-=dx*0.006;
    this.camera.rotation.x=Math.max(-Math.PI/2,Math.min(Math.PI/2,this.camera.rotation.x-dy*0.006));
  }
  public fireTouch():void{if(this.mobileActive)this.fire();}
  public stopPlaying():void{this.mobileActive=false;this.keys.clear();this.onLockChange(false);}
  public dispose():void{
    this.disposed=true;cancelAnimationFrame(this.frameId);this.resizeObserver.disconnect();
    this.attachedSocket?.off("match:state", this.onMatchState);
    this.attachedSocket?.off("match:killfeed", this.onKillfeed);
    this.attachedSocket?.off("match:round-end", this.onRoundEnd);
    this.attachedSocket?.off("bomb:planted", this.onBombEvent);
    this.attachedSocket?.off("bomb:defused", this.onBombEvent);
    this.attachedSocket?.off("bomb:exploded", this.onBombEvent);
    window.removeEventListener("keydown",this.onKeyDown);window.removeEventListener("keyup",this.onKeyUp);
    this.renderer.domElement.removeEventListener("mousedown",this.onMouseDown);
    this.renderer.domElement.removeEventListener("contextmenu",this.onContextMenu);
    window.removeEventListener("shatki-open-case-request",this.onCaseRequest);
    this.unsubscribeSkin?.();this.unsubscribeSkin=null;
    this.renderer.dispose();this.renderer.domElement.remove();
    this.scene.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();const ms=Array.isArray(o.material)?o.material:[o.material];ms.forEach(m=>m.dispose());}});
    if(this.world)this.world.free();
  }
  private createWorld():void{
    this.scene.background=new THREE.Color(0x9db7c7);this.scene.fog=new THREE.Fog(0x9db7c7,GAME_CONFIG.world.fogNear,GAME_CONFIG.world.fogFar);
    this.scene.add(new THREE.HemisphereLight(0xe0edff,0x786044,2.1));
    const sun=new THREE.DirectionalLight(0xffe1b3,3);sun.position.set(-18,32,12);this.scene.add(sun);
    const floorMat=new THREE.MeshStandardMaterial({color:0xc2a477,roughness:.95});
    this.addBox(0,-.35,0,52,.7,52,floorMat,true);
    const sand=new THREE.MeshStandardMaterial({color:0xd0b58b,roughness:.9});
    const trim=new THREE.MeshStandardMaterial({color:0x90795b,roughness:.88});
    const wood=new THREE.MeshStandardMaterial({color:0x79583b,roughness:.85});
    // Original blockout inspired by desert tactical maps, not a copied Valve map.
    const walls:[number,number,number,number,number,number][]=[
      [0,2,-25,52,4,1],[-25,2,0,1,4,52],[25,2,0,1,4,52],[0,2,25,52,4,1],
      [-8,1.7,-1,1,3.4,23],[8,1.7,1,1,3.4,23],[0,1.6,-9,14,3.2,.8],
      [-14,1.5,8,10,3,.8],[14,1.5,8,10,3,.8],[-13,1.8,-14,1,3.6,13],
      [13,1.8,-14,1,3.6,13],[-19,1.5,-17,9,3,.8],[19,1.5,-10,9,3,.8],
      [-4,1.4,17,12,2.8,.8],[4,1.4,-19,12,2.8,.8],
    ];
    for(const w of walls)this.addBox(...w,sand,true);
    const crates:[number,number,number][]=[[-4,.7,5],[4,.7,-4],[17,.7,-10],[-16,.7,12],[-12,.7,-16],[12,.7,-17],[18,.7,1]];
    for(const c of crates)this.addBox(c[0],c[1],c[2],2.1,1.4,2.1,wood,true);
    // Pillars/trim give the simple arena some depth.
    for(const x of [-20,-10,0,10,20])this.addBox(x,.12,-22,.25,.24,.25,trim,false);
    for(const zone of CALLOUTS){
      const marker=new THREE.Mesh(new THREE.CircleGeometry(1.2,24),new THREE.MeshBasicMaterial({color:0xd7b77b,transparent:true,opacity:.13,side:THREE.DoubleSide}));
      marker.rotation.x=-Math.PI/2;marker.position.set(zone.x,.015,zone.z);this.scene.add(marker);this.props.push(marker);
    }
    // Original low-poly first-person weapon silhouette.
    const gun=new THREE.Group();
    const dark=new THREE.MeshStandardMaterial({color:0x202832,metalness:.65,roughness:.36});
    const stock=new THREE.MeshStandardMaterial({color:0x5a4534,roughness:.72});this.weaponSkinMaterial=stock;this.applyEquippedSkin(useGameStore.getState().equippedSkins[useGameStore.getState().weapon] ?? null);
    const barrel=new THREE.Mesh(new THREE.BoxGeometry(.12,.12,.85),dark);barrel.position.set(.3,-.24,-.7);gun.add(barrel);
    const body=new THREE.Mesh(new THREE.BoxGeometry(.28,.2,.52),stock);body.position.set(.3,-.28,-.28);gun.add(body);
    const grip=new THREE.Mesh(new THREE.BoxGeometry(.12,.26,.15),dark);grip.position.set(.3,-.45,-.25);grip.rotation.x=-.2;gun.add(grip);
    gun.position.set(.1,-.04,-.22);this.camera.add(gun);this.scene.add(this.camera);
  }
  private applyEquippedSkin(skin: Skin | null): void {
    if (!this.weaponSkinMaterial) return;
    const colors: Record<Rarity, number> = { common: 0x8a7358, uncommon: 0x4c9a65, rare: 0x3f83c8, mythical: 0x9b4bb5, legendary: 0xd49a35, ancient: 0xd34c54 };
    this.weaponSkinMaterial.color.setHex(skin ? colors[skin.rarity] : 0x5a4534);
    this.weaponSkinMaterial.roughness = skin ? Math.min(0.9, 0.25 + skin.wear * 0.65) : 0.72;
    this.weaponSkinMaterial.metalness = skin && skin.rarity !== "common" ? 0.35 : 0.05;
    this.weaponSkinMaterial.needsUpdate = true;
  }
  private addBox(x:number,y:number,z:number,w:number,h:number,d:number,mat:THREE.Material,solid:boolean):void{
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;this.scene.add(mesh);this.colliders.push(mesh);
    if(solid && this.world){this.world.createCollider(RAPIER.ColliderDesc.cuboid(w/2,h/2,d/2).setTranslation(x,y,z).setFriction(.7));}
  }
  private spawnTargets():void{
    const mat=new THREE.MeshStandardMaterial({color:0x8f4938,roughness:.7});
    for(let i=0;i<5;i++){
      const group=new THREE.Group();const body=new THREE.Mesh(new THREE.CapsuleGeometry(.34,.8,4,8),mat);body.position.y=.95;group.add(body);
      const head=new THREE.Mesh(new THREE.SphereGeometry(.22,12,8),new THREE.MeshStandardMaterial({color:0xc7a47e}));head.position.y=1.62;group.add(head);
      const x=[-16,-11,0,11,17][i],z=[-12,-3,-16,-13,4][i];group.position.set(x,0,z);this.scene.add(group);
      this.targets.push({mesh:group,hp:100,nextMove:0,direction:new THREE.Vector3(Math.random()-.5,0,Math.random()-.5).normalize()});
    }
  }
  private readonly onKeyDown=(e:KeyboardEvent):void=>{
    this.keys.add(e.code);
    if(e.repeat)return;
    if(e.code==="Space")this.jumpQueued=true;
    if(e.code==="Digit1")useGameStore.getState().setWeapon("rifle");
    if(e.code==="Digit2")useGameStore.getState().setWeapon("pistol");
    if(e.code==="Digit3")useGameStore.getState().setWeapon("shotgun");
    if(e.code==="Digit4")useGameStore.getState().setWeapon("knife");
    if(e.code==="KeyR")this.reload();
    if(e.code==="KeyE"){
      const socket=this.getSocket();
      if(socket?.connected){
        this.bombHoldStarted=true;
        socket.emit("bomb:action-start",(result:{ok:boolean;reason?:string;action?:string;durationMs?:number})=>{
          if(result?.ok)useGameStore.getState().setNotice(result.action==="PLANTING"?"УСТАНОВКА БОМБЫ… УДЕРЖИВАЙ E": "ОБЕЗВРЕЖИВАНИЕ… УДЕРЖИВАЙ E");
          else if(result?.reason==="NOT_DEFUSAL_MODE")this.openCase();
          else if(result?.reason)useGameStore.getState().setNotice(({T_ONLY_CAN_PLANT:"Только T могут установить бомбу",CT_ONLY_CAN_DEFUSE:"Только CT могут обезвредить бомбу",MOVE_TO_SITE_A_OR_B:"Подойди к сайту A или B",MOVE_NEAR_BOMB:"Подойди к бомбе",ROUND_NOT_ACTIVE:"Раунд не активен",BOMB_ALREADY_PLANTED:"Бомба уже установлена",NO_BOMB_TO_DEFUSE:"Нет бомбы для обезвреживания"} as Record<string,string>)[result.reason]||result.reason);
        });
      }else this.openCase();
    }
  };
  private readonly onKeyUp=(e:KeyboardEvent):void=>{
    this.keys.delete(e.code);
    if(e.code==="KeyE" && this.bombHoldStarted){this.bombHoldStarted=false;this.getSocket()?.emit("bomb:action-cancel");}
  };
  private fire():void{
    const store=useGameStore.getState(),weapon=WEAPONS[store.weapon],now=performance.now();
    if(this.reloading||now-this.lastShot<weapon.fireDelayMs)return;
    if(weapon.kind==="melee"){this.lastShot=now;this.sendNetworkShot(store.weapon);this.raycaster.setFromCamera(new THREE.Vector2(0,0),this.camera);const t=this.raycaster.intersectObjects(this.targets.flatMap(x=>x.mesh.children),true)[0];if(t&&t.distance<2.5)this.damageTarget(t.object);return;}
    if(store.ammo[store.weapon]<=0){store.setNotice("Магазин пуст — нажми R");return;}
    this.lastShot=now;store.setAmmo(store.weapon,store.ammo[store.weapon]-1);this.recoil=Math.min(this.recoil+.004,.035);this.sendNetworkShot(store.weapon);
    const rays=store.weapon==="shotgun"?8:1;let hit=false;
    for(let i=0;i<rays;i++){
      this.raycaster.setFromCamera(new THREE.Vector2((Math.random()-.5)*weapon.spread,(Math.random()-.5)*weapon.spread),this.camera);
      const intersections=this.raycaster.intersectObjects([...this.targets.flatMap(t=>t.mesh.children),...this.colliders],true);
      const first=intersections[0];if(first && first.object.parent && this.targets.some(t=>t.mesh===first.object.parent||t.mesh.children.includes(first.object))){this.damageTarget(first.object);hit=true;}
      const start=this.camera.position.clone();const end=this.raycaster.ray.at(first?.distance??35,new THREE.Vector3());
      const tracer=new THREE.Line(new THREE.BufferGeometry().setFromPoints([start,end]),new THREE.LineBasicMaterial({color:0xffd28a,transparent:true,opacity:.6}));
      this.scene.add(tracer);setTimeout(()=>{this.scene.remove(tracer);tracer.geometry.dispose();(tracer.material as THREE.Material).dispose();},65);
    }
    if(!hit)store.setNotice("Выстрел");
  }
  private damageTarget(object:THREE.Object3D):void{
    const target=this.targets.find(t=>t.mesh===object||t.mesh.children.includes(object));if(!target)return;
    target.hp-=WEAPONS[useGameStore.getState().weapon].damage;
    target.mesh.traverse(o=>{if(o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial)o.material.emissive.setHex(0x552211);});
    if(target.hp<=0){useGameStore.getState().addKill();target.hp=100;target.mesh.position.set((Math.random()-.5)*34,0,-8-Math.random()*13);}
    else useGameStore.getState().setNotice(`Попадание · ${target.hp} HP`);
  }
  private sendNetworkShot(weaponId: string):void{
    const socket=this.getSocket();if(!socket?.connected)return;
    this.raycaster.setFromCamera(new THREE.Vector2(0,0),this.camera);
    const o=this.camera.position,d=this.raycaster.ray.direction;
    socket.emit("combat:shoot",{weaponId,origin:[o.x,o.y,o.z],direction:[d.x,d.y,d.z]},(result:{ok:boolean;hit?:boolean;damage?:number;killed?:boolean;reason?:string})=>{
      if(!result?.ok){if(result?.reason)useGameStore.getState().setNotice(`СЕРВЕР: ${result.reason}`);return;}
      if(result.hit)useGameStore.getState().setNotice(result.killed?"ПРОТИВНИК УСТРАНЁН":"ПОПАДАНИЕ · СЕРВЕР ПОДТВЕРДИЛ");
    });
  }
  private syncRemotePlayers(data:{id:string;players:Array<{id:string;nickname:string;team:"T"|"CT";position:{x:number;y:number;z:number};yaw:number;health:number;alive:boolean}>}):void{
    const socket=this.getSocket();if(!socket||data?.id===undefined)return;
    const seen=new Set<string>();
    for(const player of data.players||[]){
      if(player.id===socket.id){
        this.localServerTarget = { x: player.position.x, z: player.position.z };
        if(this.playerBody && (!this.syncedInitialPosition || (player.alive && !this.wasLocalAlive))){
          this.playerBody.setTranslation({x:player.position.x,y:1,z:player.position.z},true);
          this.playerBody.setLinvel({x:0,y:0,z:0},true);
          this.camera.position.set(player.position.x,GAME_CONFIG.player.eyeHeight,player.position.z);
          this.syncedInitialPosition=true;
        }
        this.wasLocalAlive=player.alive;
        continue;
      }
      seen.add(player.id);let model=this.remotePlayers.get(player.id);
      if(!model){
        model=new THREE.Group();
        const color=player.team==="T"?0xb95e43:0x477eaf;
        const body=new THREE.Mesh(new THREE.CapsuleGeometry(.34,.8,4,8),new THREE.MeshStandardMaterial({color,roughness:.72}));body.position.y=.9;model.add(body);
        const head=new THREE.Mesh(new THREE.SphereGeometry(.21,12,8),new THREE.MeshStandardMaterial({color:0xc7a47e}));head.position.y=1.58;model.add(head);
        const labelCanvas=document.createElement("canvas");labelCanvas.width=256;labelCanvas.height=64;const ctx=labelCanvas.getContext("2d");
        if(ctx){ctx.clearRect(0,0,256,64);ctx.fillStyle="#ffffff";ctx.font="bold 24px sans-serif";ctx.textAlign="center";ctx.fillText(player.nickname.slice(0,18),128,40);}
        const label=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(labelCanvas),transparent:true,depthTest:false}));label.position.y=2.25;label.scale.set(2.4,.6,1);model.add(label);
        this.scene.add(model);this.remotePlayers.set(player.id,model);
      }
      model.visible=player.alive;
      this.remoteTargets.set(player.id,{x:player.position.x,z:player.position.z,yaw:player.yaw});
    }
    for(const [id,model] of this.remotePlayers){if(!seen.has(id)){this.scene.remove(model);this.remoteTargets.delete(id);model.traverse(o=>{if(o instanceof THREE.Mesh)o.geometry.dispose();if(o instanceof THREE.Mesh||o instanceof THREE.Sprite){const mat=o.material;if(Array.isArray(mat))mat.forEach(m=>m.dispose());else mat.dispose();}});this.remotePlayers.delete(id);}}
  }
  private reload():void{
    const s=useGameStore.getState(),w=s.weapon,def=WEAPONS[w];if(this.reloading||w==="knife"||s.ammo[w]>=def.magazine||s.reserve[w]<=0)return;
    this.reloading=true;this.reloadTimer=def.reloadMs/1000; s.setNotice("Перезарядка...");
  }
  private openCase():void{
    const store=useGameStore.getState(),cost=GAME_CONFIG.economy.caseCost;if(!store.spend(cost))return;
    const rarity=rollRarity();const weapon=store.weapon;
    const names:Record<Rarity,string[]>={common:["Sandline","Dust Grid"],uncommon:["Copper Pulse","Dry Heat"],rare:["Night Bazaar","Blue Mosaic"],mythical:["Mirage Bloom","Neon Dune"],legendary:["Solar Flare","Golden Veil"],ancient:["Pharaoh's Eye","Sovereign Sand"]};
    const list=names[rarity],skin:Skin={id:`skin-${Date.now()}-${Math.floor(Math.random()*9999)}`,weaponId:weapon,name:list[Math.floor(Math.random()*list.length)],rarity,wear:Math.random(),patternSeed:Math.floor(Math.random()*1000)};
    store.addSkin(skin);store.setNotice(`Кейс открыт: ${skin.name} · ${rarityNames[rarity]}`);
    window.dispatchEvent(new CustomEvent("shatki-case-result",{detail:skin}));
  }
  private resize():void{const w=Math.max(1,this.host.clientWidth),h=Math.max(1,this.host.clientHeight);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.renderer.setSize(w,h);}
  private animate=():void=>{
    if(this.disposed)return;this.frameId=requestAnimationFrame(this.animate);
    const currentSocket=this.getSocket();if(currentSocket!==this.attachedSocket){this.attachedSocket?.off("match:state",this.onMatchState);this.attachedSocket?.off("match:killfeed",this.onKillfeed);this.attachedSocket?.off("match:round-end",this.onRoundEnd);this.attachedSocket?.off("bomb:planted",this.onBombEvent);this.attachedSocket?.off("bomb:defused",this.onBombEvent);this.attachedSocket?.off("bomb:exploded",this.onBombEvent);this.attachedSocket=currentSocket;if(currentSocket){currentSocket.on("match:state",this.onMatchState);currentSocket.on("match:killfeed",this.onKillfeed);currentSocket.on("match:round-end",this.onRoundEnd);currentSocket.on("bomb:planted",this.onBombEvent);currentSocket.on("bomb:defused",this.onBombEvent);currentSocket.on("bomb:exploded",this.onBombEvent);}}
    if(!this.world||!this.playerBody){this.renderer.render(this.scene,this.camera);return;}
    const dt=Math.min(this.clock.getDelta(),.04);
    this.velocity.set(0,0,0);
    if(this.controls.isLocked){
      this.controls.getDirection(this.direction);this.direction.y=0;this.direction.normalize();
      const right=new THREE.Vector3().crossVectors(this.direction,this.camera.up).normalize();
      const crouch=this.keys.has("ControlLeft")||this.keys.has("ControlRight");
      let speed=crouch?GAME_CONFIG.player.crouchSpeed:GAME_CONFIG.player.walkSpeed;
      if(!crouch&&(this.keys.has("ShiftLeft")||this.keys.has("ShiftRight")))speed*=GAME_CONFIG.player.sprintMultiplier;
      if(this.keys.has("KeyW"))this.velocity.add(this.direction);
      if(this.keys.has("KeyS"))this.velocity.sub(this.direction);
      if(this.keys.has("KeyD"))this.velocity.add(right);
      if(this.keys.has("KeyA"))this.velocity.sub(right);
      if(this.velocity.lengthSq()>0)this.velocity.normalize().multiplyScalar(speed);
      const vel=this.playerBody.linvel();
      this.playerBody.setLinvel({x:this.velocity.x,y:vel.y,z:this.velocity.z},true);
      if(this.jumpQueued&&Math.abs(vel.y)<.12)this.playerBody.setLinvel({x:vel.x,y:GAME_CONFIG.player.jumpVelocity,z:vel.z},true);
      this.jumpQueued=false;
      this.world.step();
      let p=this.playerBody.translation();
      // Local prediction stays responsive, while the server remains authoritative.
      // Small drift is blended out; large corrections (spawn/teleport) snap safely.
      if(this.localServerTarget && this.syncedInitialPosition){
        const dx=this.localServerTarget.x-p.x,dz=this.localServerTarget.z-p.z,dist=Math.hypot(dx,dz);
        if(dist>3){this.playerBody.setTranslation({x:this.localServerTarget.x,y:p.y,z:this.localServerTarget.z},true);this.playerBody.setLinvel({x:0,y:p.y<1.05?0:this.playerBody.linvel().y,z:0},true);}
        else if(dist>.08){const blend=Math.min(1,dt*7);this.playerBody.setTranslation({x:p.x+dx*blend,y:p.y,z:p.z+dz*blend},true);}
        p=this.playerBody.translation();
      }
      this.camera.position.set(p.x,GAME_CONFIG.player.eyeHeight+(crouch?-.38:0),p.z);
      const socket=this.getSocket();const now=performance.now();
      if(socket?.connected&&now-this.lastNetworkInput>=50){
        this.lastNetworkInput=now;
        socket.emit("player:input",{forward:(this.keys.has("KeyW")?1:0)-(this.keys.has("KeyS")?1:0),strafe:(this.keys.has("KeyD")?1:0)-(this.keys.has("KeyA")?1:0),yaw:this.camera.rotation.y,pitch:this.camera.rotation.x,sprint:!crouch&&(this.keys.has("ShiftLeft")||this.keys.has("ShiftRight")),crouch});
      }
      this.recoil=Math.max(0,this.recoil-dt*.025);
      this.camera.rotation.x-=this.recoil*.05;
      this.updateCallout(p.x,p.z);
    }else{this.world.step();}
    // Interpolate remote players between server snapshots instead of snapping
    // their models on every 20 Hz state update.
    for(const [id,model] of this.remotePlayers){
      const target=this.remoteTargets.get(id);if(!target)continue;
      const alpha=Math.min(1,dt*12);
      model.position.x+= (target.x-model.position.x)*alpha;
      model.position.z+= (target.z-model.position.z)*alpha;
      let angle=target.yaw-model.rotation.y;angle=Math.atan2(Math.sin(angle),Math.cos(angle));
      model.rotation.y+=angle*alpha;
    }
    this.updateTargets(dt);
    this.renderer.render(this.scene,this.camera);
  };
  private updateTargets(dt:number):void{
    const now=performance.now();
    for(const target of this.targets){
      if(now>target.nextMove){target.nextMove=now+900+Math.random()*1800;target.direction.set(Math.random()-.5,0,Math.random()-.5).normalize();}
      target.mesh.position.addScaledVector(target.direction,dt*.45);
      if(Math.abs(target.mesh.position.x)>21||Math.abs(target.mesh.position.z)>21)target.direction.negate();
    }
    if(this.reloading){this.reloadTimer-=dt;if(this.reloadTimer<=0){const s=useGameStore.getState(),w=s.weapon,def=WEAPONS[w],need=def.magazine-s.ammo[w],loaded=Math.min(need,s.reserve[w]);s.setAmmo(w,s.ammo[w]+loaded);useGameStore.setState(st=>({reserve:{...st.reserve,[w]:st.reserve[w]-loaded}}));this.reloading=false;s.setNotice("Перезарядка завершена");}}
  }
  private updateCallout(x:number,z:number):void{
    const nearest=[...CALLOUTS].sort((a,b)=>Math.hypot(a.x-x,a.z-z)-Math.hypot(b.x-x,b.z-z))[0];
    if(nearest&&nearest.name!==this.lastCallout&&Math.hypot(nearest.x-x,nearest.z-z)<7){this.lastCallout=nearest.name;useGameStore.getState().setNotice(nearest.name);}
  }
}