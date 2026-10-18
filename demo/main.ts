import './style.css';
import { createGame, type BrowserGame, type GameTraceOptions } from '../src/browser/index.js';
import { Scope, type SceneDefinition, type Vec3 } from '../src/core/index.js';
import type { Quality } from '../src/render/index.js';
import { createBrowserPlatform } from '../src/platform/index.js';
import islandJson from './scene.json';
import { lightStudy } from './lab.js';

const query = new URLSearchParams(location.search);
const lab = query.get('scene') !== 'island', manual = query.has('test');
const traceBackend = query.get('trace') === 'compact' ? 'compact' : 'quality';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scope = new Scope(), platform = createBrowserPlatform('harbor-demo-v1');
scope.add(() => platform.dispose());
let game: BrowserGame | undefined, generation = 0, disposed = false;
let mode: 'raster' | 'pathtrace' = query.get('mode') === 'play' || query.get('backend') === 'webgl' ? 'raster' : lab || query.get('mode') === 'trace' ? 'pathtrace' : 'raster';
let quality: Quality = ['low', 'medium', 'high'].includes(query.get('quality') ?? '') ? query.get('quality') as Quality : 'medium';
let yaw = lab ? 0.12 : 0, pitch = lab ? 0.17 : 0.48, distance = lab ? 10 : 12;
let target: Vec3 = lab ? [0, 1.5, -0.4] : [0, 1, 8];
let ready = false, hudFrame = 0, queuedJump = false, live = false;
let transition: Promise<void> = Promise.resolve();
let traceSettings: GameTraceOptions;
let sampleReadback: Promise<void> | undefined, lastSampleReadback = 0;
const keys = new Set<string>(), stick = { x: 0, y: 0 };
const qualitySelect = $<HTMLSelectElement>('quality'); qualitySelect.value = quality;
// createGame validates this inside the visible loading/error boundary.
const initialScene = (lab ? lightStudy : islandJson) as SceneDefinition;

function camera() {
  return { position: [target[0] + Math.sin(yaw) * Math.cos(pitch) * distance,
    target[1] + Math.sin(pitch) * distance, target[2] + Math.cos(yaw) * Math.cos(pitch) * distance] as Vec3,
    target: [...target] as Vec3, fov: lab ? 43 : 52 };
}
function dimensions() {
  const scale = quality === 'low' ? 0.4 : quality === 'medium' ? 0.7 : 1;
  const width = Number(query.get('width')) || Math.round(innerWidth * scale * Math.min(devicePixelRatio, quality === 'high' ? 2 : 1));
  return { width: Math.max(16, width), height: Math.max(16, Math.round(width * innerHeight / innerWidth)) };
}
function error(error: Error) {
  ready = false;
  $('loading').className = 'error';
  $('loading').querySelector('strong')!.textContent = 'This view could not start';
  $('status').textContent = `${error.message} Use Play for the WebGL2-compatible view.`;
  if (!$('compatible-view')) {
    const link = document.createElement('a'); link.id = 'compatible-view';
    link.href = '?scene=island&mode=play&backend=webgl'; link.textContent = 'Open compatible playground';
    link.style.color = '#e9d3a6'; $('loading').append(link);
  }
  console.error(error);
}
function collect() {
  if (!game || lab) return false;
  const player = game.world.get('player')!;
  const beacon = game.world.query('beacon').find(e => !e.data.collected && Math.hypot(...e.position.map((v,i) => v-player.position[i])) < 2.9);
  if (!beacon) return false;
  beacon.data.collected = true;
  beacon.visual!.emissiveIntensity = 0;
  beacon.visual!.color = '#c5a96e';
  game.invalidateScene();
  platform.save('progress', game.world.query('beacon').filter(e => e.data.collected).map(e => e.id));
  updateHUD(); return true;
}
function updateHUD() {
  if (!game) return;
  const beacons = game.world.query('beacon');
  const collected = beacons.filter(e => e.data.collected).length;
  $('count').textContent = `${collected} / ${beacons.length}`;
  $('beacons').replaceChildren(...beacons.map(e => {
    const row = document.createElement('div'); row.className = `beacon-row${e.data.collected ? ' done' : ''}`;
    const circle = document.createElement('span'); circle.className = 'circle';
    row.append(circle, document.createTextNode(String(e.data.label))); return row;
  }));
  $('quest-note').textContent = collected === 3 ? 'All three beacons collected.' : 'Approach a beacon and press E.';
  if (game.pathtracing) {
    const stats = game.pathtracing.inspect(), samples = stats.samples;
    const convergence = samples ? `${samples.avg.toFixed(1)} average spp (${samples.min}–${samples.max})` : 'Refining · samples not measured yet';
    $('trace-caption').textContent = `${convergence} / ${stats.maxBounces} bounces / ${stats.width} × ${stats.height}\n${live ? 'Live geometry · pause motion to refine.' : 'Textured physical materials · drag to orbit.'}`;
  } else if (game.tracer) {
    const stats = game.tracer.inspect();
    $('trace-caption').textContent = `Compact · ${stats.samples} samples / ${stats.maxBounces} bounces / ${stats.width} × ${stats.height}\n${live ? 'Live geometry · pause motion to refine.' : 'Constant materials · drag to orbit.'}`;
  } else $('trace-caption').textContent = '';
  if (!$('diagnostics').hidden) $('diagnostics').textContent = JSON.stringify(inspect(), null, 2);
  if (!lab && mode === 'raster') {
    const player = game.world.get('player')!;
    const nearest = beacons.find(e => !e.data.collected && Math.hypot(...e.position.map((v,i) => v-player.position[i])) < 2.9);
    $('prompt').textContent = nearest ? `E · Collect ${nearest.data.label}` : collected === 3 ? 'All three beacons collected.' : '';
  } else $('prompt').textContent = '';
}
function inspect() {
  return { ready, mode, scene: lab ? 'light-study' : 'island', tick: game?.world.tick,
    entities: game?.world.entities.size, player: game?.world.get('player')?.position,
    collected: game?.world.query('beacon').filter(e=>e.data.collected).map(e=>e.id),
    renderer: game?.pathtracing?.inspect() ?? game?.tracer?.inspect() ?? game?.renderer?.inspect(),
    physics: (game?.world.services.get('physics') as { inspect(): unknown } | undefined)?.inspect() };
}

function open(next: 'raster' | 'pathtrace', reset = false): Promise<void> {
  const request = ++generation;
  game?.pause();
  // A generation token alone cannot protect a canvas shared by asynchronous GPU initializers.
  transition = transition.catch(() => {}).then(() => performOpen(next, reset, request)).catch(e => {
    if (request === generation) error(e instanceof Error ? e : new Error(String(e)));
  });
  return transition;
}
async function performOpen(next: 'raster' | 'pathtrace', reset: boolean, request: number) {
  if (request !== generation || disposed) return;
  ready = false;
  const old = game; old?.pause();
  const source: SceneDefinition = !old || reset ? structuredClone(initialScene) : { ...initialScene, entities: old.snapshot().entities };
  $('loading').className = '';
  $('status').textContent = next === 'pathtrace' ? 'Building triangle BVH and compiling WebGPU kernels' : 'Preparing physics and raster renderer';
  traceSettings = { ...dimensions(), backend: traceBackend,
    maxBounces: Number(query.get('bounces')) || (traceBackend === 'quality' ? 15 : 8), live,
    ...(traceBackend === 'quality' ? { frameBudget: Number(query.get('budget')) || 250000, maxSamples: Number(query.get('samples')) || 0 } : {}) };
  // Dispose before reusing either canvas; worlds, listeners and GPU resources have explicit ownership.
  old?.dispose(); await old?.pathtracing?.dispose(); game = undefined;
  if (request !== generation || disposed) return;
  const canvasId = next === 'pathtrace' ? 'trace' : 'game';
  // Three releases the WebGL context on disposal; a fresh canvas has a fresh lifetime.
  const previousCanvas = $<HTMLCanvasElement>(canvasId);
  const freshCanvas = previousCanvas.cloneNode(false) as HTMLCanvasElement;
  previousCanvas.replaceWith(freshCanvas);
  let created: BrowserGame | undefined;
  try {
    created = await createGame({ canvas: freshCanvas,
      scene: source, mode: next, quality, backend: query.get('backend') === 'webgl' ? 'webgl' : 'auto',
      trace: traceSettings, camera: camera(), autoStart: false, onError: error });
    if (request !== generation || disposed) { created.dispose(); await created.pathtracing?.dispose(); return; }
    game = created; mode = next;
    if (!lab) {
      if (!manual && !old && !reset) {
        const saved = platform.load('progress', (v): v is string[] => Array.isArray(v) && v.every(x=>typeof x==='string'));
        for (const id of saved ?? []) { const e = game.world.get(id); if (e?.tags.includes('beacon')) { e.data.collected = true; e.visual!.emissiveIntensity=0; e.visual!.color='#c5a96e'; } }
        game.invalidateScene();
      }
      game.world.registerCommand('game:interact', collect);
      game.world.addSystem({ id: 'demo:input', update(world) {
        const x = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft')) + stick.x;
        const z = Number(keys.has('KeyS') || keys.has('ArrowDown')) - Number(keys.has('KeyW') || keys.has('ArrowUp')) + stick.y;
        const speed = (keys.has('ShiftLeft') ? 8 : 4.5) / Math.max(1, Math.hypot(x,z));
        world.command({ type:'physics:move',id:'player',velocity:[(x*Math.cos(yaw)+z*Math.sin(yaw))*speed,0,(-x*Math.sin(yaw)+z*Math.cos(yaw))*speed],jump:queuedJump }); queuedJump=false;
      }});
      game.world.addSystem({id:'demo:follow',phase:'afterPhysics',update(world){
        const p=world.get('player')!;
        if(p.position[1]<-12)world.command({type:'physics:teleport',id:'player',position:[0,2,8]});
        target=[p.position[0],p.position[1]+.5,p.position[2]];game?.setCamera(camera());
      }});
    } else {
      game.world.addSystem({id:'demo:orbit-gold',update(world){
        const gold=world.get('gold')!; gold.position[0]=1.6+Math.sin(world.time)*.6;
      }});
    }
    if (lab && created.pathtracing) {
      const { DataTexture, RepeatWrapping, SRGBColorSpace } = await import('three/webgpu');
      if (request !== generation || disposed) { created.dispose(); await created.pathtracing?.dispose(); if (game === created) game = undefined; return; }
      const checker = new DataTexture(new Uint8Array([
        225, 219, 200, 255, 100, 116, 117, 255,
        100, 116, 117, 255, 225, 219, 200, 255,
      ]), 2, 2);
      checker.name = 'Light Study checker'; checker.colorSpace = SRGBColorSpace;
      checker.wrapS = checker.wrapT = RepeatWrapping; checker.repeat.set(8, 8); checker.needsUpdate = true;
      const view = created.pathtracing;
      created.world.install({ id: 'demo:checker', setup(_world, owned) {
        owned.add(() => checker.dispose());
        const floor = view.worldBridge!.getObject('floor');
        if (!floor) throw new Error('Light Study requires its floor entity');
        const material = floor.material as import('three/webgpu').MeshPhysicalMaterial;
        material.map = checker; material.needsUpdate = true;
        owned.add(() => { if (material.map === checker) material.map = null; });
      } });
      created.invalidateScene();
    }
    if (mode === 'raster' && !lab) {
      const {createOcean}=await import('../src/render/index.js');
      if(request!==generation||disposed){created.dispose();if(game===created)game=undefined;return;}
      const ocean=createOcean();
      created.renderer!.scene.add(ocean.object);
      created.world.install({id:'demo:ocean',setup(world,owned){owned.add(()=>ocean.dispose());owned.add(world.addSystem({id:'demo:ocean-time',update:w=>ocean.update(w.time)}));}});
    }
    document.body.classList.toggle('tracing',mode==='pathtrace');
    $('play-mode').classList.toggle('active',mode==='raster');$('trace-mode').classList.toggle('active',mode==='pathtrace');
    $('animate').style.display=mode==='pathtrace'?'':'none';
    $('loading').className='hidden';ready=true;
    game.step(0); if(!manual)game.start(); updateHUD();
  } catch (e) {
    try { created?.dispose(); await created?.pathtracing?.dispose(); } catch {}
    if(game===created)game=undefined;
    if(request===generation)error(e instanceof Error?e:new Error(String(e)));
  }
}

if(lab){
  document.querySelector('h1')!.innerHTML='Light Study<span>Materials and lighting.</span>';
  $('description').textContent=traceBackend==='quality'?'Chrome, glass and a textured floor. Physical materials and multi-bounce light.':'Chrome, glass, colored walls. Compact geometry-only path tracing.';
  $('play-mode').textContent='Play island';
}
const animate=document.createElement('button');animate.id='animate';animate.textContent='Animate';$('trace-mode').after(animate);
animate.onclick=()=>{live=!live;if(traceSettings)traceSettings.live=live;animate.textContent=live?'Pause motion':'Animate';updateHUD();};
$('play-mode').onclick=()=>{if(lab){location.href='?scene=island&mode=play';return;}void open('raster');};
$('trace-mode').onclick=()=>void open('pathtrace');
$('reset').onclick=()=>{platform.save('progress',[]);void open(mode,true);};
qualitySelect.onchange=()=>{quality=qualitySelect.value as Quality;if(game?.tracer||game?.pathtracing){Object.assign(traceSettings,dimensions());game.resize(traceSettings.width,traceSettings.height);}else game?.renderer?.setQuality(quality);if(manual)game?.step(0);};
$('diagnostic-toggle').onclick=()=>{$('diagnostics').hidden=!$('diagnostics').hidden;updateHUD();};

function listen(target: EventTarget,type:string,handler:EventListener,options?:AddEventListenerOptions){target.addEventListener(type,handler,options);scope.add(()=>target.removeEventListener(type,handler,options));}
listen(window,'keydown',(event)=>{const e=event as KeyboardEvent;if((e.target as HTMLElement)?.matches('select,input,button'))return;
  if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','KeyE'].includes(e.code)){e.preventDefault();keys.add(e.code);}
  if(e.code==='Space'&&!e.repeat)queuedJump=true;if(e.code==='KeyE'&&!e.repeat)collect();});
listen(window,'keyup',e=>keys.delete((e as KeyboardEvent).code));
listen(window,'blur',()=>{keys.clear();queuedJump=false;stick.x=stick.y=0;});
let drag:number|undefined,lastX=0,lastY=0;
listen(document,'pointerdown',event=>{const e=event as PointerEvent;const canvas=e.target as HTMLCanvasElement;
  if(!canvas.matches('canvas#game,canvas#trace'))return;
  drag=e.pointerId;lastX=e.clientX;lastY=e.clientY;canvas.setPointerCapture(e.pointerId);canvas.focus();});
listen(document,'pointermove',event=>{const e=event as PointerEvent;if(drag!==e.pointerId)return;yaw-=(e.clientX-lastX)*.006;pitch=Math.max(-.05,Math.min(1.3,pitch+(e.clientY-lastY)*.004));lastX=e.clientX;lastY=e.clientY;game?.setCamera(camera());if(manual)game?.step(0);});
listen(document,'pointerup',()=>{drag=undefined;});listen(document,'pointercancel',()=>{drag=undefined;});
listen(document,'wheel',event=>{const e=event as WheelEvent;if(!(e.target as HTMLElement).matches('canvas#game,canvas#trace'))return;e.preventDefault();distance=Math.max(3,Math.min(32,distance+e.deltaY*.01));game?.setCamera(camera());if(manual)game?.step(0);},{passive:false});
let stickPointer:number|undefined;
function updateStick(e:PointerEvent){const r=$('joystick').getBoundingClientRect();let x=(e.clientX-r.left-r.width/2)/35,y=(e.clientY-r.top-r.height/2)/35;const length=Math.max(1,Math.hypot(x,y));x/=length;y/=length;stick.x=x;stick.y=y;$('stick').style.transform=`translate(${x*30}px,${y*30}px)`;}
listen($('joystick'),'pointerdown',e=>{const p=e as PointerEvent;stickPointer=p.pointerId;$('joystick').setPointerCapture(p.pointerId);updateStick(p);});
listen($('joystick'),'pointermove',e=>{if((e as PointerEvent).pointerId===stickPointer)updateStick(e as PointerEvent);});
for(const type of ['pointerup','pointercancel'])listen($('joystick'),type,()=>{stickPointer=undefined;stick.x=stick.y=0;$('stick').style.transform='';});
$('jump').onclick=()=>{queuedJump=true;};$('interact').onclick=collect;

async function captureLinear() {
  let data: ArrayLike<number>;
  if (game?.tracer) data = await game.tracer.captureLinear();
  else if (game?.pathtracing) {
    const current = game.pathtracing;
    const { RenderTarget, FloatType, QuadMesh, MeshBasicNodeMaterial } = await import('three/webgpu');
    const stats = current.inspect(), texture = current.pathTracer.target;
    if (!texture) throw new Error('Render the quality view before reading its linear texture');
    const target = new RenderTarget(stats.width, stats.height, { type: FloatType });
    const material = new MeshBasicNodeMaterial({ map: texture, toneMapped: false });
    const quad = new QuadMesh(material);
    try {
      const previous = current.renderer.getRenderTarget();
      try { current.renderer.setRenderTarget(target); quad.render(current.renderer); }
      finally { current.renderer.setRenderTarget(previous); }
      data = await current.renderer.readRenderTargetPixelsAsync(target, 0, 0, stats.width, stats.height);
    } finally { target.dispose(); material.dispose(); quad.dispose(); }
  } else throw new Error('Linear capture requires an active path tracing view');
  let sum=0,max=0,bad=0;
  for(let i=0;i<data.length;i+=4)for(let c=0;c<3;c++){const v=data[i+c];if(!Number.isFinite(v))bad++;sum+=v;max=Math.max(max,v);}
  return {mean:sum/(data.length*.75),max,nonFinite:bad,pixels:Array.from(data)};
}
async function measureSamples() {
  const current = game?.pathtracing;
  if (!current) throw new Error('Measured wavefront samples require the quality backend');
  const samples = await current.measureSamples();
  if (game?.pathtracing === current) updateHUD();
  return samples;
}
const api={inspect,game:()=>game,snapshot:()=>game?.snapshot(),command:(command:Parameters<NonNullable<typeof game>['world']['command']>[0])=>{const value=game!.world.command(command);updateHUD();return value;},
  step:(ticks=1)=>{game!.step(ticks);updateHUD();},setMode:open,setCamera:(value:Parameters<BrowserGame['setCamera']>[0])=>game!.setCamera(value),
  trace:()=>game?.tracer,pathtracing:()=>game?.pathtracing,captureLinear,measureSamples,
  dispose:()=>{if(!disposed){disposed=true;generation++;cancelAnimationFrame(hudFrame);game?.dispose();scope.dispose();ready=false;}return game?.pathtracing?.dispose();}};
Object.defineProperty(window,'__HARBOR__',{value:api,configurable:true});
listen(window,'pagehide',api.dispose);
if(import.meta.hot)import.meta.hot.dispose(api.dispose);
function hud(now=0){if(disposed)return;updateHUD();
  if(game?.pathtracing&&!sampleReadback&&now-lastSampleReadback>1000){
    lastSampleReadback=now;const current=game.pathtracing;
    sampleReadback=measureSamples().then(()=>{}).catch(e=>{if(!disposed&&game?.pathtracing===current)error(e instanceof Error?e:new Error(String(e)));}).finally(()=>{sampleReadback=undefined;});
  }
  hudFrame=requestAnimationFrame(hud);
}
await open(mode);if(!manual)hud();
