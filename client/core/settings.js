// Player settings, persisted per browser (localStorage guarded - it can be unavailable).
import { QUALITY_PRESETS } from '../../shared/config.js';

const KEY = 'heliummoon.settings.v2';

export const DEFAULT_BINDINGS = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  sprint: 'ShiftLeft', crouch: 'KeyC', crouchAlt: 'ControlLeft', jump: 'Space',
  interact: 'KeyE', flashlight: 'KeyF', inventory: 'Tab', chat: 'Enter', talk: 'KeyV',
  leanLeft: 'KeyQ', leanRight: 'KeyR',
  camouflage: 'KeyX',
  pebble: 'KeyG',
  ping: 'KeyZ',
};

export const BINDING_LABELS = {
  forward: 'Move forward', back: 'Move back', left: 'Strafe left', right: 'Strafe right',
  sprint: 'Sprint', crouch: 'Crouch', crouchAlt: 'Crouch (alt)', jump: 'Jump', interact: 'Interact / revive',
  flashlight: 'Lighter', inventory: 'Objectives & notes', chat: 'Text chat', talk: 'Push to talk',
  leanLeft: 'Lean left', leanRight: 'Lean right',
  camouflage: 'Use camouflage blanket',
  pebble: 'Throw a pebble (search distraction)',
  ping: 'Ping a spot for your team',
};

const DEFAULTS = {
  quality: 'high', renderScale: 1.0, sensitivity: 1.0, invertY: false, fov: 72,
  masterVolume: 0.9, sfxVolume: 1.0, ambienceVolume: 1.0, voiceVolume: 1.0,
  headBob: 1.0, cameraShake: 1.0, filmGrain: 1.0, showFps: false, adaptiveRes: true,
  // Update 0.9
  brightness: 1.0, compass: true, hints: true, touchControls: 'auto', difficulty: 'ranger', subtitles: true,
  playerName: '', serverUrl: '', bindings: { ...DEFAULT_BINDINGS },
  // microphone / voice chat / mimicry (all off until the player turns them on)
  micEnabled: false, micDevice: '', voiceMode: 'ptt', micSensitivity: 0.5, mimicOptIn: false,
  // Developer mode (owner, Oct 25): test tools, off by default
  devMode: false, devSkipDread: true, devInvincible: false, devOverlay: true,
};

export class Settings {
  constructor() {
    Object.assign(this, structuredClone(DEFAULTS));
    this.listeners = new Set();
  }
  static load() {
    const s = new Settings();
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const v = JSON.parse(raw);
        for (const k of Object.keys(DEFAULTS)) if (k in v) s[k] = v[k];
        s.bindings = { ...DEFAULT_BINDINGS, ...(v.bindings || {}) };
      }
    } catch (e) { /* storage unavailable: defaults */ }
    if (!QUALITY_PRESETS[s.quality]) s.quality = 'high';
    s.qualityChosen = false;
    try { s.qualityChosen = !!(window.localStorage.getItem(KEY) && 'quality' in JSON.parse(window.localStorage.getItem(KEY)) && JSON.parse(window.localStorage.getItem(KEY)).qualityChosen); } catch (e) { /* defaults */ }
    return s;
  }
  save() {
    try {
      const o = {}; for (const k of Object.keys(DEFAULTS)) o[k] = this[k];
      o.qualityChosen = !!this.qualityChosen;
      window.localStorage.setItem(KEY, JSON.stringify(o));
    } catch (e) { /* ignore */ }
    for (const fn of this.listeners) fn(this);
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  get preset() { return QUALITY_PRESETS[this.quality]; }
  keyName(code) {
    if (!code) return '—';
    return code.replace(/^Key/, '').replace(/^Digit/, '').replace('Left', ' L').replace('Right', ' R').replace('Control', 'Ctrl');
  }
}
