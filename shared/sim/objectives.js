// Objectives, items and notes. Locations are randomised every session.
import { CONFIG } from '../config.js';
import { pointAtDistance, makeRng } from '../math.js';
import { eyeHeight } from './perception.js';

const REPAIR_STEPS = {
  generator: ['Pour the fuel', 'Prime the starter', 'Start the generator'],
  relay: ['Open the relay housing', 'Replace the blown fuse', 'Reset the breaker'],
  transmitter: ['Tune the emergency channel', 'Power the transmitter', 'Send the distress call'],
};
export const ANTENNA_BEARINGS = ['N','NE','E','SE','S','SW','W','NW'];
const TEAM_ITEMS = ['fuel','fuse','crank'];

export const NOTES = [
  { id: 'memo', title: 'Maintenance memo (kiosk)', text: 'TO: Refuge staff\nRepeater at the old mast is on backup only. If the main line goes down:\n1. Start the backup generator (gas can in the truck or the shed).\n2. Swap the blown fuse in the trail relay box - spares are in the orange kit.\n3. Key the emergency channel from the cabinet at the base of the mast.\nThe county will send a unit to the highway bridge.\n- R. Okafor, Parks' },
  { id: 'ranger', title: 'Ranger log, Oct 14', text: 'Third report this month of a man in a red shirt standing out past the slough after closing. Same description every time. Yellow swim cap. Glasses. Green shoes. Didn\'t answer.\nHe doesn\'t move while you look at him. Dale ran and it came after him like a dog.\nSo Dale got down in the brush, killed his light and didn\'t breathe.\nIt walked right past him, stood a while, then just... folded up like a coat dropped off a hook.\nWhen Dale looked again the ground was empty. Frozen where it had been. In October.' },
  { id: 'birder', title: 'Torn page from a birding notebook', text: 'No owls tonight. No frogs. Insects stopped at 9:52 exactly.\nThe air went cold like opening a freezer.\nSomething on the far bank laughing in a voice like a kid sucking on a balloon.\nI am not going back for the scope.' },
  { id: 'camp', title: 'Note pinned to the tent', text: 'MASON - if you find this we went back to the cars.\nTyler says he heard you calling from the woods but it wasn\'t you.\nIt sounded like you but higher. It said what you said at dinner.\nDON\'T ANSWER IT.' },
  { id: 'hunter', title: 'Hunter\'s scrawl', text: 'Saw a skunk the size of a dog in the cattails by the south ponds.\nBlack and white but wrong. Too many eyes.\nSmelled like a struck match. When it stood up the air turned to soup and I couldn\'t tell which way the truck was.\nMy dog won\'t go near the water now.' },
  { id: 'grandpa', title: 'Scrap of paper', text: 'Helium Moon tonight.\nGrandpa said on those nights you don\'t talk in the woods.\nIt listens. It learns your voice.\nThen it uses it.' },  // ---- Update 0.9: eight more. Each one is a piece of the story and a lesson somebody paid for.
  { id: 'balloons', title: 'Volunteer trail report', text: 'Removed four balloons from the East Trail this week. Yellow, on white string, tied off at about head height.\nNobody has reported a party. They are never there on the walk in. They are there on the walk out.\nOne was tied to the bench I had been sitting on.\nWalked into one in the dusk and it went off like a shot. Every bird in the bottoms went quiet.\nI untie them now. Slowly.' },
  { id: 'breath', title: 'Page from a field notebook', text: 'Night 3. Blind by the pond.\nIt came through at 11:40, walking the way a marionette walks.\nI lay in the reeds with the lamp out. It stopped maybe ten feet off and stood there with its head going side to side.\nI could hear my own breathing. So could it. It turned.\nI held my breath until my ears rang. It waited. Then it went on.\nI do not know what happens if you run out of air first.' },
  { id: 'dispatch', title: 'County dispatch printout', text: 'CAD 26-10-0447  22:51\nCaller on refuge emergency channel, repeater mast, East Trail.\nStates party of hikers, one separated. States "a man who doesn\'t move when you look."\nCaller advised to proceed north to the highway bridge. Unit 14 en route to bridge, ETA 9.\n22:58  Open line. Breathing. A second voice repeating the caller\'s last words. Higher.\n23:04  Line closed from caller side.' },
  { id: 'clipping', title: 'Newspaper clipping, May 1974', text: 'HELIUM TANK FOUND IN RIVER BOTTOMS\nRefuge staff clearing the old River Road on Saturday found a welding-supply helium tank, empty, and about forty yards of white string wound around a sycamore.\nTwo night fishermen told this paper they have heard laughing from the far bank "in a voice like a cartoon" on and off since April, always on a bright moon.\n"We figured it was kids," one said. "Kids go home."\nThe tank has not been claimed.' },
  { id: 'kids', title: 'Folded notebook paper', text: 'RULES (Danny made these)\n1. If you see him you have to keep looking. He only moves when nobody looks.\n2. No flashlights. He sees light from all the way across the water.\n3. If he is looking for you get LOW and get behind something and dont move.\n4. Throw a rock the other way. He goes to see.\n5. Dont talk. Dont even breathe loud.\n6. If he grabs you thats one. You only get three.' },
  { id: 'sf6', title: 'Lab label, water-stained', text: 'SULFUR HEXAFLUORIDE  SF6\nCylinder 6 of 6. Property of the university. Do not vent.\nHandwritten underneath:\nFive times heavier than air. It pools in the low ground by the ponds.\nBreathe helium and your voice goes up. Breathe this and it goes down.\nSomething has been living in the low ground.\nIt does not sound like an animal.' },
  { id: 'lighter', title: 'Receipt with writing on the back', text: 'QuikTrip #0912  1 BIC LIGHTER  1.89\nOn the back, in pencil:\nFlashlight died at the pump house. All I have is this.\nIt lights about as far as I can spit. Good. Anything brighter and he comes.\nWhen he ran at me the flame went sideways like something was pulling the air.\nWhen he had hold of me it went out by itself.' },
  { id: 'puppet', title: 'Torn sketchbook page', text: 'A pencil drawing of a man seen from behind, arms hanging, heels off the ground.\nUnderneath:\nHe stands like something is holding him up by the back of the neck.\nWatched him for a full minute from the overlook. He did not sway. People sway.\nI looked down to turn the page.\nHe was at the next tree. Same pose. Closer.' },
];

export class Objectives {
  constructor(sim) { this.sim = sim; this.world = sim.world; this.rng = sim.rng; }

  setup() {
    const w = this.world, rng = this.rng, P = w.poi;
    const stationAt = (poiKey, ox, oz) => {
      const s = w.structures.find((o) => o.type === poiKey) || P[poiKey];
      const rot = s.rot || 0, c = Math.cos(rot), sn = Math.sin(rot);
      const x = s.x + ox * c + oz * sn, z = s.z - ox * sn + oz * c;
      return { x, z, y: w.heightAt(x, z), rot };
    };
    const genPoi = rng.pick(['pumphouse', 'shed']);
    const relayPoi = rng.pick(['blind', 'bench', 'fishing', 'footbridge']);
    // The shed has solid building collision; place equipment outside its front
    // wall so it can be seen and worked on without interacting through timber.
    const genPos = genPoi === 'pumphouse' ? stationAt('pumphouse', 0.6, 2.6) : stationAt('shed', 1.2, 3.0);
    // The mapped overlook bench is in the river channel. Mount its relay on
    // the dry, trail-facing bank nearby rather than below the water surface.
    const relayPos = relayPoi === 'footbridge' ? stationAt('footbridge', 2.0, 7.5)
      : relayPoi === 'blind' ? stationAt('blind', 2.6, 0.5)
      : relayPoi === 'bench' ? stationAt('bench', -1.0, 12.0)
      : stationAt(relayPoi, 1.6, -0.4);
    const mastPos = stationAt('mast', 1.8, 1.2);
    const antennaPos=stationAt('farbank',1.6,0);
    const targetDial=Math.round((Math.atan2(mastPos.x-antennaPos.x,-(mastPos.z-antennaPos.z))+Math.PI*2)/(Math.PI/4))%8;
    // Vary the initial setting without consuming the AI/director RNG stream.
    const initialDial=(targetDial+2+((Math.imul(this.sim.seed,1664525)>>>0)%4))%8;
    this.stations = [
      { id: 'gen', kind: 'generator', name: 'Start the backup generator', where: genPoi === 'pumphouse' ? 'Old Pump House' : 'Ranger Maintenance Shed', needs: ['fuel'], hold: 10, noisy: true, ...genPos, done: false, prog: 0 },
      { id: 'relay', kind: 'relay', name: 'Replace the fuse in the trail relay box', where: { blind: 'Pond Wildlife Blind', bench: 'River Bend Overlook', fishing: 'Fishing Bank', footbridge: 'Slough Footbridge' }[relayPoi], needs: ['fuse'], hold: 7, noisy: false, ...relayPos, done: false, prog: 0 },
      { id:'uplink',kind:'antenna',action:'dial',name:'Align the far-bank rescue antenna',where:'Far-bank Service Landing',
        needs:['crank'],hold:0,noisy:false,...antennaPos,done:false,prog:0,dial:initialDial,targetDial,targetBearing:ANTENNA_BEARINGS[targetDial],lastDialAt:-999 },
      { id: 'mast', kind: 'transmitter', name: 'Send the distress call from the repeater mast', where: 'Old Repeater Mast', needs: ['gen', 'relay','uplink'], hold: 12, noisy: true, ...mastPos, done: false, prog: 0 },
    ];
    for(const station of this.stations){station.steps=REPAIR_STEPS[station.kind];station.checkpoint=0;}
    const hw = P.highway;
    this.extract = { x: hw.x + 6, z: hw.z + 10, y: w.heightAt(hw.x + 6, hw.z + 10), r: CONFIG.SESSION.EXTRACT_RADIUS };
    this.extractOpen = false;
    // item spots near landmarks
    const spots = [];
    const near = (key, ox, oz, label) => { const s = w.structures.find((o) => o.type === key); if (s) { const p = stationAt(key, ox, oz); spots.push({ ...p, label }); } };
    near('camp', -0.4, 1.2, 'camp'); near('shed', -1.8, 3.0, 'shed'); near('pumphouse', -2.3, 0.6, 'pumphouse');
    near('blind', -1.0, 1.9, 'blind'); near('fishing', 0.8, 0.9, 'fishing'); near('bench', 1.4, 12.0, 'overlook');
    near('car', 1.4, 0, 'car'); near('kiosk', 0.8, 1.0, 'kiosk');
    for (let k = 0; k < 12; k++) {
      for (let t = 0; t < 20; t++) {
        const p = pointAtDistance(w.trail, w.trailCum, rng.range(60, w.trailLength - 60));
        const a = rng.range(0, Math.PI * 2), d = rng.range(3, 12);
        const x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
        if (w.isPlayable(x, z) && w.navWalkable(x, z) && w.waterAt(x, z) === null) { spots.push({ x, z, y: w.heightAt(x, z), rot: rng() * 6.28, label: 'trail' }); break; }
      }
    }
    // The kiosk is reserved for the actual briefing, not unrelated campsite notes.
    for(let i=spots.length-1;i>=0;i--)if(spots[i].label==='kiosk')spots.splice(i,1);
    rng.shuffle(spots);
    const take = (pred, fallback=true) => { const i = spots.findIndex(pred); return i >= 0 ? spots.splice(i, 1)[0] : fallback ? spots.shift() : null; };
    const names={camp:'Abandoned Campsite',shed:'Ranger Maintenance Shed',pumphouse:'Old Pump House',
      blind:'Pond Wildlife Blind',fishing:'Fishing Bank',overlook:'River Bend Overlook',car:'South Trailhead Lot — parked cars'};
    this.items = [];
    const fuelSpot = take((s) => ['camp','car',genPoi==='pumphouse'?'shed':'pumphouse'].includes(s.label));
    this.items.push({ id: 'fuel', kind: 'fuel', name: 'Gas can', ...fuelSpot, holder: null });
    const fuseSpot = take((s) => ['blind','fishing','overlook','pumphouse','camp'].includes(s.label));
    this.items.push({ id: 'fuse', kind: 'fuse', name: 'Orange fuse kit', ...fuseSpot, holder: null });
    this.items.push({id:'crank',kind:'crank',name:'Antenna handwheel',...stationAt('farbank',-1.1,1.2),label:'farbank',holder:null});
    this.supplyHints={fuel:names[fuelSpot.label]||'beside the marked trail',fuse:names[fuseSpot.label]||'beside the marked trail',crank:'Far-bank Service Landing'};
    this.memoText=NOTES[0].text+'\n\nTONIGHT\'S SUPPLY REGISTER\nGas can: '+this.supplyHints.fuel+'.\nFuse kit: '+this.supplyHints.fuse+'.'
      +'\n\nRIVER AERIAL\nBefore the mast call, cross the River Maintenance Crossing near Fishing Bank. Follow the dashed service path on your field map. Recover the handwheel beside the far-bank antenna, then aim the aerial toward the Old Repeater Mast: '
      +ANTENNA_BEARINGS[targetDial]+'. Press E to turn it clockwise one compass position. It locks and lights green on the correct bearing. The setting stays put if you need to hide.'
      +'\n\nRepairs latch at each completed step. If you hear the hunt hum, leave the equipment and hide; finished steps stay done.';
    for (let k = 0; k < 5; k++) { const s = take((s) => s.label === 'trail') || take(() => true); if (s) this.items.push({ id: 'bat' + k, kind: 'battery', name: 'Spare lighter', ...s, holder: null }); }
    const blanketSpot = take((s) => s.label === 'camp',false) || take((s) => s.label === 'shed',false) || take(() => true);
    if (blanketSpot) this.items.push({ id: 'camo_blanket', kind: 'blanket', name: 'Camouflage blanket', ...blanketSpot, holder: null });
    // notes: the maintenance memo always sits on the kiosk; three of the others are scattered
    const kiosk = w.structures.find((o) => o.type === 'kiosk');
    const kp = stationAt('kiosk', 0, 0.45);
    this.items.push({ id: 'note_memo', kind: 'note', note: 'memo', name: NOTES[0].title, x: kp.x, z: kp.z, y: kp.y + 1.2, rot: kiosk.rot, holder: null, wall: true });
    // Update 0.9: 13 notes, NOTES_PER_NIGHT scattered. The main stream is consumed exactly as it
    // was with five (seeded sessions keep their layouts); the choice uses its own stream.
    rng.shuffle(NOTES.slice(1, 6));
    const noteRng = makeRng((this.sim.seed ^ 0x4e07e5) >>> 0);
    const others = noteRng.shuffle(NOTES.slice(1)).slice(0, CONFIG.NOTES_PER_NIGHT);
    for (const n of others) { const s = (n.id === 'camp' && take((s) => s.label === 'camp',false)) || take(() => true); if (s) this.items.push({ id: 'note_' + n.id, kind: 'note', note: n.id, name: n.id==='camp'&&s.label!=='camp'?'Crumpled campsite note':n.title, ...s, holder: null }); }
    this.team = { fuel: false, fuse: false, crank:false };
    this.notesRead = [];
  }

  doneCount() { return this.stations.filter((s) => s.done).length; }

  canUse(s) {
    return s.needs.every((n) => TEAM_ITEMS.includes(n) ? this.team[n] : this.stations.find((x) => x.id === n)?.done);
  }

  missing(s) {
    const out = [];
    for (const n of s.needs) {
      if (n === 'fuel' && !this.team.fuel) out.push('Needs the gas can');
      else if (n === 'fuse' && !this.team.fuse) out.push('Needs the fuse kit');
      else if (n === 'crank' && !this.team.crank) out.push('Needs the handwheel beside the far-bank antenna');
      else if (!TEAM_ITEMS.includes(n) && !this.stations.find((x) => x.id === n)?.done) out.push(n==='uplink'?'Far-bank antenna is not aligned':'No power to the repeater yet');
    }
    return out;
  }

  // per-tick interaction processing; returns true while noisy work is happening
  update(dt) {
    const sim = this.sim;
    let noisy = false;
    for (const s of this.stations) {
      if (s.done) continue;
      if (s.action==='dial') continue; // only deliberate presses turn the aerial
      const workers=[];
      for (const p of sim.playerList) {
        if (p.state !== 'alive' || p.use !== s.id || p.covered || (p.heldUntil??-1)>sim.time) continue;
        if (Math.hypot(p.x - s.x, p.z - s.z) > 2.8 || !this.canUse(s)) continue;
        if(Math.abs(p.y-s.y)>2 || this.world.lineOfSight(p.x,p.y+eyeHeight(p),p.z,s.x,s.y+.6,s.z,{brushK:0})<.2)continue;
        workers.push(p);
      }
      if (workers.length) {
        const working=workers[0];
        s.prog = Math.min(1, s.prog + dt / s.hold * Math.min(1.7,1+.35*(workers.length-1)));
        const checkpoint=Math.floor(s.prog*3+1e-7)/3;
        if(checkpoint>s.checkpoint){
          s.checkpoint=checkpoint;
          sim.emit({type:'objective_step',id:s.id,pid:working.id,step:Math.min(3,Math.round(checkpoint*3)),name:s.steps[Math.min(2,Math.round(checkpoint*3)-1)]});
        }
        if (s.noisy) { for(const worker of workers)worker.interactNoise=true; noisy = true; }
        if (s.prog >= 1) {
          s.done = true;
          sim.emit({ type: 'objective', id: s.id, pid: working.id, name: s.name });
          if (s.id === 'mast') { this.extractOpen = true; sim.state = 'extract'; sim.emit({ type: 'extract_open' }); }
        }
      } else s.prog = Math.max(s.checkpoint, s.prog - dt * 0.02); // completed steps stay latched
    }
    return noisy;
  }

  pickup(p, id) {
    const it = this.items.find((i) => i.id === id);
    if (!it || it.holder || p.state!=='alive' || (p.heldUntil??-1)>this.sim.time) return false;
    if (Math.hypot(p.x - it.x, p.z - it.z) > 2.6) return false;
    if(Math.abs(p.y-it.y)>2 || this.world.lineOfSight(p.x,p.y+eyeHeight(p),p.z,it.x,it.y+.12,it.z,{brushK:0})<.2)return false;
    it.holder = p.id;
    if (TEAM_ITEMS.includes(it.kind)) this.team[it.kind] = true;
    if (it.kind === 'note') this.notesRead.push(it.note);
    this.sim.emit({ type: 'pickup', id, kind: it.kind, pid: p.id, note: it.note || null });
    return true;
  }

  snapshot() {
    return {
      st: this.stations.map((s) => s.action==='dial'?[s.id,s.done?1:0,+s.prog.toFixed(3),s.dial]:[s.id, s.done ? 1 : 0, +s.prog.toFixed(3)]),
      it: this.items.filter((i) => i.holder).map((i) => i.id),
      team: this.team, ex: this.extractOpen,
    };
  }

  // static layout sent once at session start
  layout() {
    return {
      stations: this.stations.map(({ id, kind, name, where, needs, hold, steps, action, dial, targetBearing, x, y, z, rot }) => ({ id, kind, name, where, needs, hold, steps, action, dial, targetBearing, x, y, z, rot })),
      items: this.items.map(({ id, kind, name, note, label, x, y, z, rot, wall }) => ({ id, kind, name, note, label, x, y, z, rot, wall })),
      supplyHints:this.supplyHints, memoText:this.memoText,
      extract: this.extract,
    };
  }

  turn(p,id) {
    const s=this.stations.find(s=>s.id===id),sim=this.sim;
    if(!s||s.action!=='dial'||s.done||!this.canUse(s)||p.state!=='alive'||p.covered||(p.heldUntil??-1)>sim.time)return false;
    if(Math.hypot(p.x-s.x,p.z-s.z)>2.8||Math.abs(p.y-s.y)>2||sim.time-s.lastDialAt<.35)return false;
    if(this.world.lineOfSight(p.x,p.y+eyeHeight(p),p.z,s.x,s.y+.6,s.z,{brushK:0})<.2)return false;
    s.lastDialAt=sim.time;s.dial=(s.dial+1)%8;
    sim.emit({type:'objective_dial',id:s.id,pid:p.id,bearing:ANTENNA_BEARINGS[s.dial]});
    if(s.dial===s.targetDial){s.done=true;s.prog=1;sim.emit({type:'objective',id:s.id,pid:p.id,name:s.name});}
    return true;
  }
}
