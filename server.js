'use strict';
const http=require('http'),fs=require('fs'),path=require('path');
const {WebSocketServer,WebSocket}=require('ws');
const PORT=process.env.PORT||3000,MAX_PLAYERS=10;
const server=http.createServer((req,res)=>{
 let p=req.url.split('?')[0]; if(p==='/'||p==='/index.html')p='/index.html';
 const file=path.join(__dirname,p.replace(/^\/+/,''));
 if(!file.startsWith(__dirname)){res.writeHead(403);return res.end('Forbidden')}
 fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream'});res.end(data)});
});
const wss=new WebSocketServer({server});
const players=new Map();let nextId=1,score={A:0,B:0},bomb={planted:false,by:null,x:0,z:0,until:0},round=1;
const maps=['MIRAGE','DUST II'];const now=()=>Date.now();
function send(ws,obj){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj))}
function broadcast(obj){for(const p of players.values())send(p.ws,obj)}
function pub(){broadcast({t:'state',players:[...players.values()].map(p=>({id:p.id,n:p.n,x:p.x,z:p.z,hp:p.hp,team:p.team})),count:players.size,scores:score,mode:currentMode(),mapName:maps[currentMap()] ,round:'РАУНД '+round,bomb:bomb.planted?{text:'C4 УСТАНОВЛЕН · '+Math.max(0,Math.ceil((bomb.until-now())/1000))+'с'}:null})}
function currentMap(){const p=players.values().next().value;return p?p.m:0}
function currentMode(){const p=players.values().next().value;return p?p.mode:'c4'}
function event(text){broadcast({t:'event',text})}
function resetRound(){round++;bomb={planted:false,by:null,x:0,z:0,until:0};for(const p of players.values()){p.hp=100;p.x=p.team==='A'?-21:21;p.z=(Math.random()-.5)*8}event('Раунд '+round+' начинается');pub()}
function nearestEnemy(shooter){let best=null,bd=1e9;for(const p of players.values()){if(p.id===shooter.id||p.hp<=0)continue;if(shooter.mode!=='ffa'&&p.team===shooter.team)continue;const d=Math.hypot(p.x-shooter.x,p.z-shooter.z);if(d<bd&&d<45){bd=d;best=p}}return best}
wss.on('connection',ws=>{
 const p={ws,id:String(nextId++),n:'Player',m:0,mode:'c4',team:'A',x:0,z:0,hp:100,lastShot:0};
 ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}
 if(m.t==='join'){if(players.size>=MAX_PLAYERS){send(ws,{t:'event',text:'Сервер заполнен (максимум 10 игроков)'});return}
 p.n=String(m.n||'Player').slice(0,16);p.m=Number(m.m)===1?1:0;p.mode=['c4','tdm','ffa'].includes(m.mode)?m.mode:'c4';
 const countA=[...players.values()].filter(x=>x.team==='A').length,countB=[...players.values()].filter(x=>x.team==='B').length;p.team=p.mode==='ffa'?'FFA':countA<=countB?'A':'B';p.x=p.team==='B'?21:-21;p.z=(Math.random()-.5)*8;players.set(p.id,p);send(ws,{t:'welcome',id:p.id,team:p.team,x:p.x,z:p.z});event(p.n+' подключился');pub();return}
 if(!players.has(p.id))return;
 if(m.t==='move'){p.x=Math.max(-25,Math.min(25,Number(m.x)||0));p.z=Math.max(-22,Math.min(22,Number(m.z)||0));p.yaw=Number(m.yaw)||0;return}
 if(m.t==='shoot'){if(now()-p.lastShot<140||p.hp<=0)return;p.lastShot=now();let target=players.get(String(m.target));if(!target||target.id===p.id||target.hp<=0||(p.mode!=='ffa'&&p.team===target.team))return;
 target.hp=Math.max(0,target.hp-34);send(target.ws,{t:'hit',target:target.id,hp:target.hp});if(target.hp<=0){if(p.mode==='ffa'){score[p.id]=(score[p.id]||0)+1}else score[p.team]=(score[p.team]||0)+1;event(p.n+' устранил '+target.n);target.hp=0;setTimeout(()=>{if(players.has(target.id)){target.hp=100;target.x=target.team==='B'?21:-21;target.z=(Math.random()-.5)*8;pub()}},3500);if((p.mode==='tdm'&&(score.A>=30||score.B>=30))){event('Победа команды '+(score.A>=30?'A':'B'));score={A:0,B:0};resetRound()}}pub();return}
 if(m.t==='action'&&p.mode==='c4'){const nearSite=(x,z)=>Math.hypot(p.x-x,p.z-z)<5;const sites=p.m===0?[[-19,-16],[19,16]]:[[-19,15],[19,-15]];
 if(!bomb.planted){if(p.team==='B'&&(nearSite(...sites[0])||nearSite(...sites[1]))){bomb={planted:true,by:p.id,x:p.x,z:p.z,until:now()+40000};event('C4 УСТАНОВЛЕН! 40 секунд до взрыва');pub()}else send(ws,{t:'event',text:'Подойди к точке A или B, чтобы установить C4 (команда B)'})}
 else if(p.team==='A'&&Math.hypot(p.x-bomb.x,p.z-bomb.z)<4){event(p.n+' обезвреживает C4');bomb={planted:false,by:null,x:0,z:0,until:0};score.A++;event('C4 обезврежена — победа команды A');resetRound()}
 return}
 });
 ws.on('close',()=>{if(players.delete(p.id)){event(p.n+' покинул сервер');pub()}});
});
setInterval(()=>{if(bomb.planted&&now()>=bomb.until){event('C4 взорвалась — победа команды B');score.B++;resetRound()}pub()},1000);
server.listen(PORT,()=>console.log('SHET STRIKE ONLINE listening on '+PORT));
