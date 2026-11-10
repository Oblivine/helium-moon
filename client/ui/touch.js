// Touch controls for phones and tablets (owner, Oct 25 2026: "make it playable on mobile").
// Left thumb: a floating move stick (push to the edge to sprint). Right thumb: drag to look.
// Buttons press the same key bindings the keyboard uses, so every game system works unchanged.
export const isTouchDevice = () => {
  try {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const fine = window.matchMedia && window.matchMedia('(any-pointer: fine)').matches;
    return !!(coarse || ((navigator.maxTouchPoints || 0) > 0 && !fine));
  } catch (e) { return false; }
};

const cap = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already released */ } };
const STICK_R = 56;          // px from centre to the edge of the stick
const LOOK_GAIN = 1.7;       // px of drag -> mouse-equivalent counts

export class TouchControls {
  constructor(input, settings) {
    this.input = input; this.settings = settings;
    this.visible = false; this.crouchOn = false; this.notesOn = false; this.blanketOn = false;
    this.stick = null; this.look = null;
    const root = this.root = document.createElement('div');
    root.id = 'touch'; root.className = 'hidden';
    root.innerHTML = `
      <div class="t-zone t-move"></div>
      <div class="t-zone t-look"></div>
      <div class="t-stick hidden"><div class="t-knob"></div></div>
      <button class="t-btn t-pause" data-k="pause" aria-label="Pause">II</button>
      <button class="t-btn t-notes" data-k="inventory" aria-label="Objectives and notes">NOTES</button>
      <div class="t-cluster">
        <button class="t-btn t-use" data-k="interact" aria-label="Use">USE</button>
        <button class="t-btn t-light" data-k="flashlight" aria-label="Lighter">LIGHTER</button>
        <button class="t-btn t-crouch" data-k="crouch" aria-label="Crouch">CROUCH</button>
        <button class="t-btn t-jump" data-k="jump" aria-label="Jump, or hold your breath while crouched">JUMP</button>
        <button class="t-btn t-pebble" data-k="pebble" aria-label="Throw a pebble">PEBBLE</button>
        <button class="t-btn t-blanket hidden" data-k="camouflage" aria-label="Camouflage blanket">BLANKET</button>
        <button class="t-btn t-ping hidden" data-k="ping" aria-label="Ping for your team">PING</button>
      </div>
      <div class="t-rotate">Turn your phone sideways to play.</div>`;
    document.body.appendChild(root);
    this.stickEl = root.querySelector('.t-stick'); this.knob = root.querySelector('.t-knob');
    const move = root.querySelector('.t-move'), look = root.querySelector('.t-look');
    const opts = { passive: false };
    // ---- move stick (floating: it appears under your thumb)
    move.addEventListener('pointerdown', (e) => {
      e.preventDefault(); if (this.stick) return;
      this.stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
      cap(move, e);
      this.stickEl.style.left = `${e.clientX}px`; this.stickEl.style.top = `${e.clientY}px`;
      this.stickEl.classList.remove('hidden'); this._stick(0, 0);
    }, opts);
    move.addEventListener('pointermove', (e) => {
      if (!this.stick || e.pointerId !== this.stick.id) return;
      e.preventDefault(); this._stick(e.clientX - this.stick.x, e.clientY - this.stick.y);
    }, opts);
    const endStick = (e) => { if (!this.stick || e.pointerId !== this.stick.id) return; this.stick = null; this._stick(0, 0); this.stickEl.classList.add('hidden'); };
    move.addEventListener('pointerup', endStick); move.addEventListener('pointercancel', endStick);
    // ---- look
    look.addEventListener('pointerdown', (e) => {
      e.preventDefault(); if (this.look) return;
      this.look = { id: e.pointerId, x: e.clientX, y: e.clientY }; cap(look, e);
    }, opts);
    look.addEventListener('pointermove', (e) => {
      if (!this.look || e.pointerId !== this.look.id || !this.input.enabled) return;
      e.preventDefault();
      this.input.dx += (e.clientX - this.look.x) * LOOK_GAIN; this.input.dy += (e.clientY - this.look.y) * LOOK_GAIN;
      this.look.x = e.clientX; this.look.y = e.clientY;
    }, opts);
    const endLook = (e) => { if (this.look && e.pointerId === this.look.id) this.look = null; };
    look.addEventListener('pointerup', endLook); look.addEventListener('pointercancel', endLook);
    // ---- buttons
    for (const b of root.querySelectorAll('.t-btn')) {
      const k = b.dataset.k;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (k === 'pause') { this._tap('Escape'); return; }
        if (k === 'crouch') { this.crouchOn = !this.crouchOn; this._hold(this._code('crouch'), this.crouchOn); b.classList.toggle('on', this.crouchOn); this._press(this._code('crouch')); return; }
        if (k === 'inventory') { this.notesOn = !this.notesOn; this._hold(this._code('inventory'), this.notesOn); b.classList.toggle('on', this.notesOn); this.root.classList.toggle('reading', this.notesOn); return; }
        if (k === 'camouflage') { this.blanketOn = !this.blanketOn; this._hold(this._code('camouflage'), this.blanketOn); b.classList.toggle('on', this.blanketOn); return; }
        b.classList.add('on'); cap(b, e);
        this._press(this._code(k)); this._hold(this._code(k), true);
      }, opts);
      const up = () => { if (k === 'crouch' || k === 'inventory' || k === 'pause' || k === 'camouflage') return; b.classList.remove('on'); this._hold(this._code(k), false); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    }
  }

  _code(action) { return this.settings.bindings[action]; }
  _press(code) { if (code && !this.input.keys.has(code)) this.input.pressed.add(code); }
  _hold(code, on) { if (!code) return; if (on) this.input.keys.add(code); else this.input.keys.delete(code); }
  _tap(code) { this.input.pressed.add(code); }

  // stick offset in px -> knob position + the four move keys (+ sprint at the edge)
  _stick(dx, dy) {
    const d = Math.hypot(dx, dy), k = d > STICK_R ? STICK_R / d : 1;
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    const x = dx / STICK_R, y = dy / STICK_R, m = Math.min(1, d / STICK_R);
    const b = this.settings.bindings;
    this._hold(b.forward, y < -0.35); this._hold(b.back, y > 0.35);
    this._hold(b.left, x < -0.35); this._hold(b.right, x > 0.35);
    this._hold(b.sprint, m > 0.95 && y < -0.5);
  }

  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on; this.root.classList.toggle('hidden', !on);
    if (!on) {
      // let go of everything so nothing stays held across menus
      this.stick = null; this.look = null; this.stickEl.classList.add('hidden'); this._stick(0, 0);
      for (const a of ['interact', 'flashlight', 'jump']) this._hold(this._code(a), false);
      for (const b of this.root.querySelectorAll('.t-btn:not(.t-crouch):not(.t-notes)')) b.classList.remove('on');
      for (const a of ['pebble', 'ping']) this._hold(this._code(a), false);
      if (this.notesOn) { this.notesOn = false; this._hold(this._code('inventory'), false); this.root.querySelector('.t-notes').classList.remove('on'); this.root.classList.remove('reading'); }
    }
  }

  // per-frame state from the game: which optional buttons exist, and what Jump means right now
  state({ blanket = false, ping = false, breath = false, use = '' } = {}) {
    const q = (c) => this.root.querySelector(c);
    q('.t-blanket').classList.toggle('hidden', !blanket);
    q('.t-ping').classList.toggle('hidden', !ping);
    if (!blanket && this.blanketOn) { this.blanketOn = false; this._hold(this._code('camouflage'), false); q('.t-blanket').classList.remove('on'); }
    const j = q('.t-jump'), label = breath ? 'BREATH' : 'JUMP';
    if (j.textContent !== label) j.textContent = label;
    const u = q('.t-use'); u.classList.toggle('ready', !!use);
  }

  reset() {
    this.crouchOn = false; this._hold(this._code('crouch'), false); this.root.querySelector('.t-crouch').classList.remove('on');
  }
}
