// DOM user interface: main menu, settings (graphics, audio, microphone + mimicry
// consent, controls/keybinds), multiplayer lobby, HUD, notes, pause and end screens.
import { CONFIG, QUALITY_PRESETS } from '../../shared/config.js';
import { BUILD_COMMIT } from '../build.js';
import { BINDING_LABELS, DEFAULT_BINDINGS } from '../core/settings.js';
import { FEATS } from '../core/journal.js';
import { NOTES } from '../../shared/sim/objectives.js';
import { WSTransport, defaultServerUrl } from '../net/transport.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MIMIC_TEXT = `When this is on, short phrases you say while transmitting (about 1–4 seconds) are held briefly in this browser's memory. Now and then Helium Voice plays one back — pitched up and distorted — from somewhere in the trees behind you or a teammate, and that phrase is then deleted. Phrases are never saved to disk, uploaded to any speech service, or used for training, and expire after two minutes. Turning this off, turning the microphone off, or leaving the session deletes everything immediately. Only your microphone is captured, and only while you are transmitting.`;

export class UI {
  constructor(settings) {
    this.s = settings;
    this.game = null;
    this.debugOn = /[?&]debug=1/.test(location.search);
    this.chatOpen = false;
    this.voice = { mic: 'off' };
    this.el = {
      loading: $('#loading'), loadFill: $('#load-fill'), loadText: $('#load-text'),
      menu: $('#menu'), panel: $('#panel'), hud: $('#hud'), pause: $('#pause'), pausePanel: $('#pause-panel'),
      end: $('#end'), endTitle: $('#end-title'), endText: $('#end-text'), endLobby: $('#end-lobby'),
      objectives: $('#objectives'), prompt: $('#prompt'), stamina: $('#stamina-fill'), battery: $('#battery-fill'), meters: $('#meters'),
      team: $('#team'), toast: $('#toast'), chatLog: $('#chat-log'), chatInput: $('#chat-input'), progressRing: $('#progress-ring'), progressArc: $('#progress-arc'),
      inventory: $('#inventory'), debug: $('#debug'), fade: $('#fade'), click: $('#click-to-play'),
    };
    this._extraDom();
    // Holding Tab keeps pointer lock. Route wheel input into the map/notebook so
    // the player can read the whole sheet without losing control focus.
    window.addEventListener('wheel',e=>{
      if(!document.pointerLockElement)return;
      const panel=!this.el.note.classList.contains('hidden')?this.el.note.querySelector('.paper'):
        !this.el.inventory.classList.contains('hidden')?this.el.inventory:null;
      if(panel){panel.scrollTop+=e.deltaY;e.preventDefault();}
    },{passive:false});
    const build = window.HM_BUILD || BUILD_COMMIT;
    if (typeof build === 'string' && build && !build.startsWith('$Format:')) {
      const version=document.createElement('span');version.className='build-id';
      version.textContent='Build '+build.slice(0,12);
      $('#menu-foot').append(version);
    }
    $('#whats-new')?.addEventListener('click', () => this.openWhatsNew(this.el.panel));
    $('#menu-main').addEventListener('click', (e) => { const a = e.target.closest('button')?.dataset.act; if (a) this._menuAct(a); });
    $('#pause').addEventListener('click', (e) => { const a = e.target.closest('nav button')?.dataset.act; if (a) this._pauseAct(a); });
    $('#end').addEventListener('click', (e) => { const a = e.target.closest('button')?.dataset.act; if (a) this._endAct(a); });
    this.el.click.addEventListener('click', () => { this.game && this.game.input.requestLock(); this.clickToPlay(false); });
    window.addEventListener('keydown', (e) => this._key(e), true);
    if (this.debugOn) this.el.debug.classList.remove('hidden');
  }

  _extraDom() {
    const hud = this.el.hud;
    const mk = (id, cls = '') => { const d = document.createElement('div'); d.id = id; if (cls) d.className = cls; hud.appendChild(d); return d; };
    this.el.mic = mk('mic-ind', 'hidden');
    this.el.intro = mk('intro');
    this.el.pebble=mk('pebble-tool');
    this.el.pebble.title='Throw a pebble where you are looking. Unlimited pebbles; 20 seconds between throws. Distracts Helium only during search.';
    // Update 0.9 HUD: compass strip, lungs, radio subtitles, first-time hints
    this.el.compass = mk('compass', 'hidden'); this.el.compass.innerHTML = '<div class="c-strip"></div><div class="c-needle"></div>';
    this.el.lungs = mk('lungs', 'hidden'); this.el.lungs.innerHTML = '<span>BREATH</span><div class="bar"><div></div></div>';
    this.el.subs = mk('subs', 'hidden');
    this.el.hintCard = mk('hint-card', 'hidden');
    this.el.vices = mk('vice-tool', 'hidden');
    this.el.note = document.createElement('div'); this.el.note.id = 'note'; this.el.note.className = 'hidden'; document.body.appendChild(this.el.note);
  }

  bind(game) { this.game = game; }

  // ---------------------------------------------------------------- loading / screens
  setLoading(f, text) { this.el.loadFill.style.width = `${Math.round(f * 100)}%`; if (text) this.el.loadText.textContent = text; }
  loaded() { this.el.loading.classList.add('fade-out'); setTimeout(() => this.el.loading.classList.add('hidden'), 900); this.showMenu(true); }
  loadError(msg) { this.el.loadText.innerHTML = `<span class="warn">${esc(msg)}</span>`; }

  showMenu(on) { this.el.menu.classList.toggle('hidden', !on); if (on) this.closePanel(); }
  showHUD(on) { this.el.hud.classList.toggle('hidden', !on); if (!on) { this.prompt(null); this.progress(null); this.showInventory(false); } }
  showPause(on) { this.el.pause.classList.toggle('hidden', !on); this.el.pausePanel.classList.add('hidden'); }
  clickToPlay(on) { this.el.click.classList.toggle('hidden', !on); }

  // ---------------------------------------------------------------- main menu
  _menuAct(a) {
    for (const b of document.querySelectorAll('#menu-main button')) b.classList.toggle('active', b.dataset.act === a);
    if (a === 'single') this.openSingle(this.el.panel);
    else if (a === 'journal') this.openJournal(this.el.panel);
    else if (a === 'multi') this.openMulti();
    else if (a === 'settings') this.openSettings(this.el.panel);
    else if (a === 'controls') this.openControls(this.el.panel);
    else if (a === 'credits') this.openCredits(this.el.panel);
    else if (a === 'developer') this.openDeveloper(this.el.panel, false);
  }

  // ---------------------------------------------------------------- Update 0.9 panels
  _difficultyPicker(current) {
    return `<div class="diff-list">${Object.entries(CONFIG.DIFFICULTY).map(([k, d]) => `<button class="diff ${k === current ? 'on' : ''}" data-diff="${k}"><b>${esc(d.label)}</b><span>${esc(d.blurb)}</span><small>${d.health} grab${d.health === 1 ? '' : 's'} · ${d.lungs}s of breath</small></button>`).join('')}</div>`;
  }

  openSingle(el) {
    const s = this.s, j = this.game.journal;
    const best = j.best[s.difficulty];
    this._panel(el, `<h2>Tonight</h2>
      <p class="dim">Alone on the East Trail. Read the memo at the kiosk, get the repeater working, call for help, and reach the highway bridge.</p>
      <h3>Difficulty</h3>${this._difficultyPicker(s.difficulty)}
      <p class="hint" id="single-best">${best ? `Your best escape here: ${this._clock(best.time)}.` : j.nights ? 'No escape on this difficulty yet.' : 'First night. Hints will appear the first time each thing matters.'}</p>
      <div class="row buttons"><button id="single-go" class="primary">Walk in</button></div>`);
    el.onclick = (e) => {
      const d = e.target.closest('[data-diff]');
      if (d) { s.difficulty = d.dataset.diff; s.save(); this.openSingle(el); return; }
      if (e.target.closest('#single-go')) { this.closePanel(); this.game.startSingle(s.playerName || 'You'); }
    };
    el.oninput = null;
  }

  _clock(t) { const m = Math.floor(t / 60), sec = String(Math.round(t % 60)).padStart(2, '0'); return `${m}:${sec}`; }

  openJournal(el, tab = this._jtab || 'records') {
    this._jtab = tab;
    const j = this.game.journal, T = j.totals;
    const tabs = [['records', 'Records'], ['feats', `Feats ${Object.keys(j.feats).length}/${FEATS.length}`], ['notes', `Notes ${j.notes.length}/${NOTES.length}`]];
    let body = '';
    if (tab === 'records') {
      body = `<div class="jr-grid"><div><b>${j.nights}</b><span>nights</span></div><div><b>${j.escapes}</b><span>escapes</span></div><div><b>${T.survived}</b><span>hunts survived</span></div><div><b>${(T.dist / 1000).toFixed(1)} km</b><span>walked</span></div></div>
        <h3>Best escapes</h3>${Object.entries(CONFIG.DIFFICULTY).map(([k, d]) => { const b = j.best[k]; return `<div class="row"><span>${esc(d.label)}</span><span class="${b ? '' : 'dim'}">${b ? `${this._clock(b.time)} · ${b.players > 1 ? b.players + ' players' : 'solo'} · ${b.grabs ? b.grabs + ' grab' + (b.grabs === 1 ? '' : 's') : 'untouched'}` : 'not yet'}</span></div>`; }).join('')}
        <p class="hint">Kept in this browser only. ${j.nights ? '<button class="small ghost" data-jreset>Erase journal</button>' : ''}</p>`;
    } else if (tab === 'feats') {
      body = `<ul class="feats">${FEATS.map((f) => `<li class="${j.feats[f.id] ? 'got' : ''}"><span class="box">${j.feats[f.id] ? '✓' : ''}</span><div><b>${esc(f.name)}</b><div class="sub">${esc(f.text)}</div></div></li>`).join('')}</ul>`;
    } else {
      body = `<p class="hint">Every note you have ever picked up on the trail. ${CONFIG.NOTES_PER_NIGHT} are scattered each night; the memo is always at the kiosk.</p>` +
        NOTES.map((n) => j.notes.includes(n.id) ? `<details><summary>${esc(n.title)}</summary><p>${esc(n.text).replace(/\n/g, '<br>')}</p></details>` : `<details class="locked"><summary>— not found yet —</summary></details>`).join('');
    }
    this._panel(el, `<h2>Field Journal</h2><div class="tabs">${tabs.map(([k, l]) => `<button data-jtab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div class="tab-body journal">${body}</div>`);
    el.oninput = null;
    el.onclick = (e) => {
      const t = e.target.closest('[data-jtab]'); if (t) { this.openJournal(el, t.dataset.jtab); return; }
      if (e.target.closest('[data-jreset]')) { if (this._jresetArmed) { j.reset(); this._jresetArmed = false; this.openJournal(el, 'records'); this.toast('Journal erased.', 2000); } else { this._jresetArmed = true; e.target.textContent = 'Tap again to erase everything'; } }
    };
  }

  openWhatsNew(el) {
    for (const b of document.querySelectorAll('#menu-main button')) b.classList.remove('active');
    this._panel(el, `<h2>Update 0.9 — The Long Night</h2>
      <ul class="tips">
        <li><b>Hold your breath.</b> When he searches close to where you are hiding he can hear you breathe. Hold Jump while crouched and still. Your lungs are not endless.</li>
        <li><b>Balloons.</b> He leaves one where he stood watching you, and where he gave up looking. Walk into one in the dark and it goes off like a shot. Crouch under it, untie it, or put a pebble through it from a distance.</li>
        <li><b>Difficulty.</b> Visitor, Ranger and Helium Moon.</li>
        <li><b>Night report and Field Journal.</b> Every night ends with what you did and a rank. Records, feats and every note you have found are kept in the journal on the main menu.</li>
        <li><b>Eight new notes</b> on the trail, four a night.</li>
        <li><b>A compass</b> along the top of the screen, with your current tasks marked once you have read the memo.</li>
        <li><b>First-time hints</b> at the moment each thing matters, and a line of advice when a night goes badly.</li>
        <li><b>The world beyond the trees.</b> A freight train, a farm dog, a branch coming down, somebody's car alarm.</li>
        <li><b>The handheld.</b> After the distress call, the county unit talks you in.</li>
        <li><b>Phones and tablets.</b> Touch controls, and a HUD that fits.</li>
        <li><b>Cigarettes and beer.</b> A cigarette steadies your hands for repairs but you cannot hide while it burns, and each one shortens your breath for the night; set one down lit and he will follow the smell while he searches. A beer keeps your legs going but makes you breathe louder, and the empty bottle is a throw he hears from much farther than a pebble.</li>
        <li><b>Your arms.</b> You can see your hands now: on the lighter, on the work, over your mouth.</li>
        <li><b>Co-op ping</b>, a brightness setting, and a lighter flame that no longer glows like a brick.</li>
      </ul>`);
    el.onclick = null; el.oninput = null;
  }

  closePanel() { this.el.panel.classList.add('hidden'); this.el.panel.innerHTML = ''; for (const b of document.querySelectorAll('#menu-main button')) b.classList.remove('active'); }
  _panel(el, html) { el.innerHTML = html; el.classList.remove('hidden'); el.scrollTop = 0; return el; }

  openCredits(el) {
    this._panel(el, `<h2>Credits</h2>
      <p>A co-op survival horror game set on the East Trail of Stinchcomb Wildlife Refuge, Oklahoma City.</p>
      <p class="dim">Design, code, world, creatures, sound and shaders built for this project. The trail layout was traced from aerial imagery of the refuge.</p>
      <ul class="credits">
        <li><b>three.js</b> — MIT License</li>
        <li><b>MakeHuman</b> base mesh, targets &amp; skeleton — CC0</li>
        <li>Surface photo references: <b>ambientCG</b> — CC0</li>
        <li>Tree generator approach inspired by <b>EZ-Tree</b> — MIT</li>
        <li>Fonts: Cormorant Garamond, Inter, IBM Plex Mono — SIL Open Font License</li>
        <li>Helium Voice signature line: recorded by the game's creator</li>
        <li>Player breathing: “breath.wav” by UncleSigmund — CC0</li>
      </ul>
      <p class="dim">Other environmental and creature sounds are synthesised in your browser.</p>`);
  }

  openControls(el) {
    const b = this.s.bindings, k = (a) => `<kbd>${esc(this.s.keyName(b[a]))}</kbd>`;
    this._panel(el, `<h2>Controls</h2>
      <table class="controls">
        <tr><td>${k('forward')}${k('left')}${k('back')}${k('right')}</td><td>Move</td></tr>
        <tr><td>${k('sprint')}</td><td>Sprint (stamina)</td></tr>
        <tr><td>${k('crouch')} / ${k('crouchAlt')}</td><td>Crouch — quieter; crouch still in thick brush to hide</td></tr>
        <tr><td>${k('leanLeft')} / ${k('leanRight')}</td><td>Hold to lean left / right around cover; release to center</td></tr>
        <tr><td>${k('camouflage')}</td><td>Camouflage blanket — crouch, stay still, and switch off the light</td></tr>
        <tr><td>${k('smoke')}</td><td>Smoke a cigarette (lighter lit) — faster repairs, no hiding while it burns, less breath all night. Crouched: set it down as a lure</td></tr>
        <tr><td>${k('drink')}</td><td>Drink a beer — sprint longer, breathe louder; the empty bottle becomes your next throw</td></tr>
        <tr><td>${k('pebble')}</td><td>Throw a pebble where you look — search distraction, unlimited, 20-second cooldown</td></tr>
        <tr><td>${k('jump')}</td><td>Jump</td></tr>
        <tr><td>${k('interact')}</td><td>Interact · hold to repair / revive</td></tr>
        <tr><td>${k('flashlight')}</td><td>Lighter (flick on / let go)</td></tr>
        <tr><td>${k('inventory')}</td><td>Objectives, notes &amp; temperature (hold)</td></tr>
        <tr><td>${k('talk')}</td><td>Push to talk (multiplayer voice)</td></tr>
        <tr><td>${k('chat')}</td><td>Text chat (multiplayer)</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>Pause</td></tr>
        <tr><td><kbd>F3</kbd></td><td>Performance overlay</td></tr>
      </table>
      <h3>Surviving</h3>
      <ul class="tips">
        <li>Unexplained cold is the approach warning within about ${CONFIG.TERROR.OUTER} m. His footsteps are only audible within about 8 feet.</li>
        <li>He does not like being watched or lit. Keep your light on him — but don't count on it.</li>
        <li>Sprinting, working on loud machinery and talking carry far. Silence makes him curious instead of certain.</li>
        <li>During his search, toss a pebble away from your hiding place to draw him toward its landing sound. He can still spot you; pebbles do not stop an attack rush.</li>
        <li>Stay away from low brush near water. If the air smells like a struck match, back off.</li>
        <li>If you hear your own voice in the trees behind you, it is not you.</li>
      </ul>
      <p class="dim">Rebind keys in Settings → Controls.</p>`);
  }

  // ---------------------------------------------------------------- developer mode (owner, Oct 25)
  // Test tools: skip the opening dread, start a hunt on demand, make him appear, invincibility
  // and an AI overlay. Actions need the game simulated locally (single player).
  openDeveloper(el, inGame) {
    const s = this.s, on = s.devMode, g = this.game;
    const local = !!(g && g.sim);
    const check = (key, label, hint = '') => `<label class="row check ${on ? '' : 'dim'}"><span>${label}${hint ? `<small class="hint"> ${hint}</small>` : ''}</span><input type="checkbox" data-k="${key}" ${s[key] ? 'checked' : ''} ${on ? '' : 'disabled'}></label>`;
    const act = (a, label, help) => `<div class="row"><span>${label}<small class="hint"> ${help}</small></span><button class="small" data-dev="${a}" ${on ? '' : 'disabled'}>${inGame ? 'Do it' : 'Start'}</button></div>`;
    this._panel(el, `<h2>Developer</h2>
      <label class="row check"><span><b>Developer mode</b></span><input type="checkbox" data-k="devMode" ${on ? 'checked' : ''}></label>
      <p class="hint">For testing. While it's on, these rules apply to single-player games${inGame && !local ? ' <span class="warn">(this is an online game: actions are unavailable here)</span>' : ''}.</p>
      <h3>Rules</h3>
      ${check('devSkipDread', 'Skip the opening dread', '(he can hunt as soon as the intro ends)')}
      ${check('devInvincible', 'Invincible', '(his hits land and startle you, but do no damage)')}
      ${check('devOverlay', 'AI overlay', '(his state, distance and the director phase, bottom-right)')}
      <h3>${inGame ? 'Right now' : 'Quick tests'}</h3>
      ${inGame ? act('hunt', 'Start a hunt now', 'He appears 18-28 m behind you and hunts you.')
               : act('test-hunt', 'Test a hunt', 'Starts a solo game; the hunt begins a few seconds after the intro.')}
      ${inGame ? act('reveal', 'Make him appear', 'A planned watcher glimpse aimed at you.') : act('test-free', 'Solo game, no dread', 'Normal game with the developer rules.')}
      ${inGame ? act('relocate', 'Teleport him ahead of you', 'Unseen relocation, ignoring the cooldown.') : ''}
      <h3>Hotkeys <small class="hint">(Developer mode, in game)</small></h3>
      <table class="controls"><tr><td><kbd>F6</kbd></td><td>Start a hunt now</td></tr><tr><td><kbd>F7</kbd></td><td>Make him appear</td></tr><tr><td><kbd>F8</kbd></td><td>Teleport him ahead of you</td></tr><tr><td><kbd>F9</kbd></td><td>Toggle invincible</td></tr></table>`);
    el.onclick = (e) => {
      const b = e.target.closest('[data-dev]'); if (!b || !s.devMode) return;
      const a = b.dataset.dev;
      if (a === 'test-hunt' || a === 'test-free') { this.closePanel(); g.devStart(a === 'test-hunt'); }
      else { g.pause(false); g.devAction(a); }
    };
    el.oninput = (e) => {
      const k = e.target.dataset.k; if (!k) return;
      s[k] = e.target.checked; s.save();
      if (k === 'devMode') this.openDeveloper(el, inGame);
    };
  }

  // ---------------------------------------------------------------- settings
  openSettings(el, tab = this._tab || 'graphics') {
    this._tab = tab;
    const s = this.s;
    const tabs = [['graphics', 'Graphics'], ['audio', 'Audio'], ['game', 'Game'], ['voice', 'Voice & Mic'], ['controls', 'Controls']];
    const slider = (key, label, min, max, step, fmt = (v) => v) => `<label class="row"><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}"><output>${fmt(s[key])}</output></label>`;
    const check = (key, label) => `<label class="row check"><span>${label}</span><input type="checkbox" data-k="${key}" ${s[key] ? 'checked' : ''}></label>`;
    let body = '';
    if (tab === 'graphics') {
      body = `<label class="row"><span>Quality</span><select data-k="quality">${Object.entries(QUALITY_PRESETS).map(([k, p]) => `<option value="${k}" ${k === s.quality ? 'selected' : ''}>${p.label}</option>`).join('')}</select></label>
        <p class="hint">Render scale and volumetrics update immediately. Reload after changing quality to apply forest density and all shadow settings.</p>
        ${slider('renderScale', 'Render scale', 0.5, 1, 0.05, (v) => Math.round(v * 100) + '%')}
        ${check('adaptiveRes', 'Adaptive resolution')}
        ${slider('brightness', 'Brightness', 0.6, 2, 0.05, (v) => Math.round(v * 100) + '%')}
        <p class="hint">Set it so the trail ahead is only just visible with the lighter out. The night is meant to be dark.</p>
        ${slider('fov', 'Field of view', 60, 100, 1, (v) => v + '°')}
        ${slider('headBob', 'Head bob', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')}
        ${slider('cameraShake', 'Motion effects (shake, warp)', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')}
        ${slider('filmGrain', 'Film grain', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')}
        ${check('showFps', 'Show FPS')}`;
    } else if (tab === 'audio') {
      body = `${slider('masterVolume', 'Master', 0, 1, 0.01, (v) => Math.round(v * 100))}
        ${slider('sfxVolume', 'Effects & creatures', 0, 1, 0.01, (v) => Math.round(v * 100))}
        ${slider('ambienceVolume', 'Ambience', 0, 1, 0.01, (v) => Math.round(v * 100))}
        ${slider('voiceVolume', 'Voice chat', 0, 1.5, 0.01, (v) => Math.round(v * 100))}
        <p class="hint">Headphones strongly recommended — the game is mixed for positional (HRTF) audio.</p>`;
    } else if (tab === 'game') {
      body = `${check('compass', 'Compass strip')}
        ${check('hints', 'First-time hints')}
        <div class="row"><span class="dim">Hints you have already seen stay hidden.</span><button class="small" data-rehint>Show them again</button></div>
        ${check('subtitles', 'Radio subtitles')}
        <label class="row"><span>Touch controls</span><select data-k="touchControls"><option value="auto" ${s.touchControls === 'auto' ? 'selected' : ''}>Automatic</option><option value="on" ${s.touchControls === 'on' ? 'selected' : ''}>Always on</option><option value="off" ${s.touchControls === 'off' ? 'selected' : ''}>Off</option></select></label>
        <p class="hint">Touch controls apply after a reload. Difficulty is chosen when you start a night.</p>`;
    } else if (tab === 'voice') {
      const v = this.voice, live = v.mic === 'live';
      const st = { off: 'Off', requesting: 'Waiting for permission…', live: 'On', denied: 'Permission denied', error: 'Unavailable' }[v.mic] || 'Off';
      body = `<div class="row"><span>Microphone</span><span class="mic-state ${live ? 'on' : ''}">${st}</span>
          <button class="small" data-mic="${live ? 'off' : 'on'}">${live ? 'Turn off' : 'Enable microphone'}</button></div>
        ${window.HM_EMBEDDED ? '<p class="hint warn">This hosted page cannot open a microphone. Voice chat and voice mimicry work in the downloadable build.</p>' : ''}
        ${v.error ? `<p class="hint warn">${esc(v.error)}</p>` : `<p class="hint">The microphone is only opened when you press the button above, and only used for proximity voice chat (and mimicry, if you opt in below). Nothing is transmitted unless you are talking.${v.relayed ? ` ${v.relayed} voice connection${v.relayed === 1 ? '' : 's'} using the secure server relay because a direct path was unavailable.` : ''}</p>`}
        <label class="row"><span>Input device</span><select data-k="micDevice" id="mic-devices"><option value="">Default</option></select></label>
        <label class="row"><span>Mode</span><select data-k="voiceMode"><option value="ptt" ${s.voiceMode === 'ptt' ? 'selected' : ''}>Push to talk (${esc(s.keyName(s.bindings.talk))})</option><option value="open" ${s.voiceMode === 'open' ? 'selected' : ''}>Open mic (voice activated)</option></select></label>
        ${slider('micSensitivity', 'Open-mic sensitivity', 0, 1, 0.01, (v2) => Math.round(v2 * 100) + '%')}
        <div class="row"><span>Input level</span><div class="level"><div id="mic-level"></div></div></div>
        <h3>Voice mimicry <span class="tag">separate opt-in</span></h3>
        ${check('mimicOptIn', 'Let Helium Voice learn my voice')}
        <p class="hint">${MIMIC_TEXT}</p>
        <p class="hint">Mimicry needs the microphone on. Use headphones and keep echo cancellation on so the game never hears itself.</p>`;
    } else {
      const rows = Object.keys(DEFAULT_BINDINGS).map((a) => `<div class="row"><span>${esc(BINDING_LABELS[a])}</span><button class="bind" data-bind="${a}">${esc(s.keyName(s.bindings[a]))}</button></div>`).join('');
      body = `${slider('sensitivity', 'Mouse sensitivity', 0.2, 3, 0.05, (v) => (+v).toFixed(2))}
        ${check('invertY', 'Invert Y')}
        <h3>Key bindings</h3>${rows}
        <button class="small" data-reset-binds>Reset to defaults</button>`;
    }
    this._panel(el, `<h2>Settings</h2><div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div class="tab-body">${body}</div>`);
    el.onclick = (e) => {
      const t = e.target.closest('[data-tab]'); if (t) { this.openSettings(el, t.dataset.tab); return; }
      const m = e.target.closest('[data-mic]');
      if (m) { const g = this.game; if (m.dataset.mic === 'on') g.voice.enableMic().then(() => this.openSettings(el, 'voice')); else { g.voice.disableMic(); this.openSettings(el, 'voice'); } return; }
      const b = e.target.closest('[data-bind]'); if (b) { this._rebind(b, el); return; }
      if (e.target.closest('[data-reset-binds]')) { s.bindings = { ...DEFAULT_BINDINGS }; s.save(); this.openSettings(el, 'controls'); }
      if (e.target.closest('[data-rehint]')) { const j = this.game.journal; j.hints = {}; j.save(); this.toast('Hints will show again.', 2000); }
    };
    el.oninput = (e) => {
      const k = e.target.dataset.k; if (!k) return;
      let v = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'range' ? +e.target.value : e.target.value;
      if (k === 'quality') s.qualityChosen = true;
      s[k] = v; s.save();
      const out = e.target.parentElement.querySelector('output'); if (out) out.textContent = e.target.closest('label').querySelector('output') ? this._fmt(k, v) : '';
      if (k === 'mimicOptIn' && !v) this.toast('Voice mimicry off — stored phrases deleted.', 3000);
      if (k === 'mimicOptIn' && v && this.voice.mic !== 'live') this.toast('Turn the microphone on to use mimicry.', 3000);
    };
    if (tab === 'voice') this._fillDevices();
  }

  _fmt(k, v) {
    if (['renderScale', 'headBob', 'cameraShake', 'filmGrain', 'micSensitivity', 'brightness'].includes(k)) return Math.round(v * 100) + '%';
    if (k === 'fov') return v + '°';
    if (k.endsWith('Volume')) return Math.round(v * 100);
    if (k === 'sensitivity') return (+v).toFixed(2);
    return v;
  }

  async _fillDevices() {
    const sel = $('#mic-devices'); if (!sel || !this.game) return;
    const devs = await this.game.voice.devices();
    sel.innerHTML = '<option value="">Default</option>' + devs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => `<option value="${esc(d.deviceId)}" ${d.deviceId === this.s.micDevice ? 'selected' : ''}>${esc(d.label || 'Microphone ' + (i + 1))}</option>`).join('');
  }

  _rebind(btn, el) {
    btn.textContent = 'press a key…'; btn.classList.add('waiting');
    const h = (e) => {
      e.preventDefault(); e.stopPropagation();
      window.removeEventListener('keydown', h, true);
      if (e.code !== 'Escape') { this.s.bindings[btn.dataset.bind] = e.code; this.s.save(); }
      this.openSettings(el, 'controls');
    };
    window.addEventListener('keydown', h, true);
  }

  voiceStatus(st) {
    this.voice = st;
    const m = this.el.mic;
    m.classList.toggle('hidden', st.mic !== 'live');
    m.classList.toggle('tx', !!st.transmitting);
    m.innerHTML = `<span class="dot"></span>MIC · ${st.mode === 'ptt' ? 'PUSH TO TALK' : 'OPEN'}${st.relayed ? ' · SERVER RELAY' : ''}${st.mimic ? ' · MIMICRY ON' : ''}`;
    const lvl = $('#mic-level'); if (lvl) lvl.style.width = `${Math.round(st.level * 100)}%`;
  }

  tickVoiceMeter() {
    const lvl = $('#mic-level');
    if (lvl && this.game) { lvl.style.width = `${Math.round(this.game.voice.level * 100)}%`; lvl.classList.toggle('tx', this.game.voice.transmitting || this.game.voice.gateOpen); }
  }

  // ---------------------------------------------------------------- multiplayer
  openMulti() {
    const s = this.s, el = this.el.panel;
    if (window.HM_EMBEDDED) {
      this._panel(el, `<h2>Multiplayer</h2>
        <p>Co-op for 2–6 players with lobby codes and proximity voice chat runs on a small game server, which this hosted page can't reach.</p>
        <p class="dim">To play together, download the full build, then on one computer run <code>node server/server.js</code> (Node 18 or newer) and have everyone open that computer's address, for example <code>http://192.168.1.20:8080</code>. One player creates a lobby and shares the 5-letter code.</p>
        <p class="dim">Single Player here is the complete game.</p>`);
      return;
    }
    if (this.game.net && this.game.net.networked && this.game.lobby) { this.openLobby(); return; }
    const auto = defaultServerUrl();
    this._panel(el, `<h2>Multiplayer</h2>
      <p class="dim">Co-op for 2–6 players. One person runs the server (<code>node server/server.js</code>) and everyone opens its address in a browser.</p>
      <label class="row"><span>Your name</span><input type="text" id="mp-name" maxlength="20" value="${esc(s.playerName)}" placeholder="Visitor"></label>
      <label class="row"><span>Server</span><input type="text" id="mp-url" value="${esc(s.serverUrl || auto)}" placeholder="ws://host:8080/ws"></label>
      <div class="row buttons"><button id="mp-create">Create lobby</button></div>
      <div class="row buttons"><input type="text" id="mp-code" maxlength="5" placeholder="CODE" class="code"><button id="mp-join">Join</button></div>
      <p id="mp-status" class="hint"></p>`);
    const status = (t, warn) => { const p = $('#mp-status'); p.textContent = t; p.classList.toggle('warn', !!warn); };
    const go = async (join) => {
      const name = $('#mp-name').value.trim() || 'Visitor', url = $('#mp-url').value.trim();
      s.playerName = name; s.serverUrl = url === auto ? '' : url; s.save();
      if (!url) { status('Enter the server address (for example ws://192.168.1.20:8080/ws).', true); return; }
      const code = $('#mp-code').value.trim().toUpperCase();
      if (join && code.length !== 5) { status('Lobby codes are 5 characters.', true); return; }
      status('Connecting…');
      const t = new WSTransport(url);
      try { await t.connect(name); } catch (e) { status(e.message + ' Is the server running?', true); return; }
      this.game.attach(t);
      this.game.offs.push(
        t.on('error', (m) => {
          if (this.game.net === t) this.game.detach(); else t.close();
          status(m.msg, true);
        }),
        t.on('lobby_left', () => { this.game.quitToMenu(true); this.openMulti(); }),
      );
      t.send(join ? { t: 'join', code } : { t: 'create' });
    };
    $('#mp-create').onclick = () => go(false);
    $('#mp-join').onclick = () => go(true);
    $('#mp-code').onkeydown = (e) => { if (e.key === 'Enter') go(true); };
  }

  lobby(m, myId) { this._lobby = m; this._me = myId; if (!this.el.menu.classList.contains('hidden')) this.openLobby(); }

  openLobby() {
    const m = this._lobby; if (!m) return;
    const el = this.el.panel, me = this._me, host = m.host === me;
    for (const b of document.querySelectorAll('#menu-main button')) b.classList.toggle('active', b.dataset.act === 'multi');
    this._panel(el, `<h2>Lobby</h2>
      <div class="lobby-code"><span>${esc(m.code)}</span><button class="small" id="lb-copy">Copy</button></div>
      <p class="dim">Share this code. ${m.players.length}/6 players.</p>
      <ul class="lobby-list">${m.players.map((p) => `<li>${p.host ? '<span class="tag">host</span>' : ''}${esc(p.name)}${p.id === me ? ' <span class="dim">(you)</span>' : ''}</li>`).join('')}</ul>
      <div class="row"><span>Voice</span><span class="mic-state ${this.voice.mic === 'live' ? 'on' : ''}">${this.voice.mic === 'live' ? 'Microphone on' : 'Microphone off'}</span><button class="small" id="lb-mic">Voice settings</button></div>
      ${host ? `<h3>Difficulty</h3>${this._difficultyPicker(this.s.difficulty)}` : `<p class="dim">Difficulty: ${esc((CONFIG.DIFFICULTY[m.difficulty] || CONFIG.DIFFICULTY.ranger).label)} <span class="hint">(the host can change it)</span></p>`}
      <div class="row buttons">${host ? '<button id="lb-start">Start game</button>' : '<span class="dim">Waiting for the host to start…</span>'}<button id="lb-leave" class="ghost">Leave</button></div>`);
    $('#lb-copy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(m.code).catch(() => {}); this.toast('Code copied.', 1500); };
    $('#lb-mic').onclick = () => this.openSettings(el, 'voice');
    if (host) $('#lb-start').onclick = () => this.game.net.send({ t: 'start', difficulty: this.s.difficulty });
    for (const b of el.querySelectorAll('[data-diff]')) b.onclick = () => { this.s.difficulty = b.dataset.diff; this.s.save(); this.openLobby(); };
    $('#lb-leave').onclick = () => { this.game.quitToMenu(true); this.openMulti(); };
  }

  // ---------------------------------------------------------------- pause / end
  _pauseAct(a) {
    const g = this.game;
    if (a === 'resume') g.pause(false);
    else if (a === 'settings') this.openSettings(this.el.pausePanel);
    else if (a === 'controls') this.openControls(this.el.pausePanel);
    else if (a === 'journal') this.openJournal(this.el.pausePanel);
    else if (a === 'restart') { if (g.net && g.net.networked && !g._isHost()) { this.toast('Only the host can restart.', 2000); return; } g.pause(false); g.restart(); }
    else if (a === 'developer') this.openDeveloper(this.el.pausePanel, true);
    else if (a === 'quit') g.quitToMenu();
  }

  showEnd(r, o = {}) {
    const el = this.el.end;
    if (!r) { el.classList.add('hidden'); return; }
    const won = r.result === 'won', mine = o.me, f = o.filed || {}, st = f.stats || {}, rank = f.rank;
    this.el.endTitle.textContent = won ? (mine === 'escaped' ? 'YOU MADE IT OUT' : 'THEY MADE IT OUT') : 'THE REFUGE KEPT YOU';
    this.el.endTitle.className = 'title ' + (won ? 'won' : 'lost');
    const label = { escaped: 'escaped', dead: 'did not make it', downed: 'left behind', alive: 'left behind' };
    const S = r.stats?.players || {};
    const roster = r.players.length > 1 ? `<table class="roster-t"><tr><th></th><th>hunted</th><th>hid</th><th>grabs</th><th>walked</th><th></th></tr>${r.players.map((p) => { const q = S[p.id] || {}; return `<tr class="${p.id === o.myId ? 'me' : ''}"><td>${esc(p.name)}</td><td>${q.hunted || 0}</td><td>${q.survived || 0}</td><td>${q.grabs || 0}</td><td>${Math.round(q.dist || 0)} m</td><td class="dim">${label[p.state] || p.state}</td></tr>`; }).join('')}</table>` : '';
    const story = won
      ? (mine === 'escaped' ? 'The cruiser’s lights wash over the bridge pilings. Behind you, something in the trees is laughing in a voice like a kid sucking on a balloon.' : 'The cruiser pulls away with the ones who made it. Nobody says your name until the county line.')
      : 'The insects never started up again. Somewhere past the slough, a high voice is repeating what you said.';
    const diff = (CONFIG.DIFFICULTY[r.difficulty] || CONFIG.DIFFICULTY.ranger).label;
    const pct = (a, b) => (b > 0 ? Math.round(100 * a / b) : 0);
    const cells = [
      [this._clock(r.time), 'time'], [`${r.objectives}/${r.objectivesTotal || 4}`, 'repairs'],
      [`${st.survived || 0}/${st.hunted || 0}`, 'hunts survived'], [`${st.grabs || 0}`, 'times grabbed'],
      [`${Math.round(st.dist || 0)} m`, 'walked'], [`${pct(st.darkT || 0, st.aliveT || 0)}%`, 'in the dark'],
      [`${o.notes ?? r.notes}/${1 + CONFIG.NOTES_PER_NIGHT}`, 'notes'], [`${(st.balloonsUntied || 0)}${st.balloonsPopped ? ' +' + st.balloonsPopped + ' popped' : ''}`, 'balloons untied'],
    ];
    const earned = (f.earned || []).map((x) => `<div class="feat-new"><span>FEAT</span><b>${esc(x.name)}</b><em>${esc(x.text)}</em></div>`).join('');
    const best = f.newBest ? `<div class="feat-new best"><span>RECORD</span><b>Best escape on ${esc(diff)}</b><em>${f.previousBest ? `was ${this._clock(f.previousBest)}` : 'your first'}</em></div>` : '';
    this.el.endText.innerHTML = `<p class="story">${story}</p>
      ${rank ? `<div class="rank"><span>${esc(diff)}</span><b>${esc(rank.title)}</b><em>${esc(rank.line)}</em></div>` : ''}
      <div class="report">${cells.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
      ${best}${earned}${roster}
      ${o.tip ? `<p class="tip"><span>NEXT TIME</span>${esc(o.tip)}</p>` : ''}`;
    this.el.endLobby.classList.toggle('hidden', !o.networked);
    el.querySelector('[data-act="restart"]').classList.toggle('hidden', !!o.networked && !o.host);
    el.classList.remove('hidden'); el.scrollTop = 0;
  }

  _endAct(a) {
    const g = this.game;
    if (a === 'restart') g.restart();
    else if (a === 'lobby') g.returnToLobby();
    else if (a === 'developer') this.openDeveloper(this.el.pausePanel, true);
    else if (a === 'quit') g.quitToMenu();
  }

  // ---------------------------------------------------------------- HUD
  intro() {
    const el = this.el.intro;
    const rules = this.game?.rules, d = rules && rules.id !== 'ranger' ? ` · ${esc(rules.label)}` : '';
    el.innerHTML = `<div class="l1">Stinchcomb Wildlife Refuge</div><div class="l2">East Trail · 10:00 PM${d}</div><div class="l3">The Helium Moon is up.</div>`;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(this._introT);
    this._introT = setTimeout(() => el.classList.remove('show'), 7500);
  }

  objectives(lines) {
    const el = this.el.objectives;
    el.innerHTML = lines.map((l) => `<div class="obj ${l.done ? 'done' : ''} ${l.urgent ? 'urgent' : ''}"><span class="box">${l.done ? '✓' : ''}</span><div><div>${esc(l.text)}</div>${l.sub ? `<div class="sub">${esc(l.sub)}</div>` : ''}</div></div>`).join('');
    el.classList.add('fresh'); clearTimeout(this._objT);
    this._objT = setTimeout(() => el.classList.remove('fresh'), 9000);
  }

  prompt(html) {
    if (html === this._prompt) return;
    this._prompt = html;
    this.el.prompt.innerHTML = html || '';
    this.el.prompt.classList.toggle('hidden', !html);
  }

  progress(f) {
    const r = this.el.progressRing;
    if (f === null || f === undefined) { r.classList.add('hidden'); return; }
    r.classList.remove('hidden');
    const C = 2 * Math.PI * 16;
    this.el.progressArc.style.strokeDasharray = `${C}`;
    this.el.progressArc.style.strokeDashoffset = `${C * (1 - Math.max(0, Math.min(1, f)))}`;
  }

  meters(stamina, battery, on) {
    this.el.stamina.style.width = `${Math.round(stamina * 100)}%`;
    this.el.battery.style.width = `${Math.round(battery * 100)}%`;
    this.el.battery.classList.toggle('low', battery < 0.18);
    this.el.meters.classList.toggle('quiet', stamina > 0.99 && battery > 0.5);
    this.tickVoiceMeter();
  }

  team(list) {
    const key = JSON.stringify(list);
    if (key === this._teamKey) return;
    this._teamKey = key;
    this.el.team.innerHTML = list.map((p) => `<div class="mate ${p.state} ${p.talking ? 'talking' : ''}"><span class="sw" style="background:${p.color}"></span>${esc(p.name)}${p.me ? ' <span class="dim">(you)</span>' : ''}<span class="st">${{ alive: '', downed: 'DOWN', dead: 'DEAD', escaped: 'OUT' }[p.state] || ''}</span></div>`).join('');
  }

  pebble(remaining,available) {
    const seconds=Math.ceil(Math.max(0,remaining-.01)),key=this.s.keyName(this.s.bindings.pebble);
    const state=seconds?`${seconds}s`:available?'Ready':'Unavailable';
    const stamp=`${key}:${state}`;
    if(this._pebbleStamp!==stamp){
      this._pebbleStamp=stamp;
      this.el.pebble.innerHTML=`<kbd>${esc(key)}</kbd><span><b>PEBBLE</b><small>${esc(state)} · unlimited</small></span><i><em></em></i>`;
      this.el.pebble.classList.toggle('unavailable',!available||seconds>0);
    }
    this.el.pebble.querySelector('em').style.height=`${Math.round(Math.max(0,1-remaining/CONFIG.PEBBLE.COOLDOWN)*100)}%`;
  }

  toast(text, ms = 3000) {
    const el = this.el.toast;
    clearTimeout(this._toastT);
    if (!text) { el.classList.remove('show'); return; }
    el.textContent = text; el.classList.add('show');
    this._toastT = setTimeout(() => el.classList.remove('show'), ms);
  }

  showInventory(on, dataFn) {
    const el = this.el.inventory;
    if (!on) { if (!el.classList.contains('hidden')) el.classList.add('hidden'); return; }
    const was = !el.classList.contains('hidden');
    this._invT = (this._invT || 0) + 1;
    if (was && this._invT % 10) return;
    const d = dataFn();
    const m = Math.floor(d.time / 60), sec = String(Math.floor(d.time % 60)).padStart(2, '0');
    const map=d.map;
    const fieldMap=map?`<h3>East Trail field map</h3><div class="field-map"><svg viewBox="0 0 500 300" role="img" aria-label="East Trail, landmarks and your position">
      <path d="${map.river}" fill="none" stroke="#587985" stroke-width="5" opacity=".5"/>
      <path d="${map.path}" fill="none" stroke="#c7ba8c" stroke-width="2.5" stroke-linecap="round"/>
      <path d="${map.service||''}" fill="none" stroke="#c19568" stroke-width="2" stroke-dasharray="4 3"/>
      ${map.markers.map(p=>`<g><circle cx="${p.at[0]}" cy="${p.at[1]}" r="5" fill="#b8c59a"/><text x="${p.at[0]+8}" y="${p.at[1]+4}" fill="#e1dac5" font-size="12">${p.n}</text></g>`).join('')}
      <circle cx="${map.player[0]}" cy="${map.player[1]}" r="5.5" fill="#eeb36e" stroke="#191e17" stroke-width="2"/>
      <text x="465" y="24" fill="#c7ba8c" font-size="12">N ↑</text></svg>
      <div class="map-legend">${map.markers.map(p=>`<span><b>${p.n}</b> ${esc(p.name)}</span>`).join('')}</div>
      <p class="map-key">Amber dot: you · pale line: East Trail · dashed line: river service path · scroll to read</p></div>`:'';
    const supplies=d.supplyHints?`<div class="supply-register"><b>Tonight's supply register</b><div>Gas can — ${esc(d.supplyHints.fuel)}</div><div>Fuse kit — ${esc(d.supplyHints.fuse)}</div>${d.supplyHints.crank?`<div>Handwheel — ${esc(d.supplyHints.crank)}</div>`:''}</div>`:'';
    el.innerHTML = `${fieldMap}${supplies}<h3>Rescue plan</h3>${d.objectives.map((l) => `<div class="obj ${l.done ? 'done' : ''}"><span class="box">${l.done ? '✓' : ''}</span><div><div>${esc(l.text)}</div>${l.sub ? `<div class="sub">${esc(l.sub)}</div>` : ''}</div></div>`).join('')}
      <div class="inv-grid"><div><span class="dim">Team carries</span><br>${d.team.fuel ? 'Gas can' : '<span class="dim">—</span>'}${d.team.fuse ? '<br>Fuse kit' : ''}</div>
      <div><span class="dim">Lighter fuel</span><br>${Math.round(d.battery * 100)}%</div><div><span class="dim">Air temperature</span><br>${d.temp.toFixed(1)}°C</div><div><span class="dim">Time</span><br>${m}:${sec}</div></div>
      ${d.blanket?`<p class="map-key">Camouflage blanket carried · crouch, lighter off, hold ${esc(this.s.keyName(this.s.bindings.camouflage))} while still.</p>`:''}
      <p class="map-key">${esc(this.s.keyName(this.s.bindings.pebble))} · unlimited pebbles · ${d.pebbleRemaining>0?`ready in ${Math.ceil(d.pebbleRemaining)}s`:'ready'} · distracts Helium only while searching. Aim away from your hiding place.</p>
      <h3>Notes</h3>${d.notes.length ? d.notes.map((n) => `<details><summary>${esc(n.title)}</summary><p>${esc(n.text).replace(/\n/g, '<br>')}</p></details>`).join('') : '<p class="dim">None yet.</p>'}`;
    el.classList.remove('hidden');
  }

  showNote(n, isNew = false) {
    const el = this.el.note;
    if (!n) { el.classList.add('hidden'); return; }
    el.innerHTML = `<div class="paper">${isNew ? '<div class="nnew">New in your Field Journal</div>' : ''}<div class="ntitle">${esc(n.title)}</div><div class="nbody">${esc(n.text).replace(/\n/g, '<br>')}</div><div class="nhint">${esc(this.s.keyName(this.s.bindings.interact))} or move to put it away</div></div>`;
    el.classList.remove('hidden');
  }

  // ---- Update 0.9 HUD
  // heading (radians, 0 = north, clockwise) and pips [{label, b: bearing, d: metres}]; null hides it
  compass(heading, pips = []) {
    const el = this.el.compass;
    if (heading === null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const strip = el.firstChild, SPAN = 1.15, W = el.clientWidth || 420;   // radians shown either side of centre
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const marks = [];
    const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    for (let i = 0; i < 8; i++) { const d = wrap(i * Math.PI / 4 - heading); if (Math.abs(d) < SPAN) marks.push(`<i class="${i % 2 ? 'minor' : ''}" style="left:${(50 + 50 * d / SPAN).toFixed(1)}%">${CARD[i]}</i>`); }
    for (const p of pips) {
      const d = wrap(p.b - heading), cl = Math.max(-SPAN, Math.min(SPAN, d));
      marks.push(`<u class="${Math.abs(d) > SPAN ? 'edge' : ''}" style="left:${(50 + 50 * cl / SPAN).toFixed(1)}%">${Math.abs(d) > SPAN ? (d < 0 ? '‹ ' : '') : ''}${esc(p.label)} <small>${p.d >= 1000 ? (p.d / 1000).toFixed(1) + ' km' : Math.round(p.d / 5) * 5 + ' m'}</small>${Math.abs(d) > SPAN && d > 0 ? ' ›' : ''}</u>`);
    }
    const html = marks.join('');
    if (html !== this._compHtml) { this._compHtml = html; strip.innerHTML = html; }
  }

  // what is in your pockets: cigarettes, beer, an empty bottle, and what is in your blood
  vices(v, now) {
    const key = (a) => this.s.keyName(this.s.bindings[a]), rows = [];
    const smoking = v.smoke > now, buzzed = v.buzz > now;
    if (v.cigs > 0 || smoking) rows.push(`<div><kbd>${esc(key('smoke'))}</kbd><span><b>CIGARETTES</b><small>${v.cigs} left${smoking ? ` · lit ${Math.ceil(v.smoke - now)}s` : ''}</small></span></div>`);
    if (v.beers > 0 || buzzed) rows.push(`<div><kbd>${esc(key('drink'))}</kbd><span><b>BEER</b><small>${v.beers} left${buzzed ? ` · buzzed ${Math.ceil(v.buzz - now)}s` : ''}</small></span></div>`);
    if (v.bottles > 0) rows.push(`<div><kbd>${esc(key('pebble'))}</kbd><span><b>EMPTY BOTTLE</b><small>${v.bottles} · next throw</small></span></div>`);
    const html = rows.join('');
    if (html !== this._viceHtml) { this._viceHtml = html; this.el.vices.innerHTML = html; this.el.vices.classList.toggle('hidden', !html); }
  }

  lungs(frac, holding, gasping) {
    const el = this.el.lungs, show = holding || gasping || frac < 0.995;
    el.classList.toggle('hidden', !show);
    if (!show) return;
    el.classList.toggle('holding', !!holding); el.classList.toggle('gasp', !!gasping);
    el.querySelector('.bar div').style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    const label = gasping ? 'GASPING' : holding ? 'HOLDING BREATH' : 'BREATH';
    const sp = el.firstChild; if (sp.textContent !== label) sp.textContent = label;
  }

  subtitle(who, text) {
    const el = this.el.subs;
    if (!who) { el.classList.add('hidden'); return; }
    el.innerHTML = `<b>${esc(who)}</b>${esc(text)}`; el.classList.remove('hidden');
  }

  hint(text, ms = 9000) {
    const el = this.el.hintCard;
    clearTimeout(this._hintT);
    if (!text) { el.classList.add('hidden'); el.classList.remove('show'); return; }
    el.innerHTML = `<span>HINT</span>${esc(text)}`; el.classList.remove('hidden'); void el.offsetWidth; el.classList.add('show');
    this._hintT = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.classList.add('hidden'), 700); }, ms);
  }

  chatLine(name, text, color = '#bbb') {
    const log = this.el.chatLog;
    const d = document.createElement('div'); d.className = 'line';
    d.innerHTML = `<b style="color:${color}">${esc(name)}</b> ${esc(text)}`;
    log.appendChild(d);
    while (log.children.length > 8) log.removeChild(log.firstChild);
    setTimeout(() => d.classList.add('old'), 12000);
  }

  openChat(send) {
    this.closeChat();
    const inp = this.el.chatInput, g = this.game;
    this.chatOpen = true; g.input.textFocus = true; g.input.keys.clear();
    inp.classList.remove('hidden'); inp.value = ''; inp.focus();
    const done = (text) => {
      this.closeChat();
      if (text) send(text.slice(0, 140));
    };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(inp.value.trim()); else if (e.key === 'Escape') done(''); };
  }

  closeChat() {
    const inp = this.el.chatInput;
    inp.onkeydown = null; inp.blur(); inp.classList.add('hidden'); inp.value = '';
    this.chatOpen = false;
    if (this.game?.input) this.game.input.textFocus = false;
  }

  toggleDebug() { this.debugOn = !this.debugOn; this.el.debug.classList.toggle('hidden', !this.debugOn && !this.s.showFps); }
  devOverlay(html) {
    let el = this.el.dev;
    if (!el) { el = this.el.dev = document.createElement('div'); el.id = 'dev-overlay'; this.el.hud.appendChild(el); }
    el.classList.toggle('hidden', !html); if (html) el.innerHTML = html;
  }
  debug(html) { if (this.debugOn || this.s.showFps) { this.el.debug.classList.remove('hidden'); this.el.debug.innerHTML = html; } }

  _key(e) {
    if (!this.game) return;
    // Esc while the pointer is not locked (drag-look mode) toggles pause; with pointer lock the browser releases the lock first
    if (e.code === 'Escape' && this.game.mode === 'playing' && !this.chatOpen) {
      if (this.game.paused && !this.el.pausePanel.classList.contains('hidden')) { this.el.pausePanel.classList.add('hidden'); e.preventDefault(); e.stopPropagation(); return; }
      if (this.game.paused) { this.game.pause(false); e.preventDefault(); e.stopPropagation(); }
    }
    if (e.code === 'Escape' && this.game.mode !== 'playing' && !this.el.panel.classList.contains('hidden')) this.closePanel();
  }
}
