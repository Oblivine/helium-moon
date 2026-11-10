// Entry point: settings -> UI -> game (load everything behind the loading screen).
import * as THREE from 'three';
import { Settings } from './core/settings.js';
import { UI } from './ui/ui.js';
import { Game } from './game/game.js';
import { isTouchDevice } from './ui/touch.js';

const params = new URLSearchParams(location.search);
const settings = Settings.load();
// Phones and tablets (Update 0.9): touch controls, and Low quality unless the player picked one.
const touch = params.get('touch') === '1' || settings.touchControls === 'on' || (settings.touchControls !== 'off' && params.get('touch') !== '0' && isTouchDevice());
if (touch) {
  document.documentElement.classList.add('touch');
  if (!settings.qualityChosen) { settings.quality = 'low'; settings.renderScale = Math.min(settings.renderScale, 0.8); }
}
if (params.get('q')) settings.quality = params.get('q');
if (params.get('msaa') !== null) settings.preset.msaa = +params.get('msaa');   // test/debug override
const ui = new UI(settings);
const game = new Game(document.getElementById('game'), settings, ui, { manual: params.get('manual') === '1', debug: params.get('debug') === '1', touch });
ui.bind(game);
window.game = game; window.ui = ui; window.THREE = THREE;

function webglOK() {
  try { const c = document.createElement('canvas'); return !!c.getContext('webgl2'); } catch (e) { return false; }
}

if (!webglOK()) {
  ui.loadError('This game needs WebGL 2. Try a current Chrome, Edge, Firefox or Safari with hardware acceleration enabled.');
} else {
  game.init((f, t) => ui.setLoading(f, t)).then(() => {
    ui.loaded();
    window.READY = true;
    if (params.get('autostart') === '1') { ui.showMenu(false); game.startSingle(settings.playerName || 'You'); }
  }).catch((e) => {
    console.error(e);
    ui.loadError('Something went wrong while loading: ' + (e && e.message ? e.message : e));
    window.LOAD_ERROR = String(e && e.stack || e);
  });
}
