"""Touch controls on a phone-sized touch screen (Update 0.9): the stick moves the player, a drag
on the right half looks, buttons press their bindings, pause opens the menu, and a phone gets
the Low preset unless the player chose a quality.
    python3 tests/browser_touch.py
"""
import os, sys, asyncio
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
from playwright.async_api import async_playwright
import browser_playthrough as harness

OUT = Path(os.environ.get('HM_TEST_OUT', '/tmp/hm-touch')); OUT.mkdir(parents=True, exist_ok=True)

PE = '''([sel, type, x, y, id]) => { const el = document.querySelector(sel);
  el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true })); }'''

async def play(port):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
        try:
            ctx = await browser.new_context(viewport={'width': 844, 'height': 390}, has_touch=True, is_mobile=True, device_scale_factor=1)
            page = await ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.goto(f'http://localhost:{port}/?manual=1')
            await page.wait_for_function('window.READY || window.LOAD_ERROR', timeout=300000)
            await page.locator('#loading').wait_for(state='hidden')
            st = await page.evaluate("({touch: document.documentElement.classList.contains('touch'), q: game.settings.quality, hasTouch: !!game.touch})")
            assert st['touch'] and st['hasTouch'] and st['q'] == 'low', st
            print('  ok  a touch device gets touch controls and the Low preset:', st, flush=True)
            await page.tap('#menu-main [data-act=single]')
            await page.tap('#single-go')
            await page.evaluate('game.advance(300, 1/30, false)')
            vis = await page.evaluate("!document.querySelector('#touch').classList.contains('hidden')")
            assert vis
            # move: push the stick forward for 2 s
            before = await page.evaluate('({x: game.player.pos.x, z: game.player.pos.z, yaw: game.player.yaw})')
            await page.evaluate(PE, ['#touch .t-move', 'pointerdown', 120, 260, 11])
            await page.evaluate(PE, ['#touch .t-move', 'pointermove', 120, 215, 11])
            await page.evaluate('game.advance(60, 1/30, false)')
            mid = await page.evaluate('({x: game.player.pos.x, z: game.player.pos.z, sprint: game.player.sprinting})')
            await page.evaluate(PE, ['#touch .t-move', 'pointermove', 120, 190, 11])   # to the edge: sprint
            await page.evaluate('game.advance(30, 1/30, false)')
            sprint = await page.evaluate('game.player.sprinting')
            await page.evaluate(PE, ['#touch .t-move', 'pointerup', 120, 190, 11])
            await page.evaluate('game.advance(20, 1/30, false)')
            moved = ((mid['x'] - before['x']) ** 2 + (mid['z'] - before['z']) ** 2) ** 0.5
            assert moved > 2 and not mid['sprint'] and sprint, (moved, mid, sprint)
            print(f'  ok  the stick walks ({moved:.1f} m in 2 s) and sprints at its edge', flush=True)
            # look: drag on the right half
            await page.evaluate(PE, ['#touch .t-look', 'pointerdown', 600, 200, 12])
            await page.evaluate(PE, ['#touch .t-look', 'pointermove', 680, 180, 12])
            await page.evaluate('game.advance(2, 1/30, false)')
            await page.evaluate(PE, ['#touch .t-look', 'pointerup', 680, 180, 12])
            after = await page.evaluate('({yaw: game.player.yaw, pitch: game.player.pitch})')
            assert abs(after['yaw'] - before['yaw']) > 0.15, (before, after)
            print('  ok  dragging the right half turns the view', flush=True)
            # lighter button
            on0 = await page.evaluate('game.flashlight.on')
            for _ in range(6):
                await page.evaluate(PE, ['#touch .t-light', 'pointerdown', 0, 0, 13]); await page.evaluate('game.advance(1, 1/30, false)')
                await page.evaluate(PE, ['#touch .t-light', 'pointerup', 0, 0, 13]); await page.evaluate('game.advance(2, 1/30, false)')
                if await page.evaluate('game.flashlight.on') != on0: break
            assert await page.evaluate('game.flashlight.on') != on0
            # crouch is a toggle
            await page.evaluate(PE, ['#touch .t-crouch', 'pointerdown', 0, 0, 14]); await page.evaluate(PE, ['#touch .t-crouch', 'pointerup', 0, 0, 14])
            await page.evaluate('game.advance(10, 1/30, false)')
            assert await page.evaluate('game.player.crouching')
            print('  ok  lighter and crouch buttons work; crouch stays on', flush=True)
            await page.evaluate('game.step(0, true)')
            await page.screenshot(path=str(OUT / 'touch-play.png'), timeout=180000)
            # notes sheet, then pause
            await page.evaluate(PE, ['#touch .t-notes', 'pointerdown', 0, 0, 15]); await page.evaluate('game.advance(3, 1/30, true)')
            assert await page.evaluate("!document.querySelector('#inventory').classList.contains('hidden')")
            await page.screenshot(path=str(OUT / 'touch-notes.png'), timeout=180000)
            await page.evaluate(PE, ['#touch .t-notes', 'pointerdown', 0, 0, 15]); await page.evaluate('game.advance(3, 1/30, false)')
            await page.evaluate(PE, ['#touch .t-pause', 'pointerdown', 0, 0, 16]); await page.evaluate('game.advance(2, 1/30, true)')
            paused = await page.evaluate("({p: game.paused, hidden: document.querySelector('#touch').classList.contains('hidden')})")
            assert paused['p'] and paused['hidden'], paused
            await page.screenshot(path=str(OUT / 'touch-pause.png'), timeout=180000)
            await page.tap('#pause [data-act=resume]')
            await page.evaluate('game.advance(2, 1/30, false)')
            assert not await page.evaluate('game.paused')
            print('  ok  notes sheet opens; pause button pauses and Resume returns', flush=True)
            assert not errors, errors
            print('PASS touch controls', flush=True)
        finally:
            await browser.close()

if __name__ == '__main__':
    harness.play = play
    harness.main()
