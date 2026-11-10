"""Keyboard pebble use plus two real server clients sharing flight/impact.

Controlled search fixtures isolate the tool; not an unassisted survival run.
"""
import asyncio
import os
import time
from playwright.async_api import async_playwright
import browser_playthrough as harness


async def instrument(page):
    await page.evaluate('''()=>{
        window.pebbleEvents=[];window.pebbleSounds=0;
        const event=game._onEvent.bind(game),impact=game.audio.pebbleImpact.bind(game.audio);
        game._onEvent=e=>{if(e.type.startsWith('pebble_'))pebbleEvents.push(e);event(e);};
        game.audio.pebbleImpact=(...args)=>{const h=impact(...args);if(h)pebbleSounds++;return h;};
        ui.clickToPlay=()=>{};
    }''')


async def play(port):
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE_PATH'),args=[
            '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
            '--autoplay-policy=no-user-gesture-required'])
        errors=[]
        async def load():
            context=await browser.new_context(viewport={'width':640,'height':360})
            page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            await page.goto(f'http://localhost:{port}/?manual=1&q=low&msaa=0')
            await page.wait_for_function('window.READY || window.LOAD_ERROR',timeout=300000)
            assert not await page.evaluate('window.LOAD_ERROR')
            await instrument(page)
            return context,page
        try:
            context,page=await load()
            await page.click('#menu-main [data-act=single]')
            await page.click('#single-go')
            await page.evaluate('''async()=>{
                const {pointAtDistance}=await import('/shared/math.js');
                const sim=game.sim,hv=sim.hv,w=game.world,p=sim.players.get(game.myId);
                sim.state='play';sim.time=400;
                sim.hv.update=sim.sf.update=sim.mimic.update=sim.director.update=()=>{};
                const a=pointAtDistance(w.trail,w.trailCum,500),b=pointAtDistance(w.trail,w.trailCum,530);
                const h=pointAtDistance(w.trail,w.trailCum,490);
                game.tp(a.x,a.z,b.x,b.z);game.flashlight.on=false;
                hv.place(h.x,h.z);hv.target=p.id;hv.setState('chase');
                hv.huntHideUntil=sim.time;hv.huntPhase='search';hv.huntEndsAt=sim.time+60;hv.huntContactAt=-999;
                hv.lookYaw=hv.yaw=Math.atan2(hv.x-p.x,hv.z-p.z);
                hv.lastSeenChase={x:p.x,z:p.z,t:sim.time};
                window.pebbleMemory={...hv.lastSeenChase};window.pebbleEnd=hv.huntEndsAt;
                game.advance(4,1/30,false);
            }''')
            await page.keyboard.press('g');await page.evaluate('game.advance(4,1/30,true)')
            flight=await page.evaluate('''()=>({throws:pebbleEvents.filter(e=>e.type==='pebble_throw').length,
                visible:[...game.pebbles.active.values()].some(p=>p.mesh.visible),
                hud:document.querySelector('#pebble-tool').textContent})''')
            assert flight['throws']==1 and flight['visible'] and 'PEBBLE' in flight['hud'],flight
            await page.evaluate('game.advance(75,1/30,false)')
            impact=await page.evaluate('''()=>({event:pebbleEvents.find(e=>e.type==='pebble_impact'),
                decoy:game.sim.hv.pebbleDecoy,memory:game.sim.hv.lastSeenChase,original:pebbleMemory,
                sameEnd:game.sim.hv.huntEndsAt===pebbleEnd,sounds:pebbleSounds})''')
            assert impact['event']['distracted'] and impact['decoy'],impact
            assert impact['memory']==impact['original'] and impact['sameEnd'] and impact['sounds']>0,impact
            await page.keyboard.press('g');await page.evaluate('game.advance(3,1/30,false)')
            assert await page.evaluate("pebbleEvents.filter(e=>e.type==='pebble_throw').length===1")
            await page.evaluate('game.advance(550,1/30,false)')
            await page.keyboard.press('g');await page.evaluate('game.advance(4,1/30,false)')
            assert await page.evaluate("pebbleEvents.filter(e=>e.type==='pebble_throw').length===2"),'unlimited reuse after 20 seconds'
            await page.evaluate('game.restart();game.advance(4,1/30,false)')
            assert await page.evaluate('game.pebbles.active.size===0 && game.pebbleReadyAt===0'),'restart clears tool state'
            print('PASS keyboard G, visible server arc, actual impact audio/search lure, cooldown/reuse and restart:',flight,impact,flush=True)
            await context.close()

            ca,a=await load();cb,b=await load();pages=[a,b]
            for p in pages:await p.click('#menu-main [data-act=multi]')
            await a.fill('#mp-name','Pebble lead');await a.click('#mp-create')
            await a.wait_for_function('game.lobby?.code');code=await a.evaluate('game.lobby.code')
            await b.fill('#mp-name','Pebble helper');await b.fill('#mp-code',code);await b.click('#mp-join')
            await b.wait_for_function('game.lobby?.players.length===2');await a.click('#lb-start')
            for p in pages:await p.wait_for_function("game.mode==='playing'")

            async def pump(seconds):
                end=time.monotonic()+seconds
                while time.monotonic()<end:
                    for p in pages:await p.evaluate('game.advance(2,1/30,false)')
                    await asyncio.sleep(.04)

            for i,p in enumerate(pages):
                await p.evaluate('''async(i)=>{
                    const {pointAtDistance}=await import('/shared/math.js'),w=game.world;
                    const a=pointAtDistance(w.trail,w.trailCum,500+i*2),b=pointAtDistance(w.trail,w.trailCum,530);
                    game.tp(a.x,a.z,b.x,b.z);game.flashlight.on=false;
                    game.net.send({t:'debug',cmd:'tp',x:a.x,z:a.z});
                }''',i)
            await pump(.4)
            await a.evaluate("game.net.send({t:'debug',cmd:'pebble_phase',phase:'stalk'})")
            await pump(.2);await a.keyboard.press('g');await pump(.25)
            assert await a.evaluate("pebbleEvents.some(e=>e.type==='pebble_status'&&e.reason==='search') && !pebbleEvents.some(e=>e.type==='pebble_throw')"),'stalking refuses use without spending cooldown'
            await a.evaluate("game.net.send({t:'debug',cmd:'pebble_phase',phase:'search'})")
            await pump(.2);await a.keyboard.press('g');await pump(.25)
            first=[await p.evaluate("pebbleEvents.filter(e=>e.type==='pebble_throw')")for p in pages]
            assert len(first[0])==1 and first[0]==first[1],first
            # B's cooldown is independent; A cannot bypass its gate with a raw packet.
            await a.evaluate("game.net.send({t:'act',a:'pebble',yaw:game.player.yaw,pitch:game.player.pitch})")
            await b.keyboard.press('g');await pump(.25)
            assert await a.evaluate("pebbleEvents.some(e=>e.type==='pebble_status'&&e.reason==='cooldown')")
            await pump(2)
            results=[await p.evaluate('''()=>({throws:pebbleEvents.filter(e=>e.type==='pebble_throw'),
                impacts:pebbleEvents.filter(e=>e.type==='pebble_impact'),readyAt:game.me[12],
                sounds:pebbleSounds,visible:[...game.pebbles.active.values()].some(p=>p.mesh.visible)})''')for p in pages]
            assert len(results[0]['throws'])==2 and results[0]['throws']==results[1]['throws'],results
            assert len(results[0]['impacts'])==2 and results[0]['impacts']==results[1]['impacts'],results
            assert all(r['readyAt']>400 and r['sounds']>0 for r in results),results
            assert not errors,errors
            summary=[{'throws':len(r['throws']),'impacts':len(r['impacts']),'readyAt':r['readyAt'],
                      'sounds':r['sounds'],'visible':r['visible']} for r in results]
            print('PASS two actual network clients share flights/impacts, reject stalking, enforce server cooldown and allow independent throws:',summary,flush=True)
            await ca.close();await cb.close()
        finally:
            await browser.close()


if __name__=='__main__':
    harness.play=play
    harness.main()
