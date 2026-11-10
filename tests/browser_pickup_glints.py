"""Seeded pickup checks through actual client aiming, lighting and interaction.
Fixtures position the player and freeze threats, not the glint or pickup logic.
"""
import os
from playwright.async_api import async_playwright
import browser_playthrough as harness

async def play(port):
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE_PATH'),args=[
            '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'])
        try:
            page=await browser.new_page(viewport={'width':1280,'height':720})
            errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            await page.goto(f'http://localhost:{port}/?manual=1&q=low')
            await page.wait_for_function('window.READY || window.LOAD_ERROR',timeout=300000)
            assert not await page.evaluate('window.LOAD_ERROR')
            await page.locator('#loading').wait_for(state='hidden')
            await page.click('#menu-main [data-act=single]')
            await page.click('#single-go')
            for seed in range(1,13):
                await page.evaluate('''seed=>{
                    const random=Math.random;
                    try{Math.random=()=>seed/2**31;game.restart();}finally{Math.random=random;}
                    for(const actor of [game.sim.hv,game.sim.sf,game.sim.director,game.sim.mimic])actor.update=()=>{};
                }''',seed)
                for item in ['fuel','fuse']:
                    cue=await page.evaluate('''id=>{
                        const view=game.objViews.items.get(id),def=view.def;
                        for(const radius of [1.25,.75,1.7,2])for(let i=0;i<16;i++){
                            const a=i*Math.PI/8,x=def.x+Math.cos(a)*radius,z=def.z+Math.sin(a)*radius;
                            if(!game.world.isPlayable(x,z))continue;
                            game.tp(x,z,def.x,def.z);game.advance(30,1/30,false);
                            const dx=def.x-game.camera.position.x,dz=def.z-game.camera.position.z;
                            game.look(Math.atan2(-dx,-dz),Math.atan2(view.y+.15-game.camera.position.y,Math.hypot(dx,dz)));
                            game.advance(3,1/30,false);
                            if(!(ui._prompt||'').toLowerCase().includes(def.name.toLowerCase()))continue;
                            let peak=0,minimum=1;
                            for(let n=0;n<45;n++){
                                game.advance(1,1/30,false);peak=Math.max(peak,view.glint.material.opacity);
                                minimum=Math.min(minimum,view.glint.material.opacity);
                            }
                            if(!(ui._prompt||'').toLowerCase().includes(def.name.toLowerCase()))continue;
                            return {peak,minimum,on:game.flashlight.on,pitch:game.player.pitch};
                        }
                        return null;
                    }''',item)
                    assert cue and cue['on'] and cue['peak']>.01,(seed,item,cue)
                    await page.keyboard.press('e')
                    await page.evaluate('game.advance(3,1/30,false)')
                    picked=await page.evaluate('''id=>({picked:game.team[id]&&game.objViews.items.get(id).held,
                        prompt:ui._prompt,pos:game.player.pos.toArray(),server:game.sim.players.get(game.myId),
                        item:game.sim.obj.items.find(i=>i.id===id),paused:game.paused,reading:game.reading})''',item)
                    assert picked['picked'],(seed,item,picked)
                print(f'  ok  seed {seed}: both required pickups catch light and collect through E',flush=True)
            assert not errors,errors
        finally:
            await browser.close()
if __name__=='__main__':
    harness.play=play
    harness.main()
