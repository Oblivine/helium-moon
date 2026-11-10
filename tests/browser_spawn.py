"""Actual trailhead first view, keyboard exit and memo access, plus art captures.

Threats are frozen for this environment/interaction check. Extra art viewpoints
are staged; screenshots are not evidence of reference-photo accuracy.
"""
import json
import os
from pathlib import Path
from playwright.async_api import async_playwright
import browser_playthrough as harness


async def play(port):
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE_PATH'),args=[
            '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
            '--autoplay-policy=no-user-gesture-required'])
        try:
            page=await browser.new_page(viewport={'width':1280,'height':720})
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            await page.goto(f'http://localhost:{port}/?manual=1&q=high&msaa=0')
            await page.wait_for_function('window.READY || window.LOAD_ERROR',timeout=300000)
            assert not await page.evaluate('window.LOAD_ERROR')
            await page.evaluate('ui.clickToPlay=()=>{}')
            await page.click('#menu-main [data-act=single]')
            await page.click('#single-go')
            result=await page.evaluate('''()=>{
                game.sim.hv.update=game.sim.sf.update=game.sim.director.update=game.sim.mimic.update=()=>{};
                game.advance(30,1/30,false);document.querySelector('#intro').style.display='none';game.step(0,true);
                const k=game.world.structures.find(o=>o.type==='kiosk'),p=game.player.pos;
                window.spawnStart={x:p.x,z:p.z,yaw:game.player.yaw};
                return {calls:game.renderer.gl.info.render.calls,triangles:game.renderer.gl.info.render.triangles,
                    trees:game.world.trees.length,arrival:game.world.arrival,spawn:spawnStart,kiosk:k};
            }''')
            output=Path(os.environ.get('HM_ARTIFACT_DIR','/workspace/artifacts/helium-spawn'))
            output.mkdir(parents=True,exist_ok=True)
            await page.screenshot(path=str(output/'first-view.png'))
            await page.keyboard.down('w');await page.evaluate('game.advance(90,1/30,false)');await page.keyboard.up('w')
            distance=await page.evaluate('Math.hypot(game.player.pos.x-spawnStart.x,game.player.pos.z-spawnStart.z)')
            assert distance>4.3,f'actual W movement blocked after {distance:.2f}m'
            result['keyboardExitMetres']=distance

            await page.evaluate('''()=>{
                const k=game.world.structures.find(o=>o.type==='kiosk');
                game.tp(spawnStart.x,spawnStart.z,k.x,k.z);
                const note=game.objViews.items.get('note_memo'),p=game.player.pos;
                const dx=note.def.x-game.camera.position.x,dz=note.def.z-game.camera.position.z;
                game.look(Math.atan2(-dx,-dz),Math.atan2(note.y+.1-game.camera.position.y,Math.hypot(dx,dz)));
                game.advance(3,1/30,false);
            }''')
            await page.keyboard.down('w')
            reached=False
            for _ in range(100):
                await page.evaluate('game.advance(1,1/30,false)')
                if await page.evaluate("(ui._prompt||'').toLowerCase().includes('read maintenance memo')"):
                    reached=True;break
            await page.keyboard.up('w');assert reached,'memo must be reachable on foot from the new spawn'
            await page.keyboard.press('e');await page.evaluate('game.advance(4,1/30,false)')
            assert await page.evaluate("game.notesRead.includes('memo')"),'actual E interaction reads briefing'
            result['memoReadOnFoot']=True
            await page.evaluate('game.reading=null;ui.showNote(null);game.step(0,true)')
            await page.screenshot(path=str(output/'briefing-shelter.png'))

            await page.evaluate('''()=>{
                const k=game.world.structures.find(o=>o.type==='kiosk'),c=Math.cos(k.rot),s=Math.sin(k.rot);
                game.tp(k.x+9*c+11*s,k.z-9*s+11*c,k.x,k.z+1);
                game.look(game.player.yaw,.05);game.advance(30,1/30,false);game.step(0,true);
            }''')
            await page.screenshot(path=str(output/'shelter-overview.png'))
            assert not errors,errors
            (output/'results.json').write_text(json.dumps(result,indent=2))
            print('PASS actual new spawn W exit and on-foot memo interaction; high-quality rendered captures:',result,flush=True)
        finally:
            await browser.close()


if __name__=='__main__':
    harness.play=play
    harness.main()
