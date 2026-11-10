"""Real-client planned glimpse timing, accounting and physical escape.
Fixtures establish an already-planned appearance; perception remains real.
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
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            await page.goto(f'http://localhost:{port}/?manual=1&q=low')
            await page.wait_for_function('window.READY || window.LOAD_ERROR',timeout=300000)
            assert not await page.evaluate('window.LOAD_ERROR')
            await page.locator('#loading').wait_for(state='hidden')
            await page.click('#menu-main [data-act=single]')
            await page.click('#single-go')
            output=Path(os.environ.get('HM_ARTIFACT_DIR','/tmp/helium-moon-reveals'))
            output.mkdir(parents=True,exist_ok=True)
            for kind in ['watcher','crossing']:
                mid=await page.evaluate('''async(kind)=>{
                  game.restart();
                  const {pointAtDistance}=await import('/shared/math.js');
                  const {onScreen}=await import('/shared/sim/perception.js');
                  const sim=game.sim,hv=sim.hv,p=sim.players.get(game.myId),w=game.world;
                  sim.state='play';sim.time=400;sim.director.update=()=>{};sim.director.enter('build');
                  sim.sf.update=()=>{};sim.mimic.update=()=>{};
                  const update=hv.update.bind(hv);hv.update=()=>{};
                  let at=null;
                  game.flashlight.on=true;
                  for(const along of [500,600,400,700,300]){
                    const a=pointAtDistance(w.trail,w.trailCum,along),b=pointAtDistance(w.trail,w.trailCum,along+28);
                    game.tp(b.x,b.z,a.x,a.z,0);game.advance(15,1/30,false);
                    hv.place(a.x,a.z);
                    if(hv.dist(p)>20 && onScreen(w,p,hv.x,hv.y,hv.z)){at=a;break;}
                  }
                  if(!at)throw new Error('No clear real-world glimpse fixture');
                  hv.update=update;hv.target=p.id;hv.awareness.set(p.id,.8);hv.spotted.add(p.id);
                  hv.lookYaw=hv.yaw=Math.atan2(p.x-hv.x,p.z-hv.z);hv.setState('reveal');
                  hv.reveal={kind,pid:p.id,phase:kind==='watcher'?'show':'cross',t:0,end:[at.x+8,at.z]};
                  if(kind==='crossing')hv.planTo(at.x+8,at.z,'direct');
                  const reports=[],report=sim.director.onReveal.bind(sim.director);
                  sim.director.onReveal=k=>{reports.push(k);report(k);};
                  window.revealCheck={reports,frames:0,maxStep:0,escapeAt:null};
                  game.advance(12,1/30,false);game.step(0,true);
                  return {state:hv.state,reports:[...reports],exposure:hv.reveal?.exposureT,
                    visible:game.hv.root.visible,screen:onScreen(w,p,hv.x,hv.y,hv.z),health:game.health};
                }''',kind)
                assert mid['state']=='reveal' and mid['reports']==[kind] and mid['screen'] and mid['visible'] and mid['health']==3,mid
                # Manual simulation is frozen at the glimpse; let only the UI's
                # real-time opening title finish fading before the artifact.
                # The opening title fades on a real-time 7.5 s timer + CSS transition; on slow
                # software-rendered machines that exceeded 15 s (flaky). Hide it deterministically:
                # it is DOM UI over the canvas and not under test here.
                await page.evaluate("void (document.querySelector('#intro').classList.remove('show'), document.querySelector('#intro').style.display='none')")
                await page.screenshot(path=str(output/f'{kind}-glimpse.png'),timeout=120000)
                end=await page.evaluate('''()=>{
                    const hv=game.sim.hv,c=window.revealCheck;
                    // Owner: a visible scare lasts only 1–2 seconds, then flees.
                    for(let i=0;i<300;i++){
                      const x=hv.x,z=hv.z;game.advance(1,1/30,false);
                      c.maxStep=Math.max(c.maxStep,Math.hypot(hv.x-x,hv.z-z));
                      if(hv.state!=='reveal' && c.escapeAt===null)c.escapeAt=i/30+.4;
                    }
                    return {...c,health:game.health};
                }''')
                assert end['reports']==[kind] and end['escapeAt'] is not None and 1<=end['escapeAt']<=2.1 and end['maxStep']<.8 and end['health']==3,end
                print(f'PASS actual {kind} glimpse/escape:',mid,end,flush=True)
            shadow=await page.evaluate('''async()=>{
                game.restart();
                const {pointAtDistance}=await import('/shared/math.js');
                const {onScreen}=await import('/shared/sim/perception.js');
                const sim=game.sim,hv=sim.hv,p=sim.players.get(game.myId),w=game.world;
                sim.state='play';sim.time=400;sim.director.update=()=>{};
                sim.director.nextChaseAt=640;
                sim.sf.update=sim.mimic.update=sim.wildlife.update=()=>{};
                const update=hv.update.bind(hv);hv.update=()=>{};
                game.flashlight.on=true;let found=false;
                for(const along of [500,600,400,700,300]){
                    const a=pointAtDistance(w.trail,w.trailCum,along),b=pointAtDistance(w.trail,w.trailCum,along+28);
                    game.tp(b.x,b.z,a.x,a.z,0);game.advance(15,1/30,false);hv.place(a.x,a.z);
                    if(hv.dist(p)>20&&onScreen(w,p,hv.x,hv.y,hv.z)){found=true;break;}
                }
                if(!found)throw Error('No real shadow discovery sightline');
                hv.update=update;hv.target=p.id;hv.setState('reveal');hv.scareVisibleUntil=null;
                hv.reveal={kind:'shadow',pid:p.id,phase:'follow',t:0,followFor:25};
                // Hold the shadow's destination to isolate the real turn/LOS
                // discovery from path placement; navigation is checked separately.
                const observationSpot=hv.observationSpot;
                hv.observationSpot=()=>[hv.x,hv.z];
                const face=()=>Math.atan2(-(hv.x-p.x),-(hv.z-p.z));
                game.look(face()+Math.PI,0);game.advance(15,1/30,false);
                const unseen=hv.state==='reveal'&&!onScreen(w,p,hv.x,hv.y,hv.z);
                hv.observationSpot=observationSpot;
                game.look(face(),0);const start=sim.time;
                let escapeAt=null,maxStep=0;
                for(let i=0;i<45;i++){
                    const x=hv.x,z=hv.z;game.advance(1,1/30,false);
                    maxStep=Math.max(maxStep,Math.hypot(hv.x-x,hv.z-z));
                    if(hv.state==='retreat'&&escapeAt===null)escapeAt=sim.time-start;
                }
                return {unseen,escapeAt,maxStep,chasing:sim.director.chasing,health:p.health};
            }''')
            assert shadow['unseen'] and shadow['escapeAt'] is not None and shadow['escapeAt']<=.5,shadow
            assert shadow['maxStep']<.8 and not shadow['chasing'] and shadow['health']==3,shadow
            print('PASS actual behind-view shadow flees on turn/discovery:',shadow,flush=True)
            assert not errors,errors
        finally:
            await browser.close()

if __name__=='__main__':
    harness.play=play
    harness.main()
