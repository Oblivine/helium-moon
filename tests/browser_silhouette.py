"""Render an ID silhouette against real world depth to audit AI hiding spots.
Runs low quality; this is geometry coverage, not lighting/likeness evaluation.
"""
import os
from playwright.async_api import async_playwright
import browser_playthrough as harness

async def play(port):
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE_PATH'),args=[
            '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'])
        try:
            page=await browser.new_page(viewport={'width':960,'height':540})
            await page.goto(f'http://localhost:{port}/?manual=1&q=low')
            await page.wait_for_function('window.READY || window.LOAD_ERROR',timeout=300000)
            assert not await page.evaluate('window.LOAD_ERROR')
            await page.locator('#loading').wait_for(state='hidden')
            await page.click('#menu-main [data-act=single]')
            await page.click('#single-go')
            results=await page.evaluate('''async()=>{
                const THREE=await import('/vendor/three/three.module.js');
                const {pointAtDistance,makeRng}=await import('/shared/math.js');
                const {groundAt}=await import('/shared/physics.js');
                const w=game.world,ai=game.sim.hv,view=game.hv,r=game.renderer.gl;
                for(const actor of [ai,game.sim.sf,game.sim.director,game.sim.mimic])actor.update=()=>{};
                game.sim.time=400;game.sim.state='play';
                const p=game.sim.players.get(game.myId),spots=[];
                for(const along of [300,400,500,600,700]){
                    if(spots.length===3)break;
                    const at=pointAtDistance(w.trail,w.trailCum,along);
                    game.tp(at.x,at.z);game.advance(30,1/30,false);
                    for(let seed=1;seed<=40;seed++){
                        ai.rng=makeRng(seed);ai.x=p.x;ai.z=p.z;
                        const spot=ai.observationSpot(p,'flank',20,45);
                        if(spot){spots.push({player:[p.x,p.z],spot});break;}
                    }
                }
                const rt=new THREE.WebGLRenderTarget(512,288,{depthBuffer:true});
                const probe=new THREE.Scene(),material=new THREE.MeshBasicMaterial({color:0xffffff,toneMapped:false,fog:false});
                probe.overrideMaterial=material;
                const oldTarget=r.getRenderTarget(),oldAuto=r.autoClear,oldColor=r.getClearColor(new THREE.Color()),oldAlpha=r.getClearAlpha();
                const root=view.root,parent=root.parent,results=[];
                function visiblePixels(clearDepth=false){
                    root.visible=false;r.autoClear=true;r.setRenderTarget(rt);r.render(game.scene,game.camera);
                    r.setClearColor(0x000000,1);r.clear(true,clearDepth,false);
                    root.visible=true;probe.add(root);r.autoClear=false;
                    r.render(probe,game.camera);
                    const pixels=new Uint8Array(512*288*4);r.readRenderTargetPixels(rt,0,0,512,288,pixels);
                    parent.add(root);
                    let visible=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>128&&pixels[i+1]>128&&pixels[i+2]>128)visible++;
                    return visible;
                }
                try{
                    for(const entry of spots){
                        const [x,z]=entry.spot;
                        game.tp(...entry.player);game.advance(30,1/30,false);
                        const y=groundAt(w,x,z);
                        game.look(Math.atan2(-(x-game.player.pos.x),-(z-game.player.pos.z)),Math.atan2(y+1.1-game.camera.position.y,Math.hypot(x-p.x,z-p.z)));
                        game.advance(3,1/30,false);
                        for(let n=0;n<90;n++)view.update(1/60,[x,y,z,0,0,0,0,4,0,0,4]);
                        const hidden=ai.concealedAt(x,z),visible=visiblePixels(false),control=visiblePixels(true);
                        results.push({x,z,hidden,visible,control});
                    }
                }finally{
                    parent.add(root);r.autoClear=oldAuto;r.setRenderTarget(oldTarget);r.setClearColor(oldColor,oldAlpha);rt.dispose();material.dispose();
                }
                return results;
            }''')
            for result in results:print(result,flush=True)
            assert len(results)==3 and all(r['control']>0 for r in results),'positive render controls must draw the rig'
            assert all(not r['hidden'] or r['visible']==0 for r in results),'AI hiding spot exposes rendered silhouette pixels'
        finally:
            await browser.close()
if __name__=='__main__':
    harness.play=play
    harness.main()
