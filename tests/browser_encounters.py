"""Focused real-client checks for screen-triggered encounters and crawl rendering.
Position fixtures establish the encounter; actual AI supplies all movement/damage.
Uses the same isolated-server harness as browser_playthrough.py.
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
            for seed,flash in [(2,True),(2,False),(7,True)]:
                first=await page.evaluate('''async([seed,flash])=>{
                    const random=Math.random;
                    try { Math.random=()=>seed/2**31;game.restart(); } finally { Math.random=random; }
                    const {pointAtDistance}=await import('/shared/math.js');
                    const {CONFIG}=await import('/shared/config.js');const MAXH=CONFIG.PLAYER.MAX_HEALTH;
                    const at=pointAtDistance(game.world.trail,game.world.trailCum,500);
                    const to=pointAtDistance(game.world.trail,game.world.trailCum,506);
                    game.tp(to.x,to.z,at.x,at.z);game.look(game.player.yaw+Math.PI,0);game.flashlight.on=flash;game.advance(6,1/30,false);
                    const sim=game.sim,p=sim.players.get(game.myId),hv=sim.hv;
                    sim.state='play';sim.time=400;sim.sf.update=()=>{};sim.mimic.update=()=>{};
                    hv.place(at.x,at.z);hv.yaw=hv.lookYaw=Math.atan2(p.x-hv.x,p.z-hv.z);hv.setState('roam');
                    const initial={seed:sim.seed,target:hv.target,awareness:hv.awareness.size};
                    let chased=false,aborted=false;
                    for(let i=0;i<1800 && p.health===MAXH;i++){
                        game.advance(1,1/30,false);
                        chased ||= hv.state==='chase';
                        aborted ||= hv.state==='collapse'&&p.health===MAXH;
                    }
                    const released={state:hv.state,held:p.heldUntil,x:hv.x,z:hv.z,flags:hv.snapshot()[7]};
                    let maxSpeed=0,maxStep=0,maxStepRatio=0,crawlSeen=false;
                    for(let i=0;i<45;i++){
                        game.look(Math.atan2(-(hv.x-game.player.pos.x),-(hv.z-game.player.pos.z)),0);
                        const x=hv.x,z=hv.z,time=sim.time;game.advance(1,1/30,false);
                        maxSpeed=Math.max(maxSpeed,hv.speed);
                        maxStep=Math.max(maxStep,Math.hypot(hv.x-x,hv.z-z));
                        // The simulation ticks independently of render frames;
                        // allow its existing 1.5x collision-correction bound.
                        const budget=CONFIG.HV.RETREAT*(sim.time-time)*1.5+.0001;
                        maxStepRatio=Math.max(maxStepRatio,Math.hypot(hv.x-x,hv.z-z)/budget);
                        crawlSeen ||= !!(game.hv.flags&16) && game.hv.anim.blend.crawl>.5;
                    }
                    return {initial,chased,aborted,server:p.health,client:game.health,chasing:sim.director.chasing,
                        clientChasing:game.chasing,hum:game.audio.huntHum?.level,released,
                        escape:{maxSpeed,maxStep,maxStepRatio,crawlSeen,moved:Math.hypot(hv.x-released.x,hv.z-released.z)}};
                }''',[seed,flash])
                assert first['initial']=={'seed':seed,'target':None,'awareness':0},first
                assert first['chased'] and first['client']==first['server'] and not first['chasing'],first
                # Puppet: a beam in his face no longer stops him (only hiding from him does)
                assert first['server']<3 and not first['aborted'],first
                assert first['released']['state']=='retreat' and first['released']['held'] is None,first
                assert not first['released']['flags']&2048 and first['released']['flags']&16,first
                assert first['escape']['maxSpeed']>8 and first['escape']['moved']>2 and first['escape']['maxStepRatio']<1.01,first
                assert first['escape']['crawlSeen'] and not first['clientChasing'] and first['hum']==0,first
                print(f'  ok  normal first sighting becomes a long hunt that ends in his grab (seed {seed}, flashlight {flash}):',first,flush=True)
            await page.evaluate('game.restart()')
            result=await page.evaluate('''async()=>{
                const {pointAtDistance}=await import('/shared/math.js');
                const at=pointAtDistance(game.world.trail,game.world.trailCum,500);
                const to=pointAtDistance(game.world.trail,game.world.trailCum,502.3);
                game.tp(to.x,to.z,at.x,at.z);game.look(game.player.yaw+Math.PI,0);
                game.advance(6,1/30,false);
                const sim=game.sim,p=sim.players.get(game.myId),hv=sim.hv;
                sim.state='play';sim.time=400;sim.director.update=()=>{};sim.director.enter('build');
                sim.sf.update=()=>{};sim.mimic.update=()=>{};
                hv.place(at.x,at.z);hv.yaw=hv.lookYaw=Math.atan2(p.x-hv.x,p.z-hv.z);
                hv.target=p.id;hv.awareness.set(p.id,2);hv.spotted.add(p.id);hv.setState('chase');hv.speed=6.6;
                hv.huntHideUntil=sim.time;hv.huntPhase='search';hv.huntEndsAt=sim.time+35;
                hv.lastSeenChase={x:p.x,z:p.z,t:sim.time};hv.huntContactAt=sim.time;
                for(let i=0;i<1800&&p.health===3;i++)game.advance(1,1/30,false);
                game.advance(30,1/30,false);
                return {server:p.health,client:game.health};
            }''')
            assert result['server']<3 and result['client']==result['server'],result
            print('  ok  unseen committed chase lands a real hit without a sighting:',result,flush=True)
            escape=await page.evaluate('''async()=>{
                game.restart();game.advance(6,1/30,false);
                const {pointAtDistance}=await import('/shared/math.js');
                const at=pointAtDistance(game.world.trail,game.world.trailCum,500),to=pointAtDistance(game.world.trail,game.world.trailCum,506);
                game.tp(to.x,to.z,at.x,at.z);game.advance(3,1/30,false);
                const sim=game.sim,p=sim.players.get(game.myId),hv=sim.hv;
                sim.state='play';sim.time=400;sim.director.update=()=>{};sim.sf.update=()=>{};sim.mimic.update=()=>{};
                hv.place(at.x,at.z);hv.target=p.id;hv.awareness.set(p.id,2);hv.spotted.add(p.id);hv.startChase(p);
                // Stage the last second of a survived search to inspect the rendered ending.
                // Full 15–20 / 30–40 s phase timing is exercised in hunt_search.test.mjs.
                hv.huntHideUntil=sim.time;hv.huntPhase='search';hv.huntEndsAt=sim.time+1;
                game.flashlight.on=false;hv.hidden=()=>true;
                let lost=null,start=null;
                for(let i=0;i<1850&&lost==null;i++){game.advance(1,1/30,false);if(hv.state==='collapse'){lost=i/30;start=[hv.x,hv.z];}}
                if(!start)return {lost,health:p.health,state:hv.state};
                const pitch=Math.atan2(hv.y+.25-(p.y+1.62),Math.hypot(hv.x-p.x,hv.z-p.z));
                game.look(Math.atan2(-(hv.x-p.x),-(hv.z-p.z)),pitch);
                game.advance(6,1/30,false); // let the collapse snapshot reach the view buffer
                const fell={flags:game.hv.flags};game.advance(45,1/30,false);
                const stayed=Math.hypot(hv.x-start[0],hv.z-start[1]);
                game.look(game.player.yaw+Math.PI,0);game.advance(30,1/30,false);
                return {lost,fell,stayed,gone:Math.hypot(hv.x-start[0],hv.z-start[1]),health:p.health,state:hv.state};
            }''')
            assert escape['lost'] is not None and escape['health']==3 and escape['fell']['flags']&256 and escape['stayed']<.05 and escape['gone']>20,escape
            print('  ok  hiding ends the hunt: he goes limp, lies there while watched, and is gone once you look away:',escape,flush=True)
            pose=await page.evaluate('''async()=>{
                game.restart();game.advance(9,1/30,false);
                const {pointAtDistance}=await import('/shared/math.js');
                const at=pointAtDistance(game.world.trail,game.world.trailCum,500),end=pointAtDistance(game.world.trail,game.world.trailCum,470);
                const sim=game.sim,p=sim.players.get(game.myId),hv=sim.hv;
                sim.state='play';sim.time=400;sim.director.update=()=>{};sim.sf.update=()=>{};sim.mimic.update=()=>{};
                game.tp(at.x+3,at.z+2,at.x,at.z);game.look(game.player.yaw+Math.PI,0);game.advance(3,1/30,false);   // looking away: unwatched
                hv.place(at.x,at.z);hv.target=p.id;hv.awareness.set(p.id,2);hv.spotted.add(p.id);
                hv.retreatFrom(p,false,true);hv.path=game.world.findPath(hv.x,hv.z,end.x,end.z);hv.pathI=1;
                game.advance(15,1/30,false);
                const result={flags:game.hv.flags,blend:game.hv.anim.blend.crawl,head:game.hv.headPos().y-game.hv.pos.y,speed:hv.speed};
                // Hold a real snapshot after motion so a rendered frame can be inspected.
                sim.hv.update=()=>{};game.tp(hv.x+3,hv.z+2,hv.x,hv.z);game.look(game.player.yaw,-.3);
                game.advance(12,1/30,false);game.step(0,true);
                document.querySelector('#intro').style.display='none';
                return result;
            }''')
            assert pose['flags']&16 and pose['blend']>.99 and pose['head']<.95 and pose['speed']>8,pose
            print('  ok  unwatched, the retreat renders as the low four-limb operated crawl:',pose,flush=True)
            output=Path(os.environ.get('HM_ARTIFACT_DIR','/tmp/helium-moon-encounters'))
            output.mkdir(parents=True,exist_ok=True)
            # artifact only (no assertion). HM_SKIP_ARTIFACTS=1 skips it on machines where a full
            # software-rendered 1280x720 frame exceeds memory; the default keeps it.
            if not os.environ.get('HM_SKIP_ARTIFACTS'):
                await page.screenshot(path=str(output/'operated-crawl.png'),timeout=120000)   # same artifact timeout as ground contacts (#13)
            for state in ['prowl','investigate']:
                skunk=await page.evaluate("""async(state)=>{
                  game.restart();game.advance(9,1/30,false);
                  const {pointAtDistance}=await import('/shared/math.js');
                  const at=pointAtDistance(game.world.trail,game.world.trailCum,500);
                  // Exercise close light/ambush acquisition inside the current
                  // 6.5 m lighter range, rather than a random 10 m investigation.
                  const to=pointAtDistance(game.world.trail,game.world.trailCum,503);
                  game.tp(to.x,to.z,at.x,at.z);game.flashlight.on=true;
                  const sim=game.sim,p=sim.players.get(game.myId),sf=sim.sf;
                  sim.state='play';sim.time=400;sim.director.update=()=>{};sim.director.enter('build');
                  sim.hv.update=()=>{};sim.mimic.update=()=>{};
                  Object.assign(sf,{x:at.x,z:at.z,y:game.world.heightAt(at.x,at.z)});
                  sf.setState(state,{inv:{x:p.x,z:p.z,t:sim.time,pid:p.id}});
                  game.advance(240,1/30,false);
                  return {server:p.health,client:game.health,state:sf.state};
                }""",state)
                assert skunk['server']<3 and skunk['client']==skunk['server'],skunk
                print(f'  ok  flashlight does not suppress skunk attack from {state}:',skunk,flush=True)
            route=await page.evaluate("""async()=>{
                game.restart();game.advance(9,1/30,false);
                const {CONFIG}=await import('/shared/config.js');
                const sim=game.sim,sf=sim.sf,goal=[389,450];
                sim.state='play';sim.time=400;sim.director.update=()=>{};
                sim.hv.update=()=>{};sim.mimic.update=()=>{};
                Object.assign(sf,{x:388.67781822079417,z:460.7093538507989});
                sf.y=game.world.heightAt(sf.x,sf.z);sf.setState('prowl');sf.planTo(...goal);
                let maxStep=0;
                sf.update=dt=>{
                    if(!sf.path)sf.planTo(...goal);
                    const x=sf.x,z=sf.z;sf.follow(dt,CONFIG.SF.SCURRY);
                    maxStep=Math.max(maxStep,Math.hypot(sf.x-x,sf.z-z));
                };
                game.tp(sf.x+6,sf.z+5,sf.x,sf.z);
                game.advance(600,1/30,false);
                return {remaining:Math.hypot(sf.x-goal[0],sf.z-goal[1]),maxStep,
                    clientError:Math.hypot(game.sf.pos.x-sf.x,game.sf.pos.z-sf.z)};
            }""")
            assert route['remaining']<1 and route['maxStep']<.4 and route['clientError']<.6,route
            print('  ok  actual fallen-log route recovers with physical movement and matching client pose:',route,flush=True)
            assert not errors,errors
            print('all focused browser encounter checks passed',flush=True)
        finally:
            await browser.close()

if __name__=='__main__':
    harness.play=play
    harness.main()
