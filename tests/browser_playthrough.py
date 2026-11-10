"""Scripted browser gameplay and regression checks against the real client/sim.

Uses actual keyboard interactions and deterministic game.advance(). For focused
objective coverage, threats are frozen and game.tp() positions the player beside
randomized objectives; this is not an unassisted survival playtest. Separate
checks below run movement, death/restart and live AI. Starts its own server.
Set CHROMIUM_EXECUTABLE_PATH to use an installed Chromium binary.
"""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]


async def play(port):
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=os.environ.get('CHROMIUM_EXECUTABLE_PATH'),
            args=['--use-gl=angle', '--use-angle=swiftshader',
                  '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
        )
        try:
            context = await browser.new_context(viewport={'width': 1280, 'height': 720})
            page = await context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(f'http://localhost:{port}/?manual=1&q=low')
            await page.wait_for_function('window.READY || window.LOAD_ERROR', timeout=300000)
            assert not await page.evaluate('window.LOAD_ERROR'), 'client must load'
            assert await page.evaluate("game.audio.playerBreathSource === 'recorded'"), 'recorded breathing must load'
            await page.locator('#loading').wait_for(state='hidden')

            async def advance(seconds):
                await page.evaluate('n => game.advance(n, 1/30, false)', round(seconds * 30))

            async def press(key):
                await page.keyboard.press(key)
                await advance(0.1)

            async def approach(item_id, station=False):
                found = await page.evaluate('''([id, station]) => {
                    const view = (station ? game.objViews.stations : game.objViews.items).get(id);
                    const def = view.def;
                    for (const radius of [1.25, 0.75, 1.7, 2]) {
                        for (let i = 0; i < 16; i++) {
                            const angle = i * Math.PI / 8;
                            const x = def.x + Math.cos(angle) * radius;
                            const z = def.z + Math.sin(angle) * radius;
                            if (!game.world.isPlayable(x, z)) continue;
                            game.tp(x, z, def.x, def.z);
                            // Allow gravity and collision correction to settle
                            // before accepting a fixture interaction position.
                            game.advance(30, 1/30, false);
                            const y = station ? def.y + 0.6 : view.y + 0.15;
                            // Aim after terrain/collision settles the fixture;
                            // the initial requested radius may have shifted.
                            const dx = def.x-game.camera.position.x, dz = def.z-game.camera.position.z;
                            game.look(Math.atan2(-dx,-dz), Math.atan2(y - game.camera.position.y, Math.hypot(dx,dz)));
                            game.advance(3, 1/30, false);
                            const prompt = ui._prompt || '';
                            if (prompt.toLowerCase().includes(def.name.toLowerCase())) return prompt;
                        }
                    }
                    return null;
                }''', [item_id, station])
                assert found, f'interaction prompt reachable for {item_id}'

            await page.click('#menu-main [data-act=single]')

            await page.click('#single-go')
            await advance(0.2)
            assert await page.evaluate("game.mode === 'playing' && game.myState === 'alive'")
            await page.evaluate('''() => {
                window.steps = 0;
                const original = game.audio.footstep.bind(game.audio);
                game.audio.footstep = (info, position, options) => {
                    if (!position) window.steps++;
                    return original(info, position, options);
                };
            }''')
            start = await page.evaluate('game.player.pos.toArray()')
            await page.keyboard.down('w')
            await advance(4)
            await page.keyboard.up('w')
            walked = await page.evaluate('game.player.pos.toArray()')
            assert sum((walked[i] - start[i]) ** 2 for i in (0, 2)) > 16
            assert await page.evaluate('window.steps') >= 4, 'walking plays surface footsteps'
            await advance(0.5)
            footsteps = await page.evaluate('window.steps')
            await press('Space')
            await advance(1)
            assert await page.evaluate('game.player.grounded && window.steps > ' + str(footsteps)), 'landing plays a grounded surface sound'
            print('  ok  real keyboard movement, local footsteps, jump and landing')

            await page.keyboard.down('w')
            await page.keyboard.down('Shift')
            await advance(2)
            await page.keyboard.up('Shift')
            await page.keyboard.up('w')
            assert await page.evaluate('game.player.stamina < 8'), 'sprint consumes stamina'
            await page.keyboard.down('c')
            await advance(1)
            assert await page.evaluate('game.player.crouch > 0.95'), 'crouch transition works'
            await page.keyboard.up('c')
            await advance(0.5)
            await press('f')
            assert not await page.evaluate('game.flashlight.on')
            await press('f')
            assert await page.evaluate('game.flashlight.on')
            print('  ok  sprint, crouch and flashlight controls')

            await page.evaluate('game.pause(true)')
            before = await page.evaluate('({battery:game.flashlight.battery,session:game.sessionT,sim:game.sim.time,pos:game.player.pos.toArray()})')
            await advance(30)
            after = await page.evaluate('({battery:game.flashlight.battery,session:game.sessionT,sim:game.sim.time,pos:game.player.pos.toArray()})')
            assert after == before, f'solo pause must freeze gameplay: {before} -> {after}'
            await page.click('#pause [data-act=resume]')
            await advance(0.5)
            assert await page.evaluate('game.sim.time') > after['sim']
            print('  ok  solo pause freezes battery, position and both clocks; resume continues')

            audio_check = await page.evaluate('''async () => {
                const audio = game.audio, camera = game.camera;
                const original = camera.position.clone();
                audio.setListener(camera);
                const step = creature => ({creature, surface:game.player.surface, water:0, brush:0, loud:0.35, speed:2.3});
                const position = distance => ({x:original.x + distance, y:original.y, z:original.z});
                const before = new Set(audio.active);
                audio.footstep(step('hv'), position(1));
                const handle = [...audio.active].find(h => !before.has(h) && h.range);
                const near = !!handle && handle.e.out.gain.value > 0;
                camera.position.x += 40;
                audio.setListener(camera);
                // AudioParam automation is applied on the audio thread, not
                // synchronously in this JavaScript evaluation.
                await new Promise(resolve => setTimeout(resolve, 80));
                const muted = !!handle && handle.e.out.gain.value === 0;
                camera.position.copy(original); audio.setListener(camera);
                const count = audio.active.size;
                audio.footstep(step('hv'), position(2.5));
                audio.footstep(step('sf'), position(2.5));
                const distantStepsSilent = audio.active.size === count;
                const routineSilent = audio.sfVocal('rumble', 1, position(30)) === null;
                const warning = audio.sfVocal('warn', 1, position(20));
                if (warning) warning.stop();
                if (handle) handle.stop();
                let exhales = 0;
                const exhale = audio.onExhale;
                audio.onExhale = strength => { exhales++; exhale(strength); };
                const temperature = game.temp;
                game.temp = -1;
                audio.breathIn = false; audio.breathT = 0;
                audio.update(1/30, {terror:0.3,cold:0.2,fear:0,exert:0,inGame:true});
                audio.onExhale = exhale;
                const condensation = game.breath.pool.some(p => p.s.visible && p.age === 0);
                game.temp = temperature;
                return {near,muted,distantStepsSilent,routineSilent,warning:!!warning,exhales,condensation};
            }''')
            assert all(audio_check[key] for key in ['near', 'muted', 'distantStepsSilent', 'routineSilent', 'warning']), audio_check
            assert audio_check['exhales'] == 1 and audio_check['condensation'], 'quieter breathing still drives condensation'
            print('  ok  real Web Audio distance cutoffs, retained close danger warning, and cold exhale callback')

            proximity = await page.evaluate('''async () => {
                const audio = game.audio, play = audio.play;
                const breaths = new Set(Object.entries(audio.lib).filter(([key]) => /^(in|out)(H)?[0-9]+$/.test(key)).map(([,value]) => value));
                const runs = [];
                audio.play = (buffer, options = {}) => {
                    if (buffer === audio.lib.heart) runs[runs.length - 1].heart = options;
                    if (breaths.has(buffer)) runs[runs.length - 1].breath = options;
                    return null;
                };
                try {
                    for (const distance of [100, 1]) {
                        const p = game.player.pos;
                        game.terror = 0;
                        game._terror(10, [p.x+distance,p.y,p.z,0,0,0,0,0,0,0,0]);
                        runs.push({exert:game.exert,tremor:game.player.tremor,cold:game.cold});
                        audio.breathT = audio.heartT = 0;
                        audio.update(1/30,{terror:game.terror,fear:game.fear,cold:game.cold,exert:game.exert,inGame:true});
                        await new Promise(resolve => setTimeout(resolve,80));
                        runs[runs.length-1].layers = [audio.cold.g.gain.value,audio.drone.g.gain.value,audio.drone.high.gain.value];
                    }
                } finally { audio.play = play; }
                return runs;
            }''')
            assert proximity[0]['exert'] == proximity[1]['exert'], proximity
            assert proximity[0]['breath'] == proximity[1]['breath'], proximity
            assert proximity[0]['heart'] == proximity[1]['heart'], proximity
            assert proximity[1]['cold'] > proximity[0]['cold'], proximity
            assert all(run['tremor'] == 0 and all(abs(gain) < 0.000001 for gain in run['layers']) for run in proximity), proximity
            print('  ok  near/far Helium Voice changes cold only; real breath/heartbeat playback remains identical')

            # Position fixtures isolate interactions from navigation and attacks.
            await page.evaluate('''() => {
                for (const actor of [game.sim.hv, game.sim.sf, game.sim.director, game.sim.mimic]) actor.update = () => {};
            }''')
            await approach('note_memo')
            await press('e')
            assert await page.evaluate("game.reading?.id === 'memo' && game.notesRead.includes('memo')")
            await press('e')
            assert await page.evaluate('game.reading === null')
            print('  ok  maintenance memo opens and closes with the interaction key')

            for item in ['fuel', 'fuse','crank']:
                await approach(item)
                await advance(0.5)
                glint = await page.evaluate('''id=>{
                    const it=game.objViews.items.get(id),fl=game.flashlight;
                    const dx=it.def.x-fl.light.position.x,dy=it.y+.15-fl.light.position.y,dz=it.def.z-fl.light.position.z;
                    const d=Math.hypot(dx,dy,dz);
                    return {opacity:it.glint.material.opacity,cos:(dx*fl.dir.x+dy*fl.dir.y+dz*fl.dir.z)/d,
                        d,on:fl.on,intensity:fl.light.intensity,eye:game.camera.position.toArray(),target:[it.def.x,it.y,it.def.z],
                        pitch:game.player.pitch,mode:game.mode,paused:game.paused};
                }''',item)
                assert glint['opacity'] > 0.01, f'{item} catches the flashlight: {glint}'
                await press('e')
                assert await page.evaluate('id => game.team[id] && game.objViews.items.get(id).held', item)
            print('  ok  fuel/fuse/handwheel glints and pickups update the shared inventory and visible items')

            for station in ['gen', 'relay','uplink', 'mast']:
                await approach(station, station=True)
                if station=='uplink':
                    for _ in range(8):
                        if await page.evaluate("game.objViews.stations.get('uplink').done"):break
                        await press('e');await advance(.45)
                    assert await page.evaluate("game.objViews.stations.get('uplink').done"),'actual E presses align the aerial'
                    continue
                hold = await page.evaluate('id => game.info.layout.stations.find(s => s.id === id).hold', station)
                await page.keyboard.down('e')
                await advance(hold + 0.6)
                await page.keyboard.up('e')
                await advance(0.1)
                assert await page.evaluate('id => game.objViews.stations.get(id).done', station), await page.evaluate('id => ({id,station:game.sim.obj.stations.find(s=>s.id===id),position:game.player.pos,simPlayer:game.sim.players.get(game.myId),prompt:ui._prompt,paused:game.paused})', station)
                if station in ['gen', 'relay']:
                    assert await page.evaluate('id => !!game.audio.loops[id]', station), f'{station} ambient equipment audio starts'
                if station == 'gen':
                    assert await page.evaluate('game.objViews.workLight.intensity > 0')
            assert await page.evaluate('game.extractOpen && game.objViews.extractLight.intensity > 0')
            print('  ok  three hold-E repairs plus the compass aerial complete; equipment sounds/lights and extraction strobes work')

            await page.evaluate('''() => {
                const ex = game.info.layout.extract;
                game.tp(ex.x, ex.z);
            }''')
            await advance(8)
            assert await page.evaluate("game.mode === 'ended' && game.result.result === 'won'")
            assert await page.locator('#end').is_visible()
            await page.click('#end [data-act=restart]')
            await advance(0.2)
            assert await page.evaluate("game.mode === 'playing' && game.myState === 'alive' && !game.extractOpen && !game.team.fuel && !game.team.fuse")
            print('  ok  extraction reaches victory and Play Again resets the session')

            await page.evaluate('''() => {
                const player = game.sim.players.get(game.myId);
                const hits = player.health;
                for (let i = 0; i < hits; i++) game.sim.damagePlayer(player, 'hv', game.sim.hv);
            }''')
            await advance(5)
            assert await page.evaluate("game.mode === 'ended' && game.result.result === 'lost'")
            await page.click('#end [data-act=restart]')
            await advance(0.2)
            assert await page.evaluate("game.myState === 'alive' && game.health === 3")
            print('  ok  lethal damage reaches game over and restart restores health')

            # Exercise actual AI attacks and their client health snapshots.
            # Position fixtures establish a close encounter; neither test calls
            # damagePlayer or directly puts the enemy in its damaging state.
            for creature in ['hv', 'sf']:
                attack = await page.evaluate('''async creature => {
                    const {pointAtDistance} = await import('/shared/math.js');
                    const at = pointAtDistance(game.world.trail,game.world.trailCum,500);
                    const target = pointAtDistance(game.world.trail,game.world.trailCum,506);
                    game.tp(target.x,target.z,at.x,at.z);
                    if(creature === 'hv') game.look(game.player.yaw+Math.PI,0);
                    // Let the real input transport deliver the fixture's player
                    // position before aiming/placing the enemy relative to it.
                    game.advance(3,1/30,false);
                    const sim = game.sim, player = sim.players.get(game.myId);
                    sim.state = 'play'; sim.time = 400; sim.director.enter('build');
                    sim[creature === 'hv' ? 'sf' : 'hv'].update = () => {};
                    game.flashlight.on = player.flash = creature === 'hv';
                    const actor = sim[creature];
                    Object.assign(actor,{x:at.x,z:at.z,y:game.world.heightAt(at.x,at.z)});
                    actor.yaw = actor.lookYaw = Math.atan2(player.x-at.x,player.z-at.z);
                    if(creature === 'hv') {
                        actor.target = game.myId;
                        actor.awareness.set(game.myId,1.5); actor.spotted.add(game.myId);
                        actor.setState('watch');
                    } else actor.setState('lurk');
                    for(let i=0;i<1800 && player.health===3;i++) game.advance(1,1/30,false);
                    game.advance(6,1/30,false);
                    return {server:player.health,client:game.health,state:actor.state};
                }''', creature)
                assert attack['server'] < 3 and attack['client'] == attack['server'], attack
                await page.evaluate('game.restart()')
                await advance(0.2)
            print('  ok  both real enemy AI attacks damage the player and update browser health')

            # Real AI stays enabled after restart. Follow the trail with actual
            # controller input for six simulated minutes, stopping on death.
            encounter = await page.evaluate('''async () => {
                const {pointAtDistance} = await import('/shared/math.js');
                const events = {};
                const off = game.net.on('ev', ({ev}) => { for (const e of ev) events[e.type] = (events[e.type] || 0) + 1; });
                // Observe real sound routing without queuing minutes of audio on
                // a real-time AudioContext during accelerated deterministic steps.
                const play = game.audio.play;
                game.audio.play = () => null;
                let elapsed = 0;
                try {
                    for (let i = 0; i < 360 * 30 && !game.ended; i++) {
                        const trail = game.world.trailInfo(game.player.pos.x, game.player.pos.z);
                        const target = pointAtDistance(game.world.trail, game.world.trailCum, Math.min(game.world.trailLength - 5, trail.along + 4));
                        game.look(Math.atan2(-(target.x - game.player.pos.x), -(target.z - game.player.pos.z)), -0.05);
                        game.input.keys.add(game.settings.bindings.forward);
                        game.advance(1, 1/30, false);
                        elapsed += 1/30;
                    }
                } finally {
                    game.input.keys.clear();
                    game.audio.play = play;
                    off();
                }
                return {elapsed,events,alive:game.myState,along:game.world.trailInfo(game.player.pos.x,game.player.pos.z).along};
            }''')
            assert encounter['elapsed'] >= 10, encounter
            assert encounter['along'] > 100, encounter
            assert encounter['events'].get('hv_vocal', 0) > 0, encounter
            print('  ok  live-AI trail traversal:', json.dumps(encounter))
            assert await page.evaluate('game.sf.root.scale.x === 0.6'), 'smaller skunk model scale'
            assert not errors, 'page errors: ' + '; '.join(errors)
            print('  ok  no uncaught browser errors')
            print('\nall scripted browser playthrough checks passed')
        finally:
            await browser.close()


def main():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    with tempfile.TemporaryFile(mode='w+') as log:
        server = subprocess.Popen(['node', str(ROOT / 'server/server.js')], env={**os.environ, 'PORT': str(port)}, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 30
            while True:
                try:
                    with urllib.request.urlopen(f'http://localhost:{port}/healthz', timeout=1) as response:
                        assert response.read() == b'ok'
                    break
                except OSError:
                    if server.poll() is not None or time.monotonic() >= deadline:
                        log.seek(0)
                        raise RuntimeError('server failed to start: ' + log.read())
                    time.sleep(0.1)
            asyncio.run(play(port))
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == '__main__':
    main()
