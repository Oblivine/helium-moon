"""Actual character/view terrain contacts on the refuge and its supported bridge.
Position/pose fixtures isolate visual grounding; this does not test AI routing.
"""
import os
from pathlib import Path
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
            result=await page.evaluate('''async()=>{
                const {groundAt}=await import('/shared/physics.js');
                const w=game.world,v=game.hv;
                for(const actor of [game.sim.hv,game.sim.sf,game.sim.director,game.sim.mimic])actor.update=()=>{};
                // Select reachable real terrain with measurable gradients, not a
                // synthetic plane installed into the browser world.
                const slopes=[];
                for(let i=0;i<w.navCost.length;i++){
                    if(!w.navCost[i])continue;
                    const [x,z]=w.cellPos(i);
                    if(!w.isPlayable(x,z)||w.deckAt(x,z)!==null)continue;
                    const sx=(w.heightAt(x+.5,z)-w.heightAt(x-.5,z));
                    const sz=(w.heightAt(x,z+.5)-w.heightAt(x,z-.5));
                    const gradient=Math.hypot(sx,sz);
                    if(gradient<.12||gradient>.3)continue;
                    if(slopes.some(p=>Math.hypot(p.x-x,p.z-z)<30))continue;
                    slopes.push({x,z,y:groundAt(w,x,z),yaw:Math.atan2(sx,sz),gradient});
                    if(slopes.length===3)break;
                }
                const bridge=w.structures.find(s=>s.type==='footbridge');
                const points=[...slopes];
                if(bridge)points.push({x:bridge.x,z:bridge.z,y:groundAt(w,bridge.x,bridge.z),yaw:bridge.rot||0,bridge:true});
                let maxFoot=0,maxHand=0,contacts=0;
                for(const point of points)for(const crawl of [false,true])for(const turn of [0,Math.PI/2,Math.PI]){
                    const {x,y,z}=point,yaw=point.yaw+turn;
                    for(let frame=0;frame<150;frame++){
                        v.update(1/60,[x,y,z,yaw,yaw,0,crawl?10.5:1.35,crawl?16:0,0,0,crawl?6:3]);
                        if(frame<60)continue;
                        v.root.updateMatrixWorld(true);
                        for(const side of ['L','R']){
                            const foot=v.anim.feet[side],ankle=v.char.bones['foot.'+side].getWorldPosition(new game.camera.position.constructor());
                            if(foot.contact){
                                maxFoot=Math.max(maxFoot,Math.abs(ankle.y-v.anim.l[side].ankY-groundAt(w,ankle.x,ankle.z)));contacts++;
                            }
                            if(crawl&&v.anim.hands[side].contact){
                                const wrist=v.char.bones['wrist.'+side].getWorldPosition(new game.camera.position.constructor());
                                maxHand=Math.max(maxHand,Math.abs(wrist.y-.11-groundAt(w,wrist.x,wrist.z)));contacts++;
                            }
                        }
                    }
                }
                let skunkPawError=0,skunkContacts=0;
                const skunk=game.sf,scale=skunk.root.scale.x;
                for(const point of points)for(const turn of [0,Math.PI/2,Math.PI])for(const flags of [0,1,2,8]){
                    const yaw=point.yaw+turn,speed=flags===1?2.3:flags===2?0:.6;
                    for(let frame=0;frame<180;frame++){
                        skunk.update(1/60,[point.x,point.y,point.z,yaw,yaw,speed,flags,0,1]);
                        if(frame<120)continue;
                        skunk.root.updateMatrixWorld(true);
                        for(const [key,foot] of Object.entries(skunk.anim.feet)){
                            if(!foot.contact)continue;
                            const paw=skunk.anim.legs[key].e.getWorldPosition(new game.camera.position.constructor());
                            skunkPawError=Math.max(skunkPawError,Math.abs(paw.y-.02*scale-groundAt(w,paw.x,paw.z)));
                            skunkContacts++;
                        }
                    }
                }
                skunk.root.visible=false;
                // Render a crawl on the bridge's clear surface for inspection.
                const point=points.find(p=>p.bridge);v.update(1/30,[point.x,point.y,point.z,point.yaw,point.yaw,0,10.5,16,0,0,6]);
                const viewX=point.x+Math.sin(point.yaw)*3.5+Math.cos(point.yaw)*.6;
                const viewZ=point.z+Math.cos(point.yaw)*3.5-Math.sin(point.yaw)*.6;
                game.tp(viewX,viewZ,point.x,point.z);game.look(game.player.yaw,-.3);
                game.flashlight.update(1/30,game.camera,0);
                game.fade=game.fadeTarget=0;game.env.update(1/30,game.camera,0);
                game._render(0);
                document.querySelector('#intro').style.display='none';
                return {slopes:slopes.length,bridge:points.some(p=>p.bridge),maxFoot,maxHand,contacts,skunkPawError,skunkContacts};
            }''')
            assert result['slopes']==3,result
            assert result['contacts']>1000,result
            assert result['maxFoot']<.025 and result['maxHand']<.025,result
            assert result['bridge'],result
            assert result['skunkContacts']>1000 and result['skunkPawError']<.02,result
            output=Path(os.environ.get('HM_ARTIFACT_DIR','/tmp/helium-moon-ground-contacts'))
            output.mkdir(parents=True,exist_ok=True)
            await page.screenshot(path=str(output/'grounded-crawl.png'),timeout=120000)
            assert not errors,errors
            print('  ok  actual view plants on real slopes in three orientations and on the bridge:',result,flush=True)
            print('all browser ground-contact checks passed',flush=True)
        finally:
            await browser.close()

if __name__=='__main__':
    harness.play=play
    harness.main()
