"use strict";
(function(g){
const MAPS=[
{n:"АРЕНА",d:"Классика: ящики и неон",seed:20261022,A:30,cnt:22,w:[2,5],h:[1.5,3.6],pal:[0x3a2f5c,0x2f4a5c,0x5c2f4a,0x2f5c45,0x5c4a2f],bg:0x0a0c14,fog:[14,58],fl:["#151826","#2b3350"],wall:0x1b2038,edge:0x19f0ff,strip:0xff2d8a,hemi:[0x9fb4ff,0x1a1a2a,.95]},
{n:"ДЖУНГЛИ",d:"Бетонные башни и тесные проходы",seed:777,A:34,cnt:36,w:[2,4],h:[3,6.5],pal:[0x4a4f55,0x3b4045,0x555a60,0x2f3338],bg:0x0d0f12,fog:[10,45],fl:["#1a1c20","#30343a"],wall:0x25282d,edge:0xff9a2f,strip:0xff9a2f,hemi:[0xaab4c0,0x20242a,.9]},
{n:"КОРОБКА",d:"Маленькая карта, сплошной хаос",seed:4242,A:20,cnt:11,w:[2,4],h:[1.5,3],pal:[0x5c2f4a,0x4a2f5c,0x2f2f5c,0x5c2f5c],bg:0x120816,fog:[10,40],fl:["#1c0f24","#4a2a66"],wall:0x2a1238,edge:0xff2d8a,strip:0x19f0ff,hemi:[0xd0a0ff,0x1a1020,.95]},
{n:"ПУСТЫНЯ",d:"Просторно, видно далеко",seed:9001,A:36,cnt:14,w:[4,8],h:[2,4.5],pal:[0x8a6f45,0x7a5f3a,0x9a7d52,0x6e5636],bg:0xc9a46a,fog:[30,90],fl:["#b89460","#a07f4c"],wall:0x7a5f3a,edge:0xffe6a8,strip:0xff7a2d,hemi:[0xfff0d0,0x6a5030,1.1]}
];;
const WPN=[
{n:"ВИНТОВКА",mag:30,res:90,rate:.095,dmg:15,pel:1,sp:.008,rl:1.5,kick:.05,rng:90},
{n:"ДРОБОВИК",mag:8,res:24,rate:.85,dmg:11,pel:8,sp:.045,rl:2.2,kick:.18,rng:20},
{n:"СНАЙПЕРКА",mag:5,res:15,rate:1.2,dmg:80,pel:1,sp:.0015,rl:2.6,kick:.22,rng:150},
{n:"ПИСТОЛЕТ",mag:12,res:48,rate:.22,dmg:22,pel:1,sp:.012,rl:1.1,kick:.07,rng:70}];
const mkSr=a=>()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};
function genObs(i){const M=MAPS[i],A=M.A,sr=mkSr(M.seed),srr=(a,b)=>a+sr()*(b-a),obs=[];
for(let n=0,k=0;n<M.cnt&&k<600;k++){const w=srr(M.w[0],M.w[1]),d=srr(M.w[0],M.w[1]),h=srr(M.h[0],M.h[1]),x=srr(-A+4,A-4),z=srr(-A+4,A-4);
if(Math.abs(x)<w/2+4&&Math.abs(z)<d/2+4)continue;
let ok=true;for(const o of obs)if(x-w/2-2<o.x1&&x+w/2+2>o.x0&&z-d/2-2<o.z1&&z+d/2+2>o.z0){ok=false;break}
if(!ok)continue;obs.push({x0:x-w/2,x1:x+w/2,z0:z-d/2,z1:z+d/2,h,x,z,w,d,ci:n});n++}return obs}
g.GM={MAPS,WPN,mkSr,genObs};if(typeof module!=="undefined")module.exports=g.GM;
})(typeof window!=="undefined"?window:globalThis);
