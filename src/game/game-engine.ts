import { COLS, MAZE_A, MAZE_B, ROWS } from './maze';
import { PHYSICS, QuantumState, STATE_GLYPHS } from '../quantum/physics';
import { allocateResources, minimumCostCoordinate } from '../strategy/optimizer';

type Direction = { x: number; y: number; name: 'up' | 'down' | 'left' | 'right' };
type Point = { x: number; y: number };
type Candidate = Point & { weight: number };
type Reinforcement = Point & { brane: number; expires: number };
type Phase = 'ready' | 'playing' | 'paused' | 'gameover' | 'complete';
export type GameTheme = 'classic' | 'halloween' | 'arcade';

const DIRS: Direction[] = [
  { x: 0, y: -1, name: 'up' }, { x: -1, y: 0, name: 'left' },
  { x: 0, y: 1, name: 'down' }, { x: 1, y: 0, name: 'right' },
];
const GHOST_COLORS = ['#66f8e3', '#d8a94d', '#bd78db', '#ff6f72'];
const ARCADE_GHOST_COLORS = ['#ff3030', '#ff8fcf', '#38e8ff', '#ffad32'];
const STARTS: Point[] = [{x:12,y:14},{x:15,y:14},{x:13,y:17},{x:14,y:17}];

class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0 || 0x6d2b79f5; }
  next() { let t = this.state += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }
  pick<T>(items: T[]) { return items[Math.floor(this.next() * items.length)]; }
}

interface Ghost {
  id: number; x: number; y: number; prevX: number; prevY: number; brane: number;
  dir: Direction; state: QuantumState; baseState: QuantumState; candidates: Candidate[];
  observed: boolean; observationMs: number; unobservedMs: number; lastMove: number;
  lastTunnel: number; collapseAt: number; frightenedUntil: number; eaten: boolean;
}

export interface GameSnapshot {
  score: number; highScore: number; lives: number; level: number; dotsLeft: number; observations: number;
  observer: number; brane: number; braneReady: boolean; phase: Phase; muted: boolean; seed: number;
  entropy: number[]; ghosts: Array<{state: QuantumState; observed: boolean; timer: number; frightened: boolean; entropy: number}>;
  strategy: { threat: number; spawn: Point; defense: number; offense: number; reserves: number; reinforcements: number; telemetrySeq: number };
}

export class GameEngine {
  private canvas: HTMLCanvasElement; private ctx: CanvasRenderingContext2D; private rng: SeededRandom;
  private maps = [MAZE_A, MAZE_B]; private dots: Array<Set<string>> = [new Set(), new Set()];
  private player = {x:13,y:23,prevX:13,prevY:23,brane:0,dir:DIRS[1],requested:DIRS[1],lastMove:0,immuneUntil:0};
  private ghosts: Ghost[] = []; private keys = new Set<string>(); private raf = 0; private lastFrame = 0;
  private phase: Phase = 'ready'; private score = 0; private highScore = 0; private lives = 3; private level = 1;
  private observations = 0; private observer = 0; private lastRotate = 0; private lastBraneShift = -9999;
  private muted = false; private audio?: AudioContext; private hum?: OscillatorNode; private humGain?: GainNode;
  private shakeUntil = 0; private entropyHistory = Array.from({length: 30}, () => .3);
  private onUpdate: (snapshot: GameSnapshot) => void; private lastUi = 0; private touch?: Point;
  private resourcePool = 100; private defenseAllocation = 50; private offenseAllocation = 50;
  private reinforcements: Reinforcement[] = []; private lastTelemetryParse = 0; private telemetrySeq = 0;
  private threatScore = 0; private optimalSpawn: Point = {x:13,y:23};
  private theme: GameTheme = 'classic';

  constructor(canvas: HTMLCanvasElement, seed: number, onUpdate: (snapshot: GameSnapshot) => void) {
    this.canvas = canvas; const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas unavailable'); this.ctx = ctx;
    this.rng = new SeededRandom(seed); this.onUpdate = onUpdate;
    this.highScore = Number(localStorage.getItem('pacman4d-high-score') || 0);
    this.muted = localStorage.getItem('pacman4d-muted') === 'true';
    this.seed = seed; this.resetDots(); this.spawnGhosts(); this.bind(); this.resize(); this.raf = requestAnimationFrame(this.loop);
  }
  readonly seed: number;

  private resetDots() {
    this.dots = this.maps.map(map => { const set = new Set<string>(); map.forEach((row,y)=>[...row].forEach((c,x)=>{if(c==='.'||c==='o')set.add(`${x},${y}`);})); return set; });
  }
  private spawnGhosts() {
    const states = [QuantumState.SUPERPOSITION, QuantumState.ENTANGLED, QuantumState.TUNNELING, QuantumState.DECOHERED];
    this.ghosts = STARTS.map((p,id) => ({id,x:p.x,y:p.y,prevX:p.x,prevY:p.y,brane:id===2?1:0,dir:DIRS[id%4],state:states[id],baseState:states[id],candidates:[],observed:false,observationMs:0,unobservedMs:0,lastMove:0,lastTunnel:-9999,collapseAt:0,frightenedUntil:0,eaten:false}));
    this.ghosts.forEach(g => this.diffuse(g));
  }
  private bind() {
    window.addEventListener('keydown', this.keydown); window.addEventListener('keyup', this.keyup); window.addEventListener('resize', this.resize);
    this.canvas.addEventListener('touchstart', this.touchStart, {passive:true}); this.canvas.addEventListener('touchend', this.touchEnd, {passive:true});
  }
  destroy() { cancelAnimationFrame(this.raf); window.removeEventListener('keydown',this.keydown); window.removeEventListener('keyup',this.keyup); window.removeEventListener('resize',this.resize); this.canvas.removeEventListener('touchstart',this.touchStart); this.canvas.removeEventListener('touchend',this.touchEnd); this.stopHum(); }
  start = () => { if (this.phase==='gameover'||this.phase==='complete') this.restart(); this.phase='playing'; this.lastFrame=performance.now(); this.initAudio(); this.emit(true); };
  togglePause = () => { if(this.phase==='playing')this.phase='paused'; else if(this.phase==='paused')this.phase='playing'; this.emit(true); };
  toggleMute = () => { this.muted=!this.muted; localStorage.setItem('pacman4d-muted',String(this.muted)); if(this.muted)this.stopHum();else this.initAudio();this.emit(true); };
  setTheme = (theme:GameTheme) => { const wasArcade=this.theme==='arcade';this.theme=theme;if(theme==='arcade'){this.player.brane=0;this.reinforcements=[];this.ghosts.forEach(g=>g.brane=0);}else if(wasArcade)this.spawnGhosts();this.emit(true); };
  restart = () => { this.score=0;this.lives=3;this.level=1;this.observations=0;this.resourcePool=100;this.defenseAllocation=50;this.offenseAllocation=50;this.reinforcements=[];this.player={x:13,y:23,prevX:13,prevY:23,brane:0,dir:DIRS[1],requested:DIRS[1],lastMove:0,immuneUntil:0};this.resetDots();this.spawnGhosts();this.phase='playing';this.lastRotate=performance.now();this.emit(true); };
  shiftBrane = () => { const now=performance.now(); if(this.theme==='arcade'||this.phase!=='playing'||now-this.lastBraneShift<PHYSICS.braneShiftCooldownMs)return;this.player.brane=1-this.player.brane; if(this.isWall(this.player.x,this.player.y,this.player.brane))this.player.brane=1-this.player.brane;else{this.lastBraneShift=now;this.player.immuneUntil=now+PHYSICS.braneImmunityMs;this.sfx('shift');}this.emit(true); };
  setDirection(name: Direction['name']) { const d=DIRS.find(v=>v.name===name);if(d)this.player.requested=d; }

  private keydown = (e: KeyboardEvent) => {
    const names:Record<string,Direction['name']>={ArrowUp:'up',w:'up',W:'up',ArrowDown:'down',s:'down',S:'down',ArrowLeft:'left',a:'left',A:'left',ArrowRight:'right',d:'right',D:'right'};
    if(names[e.key]){e.preventDefault();this.setDirection(names[e.key]);}
    if(e.key===' '){e.preventDefault();this.shiftBrane();} if(e.key==='Enter'&&this.phase!=='playing')this.start(); if(e.key==='p'||e.key==='P'||e.key==='Escape')this.togglePause(); this.keys.add(e.key);
  };
  private keyup = (e: KeyboardEvent) => { this.keys.delete(e.key); };
  private touchStart = (e: TouchEvent) => {const t=e.changedTouches[0];this.touch={x:t.clientX,y:t.clientY};};
  private touchEnd = (e: TouchEvent) => {if(!this.touch)return;const t=e.changedTouches[0],dx=t.clientX-this.touch.x,dy=t.clientY-this.touch.y;if(Math.hypot(dx,dy)<24){this.shiftBrane();return;}this.setDirection(Math.abs(dx)>Math.abs(dy)?dx>0?'right':'left':dy>0?'down':'up');};
  private resize = () => { const rect=this.canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);this.canvas.width=Math.max(1,rect.width*dpr);this.canvas.height=Math.max(1,rect.height*dpr);this.ctx.setTransform(dpr,0,0,dpr,0,0); };

  private loop = (now:number) => { const dt=Math.min(50,now-(this.lastFrame||now));this.lastFrame=now;if(this.phase==='playing')this.update(now,dt);this.draw(now);if(now-this.lastUi>100){this.emit();this.lastUi=now;}this.raf=requestAnimationFrame(this.loop); };
  private update(now:number,dt:number) {
    const offenseBoost = 1 - Math.min(.22, this.offenseAllocation / 450);
    if(now-this.player.lastMove>PHYSICS.playerStepMs*offenseBoost)this.movePlayer(now);
    if(now-this.lastRotate>PHYSICS.stateRotationMs){this.rotateStates();this.lastRotate=now;}
    this.ghosts.forEach(g=>{this.observe(g,dt,now);const step=g.state===QuantumState.SUPERPOSITION?PHYSICS.superpositionStepMs:PHYSICS.ghostStepMs/(g.state===QuantumState.DECOHERED?PHYSICS.decoheredSpeedMultiplier:1);if(now-g.lastMove>step)this.moveGhost(g,now);});
    this.resolveEntanglement(); this.checkCollisions(now); this.parseAdaptiveTelemetry(now,dt); this.updateHum();
    const nearest=this.nearestGhost(); const ent=nearest?this.entropy(nearest):0;this.entropyHistory.push(ent);if(this.entropyHistory.length>30)this.entropyHistory.shift();
  }
  private movePlayer(now:number) {
    const p=this.player; if(this.canMove(p.x,p.y,p.requested,p.brane))p.dir=p.requested;if(this.canMove(p.x,p.y,p.dir,p.brane)){p.prevX=p.x;p.prevY=p.y;p.x=this.wrapX(p.x+p.dir.x);p.y+=p.dir.y;}
    p.lastMove=now; const key=`${p.x},${p.y}`;if(this.dots[p.brane].has(key)){this.dots[p.brane].delete(key);const pellet=this.maps[p.brane][p.y][p.x]==='o';const multiplier=1+Math.floor(this.offenseAllocation/40)*.25;this.score+=Math.round((pellet?50:10)*multiplier);if(pellet){this.ghosts.forEach(g=>{g.state=QuantumState.DECOHERED;g.frightenedUntil=now+PHYSICS.powerPelletMs;g.observationMs=0;});this.sfx('power');}this.saveScore();}
    if((this.theme==='arcade'?this.dots[0].size:this.dots[0].size+this.dots[1].size)===0){this.phase='complete';this.sfx('complete');}
  }
  private moveGhost(g:Ghost,now:number) {
    g.lastMove=now;if(g.eaten){g.eaten=false;g.x=STARTS[g.id].x;g.y=STARTS[g.id].y;g.brane=g.id===2?1:0;}
    if(g.state===QuantumState.SUPERPOSITION){this.diffuse(g);const c=this.weighted(g.candidates);g.prevX=g.x;g.prevY=g.y;g.x=c.x;g.y=c.y;return;}
    if(g.state===QuantumState.ENTANGLED)return;
    const frightened=now<g.frightenedUntil; const choices=DIRS.filter(d=>this.canGhostMove(g,d,now)); if(!choices.length)return;
    const target=frightened?{x:COLS-1-this.player.x,y:ROWS-1-this.player.y}:this.player;
    const scored=choices.map(d=>({d,score:Math.abs(this.wrapDistance(this.wrapX(g.x+d.x),target.x))+Math.abs(g.y+d.y-target.y)+(d.x===-g.dir.x&&d.y===-g.dir.y?2:0)+this.rng.next()*.35}));
    scored.sort((a,b)=>a.score-b.score);const choice=frightened?this.rng.pick(choices):scored[0].d;g.dir=choice;g.prevX=g.x;g.prevY=g.y;
    const nx=this.wrapX(g.x+choice.x),ny=g.y+choice.y;if(this.isWall(nx,ny,g.brane)&&g.state===QuantumState.TUNNELING&&now-g.lastTunnel>PHYSICS.tunnelCooldownMs&&this.rng.next()<PHYSICS.tunnelProbability&&nx>0&&nx<COLS-1&&ny>0&&ny<ROWS-1){const bx=this.wrapX(nx+choice.x),by=ny+choice.y;if(!this.isWall(bx,by,g.brane)){g.x=bx;g.y=by;g.lastTunnel=now;this.sfx('tunnel');}}else if(!this.isWall(nx,ny,g.brane)){g.x=nx;g.y=ny;}
    if(g.state===QuantumState.TUNNELING&&this.rng.next()<.06)g.brane=1-g.brane;
  }
  private observe(g:Ghost,dt:number,now:number) {
    const visible=g.brane===this.player.brane&&this.inSight(g)&&this.lineClear(this.player,g);g.observed=visible;
    if(visible){g.observationMs+=dt;g.unobservedMs=0;this.observer=Math.min(100,this.observer+dt*.055);if(g.state===QuantumState.SUPERPOSITION&&g.observationMs>160){const c=this.weighted(g.candidates);g.x=c.x;g.y=c.y;g.state=QuantumState.DECOHERED;g.collapseAt=now;g.observationMs=0;this.observations++;this.sfx('collapse');}if(g.state===QuantumState.ENTANGLED&&g.observationMs>PHYSICS.sustainedObservationMs){const pair=this.ghosts[g.id%2===0?g.id+1:g.id-1];g.state=QuantumState.DECOHERED;pair.state=QuantumState.DECOHERED;g.collapseAt=pair.collapseAt=now;g.observationMs=pair.observationMs=0;this.observations+=2;this.sfx('entangle');}}
    else{g.observationMs=0;g.unobservedMs+=dt;this.observer=Math.max(0,this.observer-dt*.012);if(g.state===QuantumState.DECOHERED&&now>=g.frightenedUntil&&g.unobservedMs>PHYSICS.unobservedDecayMs){g.state=QuantumState.SUPERPOSITION;g.unobservedMs=0;this.diffuse(g);}}
  }
  private resolveEntanglement() { for(const id of [0,2]){const a=this.ghosts[id],b=this.ghosts[id+1];if(!a||!b)continue;const entangled=a.state===QuantumState.ENTANGLED?a:b.state===QuantumState.ENTANGLED?b:null;if(!entangled)continue;const anchor=entangled===a?b:a;const target={x:COLS-1-anchor.x,y:anchor.y};const safe=this.nearestOpen(target.x,target.y,entangled.brane);entangled.prevX=entangled.x;entangled.prevY=entangled.y;entangled.x=safe.x;entangled.y=safe.y;entangled.dir={...anchor.dir,x:-anchor.dir.x,name:anchor.dir.name==='left'?'right':anchor.dir.name==='right'?'left':anchor.dir.name};} }
  private diffuse(g:Ghost) { const result:Candidate[]=[];let cursor={x:g.x,y:g.y};for(let i=0;i<4;i++){const options=DIRS.filter(d=>!this.isWall(this.wrapX(cursor.x+d.x),cursor.y+d.y,g.brane));if(options.length){const d=this.rng.pick(options);cursor={x:this.wrapX(cursor.x+d.x),y:cursor.y+d.y};}result.push({...cursor,weight:.2+this.rng.next()});}const sum=result.reduce((s,c)=>s+c.weight,0);g.candidates=result.map(c=>({...c,weight:c.weight/sum})); }
  private weighted(candidates:Candidate[]) {let n=this.rng.next();for(const c of candidates){n-=c.weight;if(n<=0)return c;}return candidates[0]||{x:13,y:14,weight:1};}
  private rotateStates(){const cycle=[QuantumState.SUPERPOSITION,QuantumState.ENTANGLED,QuantumState.TUNNELING,QuantumState.DECOHERED];this.ghosts.forEach(g=>{const i=cycle.indexOf(g.baseState);g.baseState=cycle[(i+1)%cycle.length];g.state=g.baseState;g.unobservedMs=0;if(g.state===QuantumState.SUPERPOSITION)this.diffuse(g);});this.sfx('rotate');}
  private parseAdaptiveTelemetry(now:number,dt:number){
    this.resourcePool=Math.min(100,this.resourcePool+dt*.0035);
    this.reinforcements=this.reinforcements.filter(r=>r.expires>now);
    if(now-this.lastTelemetryParse<750)return;
    this.lastTelemetryParse=now;this.telemetrySeq++;
    const packet=JSON.stringify({sequence:this.telemetrySeq,player:{x:this.player.x,y:this.player.y,brane:this.player.brane},ghosts:this.ghosts.map(g=>({x:g.x,y:g.y,brane:g.brane,state:g.state,dx:g.dir.x,dy:g.dir.y})),resources:this.resourcePool});
    const telemetry=JSON.parse(packet) as {player:Point&{brane:number};ghosts:Array<Point&{brane:number;state:QuantumState;dx:number;dy:number}>};
    this.threatScore=Math.min(100,Math.round(this.evaluateThreatAt(telemetry.player,telemetry.player.brane)*11));
    const allocation=allocateResources(this.threatScore);this.defenseAllocation=allocation.defense;this.offenseAllocation=allocation.offense;
    this.optimalSpawn=this.findOptimalSpawn(telemetry.player.brane);
    if(this.theme==='arcade')return;
    if(this.threatScore>42&&this.resourcePool>=16&&this.reinforcements.length<3){
      const closest=telemetry.ghosts.filter(g=>g.brane===telemetry.player.brane).sort((a,b)=>Math.hypot(a.x-telemetry.player.x,a.y-telemetry.player.y)-Math.hypot(b.x-telemetry.player.x,b.y-telemetry.player.y))[0];
      if(closest){const candidates=DIRS.map(d=>({x:this.wrapX(closest.x+d.x),y:closest.y+d.y})).filter(p=>!this.isWall(p.x,p.y,closest.brane)&&!(p.x===this.player.x&&p.y===this.player.y));const breach=candidates.sort((a,b)=>Math.hypot(a.x-this.player.x,a.y-this.player.y)-Math.hypot(b.x-this.player.x,b.y-this.player.y))[0];if(breach&&!this.reinforcements.some(r=>r.x===breach.x&&r.y===breach.y&&r.brane===closest.brane)){this.reinforcements.push({...breach,brane:closest.brane,expires:now+3800});this.resourcePool-=16;this.sfx('reinforce');}}
    }
  }
  private evaluateThreatAt(point:Point,brane:number){let threat=0;for(const g of this.ghosts){if(g.brane!==brane)continue;const weight=g.state===QuantumState.DECOHERED?1.55:g.state===QuantumState.TUNNELING?1.25:g.state===QuantumState.SUPERPOSITION?.78:1.05;for(let step=0;step<4;step++){const px=this.wrapX(g.x+g.dir.x*step),py=g.y+g.dir.y*step;const distance=Math.max(1,this.wrapDistance(px,point.x)+Math.abs(py-point.y));threat+=weight*(4-step)/distance;}}const exits=DIRS.filter(d=>!this.isWall(this.wrapX(point.x+d.x),point.y+d.y,brane)).length;return Math.max(0,threat+(3-exits)*1.4);}
  private findOptimalSpawn(brane:number){const candidates:Point[]=[];for(let y=1;y<ROWS-1;y++)for(let x=1;x<COLS-1;x++){if(this.isWall(x,y,brane)||(x>9&&x<18&&y>10&&y<19))continue;const exits=DIRS.filter(d=>!this.isWall(this.wrapX(x+d.x),y+d.y,brane)).length;if(exits>=2)candidates.push({x,y});}return minimumCostCoordinate(candidates,point=>{const nearbyDots=DIRS.filter(d=>this.dots[brane].has(`${this.wrapX(point.x+d.x)},${point.y+d.y}`)).length;const resourceCost=Math.abs(point.x-13)*.035+Math.abs(point.y-23)*.025;return this.evaluateThreatAt(point,brane)*10+resourceCost-nearbyDots*.45;})||{x:13,y:23};}
  private checkCollisions(now:number){if(now<this.player.immuneUntil)return;for(const g of this.ghosts){if(g.brane!==this.player.brane||Math.abs(g.x-this.player.x)+Math.abs(g.y-this.player.y)>0)continue;if(now<g.frightenedUntil){g.eaten=true;g.frightenedUntil=0;this.score+=Math.round(200*(1+this.offenseAllocation/200));this.saveScore();this.sfx('eat');}else{this.lives--;this.shakeUntil=now+180;this.sfx('hit');if(this.lives<=0){this.phase='gameover';this.stopHum();}else{const spawn=this.findOptimalSpawn(this.player.brane);this.optimalSpawn=spawn;this.player.x=this.player.prevX=spawn.x;this.player.y=this.player.prevY=spawn.y;this.player.immuneUntil=now+900;this.spawnGhosts();}}}}
  // The spectral gate (`=`) is a visual threshold, not a collision wall. Keeping
  // it walkable gives Pacman and the ghosts a clear route through the house.
  private isWall(x:number,y:number,brane:number){if(y<0||y>=ROWS)return true;return this.maps[brane][y][x]==='#';}
  private canMove(x:number,y:number,d:Direction,brane:number){return !this.isWall(this.wrapX(x+d.x),y+d.y,brane);}
  private canGhostMove(g:Ghost,d:Direction,now:number){const nx=this.wrapX(g.x+d.x),ny=g.y+d.y;if(!this.isGhostBlocked(nx,ny,g.brane,now))return true;return g.state===QuantumState.TUNNELING&&now-g.lastTunnel>PHYSICS.tunnelCooldownMs&&nx>0&&nx<COLS-1&&ny>0&&ny<ROWS-1;}
  private isGhostBlocked(x:number,y:number,brane:number,now:number){return this.isWall(x,y,brane)||this.reinforcements.some(r=>r.brane===brane&&r.x===x&&r.y===y&&r.expires>now);}
  private wrapX(x:number){return(x+COLS)%COLS;} private wrapDistance(a:number,b:number){const d=Math.abs(a-b);return Math.min(d,COLS-d);}
  private nearestOpen(x:number,y:number,brane:number){if(!this.isWall(x,y,brane))return{x,y};for(let r=1;r<8;r++)for(const d of DIRS){const nx=this.wrapX(x+d.x*r),ny=Math.max(0,Math.min(ROWS-1,y+d.y*r));if(!this.isWall(nx,ny,brane))return{x:nx,y:ny};}return{x:13,y:14};}
  private inSight(g:Ghost){const dx=this.wrapDistanceSigned(this.player.x,g.x),dy=g.y-this.player.y,len=Math.hypot(dx,dy);if(len<.1||len>11)return len<1;return(dx*this.player.dir.x+dy*this.player.dir.y)/len>=PHYSICS.observationConeCosine;}
  private wrapDistanceSigned(a:number,b:number){let d=b-a;if(d>COLS/2)d-=COLS;if(d<-COLS/2)d+=COLS;return d;}
  private lineClear(a:Point,b:Point){let x=a.x,y=a.y;const dx=this.wrapDistanceSigned(a.x,b.x),dy=b.y-a.y,steps=Math.ceil(Math.max(Math.abs(dx),Math.abs(dy)));for(let i=1;i<steps;i++){x=a.x+Math.round(dx*i/steps);y=a.y+Math.round(dy*i/steps);if(this.isWall(this.wrapX(x),y,this.player.brane))return false;}return true;}
  private nearestGhost(){return this.ghosts.filter(g=>g.brane===this.player.brane).sort((a,b)=>(Math.abs(a.x-this.player.x)+Math.abs(a.y-this.player.y))-(Math.abs(b.x-this.player.x)+Math.abs(b.y-this.player.y)))[0];}
  private entropy(g:Ghost){if(g.state!==QuantumState.SUPERPOSITION)return .05;return Math.min(1,-g.candidates.reduce((s,c)=>s+c.weight*Math.log2(c.weight),0)/2);}
  private saveScore(){if(this.score>this.highScore){this.highScore=this.score;localStorage.setItem('pacman4d-high-score',String(this.highScore));}}

  private initAudio(){if(this.muted||this.audio)return;this.audio=new AudioContext();this.hum=this.audio.createOscillator();this.humGain=this.audio.createGain();this.hum.type='sine';this.hum.frequency.value=48;this.humGain.gain.value=.012;this.hum.connect(this.humGain).connect(this.audio.destination);this.hum.start();}
  private stopHum(){try{this.hum?.stop();}catch{}this.audio?.close();this.audio=undefined;this.hum=undefined;this.humGain=undefined;}
  private updateHum(){if(!this.humGain)return;const density=this.ghosts.filter(g=>g.state===QuantumState.SUPERPOSITION).length/4;this.humGain.gain.setTargetAtTime(this.muted?0:.006+density*.018,this.audio!.currentTime,.1);this.hum!.frequency.setTargetAtTime(42+density*25,this.audio!.currentTime,.1);}
  private sfx(kind:string){if(this.muted)return;this.initAudio();const a=this.audio;if(!a)return;const o=a.createOscillator(),g=a.createGain();const now=a.currentTime;const map:Record<string,[number,number,string]>={collapse:[980,.08,'square'],power:[330,.35,'sine'],entangle:[440,.3,'triangle'],shift:[130,.16,'sine'],tunnel:[180,.12,'sawtooth'],eat:[740,.09,'square'],hit:[70,.3,'sawtooth'],complete:[660,.6,'triangle'],rotate:[260,.25,'sine'],reinforce:[520,.14,'triangle']};const [freq,dur,type]=map[kind]||[300,.08,'sine'];o.type=type as OscillatorType;o.frequency.setValueAtTime(freq,now);o.frequency.exponentialRampToValueAtTime(Math.max(40,freq*(kind==='hit'?.35:1.45)),now+dur);g.gain.setValueAtTime(.08,now);g.gain.exponentialRampToValueAtTime(.001,now+dur);o.connect(g).connect(a.destination);o.start();o.stop(now+dur);}

  private emit(force=false){if(!force&&this.lastUi===0)return;const now=performance.now();this.onUpdate({score:this.score,highScore:this.highScore,lives:this.lives,level:this.level,dotsLeft:this.theme==='arcade'?this.dots[0].size:this.dots[0].size+this.dots[1].size,observations:this.observations,observer:this.observer,brane:this.player.brane,braneReady:now-this.lastBraneShift>=PHYSICS.braneShiftCooldownMs,phase:this.phase,muted:this.muted,seed:this.seed,entropy:[...this.entropyHistory],ghosts:this.ghosts.map(g=>({state:g.state,observed:g.observed,timer:g.state===QuantumState.DECOHERED?Math.max(0,PHYSICS.unobservedDecayMs-g.unobservedMs):0,frightened:now<g.frightenedUntil,entropy:this.entropy(g)})),strategy:{threat:this.threatScore,spawn:{...this.optimalSpawn},defense:this.defenseAllocation,offense:this.offenseAllocation,reserves:Math.round(this.resourcePool),reinforcements:this.reinforcements.length,telemetrySeq:this.telemetrySeq}});}

  private draw(now:number){const rect=this.canvas.getBoundingClientRect(),w=rect.width,h=rect.height,ctx=this.ctx,haunted=this.theme==='halloween',arcade=this.theme==='arcade';ctx.save();if(now<this.shakeUntil)ctx.translate((this.rng.next()-.5)*8,(this.rng.next()-.5)*8);ctx.clearRect(-20,-20,w+40,h+40);const bg=ctx.createRadialGradient(w*.48,h*.42,0,w*.5,h*.5,Math.max(w,h)*.7);bg.addColorStop(0,arcade?'#000':haunted?'#171129':'#0c1720');bg.addColorStop(.5,arcade?'#000':haunted?'#090b18':'#070d13');bg.addColorStop(1,arcade?'#000':haunted?'#020306':'#030507');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);const tile=Math.min((w-40)/COLS,(h-28)/ROWS),ox=(w-tile*COLS)/2,oy=(h-tile*ROWS)/2;if(haunted)this.drawHauntedAtmosphere(w,h,now);if(!arcade){this.drawThreatField(tile,ox,oy);this.drawMaze(1-this.player.brane,tile,ox+tile*.32,oy+tile*.38,.12);}this.drawMaze(this.player.brane,tile,ox,oy,1);if(haunted)this.drawGhostHouse(tile,ox,oy,now);if(!arcade){this.drawReinforcements(tile,ox,oy,now);this.drawSight(tile,ox,oy);}
    for(const g of this.ghosts)if(g.brane===this.player.brane)this.drawGhost(g,tile,ox,oy,now);this.drawPlayer(tile,ox,oy,now);ctx.restore();}
  private drawMaze(brane:number,t:number,ox:number,oy:number,alpha:number){if(this.theme==='arcade'){this.drawArcadeMaze(brane,t,ox,oy);return;}const ctx=this.ctx,depth=t*.2,haunted=this.theme==='halloween';ctx.save();ctx.globalAlpha=alpha;ctx.lineWidth=Math.max(.7,t*.055);const stroke=brane===0?(haunted?'rgba(219,146,255,.86)':'rgba(221,178,87,.86)'):'rgba(105,226,213,.72)';ctx.strokeStyle=stroke;ctx.shadowBlur=alpha>.5?(haunted?8:7):0;ctx.shadowColor=stroke;this.maps[brane].forEach((row,y)=>[...row].forEach((c,x)=>{if(c==='#'){const px=ox+x*t+t*.12,py=oy+y*t+t*.12,w=t*.76,h=t*.76;ctx.fillStyle=brane===0?(haunted?'rgba(43,24,57,.88)':'rgba(58,42,17,.76)'):'rgba(17,52,55,.65)';ctx.beginPath();ctx.moveTo(px+w,py);ctx.lineTo(px+w+depth,py+depth);ctx.lineTo(px+w+depth,py+h+depth);ctx.lineTo(px+w,py+h);ctx.closePath();ctx.fill();ctx.fillStyle=brane===0?(haunted?'rgba(126,59,148,.26)':'rgba(128,92,30,.22)'):'rgba(38,118,116,.18)';ctx.fillRect(px+depth,py+depth,w,h);ctx.strokeRect(px,py,w,h);ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(px+depth,py+depth);ctx.lineTo(px+w+depth,py+depth);ctx.lineTo(px+w,py);ctx.stroke();}else if(this.dots[brane].has(`${x},${y}`)){const px=ox+(x+.5)*t,py=oy+(y+.55)*t;if(c==='o'&&haunted){this.drawPumpkin(px,py,t);}else{ctx.fillStyle=c==='o'?'#e9c875':'#72f6e5';ctx.shadowBlur=c==='o'?12:5;ctx.beginPath();ctx.ellipse(px,py,c==='o'?t*.19:Math.max(1,t*.06),c==='o'?t*.13:Math.max(.7,t*.035),0,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;}}}));ctx.restore();}
  private drawArcadeMaze(brane:number,t:number,ox:number,oy:number){const ctx=this.ctx;ctx.save();ctx.lineWidth=Math.max(1.2,t*.09);ctx.strokeStyle='#2364ff';ctx.shadowBlur=6;ctx.shadowColor='#003cff';this.maps[brane].forEach((row,y)=>[...row].forEach((c,x)=>{const px=ox+x*t,py=oy+y*t;if(c==='#'){ctx.fillStyle='#071967';ctx.fillRect(px+t*.08,py+t*.08,t*.84,t*.84);ctx.strokeRect(px+t*.13,py+t*.13,t*.74,t*.74);}else if(this.dots[brane].has(`${x},${y}`)){ctx.shadowBlur=c==='o'?9:2;ctx.shadowColor='#fff';ctx.fillStyle='#fff4dc';ctx.beginPath();ctx.arc(px+t*.5,py+t*.52,c==='o'?t*.18:Math.max(1,t*.055),0,Math.PI*2);ctx.fill();ctx.shadowBlur=6;ctx.shadowColor='#003cff';}}));ctx.restore();}
  private drawPumpkin(x:number,y:number,t:number){const ctx=this.ctx;ctx.save();ctx.shadowBlur=13;ctx.shadowColor='#ff7a18';ctx.fillStyle='#f37a21';ctx.beginPath();ctx.ellipse(x,y,t*.22,t*.17,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#8f3515';ctx.lineWidth=Math.max(.6,t*.035);for(const offset of [-.09,.09]){ctx.beginPath();ctx.ellipse(x+offset*t,y,t*.095,t*.16,0,Math.PI/2,Math.PI*1.5);ctx.stroke();}ctx.shadowBlur=0;ctx.strokeStyle='#79a84a';ctx.beginPath();ctx.moveTo(x,y-t*.16);ctx.lineTo(x+t*.04,y-t*.25);ctx.stroke();ctx.fillStyle='#2b1107';ctx.beginPath();ctx.moveTo(x-t*.12,y-t*.035);ctx.lineTo(x-t*.04,y-t*.085);ctx.lineTo(x-t*.035,y+t*.015);ctx.closePath();ctx.moveTo(x+t*.12,y-t*.035);ctx.lineTo(x+t*.04,y-t*.085);ctx.lineTo(x+t*.035,y+t*.015);ctx.closePath();ctx.fill();ctx.restore();}
  private drawHauntedAtmosphere(w:number,h:number,now:number){const ctx=this.ctx;ctx.save();const moon=ctx.createRadialGradient(w*.84,h*.12,1,w*.84,h*.12,w*.12);moon.addColorStop(0,'rgba(221,218,255,.3)');moon.addColorStop(.2,'rgba(146,125,190,.12)');moon.addColorStop(1,'rgba(80,45,105,0)');ctx.fillStyle=moon;ctx.fillRect(0,0,w,h);ctx.strokeStyle='rgba(170,135,194,.13)';ctx.lineWidth=1;for(const side of [-1,1]){const baseX=side<0?w*.035:w*.965;ctx.beginPath();ctx.moveTo(baseX,h);ctx.quadraticCurveTo(baseX-side*w*.01,h*.6,baseX-side*w*.045,h*.3);ctx.moveTo(baseX-side*w*.025,h*.52);ctx.lineTo(baseX-side*w*.09,h*.42);ctx.moveTo(baseX-side*w*.04,h*.63);ctx.lineTo(baseX-side*w*.12,h*.56);ctx.stroke();}for(let i=0;i<4;i++){const y=h*(.22+i*.19)+Math.sin(now*.00035+i)*12;const fog=ctx.createLinearGradient(0,y,w,y);fog.addColorStop(0,'rgba(127,92,150,0)');fog.addColorStop(.5,`rgba(127,92,150,${.022+i*.004})`);fog.addColorStop(1,'rgba(127,92,150,0)');ctx.fillStyle=fog;ctx.fillRect(0,y,w,h*.08);}ctx.restore();}
  private drawGhostHouse(t:number,ox:number,oy:number,now:number){const ctx=this.ctx,left=ox+10.2*t,right=ox+17.8*t,top=oy+11.05*t,bottom=oy+16.05*t,cx=(left+right)/2,pulse=.72+Math.sin(now*.004)*.18;ctx.save();ctx.fillStyle='rgba(8,3,14,.7)';ctx.strokeStyle=`rgba(214,125,255,${pulse})`;ctx.lineWidth=Math.max(1,t*.07);ctx.shadowColor='#b752e5';ctx.shadowBlur=t*.6;ctx.beginPath();ctx.moveTo(left,top+t*1.4);ctx.lineTo(cx,top-t*.75);ctx.lineTo(right,top+t*1.4);ctx.lineTo(right,bottom);ctx.lineTo(left,bottom);ctx.closePath();ctx.fill();ctx.stroke();ctx.shadowBlur=0;ctx.fillStyle='rgba(245,178,78,.2)';for(const x of [left+t*1.2,right-t*1.75]){ctx.fillRect(x,top+t*1.7,t*.55,t*.72);ctx.strokeRect(x,top+t*1.7,t*.55,t*.72);ctx.beginPath();ctx.moveTo(x+t*.275,top+t*1.7);ctx.lineTo(x+t*.275,top+t*2.42);ctx.moveTo(x,top+t*2.06);ctx.lineTo(x+t*.55,top+t*2.06);ctx.stroke();}ctx.fillStyle='rgba(4,1,8,.78)';ctx.beginPath();ctx.moveTo(cx-t*1.05,bottom);ctx.lineTo(cx-t*.92,top+t*2.2);ctx.quadraticCurveTo(cx,top+t*1.28,cx+t*.92,top+t*2.2);ctx.lineTo(cx+t*1.05,bottom);ctx.closePath();ctx.fill();ctx.strokeStyle=`rgba(255,100,204,${.55+pulse*.3})`;ctx.setLineDash([t*.22,t*.16]);ctx.beginPath();ctx.moveTo(ox+12*t,oy+16.48*t);ctx.lineTo(ox+16*t,oy+16.48*t);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='rgba(235,214,246,.74)';ctx.font=`${Math.max(7,t*.38)}px Georgia`;ctx.textAlign='center';ctx.fillText('SPECTRAL HOUSE',cx,top+t*.62);ctx.fillStyle='rgba(230,218,240,.5)';ctx.font=`${Math.max(6,t*.25)}px Georgia`;ctx.fillText('ENTER',cx,bottom-t*.2);ctx.strokeStyle='rgba(224,210,235,.22)';for(const side of [-1,1]){const x=side<0?left:right;ctx.beginPath();ctx.moveTo(x,top+t*1.38);ctx.lineTo(x+side*t*.9,top+t*.55);ctx.moveTo(x,top+t*1.38);ctx.lineTo(x+side*t*1.05,top+t*1.32);ctx.stroke();}ctx.restore();}
  private drawThreatField(t:number,ox:number,oy:number){const ctx=this.ctx;ctx.save();for(let y=1;y<ROWS-1;y+=2)for(let x=1;x<COLS-1;x+=2){if(this.isWall(x,y,this.player.brane))continue;const risk=Math.min(1,this.evaluateThreatAt({x,y},this.player.brane)/9);if(risk<.12)continue;ctx.fillStyle=`rgba(${Math.round(80+risk*170)},${Math.round(180-risk*125)},70,${risk*.06})`;ctx.fillRect(ox+x*t,oy+y*t,t*2,t*2);}ctx.restore();}
  private drawReinforcements(t:number,ox:number,oy:number,now:number){const ctx=this.ctx;ctx.save();for(const r of this.reinforcements){if(r.brane!==this.player.brane||r.expires<=now)continue;const x=ox+(r.x+.5)*t,y=oy+(r.y+.5)*t,pulse=.55+Math.sin(now*.018+r.x)*.35;ctx.strokeStyle=`rgba(114,246,229,${pulse})`;ctx.shadowBlur=14;ctx.shadowColor='#72f6e5';ctx.lineWidth=1;for(let i=-2;i<=2;i++){ctx.beginPath();ctx.moveTo(x+i*t*.12,y-t*.48);ctx.lineTo(x-i*t*.12,y+t*.42);ctx.stroke();}ctx.strokeRect(x-t*.38,y-t*.42,t*.76,t*.84);}ctx.restore();}
  private drawSight(t:number,ox:number,oy:number){const p=this.player,ctx=this.ctx,x=ox+(p.x+.5)*t,y=oy+(p.y+.5)*t,ang=Math.atan2(p.dir.y,p.dir.x);ctx.save();ctx.fillStyle=`rgba(112,246,229,${.025+this.observer/4000})`;ctx.beginPath();ctx.moveTo(x,y);ctx.arc(x,y,t*10,ang-Math.PI/4,ang+Math.PI/4);ctx.closePath();ctx.fill();ctx.restore();}
  private drawPlayer(t:number,ox:number,oy:number,now:number){const p=this.player,ctx=this.ctx,x=ox+(p.x+.5)*t,y=oy+(p.y+.5)*t;if(this.theme==='halloween'){this.drawSheetGhost(x,y,t,now);return;}const ang=Math.atan2(p.dir.y,p.dir.x),mouth=.16+Math.abs(Math.sin(now*.012))*.22;if(this.theme==='arcade'){ctx.save();ctx.fillStyle='#ffe600';ctx.shadowBlur=8;ctx.shadowColor='#ffe600';ctx.beginPath();ctx.arc(x,y,t*.39,ang+mouth,ang+Math.PI*2-mouth);ctx.lineTo(x,y);ctx.fill();ctx.restore();return;}ctx.save();ctx.fillStyle='rgba(0,0,0,.48)';ctx.beginPath();ctx.ellipse(x+t*.12,y+t*.4,t*.42,t*.16,0,0,Math.PI*2);ctx.fill();ctx.shadowBlur=15;ctx.shadowColor='#e9c875';const gold=ctx.createRadialGradient(x-t*.14,y-t*.18,t*.02,x,y,t*.45);gold.addColorStop(0,'#fff2b3');gold.addColorStop(.32,'#e9c875');gold.addColorStop(1,'#8d641a');ctx.fillStyle=gold;ctx.beginPath();ctx.arc(x,y,t*.38,ang+mouth,ang+Math.PI*2-mouth);ctx.lineTo(x,y);ctx.fill();ctx.restore();}
  private drawSheetGhost(x:number,y:number,t:number,now:number){const ctx=this.ctx,bob=Math.sin(now*.009)*t*.045,pulse=.78+Math.sin(now*.006)*.12;y+=bob;ctx.save();ctx.fillStyle='rgba(0,0,0,.4)';ctx.beginPath();ctx.ellipse(x+t*.08,y+t*.42,t*.42,t*.14,0,0,Math.PI*2);ctx.fill();ctx.shadowBlur=16;ctx.shadowColor=`rgba(222,211,255,${pulse})`;const sheet=ctx.createLinearGradient(x,y-t*.42,x,y+t*.42);sheet.addColorStop(0,'#fffdf5');sheet.addColorStop(.62,'#ddd8e8');sheet.addColorStop(1,'#a79fb7');ctx.fillStyle=sheet;ctx.beginPath();ctx.arc(x,y-t*.08,t*.34,Math.PI,0);ctx.lineTo(x+t*.35,y+t*.34);ctx.quadraticCurveTo(x+t*.22,y+t*.2,x+t*.1,y+t*.36);ctx.quadraticCurveTo(x,y+t*.2,x-t*.1,y+t*.36);ctx.quadraticCurveTo(x-t*.23,y+t*.2,x-t*.35,y+t*.34);ctx.closePath();ctx.fill();ctx.shadowBlur=0;ctx.fillStyle='#17101f';ctx.beginPath();ctx.ellipse(x-t*.12,y-t*.09,t*.055,t*.085,-.1,0,Math.PI*2);ctx.ellipse(x+t*.12,y-t*.09,t*.055,t*.085,.1,0,Math.PI*2);ctx.ellipse(x,y+t*.08,t*.045,t*.065,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='rgba(255,255,255,.6)';ctx.lineWidth=Math.max(.5,t*.025);ctx.beginPath();ctx.arc(x-t*.07,y-t*.2,t*.16,Math.PI*1.1,Math.PI*1.55);ctx.stroke();ctx.restore();}
  private drawGhost(g:Ghost,t:number,ox:number,oy:number,now:number){const ctx=this.ctx;if(this.theme==='arcade'){this.arcadeGhostShape(ox+(g.x+.5)*t,oy+(g.y+.5)*t,t,now<g.frightenedUntil?'#243be8':ARCADE_GHOST_COLORS[g.id],g);return;}const color=GHOST_COLORS[g.id];if(g.state===QuantumState.ENTANGLED){const pair=this.ghosts[g.id%2===0?g.id+1:g.id-1];if(pair?.brane===g.brane){ctx.save();ctx.setLineDash([t*.25,t*.22]);ctx.strokeStyle='rgba(224,185,94,.35)';ctx.beginPath();ctx.moveTo(ox+(g.x+.5)*t,oy+(g.y+.5)*t);ctx.lineTo(ox+(pair.x+.5)*t,oy+(pair.y+.5)*t);ctx.stroke();ctx.restore();}}
    if(g.state===QuantumState.SUPERPOSITION){g.candidates.forEach(c=>this.ghostShape(ox+(c.x+.5)*t,oy+(c.y+.5)*t,t,color,Math.max(.08,c.weight*.95),now,g));return;}this.ghostShape(ox+(g.x+.5)*t,oy+(g.y+.5)*t,t,now<g.frightenedUntil?'#7286e8':color,g.observed?1:.82,now,g);}
  private ghostShape(x:number,y:number,t:number,color:string,alpha:number,now:number,g:Ghost){const ctx=this.ctx,pulse=1+Math.sin(now*.01+g.id)*.04;ctx.save();ctx.globalAlpha=alpha;ctx.shadowBlur=g.state===QuantumState.SUPERPOSITION?20:8;ctx.shadowColor=color;if(g.state===QuantumState.TUNNELING){ctx.setLineDash([2,2]);ctx.globalCompositeOperation='screen';x+=Math.sin(now*.025)*t*.09;}ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,t*.36*pulse,Math.PI,0);ctx.lineTo(x+t*.36,y+t*.34);ctx.lineTo(x+t*.18,y+t*.22);ctx.lineTo(x,y+t*.36);ctx.lineTo(x-t*.18,y+t*.22);ctx.lineTo(x-t*.36,y+t*.34);ctx.closePath();ctx.fill();if(alpha>.5){ctx.shadowBlur=0;ctx.fillStyle='#071018';ctx.beginPath();ctx.arc(x-t*.13,y-t*.04,t*.065,0,Math.PI*2);ctx.arc(x+t*.13,y-t*.04,t*.065,0,Math.PI*2);ctx.fill();ctx.font=`${t*.28}px Georgia`;ctx.fillStyle='rgba(255,255,255,.75)';ctx.textAlign='center';ctx.fillText(STATE_GLYPHS[g.state],x,y+t*.75);}ctx.restore();}
  private arcadeGhostShape(x:number,y:number,t:number,color:string,g:Ghost){const ctx=this.ctx;ctx.save();ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y-t*.05,t*.35,Math.PI,0);ctx.lineTo(x+t*.35,y+t*.32);ctx.lineTo(x+t*.18,y+t*.22);ctx.lineTo(x,y+t*.34);ctx.lineTo(x-t*.18,y+t*.22);ctx.lineTo(x-t*.35,y+t*.32);ctx.closePath();ctx.fill();for(const side of [-1,1]){const ex=x+side*t*.13,ey=y-t*.08;ctx.fillStyle='#fff';ctx.beginPath();ctx.ellipse(ex,ey,t*.09,t*.12,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#1746be';ctx.beginPath();ctx.arc(ex+g.dir.x*t*.025,ey+g.dir.y*t*.025,t*.045,0,Math.PI*2);ctx.fill();}ctx.restore();}
}
