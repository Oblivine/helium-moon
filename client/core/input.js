// Keyboard / mouse input with pointer lock, plus a drag-to-look fallback for
// embedded frames that refuse pointer lock.
export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas; this.settings = settings;
    this.keys = new Set(); this.pressed = new Set();
    this.dx = 0; this.dy = 0;
    this.locked = false; this.dragLook = false; this.dragging = false;
    this.enabled = false; this.lockFailed = false;
    this.onLockChange = null; this.textFocus = false;
    window.addEventListener('keydown', (e) => {
      if (this.textFocus) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (this.enabled && (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
      if (this.enabled && (e.ctrlKey || e.metaKey) && ['KeyW', 'KeyS', 'KeyD', 'KeyA'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.dragging = false; });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked || (this.dragLook && this.dragging)) { this.dx += e.movementX || 0; this.dy += e.movementY || 0; }
    });
    canvas.addEventListener('mousedown', () => {
      if (!this.enabled) return;
      if (!this.locked) { if (!this.lockFailed) this.requestLock(); this.dragging = true; }
    });
    window.addEventListener('mouseup', () => { this.dragging = false; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => { this.lockFailed = true; this.dragLook = true; if (this.onLockChange) this.onLockChange(false); });
    let tx = 0, ty = 0;
    canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; tx = t.clientX; ty = t.clientY; }, { passive: true });
    canvas.addEventListener('touchmove', (e) => { if (!this.enabled) return; const t = e.touches[0]; this.dx += (t.clientX - tx) * 1.5; this.dy += (t.clientY - ty) * 1.5; tx = t.clientX; ty = t.clientY; }, { passive: true });
  }

  requestLock() {
    if (this.noLock) return;   // touch screens: look is a drag, never pointer lock
    try {
      const p = this.canvas.requestPointerLock && this.canvas.requestPointerLock({ unadjustedMovement: false });
      if (p && p.catch) p.catch(() => { this.lockFailed = true; this.dragLook = true; });
    } catch (e) { this.lockFailed = true; this.dragLook = true; }
  }
  exitLock() { try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* ignore */ } }

  down(action) {
    const b = this.settings.bindings;
    if (action === 'crouch') return this.keys.has(b.crouch) || this.keys.has(b.crouchAlt) || this.keys.has('ControlRight');
    if (action === 'sprint') return this.keys.has(b.sprint) || this.keys.has('ShiftRight');
    return this.keys.has(b[action]);
  }
  hit(action) {
    const b = this.settings.bindings;
    if (action === 'crouch') return this.pressed.has(b.crouch) || this.pressed.has(b.crouchAlt);
    return this.pressed.has(b[action]);
  }
  hitCode(code) { return this.pressed.has(code); }
  consumeLook() {
    let dx = this.dx, dy = this.dy;
    if (this.keys.has('ArrowLeft')) dx -= 9; if (this.keys.has('ArrowRight')) dx += 9;
    if (this.keys.has('ArrowUp')) dy -= 6; if (this.keys.has('ArrowDown')) dy += 6;
    this.dx = 0; this.dy = 0;
    return [dx, dy];
  }
  endFrame() { this.pressed.clear(); }
}
