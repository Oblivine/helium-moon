"""Boot a generated hosted package locally using its actual publication manifest.
This validates packaging; it does not publish to Claude's hosting service.
"""
import asyncio
import functools
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from playwright.async_api import async_playwright

ROOT=Path(__file__).resolve().parents[1]

async def check(port,commit):
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_EXECUTABLE_PATH'),args=[
            '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'])
        try:
            page=await browser.new_page(viewport={'width':960,'height':540})
            errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
            await page.goto(f'http://localhost:{port}/helium-moon.html?manual=1&q=low')
            await page.wait_for_function('window.READY || window.LOAD_ERROR',timeout=300000)
            assert not await page.evaluate('window.LOAD_ERROR')
            assert await page.evaluate('HM_BUILD')==commit
            assert await page.locator('.build-id').text_content()=='Build '+commit
            assert await page.evaluate("game.audio.playerBreathSource==='recorded'")
            assert await page.evaluate("game.arms.ready===true"),'first-person hand models must load in the hosted package'
            await page.locator('#loading').wait_for(state='hidden')
            await page.click('#menu-main [data-act=single]')
            await page.click('#single-go')
            await page.evaluate('game.advance(60,1/30,false)')
            assert await page.evaluate("game.mode==='playing' && game.myState==='alive'")
            await page.evaluate('game.quitToMenu(true)')
            await page.click('#menu-main [data-act=multi]')
            assert not await page.locator('#mp-create').count(),'embedded page must explain its limits'
            assert 'game server' in await page.locator('#panel').inner_text()
            assert not errors,errors
            print(f'  ok  hosted package {commit}: model aliases, recorded audio, visible version, solo start and embedded notice',flush=True)
        finally:
            await browser.close()

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*args):pass

def main():
    with tempfile.TemporaryDirectory(prefix='helium-hosted-') as folder:
        out=Path(folder)
        subprocess.run(['python',str(ROOT/'tools/build_hosted.py'),str(out)],check=True)
        manifest=json.loads((out/'files.json').read_text())
        for name,entry in manifest.items():
            src=entry['from'] if isinstance(entry,dict) else entry
            target=out/name;target.parent.mkdir(parents=True,exist_ok=True)
            target.symlink_to(ROOT/src)
        commit=subprocess.check_output(['git','rev-parse','--short','HEAD'],cwd=ROOT,text=True).strip()
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(QuietHandler,directory=folder))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:asyncio.run(check(server.server_port,commit))
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':main()
