import { useEffect,useRef,useState } from "react";
import { io, type Socket } from "socket.io-client";
import { GameScene } from "../game/GameScene";
import { useGameStore } from "../store/gameStore";
import { GAME_CONFIG, WEAPONS } from "../shared/config";
import type { Skin } from "../shared/types";

type Screen="home"|"play"|"inventory"|"cases"|"settings"|"online";
type RoomSummary={id:string;mode:"deathmatch"|"defusal";players:number;createdAt:number;phase?:string;score?:{T:number;CT:number}};
type Profile={id:string;nickname:string;currency:number;kills:number;deaths:number;wins:number;createdAt:number;inventory:Skin[];equipped?:Partial<Record<Skin["weaponId"],string>>;hasAccount?:boolean};
type MatchHud={id:string;mode:"deathmatch"|"defusal";phase:string;endsAt:number;score:{T:number;CT:number};winner?:string;bomb:{planted:boolean;site:"A"|"B"|null;explodesAt:number|null;defused:boolean};players:Array<{id:string;nickname:string;team:"T"|"CT";health:number;armor:number;kills:number;deaths:number;alive:boolean}>};
export default function App(){
  const hostRef=useRef<HTMLDivElement>(null),gameRef=useRef<GameScene|null>(null);
  const [locked,setLocked]=useState(false),[screen,setScreen]=useState<Screen>("home");
  const socketRef=useRef<Socket|null>(null);
  const apiBase=import.meta.env.VITE_SERVER_URL||(import.meta.env.PROD?window.location.origin:"http://localhost:3001");
  const [profile,setProfile]=useState<Profile|null>(null),[profileBusy,setProfileBusy]=useState(false),[caseBusy,setCaseBusy]=useState(false);
  const [leaderboard,setLeaderboard]=useState<Array<Pick<Profile,"id"|"nickname"|"kills"|"wins">>>([]);
  const [networkStatus,setNetworkStatus]=useState("ПОДКЛЮЧЕНИЕ..."),[rooms,setRooms]=useState<RoomSummary[]>([]),[activeRoom,setActiveRoom]=useState("");
  const [matchHud,setMatchHud]=useState<MatchHud|null>(null),[remainingMs,setRemainingMs]=useState(0);
  const screenRef=useRef<Screen>("home"),activeRoomRef=useRef("");screenRef.current=screen;activeRoomRef.current=activeRoom;
  const [nickname,setNickname]=useState(useGameStore.getState().nickname),[caseResult,setCaseResult]=useState<Skin|null>(null);
  const [accountUsername,setAccountUsername]=useState(""),[accountPassword,setAccountPassword]=useState(""),[accountBusy,setAccountBusy]=useState(false);
  const state=useGameStore();
  useEffect(()=>{if(!hostRef.current)return;const game=new GameScene(hostRef.current,setLocked,()=>socketRef.current);gameRef.current=game;return()=>{game.dispose();gameRef.current=null;};},[]);
  useEffect(()=>{const handler=(e:Event)=>setCaseResult((e as CustomEvent<Skin>).detail);window.addEventListener("shatki-case-result",handler);return()=>window.removeEventListener("shatki-case-result",handler);},[]);
  useEffect(()=>{
    const socket=io(apiBase,{timeout:5000,reconnectionAttempts:5,auth:{token:localStorage.getItem("shatki_profile_token")||""}});
    socketRef.current=socket;
    socket.on("connect",()=>{setNetworkStatus("ПОДКЛЮЧЕНО");if(screenRef.current==="online")socket.emit("room:list",(data:RoomSummary[])=>setRooms(Array.isArray(data)?data:[]));});
    socket.on("disconnect",()=>setNetworkStatus("СОЕДИНЕНИЕ ПОТЕРЯНО"));
    socket.on("room:list-updated",(data:RoomSummary[])=>setRooms(Array.isArray(data)?data:[]));
    socket.on("profile:update",(next:Profile)=>{setProfile(next);syncActiveSkin(next);});
    socket.on("connect_error",()=>setNetworkStatus("СЕРВЕР НЕДОСТУПЕН"));
    socket.on("match:state",(data:MatchHud)=>{
      if(data?.id===activeRoomRef.current){
        setMatchHud(data);
        setRemainingMs(Math.max(0,data.endsAt-Date.now()));
        setRooms(old=>old.map(r=>r.id===data.id?{...r,players:data.players.length,phase:data.phase,score:data.score}:r));
      }
    });
    socket.on("match:clock",(data:{phase:string;remainingMs:number;score:{T:number;CT:number};winner?:string})=>{
      setRemainingMs(Math.max(0,data.remainingMs));
      setMatchHud(old=>old&&old.id===activeRoomRef.current?{...old,phase:data.phase,score:data.score,winner:data.winner}:old);
    });
    socket.on("match:round-start",(data:{endsAt:number;score:{T:number;CT:number}})=>{
      setRemainingMs(Math.max(0,data.endsAt-Date.now()));
      setMatchHud(old=>old?{...old,phase:"live",endsAt:data.endsAt,score:data.score,winner:undefined,bomb:{planted:false,site:null,explodesAt:null,defused:false},players:old.players.map(p=>({...p,alive:true,health:100,armor:0}))}:old);
    });
    return()=>{socket.disconnect();socketRef.current=null;};
  },[]);
  useEffect(()=>{
    const token=localStorage.getItem("shatki_profile_token");
    if(!token)return;
    fetch(`${apiBase}/api/me`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.ok?r.json():Promise.reject()).then(data=>{if(data.profile){setProfile(data.profile);setNickname(data.profile.nickname);syncActiveSkin(data.profile);}}).catch(()=>{localStorage.removeItem("shatki_profile_token");setProfile(null);});
  },[]);
  useEffect(()=>{if(screen!=="settings")return;fetch(`${apiBase}/api/leaderboard`).then(r=>r.ok?r.json():Promise.reject()).then(data=>setLeaderboard(Array.isArray(data.players)?data.players:[])).catch(()=>setLeaderboard([]));},[screen]);
  const syncActiveSkin=(next:Profile)=>{
    const equipped:Partial<Record<Skin["weaponId"],Skin>>={};
    for(const [weaponId,skinId] of Object.entries(next.equipped??{})){
      const skin=next.inventory.find(item=>item.id===skinId);
      if(skin)equipped[weaponId as Skin["weaponId"]]=skin;
    }
    state.setEquippedSkins(equipped);
  };
  const equipSkin=async(skin:Skin)=>{
    const token=localStorage.getItem("shatki_profile_token");
    if(!token){state.setNotice("Создай гостевой профиль, чтобы сохранять экипировку");setScreen("settings");return;}
    try{
      const response=await fetch(`${apiBase}/api/me/equip`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({skinId:skin.id})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"EQUIP_FAILED");
      setProfile(data.profile);syncActiveSkin(data.profile);state.setNotice(`Экипирован скин ${skin.name}`);
    }catch{state.setNotice("Не удалось экипировать предмет: проверь подключение к серверу");}
  };
  const createGuestProfile=async()=>{
    setProfileBusy(true);
    try{
      const response=await fetch(`${apiBase}/api/guest`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nickname})});
      if(!response.ok)throw new Error("Не удалось создать профиль");
      const data=await response.json();localStorage.setItem("shatki_profile_token",data.token);setProfile(data.profile);setNickname(data.profile.nickname);syncActiveSkin(data.profile);
      if(socketRef.current){socketRef.current.auth={token:data.token};socketRef.current.disconnect();socketRef.current.connect();}
      state.setNotice("Гостевой профиль создан и сохранён на сервере");
    }catch{state.setNotice("Сервер профилей недоступен");}finally{setProfileBusy(false);}
  };
  const saveProfile=async()=>{
    const token=localStorage.getItem("shatki_profile_token");
    if(!token){state.setNickname(nickname);state.setNotice("Ник сохранён только локально");return;}
    setProfileBusy(true);
    try{const response=await fetch(`${apiBase}/api/me`,{method:"PATCH",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({nickname})});if(!response.ok)throw new Error();const data=await response.json();setProfile(data.profile);syncActiveSkin(data.profile);state.setNickname(data.profile.nickname);state.setNotice("Профиль сохранён на сервере");}
    catch{state.setNotice("Не удалось сохранить профиль");}finally{setProfileBusy(false);}
  };
  const loginAccount=async()=>{
    if(accountBusy)return;setAccountBusy(true);
    try{
      const response=await fetch(`${apiBase}/api/account/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:accountUsername,password:accountPassword})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"LOGIN_FAILED");
      localStorage.setItem("shatki_profile_token",data.token);setProfile(data.profile);setNickname(data.profile.nickname);syncActiveSkin(data.profile);setAccountPassword("");
      if(socketRef.current){socketRef.current.auth={token:data.token};socketRef.current.disconnect();socketRef.current.connect();}
      state.setNotice("Вход выполнен; профиль загружен с сервера");
    }catch(e){state.setNotice(e instanceof Error&&e.message==="TOO_MANY_ATTEMPTS"?"Слишком много попыток. Подожди минуту.":"Не удалось войти: проверь логин и пароль");}
    finally{setAccountBusy(false);}
  };
  const upgradeAccount=async()=>{
    const token=localStorage.getItem("shatki_profile_token");
    if(!token){state.setNotice("Сначала создай гостевой профиль");return;}
    if(accountBusy)return;setAccountBusy(true);
    try{
      const response=await fetch(`${apiBase}/api/account/upgrade`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({username:accountUsername,password:accountPassword})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"UPGRADE_FAILED");
      setProfile(data.profile);setAccountPassword("");state.setNotice("Аккаунт создан: инвентарь и Шэтки сохранены");
    }catch(e){const code=e instanceof Error?e.message:"";state.setNotice(code==="USERNAME_TAKEN"?"Этот логин уже занят":code==="INVALID_PASSWORD"?"Пароль должен содержать от 10 до 128 символов":code==="INVALID_USERNAME"?"Логин: 3–20 символов, латиница, цифры или _":"Не удалось создать аккаунт; проверь данные и сервер");}
    finally{setAccountBusy(false);}
  };
  useEffect(()=>{if(screen==="online"&&socketRef.current?.connected)socketRef.current.emit("room:list",(data:RoomSummary[])=>setRooms(Array.isArray(data)?data:[]));},[screen]);
  const refreshRooms=()=>socketRef.current?.emit("room:list",(data:RoomSummary[])=>setRooms(Array.isArray(data)?data:[]));
  const acceptRoom=(room:{id:string},matchState?:MatchHud)=>{setActiveRoom(room.id);activeRoomRef.current=room.id;setMatchHud(matchState??null);if(matchState)setRemainingMs(Math.max(0,matchState.endsAt-Date.now()));setNetworkStatus(`КОМНАТА ${room.id}`);refreshRooms();};
  const createRoom=(mode:"deathmatch"|"defusal")=>socketRef.current?.emit("room:create",{mode,nickname},(result:{ok:boolean;room?:{id:string};state?:MatchHud})=>{if(result?.ok&&result.room)acceptRoom(result.room,result.state);else setNetworkStatus("НЕ УДАЛОСЬ СОЗДАТЬ КОМНАТУ");});
  const quickJoin=(mode:"deathmatch"|"defusal")=>socketRef.current?.emit("room:quick-join",{mode,nickname},(result:{ok:boolean;room?:{id:string;players?:number;capacity?:number;created?:boolean};state?:MatchHud;error?:string})=>{if(result?.ok&&result.room){acceptRoom(result.room,result.state);setNetworkStatus(`МАТЧ ${result.room.id} · ${result.room.players??1}/${result.room.capacity??10}`);}else setNetworkStatus(`ОШИБКА ПОДБОРА: ${result?.error||"UNKNOWN"}`);});
  const joinRoom=(id:string)=>socketRef.current?.emit("room:join",id,{nickname},(result:{ok:boolean;error?:string;room?:{id:string};state?:MatchHud})=>{if(result?.ok){acceptRoom(result.room??{id},result.state);}else setNetworkStatus(`ОШИБКА: ${result?.error||"UNKNOWN"}`);});
  const start=()=>{setScreen("play");setTimeout(()=>gameRef.current?.lockPointer(),100);};
  const closeCase=()=>setCaseResult(null);
  const openServerCase=async()=>{
    const token=localStorage.getItem("shatki_profile_token");
    if(!token){state.setNotice("Сначала создай гостевой профиль в разделе ПРОФИЛЬ");setScreen("settings");return;}
    if(caseBusy)return;
    setCaseBusy(true);
    try{
      const response=await fetch(`${apiBase}/api/cases/open`,{method:"POST",headers:{Authorization:`Bearer ${token}`}});
      const data=await response.json();
      if(!response.ok){state.setNotice(data.error==="INSUFFICIENT_FUNDS"?"Недостаточно Шэток для открытия кейса":"Не удалось открыть кейс");return;}
      setProfile(data.profile);setCaseResult(data.item as Skin);state.setNotice("Кейс открыт сервером; предмет сохранён в инвентаре");
    }catch{state.setNotice("Сервер экономики недоступен");}
    finally{setCaseBusy(false);}
  };
  return <main className="app-shell">
    <div className="scene" ref={hostRef}/>
    <header className="topbar"><button className="brand" onClick={()=>{if(locked)document.exitPointerLock();setScreen("home");}}><span className="brand-symbol">S</span> SHATKI<span className="muted"> FPS</span></button><div className="top-actions"><span className="online-dot"/> TRAINING BUILD <span className="currency">◈ {profile?.currency ?? state.currency} ШЭТКИ</span></div></header>
    {!locked&&screen!=="play"&&<section className="menu">
      <div className="menu-kicker">TACTICAL COMBAT · WEBGL</div><h1>YOUR GAME.<br/><em>YOUR RULES.</em></h1><p className="lead">Оригинальный браузерный тактический шутер. Тренировочная карта, оружие и экономика — основа будущего онлайн-матча.</p>
      {screen==="home"&&<div className="menu-buttons"><button className="primary" onClick={start}>НАЧАТЬ ТРЕНИРОВКУ <span>↗</span></button><button onClick={()=>setScreen("inventory")}>ИНВЕНТАРЬ</button><button onClick={()=>setScreen("cases")}>КЕЙСЫ</button><button onClick={()=>setScreen("settings")}>ПРОФИЛЬ</button><button onClick={()=>setScreen("online")}>ОНЛАЙН-ЛОББИ</button></div>}
      {screen==="inventory"&&<div className="subscreen"><div className="subhead"><h2>ИНВЕНТАРЬ</h2><button onClick={()=>setScreen("home")}>← НАЗАД</button></div><div className="skin-grid">{(profile?.inventory?.length ? profile.inventory : state.inventory).map(s=><div className={`skin-card rarity-${s.rarity}`} key={s.id}><div className="skin-weapon">⌁</div><b>{s.name}</b><span>{WEAPONS[s.weaponId].name}</span><small>{s.rarity.toUpperCase()} · WEAR {s.wear.toFixed(2)}</small>{profile&&<button className="equip-button" disabled={profile.equipped?.[s.weaponId]===s.id} onClick={()=>equipSkin(s)}>{profile.equipped?.[s.weaponId]===s.id?"ЭКИПИРОВАНО":"ЭКИПИРОВАТЬ"}</button>}</div>)}</div><p className="subnote">{profile ? "Предметы гостевого профиля сохранены на сервере." : "Показываются только локальные демонстрационные предметы. Создай профиль, чтобы пользоваться постоянным инвентарём."}</p></div>}
      {screen==="cases"&&<div className="subscreen"><div className="subhead"><h2>ПОЛЕВОЙ КЕЙС</h2><button onClick={()=>setScreen("home")}>← НАЗАД</button></div><div className="case-art"><div className="case-icon">◇</div><h3>DESERT COLLECTION</h3><p>Случайный оригинальный скин</p><button className="primary" disabled={caseBusy} onClick={openServerCase}>{caseBusy?"ОТКРЫТИЕ...":"ОТКРЫТЬ · "+GAME_CONFIG.economy.caseCost+" ◈"}</button></div><div className="odds">{GAME_CONFIG.caseOdds.map(x=><span key={x.rarity}>{x.rarity} <b>{x.weight}%</b></span>)}</div><p className="subnote">Только виртуальная валюта. Вход в гостевой профиль обязателен: сервер списывает стоимость, определяет редкость и сохраняет предмет. Вероятности: common 60%, uncommon 25%, rare 10%, mythical 4%, legendary 0,9%, ancient 0,1%.</p></div>}
      {screen==="online"&&<div className="subscreen"><div className="subhead"><h2>ОНЛАЙН-ЛОББИ</h2><button onClick={()=>setScreen("home")}>← НАЗАД</button></div><p className="subnote">СЕРВЕР: {networkStatus}</p><div className="menu-buttons"><button className="primary" onClick={()=>quickJoin("deathmatch")}>БЫСТРАЯ ИГРА · DEATHMATCH</button><button className="primary" onClick={()=>quickJoin("defusal")}>БЫСТРАЯ ИГРА · BOMB DEFUSAL</button><button onClick={()=>createRoom("deathmatch")}>СОЗДАТЬ DEATHMATCH</button><button onClick={()=>createRoom("defusal")}>СОЗДАТЬ BOMB DEFUSAL</button><button onClick={refreshRooms}>ОБНОВИТЬ СПИСОК</button>{activeRoom&&<button className="primary" onClick={start}>ИГРАТЬ В КОМНАТЕ ↗</button>}<button onClick={()=>{socketRef.current?.emit("room:leave");setActiveRoom("");setNetworkStatus("ВЫ ВЫШЛИ ИЗ КОМНАТЫ");refreshRooms();}}>ПОКИНУТЬ КОМНАТУ</button></div><div className="room-list">{rooms.length===0?<p className="subnote">Активных комнат пока нет. Создай свою или проверь подключение.</p>:rooms.map(room=><div className="room-row" key={room.id}><div><b>{room.id}</b><small>{room.mode.toUpperCase()} · {room.players}/10</small></div><button disabled={room.players>=10} onClick={()=>joinRoom(room.id)}>{activeRoom===room.id?"В КОМНАТЕ":"ПРИСОЕДИНИТЬСЯ"}</button></div>)}</div><p className="subnote">Быстрая игра автоматически заполняет подходящую комнату; лимит — 10 игроков, следующий игрок попадёт в новый матч. В режиме Bomb Defusal: удерживай E 3 секунды для установки на сайте A/B и 5 секунд для обезвреживания рядом с бомбой. В Deathmatch остаётся тренировочный кейс по E. Сетевая физика игрока пока не полностью авторитетна.</p></div>}
      {screen==="settings"&&<div className="subscreen"><div className="subhead"><h2>ПРОФИЛЬ</h2><button onClick={()=>setScreen("home")}>← НАЗАД</button></div><label className="field-label">ИГРОВОЙ НИКНЕЙМ</label><input className="nickname-input" value={nickname} maxLength={18} onChange={e=>setNickname(e.target.value)}/><button className="primary profile-save" disabled={profileBusy} onClick={saveProfile}>СОХРАНИТЬ НИКНЕЙМ</button>
          {profile ? <div className="profile-stats"><b>{profile.hasAccount?"АККАУНТ · СЕРВЕР":"ГОСТЕВОЙ ПРОФИЛЬ · СЕРВЕР"}</b><span>Убийства: {profile.kills}</span><span>Смерти: {profile.deaths}</span><span>Победы: {profile.wins}</span><span>Баланс: {profile.currency} Шэток</span>{!profile.hasAccount&&<><b>ЗАЩИТИ ПРОФИЛЬ ПАРОЛЕМ</b><label className="field-label">ЛОГИН (3–20: a-z, 0–9, _)</label><input className="nickname-input" autoComplete="username" value={accountUsername} onChange={e=>setAccountUsername(e.target.value)} maxLength={20}/><label className="field-label">ПАРОЛЬ (МИНИМУМ 10 СИМВОЛОВ)</label><input className="nickname-input" type="password" autoComplete="new-password" value={accountPassword} onChange={e=>setAccountPassword(e.target.value)} maxLength={128}/><button className="primary" disabled={accountBusy} onClick={upgradeAccount}>{accountBusy?"СОХРАНЕНИЕ...":"СОЗДАТЬ АККАУНТ И СОХРАНИТЬ ПРОГРЕСС"}</button></>}<button onClick={()=>{localStorage.removeItem("shatki_profile_token");setProfile(null);if(socketRef.current){socketRef.current.auth={token:""};socketRef.current.disconnect();socketRef.current.connect();}state.setNotice("Вы вышли из профиля");}}>ВЫЙТИ ИЗ ПРОФИЛЯ</button></div> : <><div className="profile-stats"><b>ВОЙТИ В АККАУНТ</b><label className="field-label">ЛОГИН</label><input className="nickname-input" autoComplete="username" value={accountUsername} onChange={e=>setAccountUsername(e.target.value)} maxLength={20}/><label className="field-label">ПАРОЛЬ</label><input className="nickname-input" type="password" autoComplete="current-password" value={accountPassword} onChange={e=>setAccountPassword(e.target.value)} maxLength={128}/><button className="primary" disabled={accountBusy} onClick={loginAccount}>{accountBusy?"ВХОД...":"ВОЙТИ"}</button></div><div className="profile-stats"><p className="subnote">Или начни с гостевого профиля. Позже его можно защитить логином и паролем без потери предметов.</p><button className="primary" disabled={profileBusy} onClick={createGuestProfile}>{profileBusy?"СОЗДАНИЕ...":"СОЗДАТЬ ГОСТЕВОЙ ПРОФИЛЬ"}</button></div></>}
          <div className="profile-stats"><b>ТАБЛИЦА ЛИДЕРОВ</b>{leaderboard.length===0?<span>Пока нет сохранённой статистики или сервер недоступен.</span>:leaderboard.slice(0,5).map((p,i)=><span key={p.id}>{i+1}. {p.nickname} — {p.kills} убийств · {p.wins} побед</span>)}</div>
          <p className="subnote">Пароль хранится в виде криптографического scrypt-хеша. Гостевой профиль не защищён, пока ты не создашь аккаунт.</p></div>}
    </section>}
    {locked&&activeRoom&&matchHud&&<div className="match-hud">
      <div className="match-score"><span className="team-t">T {matchHud.score.T}</span><b>{Math.ceil(remainingMs/1000/60).toString().padStart(2,"0")}:{(Math.ceil(remainingMs/1000)%60).toString().padStart(2,"0")}</b><span className="team-ct">{matchHud.score.CT} CT</span></div>
      <div className="match-meta"><span>{matchHud.mode=== "defusal" ? "BOMB DEFUSAL" : "DEATHMATCH"}</span><span>{matchHud.phase==="ended" ? `РАУНД ЗАВЕРШЁН${matchHud.winner?` · ${matchHud.winner}`:""}` : "МАТЧ ИДЁТ"}</span>{matchHud.bomb.planted&&<strong>БОМБА · САЙТ {matchHud.bomb.site} · {Math.max(0,Math.ceil(((matchHud.bomb.explodesAt||Date.now())-Date.now())/1000))}с</strong>}</div>
      <div className="match-players">{matchHud.players.slice().sort((a,b)=>b.kills-a.kills).map(p=><div key={p.id} className={!p.alive?"dead-player":""}><span className={p.team==="T"?"team-t":"team-ct"}>{p.team}</span><span>{p.nickname}</span><b>{p.kills}</b><small>{p.alive?`${p.health} HP`:"DEAD"}</small></div>)}</div>
    </div>}
    {locked&&<><div className="crosshair"><i/><i/><i/><i/></div><div className="zone-label"><span/> {state.notice}</div><div className="weapon-list"><span className={state.weapon==="rifle"?"selected":""}>1 RIFLE</span><span className={state.weapon==="pistol"?"selected":""}>2 PISTOL</span><span className={state.weapon==="shotgun"?"selected":""}>3 SHOTGUN</span><span className={state.weapon==="knife"?"selected":""}>4 KNIFE</span></div><div className="hud-bottom"><div className="hud-block"><span>HEALTH</span><b>{state.health}</b><div className="health-bar"><i style={{width:`${state.health}%`}}/></div></div><div className="hud-block"><span>ARMOR</span><b>{state.armor}</b></div><div className="hud-ammo"><b>{state.weapon==="knife"?"MELEE":`${state.ammo[state.weapon]} <small>/ ${state.reserve[state.weapon]}</small>`}</b><span>{WEAPONS[state.weapon].name.toUpperCase()}</span></div></div><div className="help-hint">WASD — MOVE · SHIFT — RUN · CTRL — CROUCH · SPACE — JUMP · R — RELOAD · E — CASE · ESC — MENU</div></>}
    {!locked&&screen==="play"&&<div className="resume-panel"><h2>ТРЕНИРОВКА ПРИОСТАНОВЛЕНА</h2><p>Нажми, чтобы вернуться на полигон.</p><button className="primary" onClick={()=>gameRef.current?.lockPointer()}>ПРОДОЛЖИТЬ</button><button onClick={()=>setScreen("home")}>В ГЛАВНОЕ МЕНЮ</button></div>}
    {caseResult&&<div className="modal-backdrop"><div className={`case-result rarity-${caseResult.rarity}`}><button className="modal-close" onClick={closeCase}>×</button><div className="case-spark">✦</div><span>ВЫПАЛО ИЗ КЕЙСА</span><h2>{caseResult.name}</h2><p>{WEAPONS[caseResult.weaponId].name} · {caseResult.rarity.toUpperCase()}</p><button className="primary" onClick={closeCase}>ЗАБРАТЬ</button></div></div>}
    <footer className="footer"><span>SHATKI FPS / BUILD 1.7</span><span>ORIGINAL ASSETS · PROTOTYPE</span></footer>
  </main>;
}