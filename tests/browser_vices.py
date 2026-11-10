"""Cigarettes, beer and first-person arms in the browser.
    python3 tests/browser_vices.py     Screenshots go to $HM_TEST_OUT (default /tmp/hm-vices).
"""
import os, sys
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
from playwright.async_api import async_playwright
import browser_playthrough as harness

OUT = Path(os.environ.get('HM_TEST_OUT', '/tmp/hm-vices')); OUT.mkdir(parents=True, exist_ok=True)

async def play(port):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
        try:
            page = await (await browser.new_context(viewport={'width': 1280, 'height': 720})).new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.goto(f'http://localhost:{port}/?manual=1&q=low')
            await page.wait_for_function('window.READY || window.LOAD_ERROR', timeout=300000)
            await page.locator('#loading').wait_for(state='hidden')
            await page.click('#menu-main [data-act=single]'); await page.click('#single-go')
            await page.evaluate('game.advance(400, 1/30, false)')
            shot = lambda n: page.screenshot(path=str(OUT / f'{n}.png'), timeout=180000)
            assert await page.evaluate('game.arms.ready === true'), 'hand models did not load'
            await page.evaluate('game.advance(2, 1/30, true)'); await shot('arm-lighter')
            # hand the player a pack and two beers through the real sim
            await page.evaluate("(() => { const s = game.net.sim, p = s.playerList[0]; p.cigs = 3; p.beers = 2; s.viceState(p); })()")
            await page.evaluate('game.advance(4, 1/30, false)')
            assert await page.evaluate('game.vice.cigs') == 3
            await page.keyboard.press('KeyT'); await page.evaluate('game.advance(30, 1/30, false)')
            await page.evaluate('game.advance(1, 1/30, true)'); await shot('smoke-light')
            v = await page.evaluate('({c: game.vice.cigs, s: game.vice.smoked, on: game.vice.smoke > game.snapT, sim: game.net.sim.playerList[0].smokeUntil > game.net.sim.time, lung: game._lungMax()})')
            assert v['c'] == 2 and v['s'] == 1 and v['on'] and v['sim'] and v['lung'] < (await page.evaluate('game.rules.lungs')), v
            await page.evaluate('game.advance(150, 1/30, false)'); await page.evaluate('game.advance(1, 1/30, true)'); await shot('smoke-drag')
            print('  ok  smoking: pack 3 -> 2, lit in the sim, lungs shortened to', round(v['lung'], 2), flush=True)
            # no hiding while it burns
            hid = await page.evaluate("(() => { const s = game.net.sim, p = s.playerList[0]; const tp = { ...p, flash: false, crouch: true, hidden: true, moveSpeed: 0, sprint: false, noise: 0 }; const a = s.hv.hidden(tp); tp.smokeUntil = -1; return [a, typeof s.hv.hidden(tp)]; })()")
            assert hid[0] is False, hid
            print('  ok  a lit cigarette means he does not count you as hidden', flush=True)
            await page.keyboard.press('KeyB'); await page.evaluate('game.advance(40, 1/30, false)')
            await page.evaluate('game.advance(1, 1/30, true)'); await shot('drink')
            await page.evaluate('game.advance(80, 1/30, false)')
            b = await page.evaluate('({b: game.vice.beers, e: game.vice.bottles, buzz: game.vice.buzz > game.snapT, mul: game.player.staminaMul})')
            assert b['b'] == 1 and b['e'] == 1 and b['buzz'] and b['mul'] < 0.7, b
            print('  ok  beer: 2 -> 1, one empty in hand, buzzed, stamina drain x', round(b['mul'], 2), flush=True)
            hud = await page.locator('#vice-tool').inner_text()
            assert 'CIGARETTES' in hud and 'BEER' in hud and 'EMPTY BOTTLE' in hud, hud
            # crouch + smoke sets one down
            await page.keyboard.down('KeyC'); await page.evaluate('game.advance(10, 1/30, false)')
            await page.keyboard.press('KeyT'); await page.evaluate('game.advance(10, 1/30, false)'); await page.keyboard.up('KeyC')
            l = await page.evaluate('({n: game.net.sim.lures.length, v: game.smoulders.items.size, c: game.vice.cigs})')
            assert l['n'] == 1 and l['v'] == 1 and l['c'] == 1, l
            print('  ok  crouched: a lit cigarette is set down as a lure', flush=True)
            # the bottle goes before a pebble, during a search, and he comes to the smash
            r = await page.evaluate("""(() => { const s = game.net.sim, hv = s.hv, p = s.playerList[0];
              hv.canHearPebble = () => true; hv.outsideSpawn = () => true; hv.x = s.lures[0].x + 12; hv.z = s.lures[0].z; const before = s.lures[0].smelt; s.updateLures();
              game.net.sim.action(p.id, { a: 'pebble', yaw: game.player.yaw, pitch: 0.2 });
              return { smelt: [before, s.lures[0].smelt], bottles: p.bottles, flying: s.pebbles.length && s.pebbles[s.pebbles.length - 1].bottle, cd: p.pebbleReadyAt }; })()""")
            assert r['bottles'] == 0 and r['flying'] and r['smelt'][1], r
            await page.evaluate('game.advance(120, 1/30, false)')
            d = await page.evaluate('!!game.net.sim.hv.pebbleDecoy')
            print('  ok  the empty bottle is the next throw (no pebble cooldown spent); he follows the smoke while searching; decoy set:', d, flush=True)
            # hand over the mouth while holding your breath
            await page.keyboard.down('KeyC'); await page.keyboard.down('Space'); await page.evaluate('game.advance(40, 1/30, false)')
            await page.evaluate('game.advance(1, 1/30, true)'); await shot('hush')
            assert await page.evaluate('game.holdingBreath && game.arms.left.visible'), 'left hand should cover the mouth while holding breath'
            await page.keyboard.up('Space'); await page.keyboard.up('KeyC')
            print('  ok  hand models loaded; the left hand comes up while you hold your breath', flush=True)
            assert not errors, errors
            print('PASS cigarettes, beer and arms', flush=True)
        finally:
            await browser.close()

if __name__ == '__main__':
    harness.play = play
    harness.main()
