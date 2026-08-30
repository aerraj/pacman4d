import { COLS, MAZE_A, MAZE_B, ROWS } from './maze';
import { PHYSICS, QuantumState, STATE_GLYPHS } from '../quantum/physics';

type Direction = { x: number; y: number; name: 'up' | 'down' | 'left' | 'right' };
type Point = { x: number; y: number };
type Candidate = Point & { weight: number };
type Phase = 'ready' | 'playing' | 'paused' | 'gameover' | 'complete';

const DIRS: Direction[] = [
  { x: 0, y: -1, name: 'up' }, { x: -1, y: 0, name: 'left' },
  { x: 0, y: 1, name: 'down' }, { x: 1, y: 0, name: 'right' },
];
const GHOST_COLORS = ['#66f8e3', '#d8a94d', '#bd78db', '#ff6f72'];
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
  restart = () => { this.score=0;this.lives=3;this.level=1;this.observations=0;this.player={x:13,y:23,prevX:13,prevY:23,brane:0,dir:DIRS[1],requested:DIRS[1],lastMove:0,immuneUntil:0};this.resetDots();this.spawnGhosts();this.phase='playing';this.lastRotate=performance.now();this.emit(true); };
  shiftBrane = () => { const now=performance.now(); if(this.phase!=='playing'||now-this.lastBraneShift<PHYSICS.braneShiftCooldownMs)return;this.player.brane=1-this.player.brane; if(this.isWall(this.player.x,this.player.y,this.player.brane))this.player.brane=1-this.player.brane;else{this.lastBraneShift=now;this.player.immuneUntil=now+PHYSICS.braneImmunityMs;this.sfx('shift');}this.emit(true); };
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
    if(now-this.player.lastMove>PHYSICS.playerStepMs)this.movePlayer(now);
    if(now-this.lastRotate>PHYSICS.stateRotationMs){this.rotateStates();this.lastRotate=now;}
    this.ghosts.forEach(g=>{this.observe(g,dt,now);const step=g.state===QuantumState.SUPERPOSITION?PHYSICS.superpositionStepMs:PHYSICS.ghostStepMs/(g.state===QuantumState.DECOHERED?PHYSICS.decoheredSpeedMultiplier:1);if(now-g.lastMove>step)this.moveGhost(g,now);});
    this.resolveEntanglement(); this.checkCollisions(now); this.updateHum();
    const nearest=this.nearestGhost(); const ent=nearest?this.entropy(nearest):0;this.entropyHistory.push(ent);if(this.entropyHistory.length>30)this.entropyHistory.shift();
  }
  private movePlayer(now:number) {
    const p=this.player; if(this.canMove(p.x,p.y,p.requested,p.brane))p.dir=p.requested;if(this.canMove(p.x,p.y,p.dir,p.brane)){p.prevX=p.x;p.prevY=p.y;p.x=this.wrapX(p.x+p.dir.x);p.y+=p.dir.y;}
    p.lastMove=now; const key=`${p.x},${p.y}`;if(this.dots[p.brane].has(key)){this.dots[p.brane].delete(key);const pellet=this.maps[p.brane][p.y][p.x]==='o';this.score+=pellet?50:10;if(pellet){this.ghosts.forEach(g=>{g.state=QuantumState.DECOHERED;g.frightenedUntil=now+PHYSICS.powerPelletMs;g.observationMs=0;});this.sfx('power');}this.saveScore();}
    if(this.dots[0].size+this.dots[1].size===0){this.phase='complete';this.sfx('complete');}
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
  private checkCollisions(now:number){if(now<this.player.immuneUntil)return;for(const g of this.ghosts){if(g.brane!==this.player.brane||Math.abs(g.x-this.player.x)+Math.abs(g.y-this.player.y)>0)continue;if(now<g.frightenedUntil){g.eaten=true;g.frightenedUntil=0;this.score+=200;this.saveScore();this.sfx('eat');}else{this.lives--;this.shakeUntil=now+180;this.sfx('hit');if(this.lives<=0){this.phase='gameover';this.stopHum();}else{this.player.x=this.player.prevX=13;this.player.y=this.player.prevY=23;this.player.brane=0;this.spawnGhosts();}}}}
  private isWall(x:number,y:number,brane:number){if(y<0||y>=ROWS)return true;return this.maps[brane][y][x]==='#'||this.maps[brane][y][x]==='=';}
  private canMove(x:number,y:number,d:Direction,brane:number){return !this.isWall(this.wrapX(x+d.x),y+d.y,brane);}
  private canGhostMove(g:Ghost,d:Direction,now:number){const nx=this.wrapX(g.x+d.x),ny=g.y+d.y;if(!this.isWall(nx,ny,g.brane))return true;return g.state===QuantumState.TUNNELING&&now-g.lastTunnel>PHYSICS.tunnelCooldownMs&&nx>0&&nx<COLS-1&&ny>0&&ny<ROWS-1;}
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
  private sfx(kind:string){if(this.muted)return;this.initAudio();const a=this.audio;if(!a)return;const o=a.createOscillator(),g=a.createGain();const now=a.currentTime;const map:Record<string,[number,number,string]>={collapse:[980,.08,'square'],power:[330,.35,'sine'],entangle:[440,.3,'triangle'],shift:[130,.16,'sine'],tunnel:[180,.12,'sawtooth'],eat:[740,.09,'square'],hit:[70,.3,'sawtooth'],complete:[660,.6,'triangle'],rotate:[260,.25,'sine']};const [freq,dur,type]=map[kind]||[300,.08,'sine'];o.type=type as OscillatorType;o.frequency.setValueAtTime(freq,now);o.frequency.exponentialRampToValueAtTime(Math.max(40,freq*(kind==='hit'?.35:1.45)),now+dur);g.gain.setValueAtTime(.08,now);g.gain.exponentialRampToValueAtTime(.001,now+dur);o.connect(g).connect(a.destination);o.start();o.stop(now+dur);}

  private emit(force=false){if(!force&&this.lastUi===0)return;const now=performance.now();this.onUpdate({score:this.score,highScore:this.highScore,lives:this.lives,level:this.level,dotsLeft:this.dots[0].size+this.dots[1].size,observations:this.observations,observer:this.observer,brane:this.player.brane,braneReady:now-this.lastBraneShift>=PHYSICS.braneShiftCooldownMs,phase:this.phase,muted:this.muted,seed:this.seed,entropy:[...this.entropyHistory],ghosts:this.ghosts.map(g=>({state:g.state,observed:g.observed,timer:g.state===QuantumState.DECOHERED?Math.max(0,PHYSICS.unobservedDecayMs-g.unobservedMs):0,frightened:now<g.frightenedUntil,entropy:this.entropy(g)}))});}

  private draw(now:number){const rect=this.canvas.getBoundingClientRect(),w=rect.width,h=rect.height,ctx=this.ctx;ctx.save();if(now<this.shakeUntil)ctx.translate((this.rng.next()-.5)*8,(this.rng.next()-.5)*8);ctx.clearRect(-10,-10,w+20,h+20);ctx.fillStyle='#060a0f';ctx.fillRect(0,0,w,h);const tile=Math.min((w-20)/COLS,(h-12)/ROWS),ox=(w-tile*COLS)/2,oy=(h-tile*ROWS)/2;this.drawMaze(this.player.brane,tile,ox,oy,1);this.drawMaze(1-this.player.brane,tile,ox+tile*.12,oy+tile*.12,.11);this.drawSight(tile,ox,oy);
    for(const g of this.ghosts)if(g.brane===this.player.brane)this.drawGhost(g,tile,ox,oy,now);this.drawPlayer(tile,ox,oy,now);ctx.restore();}
  private drawMaze(brane:number,t:number,ox:number,oy:number,alpha:number){const ctx=this.ctx;ctx.save();ctx.globalAlpha=alpha;ctx.lineWidth=Math.max(.7,t*.055);ctx.strokeStyle=brane===0?'rgba(201,162,83,.78)':'rgba(105,226,213,.6)';ctx.shadowBlur=alpha>.5?5:0;ctx.shadowColor=ctx.strokeStyle;this.maps[brane].forEach((row,y)=>[...row].forEach((c,x)=>{if(c==='#'){const px=ox+x*t,py=oy+y*t;ctx.strokeRect(px+t*.12,py+t*.12,t*.76,t*.76);}else if(this.dots[brane].has(`${x},${y}`)){ctx.fillStyle=c==='o'?'#e9c875':'#72f6e5';ctx.shadowBlur=c==='o'?10:4;ctx.beginPath();ctx.arc(ox+(x+.5)*t,oy+(y+.5)*t,c==='o'?t*.19:Math.max(1,t*.055),0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;}}));ctx.restore();}
  private drawSight(t:number,ox:number,oy:number){const p=this.player,ctx=this.ctx,x=ox+(p.x+.5)*t,y=oy+(p.y+.5)*t,ang=Math.atan2(p.dir.y,p.dir.x);ctx.save();ctx.fillStyle=`rgba(112,246,229,${.025+this.observer/4000})`;ctx.beginPath();ctx.moveTo(x,y);ctx.arc(x,y,t*10,ang-Math.PI/4,ang+Math.PI/4);ctx.closePath();ctx.fill();ctx.restore();}
  private drawPlayer(t:number,ox:number,oy:number,now:number){const p=this.player,ctx=this.ctx,x=ox+(p.x+.5)*t,y=oy+(p.y+.5)*t,ang=Math.atan2(p.dir.y,p.dir.x),mouth=.16+Math.abs(Math.sin(now*.012))*.22;ctx.save();ctx.shadowBlur=12;ctx.shadowColor='#e9c875';ctx.fillStyle='#e9c875';ctx.beginPath();ctx.arc(x,y,t*.38,ang+mouth,ang+Math.PI*2-mouth);ctx.lineTo(x,y);ctx.fill();ctx.restore();}
  private drawGhost(g:Ghost,t:number,ox:number,oy:number,now:number){const ctx=this.ctx,color=GHOST_COLORS[g.id];if(g.state===QuantumState.ENTANGLED){const pair=this.ghosts[g.id%2===0?g.id+1:g.id-1];if(pair?.brane===g.brane){ctx.save();ctx.setLineDash([t*.25,t*.22]);ctx.strokeStyle='rgba(224,185,94,.35)';ctx.beginPath();ctx.moveTo(ox+(g.x+.5)*t,oy+(g.y+.5)*t);ctx.lineTo(ox+(pair.x+.5)*t,oy+(pair.y+.5)*t);ctx.stroke();ctx.restore();}}
    if(g.state===QuantumState.SUPERPOSITION){g.candidates.forEach(c=>this.ghostShape(ox+(c.x+.5)*t,oy+(c.y+.5)*t,t,color,Math.max(.08,c.weight*.95),now,g));return;}this.ghostShape(ox+(g.x+.5)*t,oy+(g.y+.5)*t,t,now<g.frightenedUntil?'#7286e8':color,g.observed?1:.82,now,g);}
  private ghostShape(x:number,y:number,t:number,color:string,alpha:number,now:number,g:Ghost){const ctx=this.ctx,pulse=1+Math.sin(now*.01+g.id)*.04;ctx.save();ctx.globalAlpha=alpha;ctx.shadowBlur=g.state===QuantumState.SUPERPOSITION?20:8;ctx.shadowColor=color;if(g.state===QuantumState.TUNNELING){ctx.setLineDash([2,2]);ctx.globalCompositeOperation='screen';x+=Math.sin(now*.025)*t*.09;}ctx.fillStyle=color;ctx.beginPath();ctx.arc(x,y,t*.36*pulse,Math.PI,0);ctx.lineTo(x+t*.36,y+t*.34);ctx.lineTo(x+t*.18,y+t*.22);ctx.lineTo(x,y+t*.36);ctx.lineTo(x-t*.18,y+t*.22);ctx.lineTo(x-t*.36,y+t*.34);ctx.closePath();ctx.fill();if(alpha>.5){ctx.shadowBlur=0;ctx.fillStyle='#071018';ctx.beginPath();ctx.arc(x-t*.13,y-t*.04,t*.065,0,Math.PI*2);ctx.arc(x+t*.13,y-t*.04,t*.065,0,Math.PI*2);ctx.fill();ctx.font=`${t*.28}px Georgia`;ctx.fillStyle='rgba(255,255,255,.75)';ctx.textAlign='center';ctx.fillText(STATE_GLYPHS[g.state],x,y+t*.75);}ctx.restore();}
}
