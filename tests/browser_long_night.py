"""Update 0.9 "The Long Night" in the browser: difficulty panel, Field Journal, What's New,
Game settings tab, HUD (compass, lungs, hint card, radio subtitle), a balloon, the night report.
    python3 tests/browser_long_night.py            (desktop)
    HM_PHONE=1 python3 tests/browser_long_night.py (phone, landscape)
Screenshots go to $HM_TEST_OUT (default /tmp/hm-longnight).
"""
import os, sys
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
from playwright.async_api import async_playwright
import browser_playthrough as harness

PHONE = os.environ.get('HM_PHONE') == '1'
OUT = Path(os.environ.get('HM_TEST_OUT', '/tmp/hm-longnight')); OUT.mkdir(parents=True, exist_ok=True)
TAG = 'phone' if PHONE else 'desk'

async def shot(page, name):
    await page.screenshot(path=str(OUT / f'{TAG}-{name}.png'), timeout=180000)

async def play(port):
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'])
        try:
            if PHONE: ctx = await browser.new_context(viewport={'width': 844, 'height': 390}, has_touch=True, is_mobile=True, device_scale_factor=1)
            else: ctx = await browser.new_context(viewport={'width': 1280, 'height': 720})
            page = await ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            await page.goto(f'http://localhost:{port}/?manual=1&q=low')
            await page.wait_for_function('window.READY || window.LOAD_ERROR', timeout=300000)
            await page.locator('#loading').wait_for(state='hidden')
            click = page.tap if PHONE else page.click
            # menu panels
            await click('#whats-new'); assert await page.locator('.menu-panel >> text=Hold your breath').count()
            await shot(page, 'whatsnew')
            await click('#menu-main [data-act=journal]'); await click('[data-jtab=feats]')
            assert await page.locator('ul.feats li').count() >= 10
            await click('[data-jtab=notes]'); await shot(page, 'journal')
            await click('#menu-main [data-act=settings]'); await click('[data-tab=game]')
            assert await page.locator('[data-rehint]').count()
            print('  ok  What\'s New, Field Journal and the Game settings tab open', flush=True)
            await click('#menu-main [data-act=single]')
            await click('[data-diff=visitor]'); await shot(page, 'difficulty')
            assert await page.evaluate("game.settings.difficulty") == 'visitor'
            await click('#single-go')
            await page.evaluate('game.advance(400, 1/30, false)')
            r = await page.evaluate('game.rules && game.rules.id')
            assert r == 'visitor', r
            print('  ok  the chosen difficulty reaches the sim:', r, flush=True)
            # a balloon right in front of the player, and HUD elements
            await page.evaluate('''() => { const s = game.net.sim, p = game.player.pos, y = game.player.yaw;
              s.balloons.place(p.x - Math.sin(y) * 4, p.z - Math.cos(y) * 4, 'test'); }''')
            await page.evaluate('game.advance(30, 1/30, false)')
            n = await page.evaluate('game.balloons.items.size')
            assert n >= 1, n
            await page.evaluate("game.ui.subtitle('COUNTY DISPATCH', 'Unit four, we copy. Get to the highway bridge.')")
            await page.evaluate("game.ui.hint('He is searching for you. Stay low, dark and still.', 60000)")
            await page.evaluate("game.ui.lungs(0.4, true, false)")
            await page.evaluate('game.advance(1, 1/30, true)')
            comp = await page.evaluate("!document.querySelector('#compass').classList.contains('hidden') && document.querySelectorAll('#compass i').length")
            assert comp, comp
            await shot(page, 'hud')
            print(f'  ok  compass ({comp} marks), hint, subtitle, lungs and a balloon ({n}) render', flush=True)
            # end the night and read the report
            await page.evaluate("game.net.sim.playerList[0].state = 'escaped'; game.net.sim.finish('won')")
            await page.evaluate('game.advance(150, 1/30, false)')
            await page.wait_for_function("!document.querySelector('#end').classList.contains('hidden')", timeout=60000)
            rank = await page.locator('#end .rank b').inner_text()
            cells = await page.locator('#end .report > div').count()
            await shot(page, 'report')
            assert rank and cells == 8, (rank, cells)
            j = await page.evaluate("({n: game.journal.nights, e: game.journal.escapes, best: !!game.journal.best.visitor})")
            assert j['n'] == 1 and j['e'] == 1 and j['best'], j
            print(f'  ok  night report: rank "{rank}", {cells} stats; journal filed {j}', flush=True)
            assert not errors, errors
            print('PASS long night', flush=True)
        finally:
            await browser.close()

if __name__ == '__main__':
    harness.play = play
    harness.main()
