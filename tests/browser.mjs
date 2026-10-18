import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const artifacts = resolve('tests/artifacts'); await mkdir(artifacts,{recursive:true});
const selectedCases = new Set((process.env.HARBOR_BROWSER_CASES || 'compact,quality,webgl,auto').split(','));
for (const test of selectedCases) assert.ok(['compact','quality','webgl','auto'].includes(test), `Unknown browser case: ${test}`);
const resultFile = process.env.HARBOR_BROWSER_RESULT || 'browser-result.json';
const directory = resolve(process.env.HARBOR_DIST_DIR || 'dist');
const mime = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.glb':'model/gltf-binary','.wasm':'application/wasm','.txt':'text/plain' };
const server=createServer(async(req,res)=>{
  try{
    const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/nested\//,'/');
    const file=resolve(directory,`.${path.endsWith('/')?path+'index.html':path}`);
    if(!file.startsWith(directory+sep)){res.writeHead(403);res.end();return;}
    const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream'});res.end(data);
  }catch{res.writeHead(404);res.end('Not found');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/nested/`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:[
  '--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--no-proxy-server',
  '--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader',
  '--use-angle=swiftshader',
]});
const errors=[],warnings=[],results=[],captures=[];let failure;
async function evaluate(page, callback, argument) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(callback, argument),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser evaluation exceeded 60 seconds')), 60000); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function screenshot(page,name){
  // Complete one frame instead of feeding an unbounded software-GPU RAF queue.
  const pixels=await evaluate(page,async()=>{
    const app=window.__HARBOR__,game=app.game();app.step(0);
    const renderer=game.pathtracing?.renderer||game.renderer?.renderer;
    if(renderer?.backend?.device)await renderer.backend.device.queue.onSubmittedWorkDone();
    else if(game.tracer)await app.captureLinear();
    const canvas=renderer?.domElement||document.querySelector('#trace');
    const bitmap=await createImageBitmap(await (await fetch(canvas.toDataURL())).blob());
    const copy=new OffscreenCanvas(bitmap.width,bitmap.height),context=copy.getContext('2d');
    context.drawImage(bitmap,0,0);bitmap.close();
    const data=context.getImageData(0,0,copy.width,copy.height).data;
    let sum=0,visible=0;for(let i=0;i<data.length;i+=4){sum+=data[i]+data[i+1]+data[i+2];if(data[i+3])visible++;}
    return{width:copy.width,height:copy.height,cssWidth:canvas.clientWidth,cssHeight:canvas.clientHeight,
      mean:sum/(copy.width*copy.height*3*255),visible};
  });
  assert.ok(pixels.mean>.005&&pixels.visible>0,`Canvas has no visible rendered pixels: ${name}`);
  assert.equal(pixels.cssWidth,900,`Canvas must fill the viewport: ${name}`);
  assert.equal(pixels.cssHeight,600,`Canvas must fill the viewport: ${name}`);
  captures.push({file:name,...pixels});
  await page.screenshot({path:resolve(artifacts,name),timeout:60000});
}
async function pageFor(query){
  const page=await browser.newPage({viewport:{width:900,height:600}});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='warning')warnings.push(m.text());});
  page.on('response',r=>{if(r.status()>=400)errors.push(`HTTP ${r.status()} ${r.url()}`);});
  await page.route('**/*',route=>{
    const u=new URL(route.request().url());
    if(['http:','https:'].includes(u.protocol)&&u.hostname!=='127.0.0.1'){errors.push(`External request: ${u.href}`);return route.abort();}
    return route.continue();
  });
  await page.goto(base+query);
  await page.waitForFunction(()=>window.__HARBOR__?.inspect().ready||document.querySelector('#loading.error'),null,{timeout:120000});
  assert.equal(await evaluate(page,()=>window.__HARBOR__?.inspect().ready),true,await page.locator('#status').textContent());
  return page;
}
try{
  for(const bounces of selectedCases.has('compact')?[1,8]:[]){
    const page=await pageFor(`?test&trace=compact&width=96&bounces=${bounces}&quality=low`);
    await evaluate(page,()=>{for(let i=0;i<15;i++)window.__HARBOR__.step(0);});
    const stats=await evaluate(page,async()=>{const a=window.__HARBOR__;const pixels=await a.captureLinear();return {state:a.inspect(),mean:pixels.mean,max:pixels.max,nonFinite:pixels.nonFinite};});
    assert.equal(stats.state.renderer.backend,'webgpu-compute');assert.equal(stats.state.renderer.status,'ready');
    assert.equal(stats.nonFinite,0);assert.ok(stats.mean>0.01);assert.ok(stats.max>0.1);assert.equal(stats.state.renderer.samples,17);
    results.push({test:`pathtrace-${bounces}-bounces`,...stats});
    await screenshot(page,`pathtrace-${bounces}.png`);
    if(bounces===8){
      const refit=await evaluate(page,async()=>{
        const a=window.__HARBOR__,g=a.game();const before=g.tracer.inspect();
        g.world.get('chrome').position[0]-=.6;g.step(0);const after=g.tracer.inspect();
        g.step(0);const unchanged=g.tracer.inspect();
        const data=await a.captureLinear();return{before,after,unchanged,nonFinite:data.nonFinite};
      });
      assert.equal(refit.after.samples,1);assert.equal(refit.unchanged.samples,2);assert.equal(refit.nonFinite,0);
      assert.equal(refit.before.bvhNodes,refit.after.bvhNodes);results.push({test:'dynamic-refit',...refit});
    }
    await evaluate(page,()=>window.__HARBOR__.dispose());await page.close();
  }
  if(selectedCases.has('compact'))assert.ok(results[1].mean>results[0].mean+0.01,'multiple bounces must add indirect light to this scene');

  // Default facade tracing uses the full quality renderer, including native textures.
  // Wavefront dispatches are not spp: every sample assertion uses an explicit readback.
  if(selectedCases.has('quality')){
    const page=await pageFor('?test&width=32&budget=2048&bounces=4&samples=2&quality=low');
    const quality=await evaluate(page,async()=>{
      const a=window.__HARBOR__,g=a.game(),view=g.pathtracing;
      if(!view||g.tracer)throw new Error('Default pathtrace mode must expose the quality renderer');
      let samples;
      for(let i=0;i<16;i++){a.step(0);samples=await a.measureSamples();if(samples.min>=2)break;}
      const state=a.inspect(),pixels=await a.captureLinear();
      const texturedFloor=!!view.worldBridge.getObject('floor').material.map;
      g.setCamera({position:[4,3,8],target:[0,1,0],fov:43,focusDistance:8,fStop:8});
      const optics={focusDistance:view.camera.focusDistance,fStop:view.camera.fStop,reset:view.inspect().samples===null};
      a.step(0);await a.measureSamples();
      g.world.get('chrome').position[0]-=.2;g.step(0);
      const transformReset=view.inspect().samples===null;
      return{state,samples,mean:pixels.mean,max:pixels.max,nonFinite:pixels.nonFinite,texturedFloor,optics,transformReset};
    });
    assert.equal(quality.state.renderer.implementation,'three-gpu-pathtracer');
    assert.equal(quality.state.renderer.backend,'webgpu');assert.equal(quality.state.renderer.maxBounces,4);
    assert.equal(quality.state.renderer.frameBudget,2048);assert.ok(quality.state.renderer.texturePages>0);
    assert.ok(quality.samples.avg>0);assert.equal(quality.nonFinite,0);assert.ok(quality.mean>.01);
    assert.equal(quality.texturedFloor,true);assert.deepEqual(quality.optics,{focusDistance:8,fStop:8,reset:true});
    assert.equal(quality.transformReset,true);results.push({test:'quality-facade',...quality});
    await screenshot(page,'pathtrace-quality.png');
    await evaluate(page,()=>window.__HARBOR__.dispose());await page.close();
  }

  for(const backend of ['webgl','auto'].filter(backend=>selectedCases.has(backend))){
    const page=await pageFor(`?test&scene=island&mode=play&backend=${backend}&quality=low`);
    const initial=await evaluate(page,()=>window.__HARBOR__.inspect());
    assert.equal(initial.renderer.backend,backend==='webgl'?'webgl2':'webgpu');
    await evaluate(page,()=>window.__HARBOR__.step(120));
    const before=await evaluate(page,()=>window.__HARBOR__.inspect().player);
    await page.keyboard.press('Tab');await page.locator('#game').focus();
    await page.keyboard.down('KeyW');await evaluate(page,()=>window.__HARBOR__.step(60));await page.keyboard.up('KeyW');
    const after=await evaluate(page,()=>window.__HARBOR__.inspect().player);
    assert.ok(after[2]<before[2]-2,'WASD moves the physical character');
    await page.keyboard.down('Space');await evaluate(page,()=>window.__HARBOR__.step(12));await page.keyboard.up('Space');
    const jumped=await evaluate(page,()=>window.__HARBOR__.inspect().player);
    assert.ok(jumped[1]>after[1]+.25,'jump leaves the floor');
    await evaluate(page,()=>window.__HARBOR__.step(120));
    const collected=await evaluate(page,()=>{
      const a=window.__HARBOR__;
      for(const beacon of a.snapshot().entities.filter(e=>e.tags.includes('beacon'))){
        a.command({type:'physics:teleport',id:'player',position:[beacon.position[0],beacon.position[1],beacon.position[2]+1.6]});
        if(!a.command({type:'game:interact'}))throw new Error('Failed collection');a.step(1);
      }
      return a.inspect();
    });
    assert.equal(collected.collected.length,3);assert.equal(collected.physics.bodies,initial.physics.bodies);
    const batches=await evaluate(page,()=>{
      const a=window.__HARBOR__,g=a.game();a.command({type:'physics:teleport',id:'house-0',position:[-10,2.1,-10]});a.step(0);
      const object=g.renderer.getObject('house-0');return{hasObject:!!object,stats:g.renderer.inspect()};
    });assert.equal(batches.hasObject,true);
    // Shadow/bloom creation and disposal use the same actual browser backend.
    await page.selectOption('#quality','high');await evaluate(page,()=>window.__HARBOR__.step(0));
    assert.equal(await evaluate(page,()=>window.__HARBOR__.inspect().renderer.bloom),true);
    await page.selectOption('#quality','low');await evaluate(page,()=>window.__HARBOR__.step(0));
    await screenshot(page,`island-${backend}.png`);
    results.push({test:`playable-${backend}`,initial,before,after,jumped,collected,batches});
    await evaluate(page,()=>{window.__HARBOR__.dispose();window.__HARBOR__.dispose();});await page.close();
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:results.length,browser:browser.version()}));
}catch(e){failure=e.stack||String(e);process.exitCode=1;console.error(failure);}
finally{
  await writeFile(resolve(artifacts,resultFile),JSON.stringify({ok:!failure,failure,browser:browser.version(),softwareAdapter:true,cases:[...selectedCases],results,captures,errors,warnings:[...new Set(warnings)]},null,2));
  await browser.close();await new Promise(r=>server.close(r));
}
