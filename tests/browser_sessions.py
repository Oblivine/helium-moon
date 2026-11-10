"""Browser/session regression: no ghost players after changing modes or retries.

Needs Python Playwright and Chromium. Optionally set CHROMIUM_EXECUTABLE_PATH
to an installed Chromium binary. Starts and stops its own local game server.
Run: python3 tests/browser_sessions.py
"""
import asyncio
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]


async def run(port):
    async with async_playwright() as playwright:
        launch = {"args": [
            "--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required",
        ]}
        if os.environ.get("CHROMIUM_EXECUTABLE_PATH"):
            launch["executable_path"] = os.environ["CHROMIUM_EXECUTABLE_PATH"]
        browser = await playwright.chromium.launch(**launch)
        try:
            context = await browser.new_context(viewport={"width": 1280, "height": 720})
            page = await context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.goto(f"http://localhost:{port}/?manual=1&q=low")
            await page.wait_for_function("window.READY || window.LOAD_ERROR", timeout=300000)
            assert not await page.evaluate("window.LOAD_ERROR"), "game must load"
            await page.locator("#loading").wait_for(state="hidden")

            # One lightweight protocol client observes the real browser's room.
            observer = await context.new_page()
            await observer.goto(f"http://localhost:{port}/healthz")
            await observer.evaluate("""() => new Promise((resolve, reject) => {
                window.observed = [];
                window.peer = new WebSocket(`ws://${location.host}/ws`);
                peer.onerror = reject;
                peer.onmessage = event => {
                    const message = JSON.parse(event.data); observed.push(message);
                    if (message.t === 'welcome') { window.peerId = message.id; resolve(); }
                };
            })""")
            await page.click("#menu-main [data-act=multi]")
            await page.fill("#mp-name", "Host")
            await page.click("#mp-create")
            await page.wait_for_function("game.lobby && game.lobby.code")
            code = await page.evaluate("game.lobby.code")
            await observer.evaluate("code => peer.send(JSON.stringify({t:'join', code}))", code)
            await observer.wait_for_function("observed.some(m => m.t === 'lobby' && m.players.length === 2)")
            await page.wait_for_function("game.lobby.players.length === 2")
            await page.evaluate("window.oldSocket = game.net.ws")

            # Real menu action: replacing the transport must leave the old room.
            await page.click("#menu-main [data-act=single]")
            await page.click('#single-go')
            await page.wait_for_function("game.mode === 'playing' && !game.net.networked")
            await page.wait_for_function("oldSocket.readyState === WebSocket.CLOSED")
            await observer.wait_for_function("observed.some(m => m.t === 'lobby' && m.host === peerId && m.players.length === 1)")
            assert await page.evaluate("game.lobby === null && game.voice.peers.size === 0")
            assert await page.evaluate("game.myId === 'p1'")
            print("  ok  lobby -> single player closes the old socket, clears peers, and migrates host")

            await page.evaluate("game.quitToMenu(true)")
            await page.click("#menu-main [data-act=multi]")
            await page.fill("#mp-code", "AAAAA" if code != "AAAAA" else "BBBBB")
            async with page.expect_websocket() as rejected_socket:
                await page.click("#mp-join")
            failed_socket = await rejected_socket.value
            await page.wait_for_function("document.querySelector('#mp-status').textContent.includes('No lobby')")
            assert await page.evaluate("game.net === null && game.lobby === null && game.myId === null")
            if not failed_socket.is_closed():
                await failed_socket.wait_for_event("close", timeout=10000)
            assert failed_socket.is_closed()
            print("  ok  rejected join releases its connection and preserves the error panel")

            await page.click("#mp-create")
            await page.wait_for_function("game.lobby && game.lobby.code")
            assert await page.evaluate("ui._me === game.net.myId() && game.lobby.host === game.net.myId()")
            assert await page.locator("#lb-start").is_visible()
            print("  ok  retry creates a fresh lobby using the current connection's identity")

            # Actual multiplayer chat must not leave text focus stuck on restart.
            await page.click("#lb-start")
            await page.wait_for_function("game.mode === 'playing' && game.net.networked")
            await page.keyboard.press("Enter")
            await page.evaluate("game.advance(3,1/30,false)")
            assert await page.evaluate("ui.chatOpen && game.input.textFocus")
            await page.fill("#chat-input", "unsent old-session text")
            await page.evaluate("window.previousInfo=game.info;game.restart()")
            await page.wait_for_function("game.info !== previousInfo")
            assert await page.evaluate("!ui.chatOpen && !game.input.textFocus && document.querySelector('#chat-input').classList.contains('hidden')"), "restart must cancel old chat focus"
            start=await page.evaluate("game.player.pos.toArray()")
            await page.keyboard.down("w")
            await page.evaluate("game.advance(30,1/30,false)")
            await page.keyboard.up("w")
            end=await page.evaluate("game.player.pos.toArray()")
            assert sum((end[i]-start[i])**2 for i in (0,2))>.2, "movement resumes after chat cancellation"
            await page.keyboard.press("Enter")
            await page.evaluate("game.advance(3,1/30,false)")
            assert await page.evaluate("ui.chatOpen")
            await page.evaluate("game.quitToMenu(true)")
            assert await page.evaluate("!ui.chatOpen && !game.input.textFocus && !document.querySelector('#chat-input').value")
            print("  ok  restart and quit cancel unsent chat and release movement focus")
            await page.click("#menu-main [data-act=multi]")
            await page.click("#mp-create")
            await page.wait_for_function("game.lobby && game.lobby.code")
            await page.click("#lb-start")
            await page.wait_for_function("game.mode === 'playing'")
            await page.keyboard.press("Enter")
            await page.evaluate("game.advance(3,1/30,false)")
            assert await page.evaluate("ui.chatOpen")
            # Dedicated HM_TEST server supplies a real death/end event; the
            # fixture tests UI lifecycle, not enemy pursuit or damage balance.
            await page.evaluate("game.net.send({t:'debug',cmd:'down'})")
            await page.wait_for_function("game.ended")
            assert await page.evaluate("!ui.chatOpen && !game.input.textFocus")
            await page.evaluate("game.quitToMenu(true)")
            print("  ok  authoritative death/end event cancels open chat immediately")


            await page.click("#menu-main [data-act=multi]")
            await page.click("#mp-create")
            await page.wait_for_function("game.lobby && game.lobby.code")
            await page.click("#lb-leave")
            await page.wait_for_function("game.net === null && game.lobby === null")
            await observer.evaluate("peer.close()")
            assert not errors, "unexpected page errors: " + "; ".join(errors)
            print("  ok  leave completes without page errors")
            print("\nall browser session tests passed")
        finally:
            await browser.close()


def main():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    with tempfile.TemporaryFile(mode="w+") as log:
        server = subprocess.Popen(
            ["node", str(ROOT / "server/server.js")],
            env={**os.environ, "PORT": str(port), "HM_TEST": "1"}, stdout=log, stderr=log,
        )
        try:
            deadline = time.monotonic() + 30
            while True:
                try:
                    with urllib.request.urlopen(f"http://localhost:{port}/healthz", timeout=1) as response:
                        assert response.read() == b"ok"
                    break
                except OSError:
                    if server.poll() is not None or time.monotonic() >= deadline:
                        log.seek(0)
                        raise RuntimeError("server failed to become ready: " + log.read())
                    time.sleep(0.1)
            asyncio.run(run(port))
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


if __name__ == "__main__":
    main()
