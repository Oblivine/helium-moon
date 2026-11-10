// Procedural sound library. Functions return Float32Array (mono) or [L,R] at
// SR. Recorded player breathing, crickets, foliage wind and signature audio
// are loaded separately by AudioEngine; unused legacy wildlife is not scheduled.
import { Biquad, filter, noise, brown, normalize, fade, softclip, mixInto, voice, VOWELS, lerpVowel, pitchShift, resample, reverse, rngFor } from './dsp.js';

export const SR = 32000;
const TAU = Math.PI * 2;
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));
const N = (s) => Math.floor(s * SR);

// crossfade the tail into the head so a buffer loops seamlessly
function loopify(buf, xf) {
  const n = buf.length - xf, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf[i];
  for (let i = 0; i < xf; i++) { const k = i / xf; out[i] = buf[i] * k + buf[n + i] * (1 - k); }
  return out;
}

// ------------------------------------------------------------------ ambience loops
export function crickets(seed) {
  const r = rngFor(seed), L = 14, n = N(L);
  const outL = new Float32Array(n), outR = new Float32Array(n);
  // field crickets: 3-4 pulse chirps (cool October night -> slow chirp rate)
  for (let c = 0; c < 26; c++) {
    const f = Math.round(r.range(4100, 5200) * L) / L;
    const k = Math.max(1, Math.round(L * r.range(1.1, 2.2))), period = L / k;
    const ph = r() * period, pulses = r.int(3, 4), amp = 0.04 + Math.pow(r(), 2.2) * 0.45, pan = r.range(-1, 1);
    const gl = Math.sqrt((1 - pan) / 2), gr = Math.sqrt((1 + pan) / 2);
    const skip = r.range(0, 0.35);
    for (let j = 0; j < k; j++) {
      if (r() < skip) continue;
      const t0 = ph + j * period;
      for (let p = 0; p < pulses; p++) {
        const ts = t0 + p * 0.034, s0 = N(ts) % n, len = N(0.02);
        for (let i = 0; i < len; i++) {
          const e = Math.sin(Math.PI * i / len) ** 2, idx = (s0 + i) % n, t = idx / SR;
          const v = Math.sin(TAU * f * t) * e * amp;
          outL[idx] += v * gl; outR[idx] += v * gr;
        }
      }
    }
  }
  // tree crickets: continuous pulsing trills
  for (let c = 0; c < 4; c++) {
    const f = Math.round(r.range(2700, 3100) * L) / L, am = Math.round(r.range(38, 52) * L) / L, amp = r.range(0.02, 0.07), pan = r.range(-1, 1);
    const sw = Math.round(r.range(1, 3)) / L;
    for (let i = 0; i < n; i++) {
      const t = i / SR, e = Math.max(0, Math.sin(TAU * am * t)) ** 3 * (0.6 + 0.4 * Math.sin(TAU * sw * t + c));
      const v = Math.sin(TAU * f * t) * e * amp;
      outL[i] += v * (1 - pan) * 0.5; outR[i] += v * (1 + pan) * 0.5;
    }
  }
  return [normalize(outL, 0.5), normalize(outR, 0.5)];
}

export function katydids(seed) {
  const r = rngFor(seed), L = 15, n = N(L);
  const outL = new Float32Array(n), outR = new Float32Array(n);
  const bp = new Biquad('bp', 7000, 2.5, SR);
  const nz = noise(N(0.12), r);
  for (let c = 0; c < 7; c++) {
    const k = Math.round(L / r.range(0.9, 1.4)), period = L / k, ph = r() * period;
    const amp = 0.08 + Math.pow(r(), 2) * 0.5, pan = r.range(-1, 1);
    const groups = r() < 0.5 ? 3 : 2;
    for (let j = 0; j < k; j++) {
      for (let g = 0; g < groups; g++) {
        const ts = ph + j * period + g * 0.16, s0 = N(ts), len = N(r.range(0.05, 0.085));
        const tooth = r.range(160, 240);
        for (let i = 0; i < len; i++) {
          const idx = (s0 + i) % n, t = i / SR;
          const e = Math.sin(Math.PI * i / len) * (0.5 + 0.5 * Math.sign(Math.sin(TAU * tooth * t)));
          const v = bp.tick(nz[i % nz.length]) * e * amp;
          outL[idx] += v * (1 - pan) * 0.5; outR[idx] += v * (1 + pan) * 0.5;
        }
      }
    }
  }
  return [normalize(outL, 0.45), normalize(outR, 0.45)];
}

export function wind(seed) {
  const r = rngFor(seed), L = 22, xf = N(2), n = N(L) + xf;
  const chans = [];
  for (let ch = 0; ch < 2; ch++) {
    const low = filter(brown(n, r), 'lp', 420, 0.6, SR);
    const leaves = filter(filter(noise(n, r), 'hp', 1800, 0.7, SR), 'lp', 7000, 0.7, SR);
    const out = new Float32Array(n);
    const p1 = r() * 6, p2 = r() * 6;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const g = 0.55 + 0.25 * Math.sin(TAU * t / 11 + p1) + 0.2 * Math.sin(TAU * t / 4.4 + p2);
      out[i] = low[i] * 0.9 * g + leaves[i] * 0.18 * g * g * g;
    }
    chans.push(normalize(loopify(out, xf), 0.6));
  }
  return chans;
}

export function river(seed) {
  const r = rngFor(seed), L = 10, xf = N(1), n = N(L) + xf;
  const chans = [];
  for (let ch = 0; ch < 2; ch++) {
    const b = filter(filter(noise(n, r), 'bp', 900, 0.5, SR), 'lp', 2500, 0.7, SR);
    for (let k = 0; k < 140; k++) {
      const s0 = r.int(0, n - N(0.08)), f0 = r.range(300, 1100), len = N(r.range(0.02, 0.07)), a = r.range(0.05, 0.3);
      for (let i = 0; i < len; i++) { const t = i / SR; b[s0 + i] += Math.sin(TAU * f0 * t * (1 + t * 8)) * Math.exp(-t * 60) * a; }
    }
    chans.push(normalize(loopify(b, xf), 0.5));
  }
  return chans;
}

export function traffic(seed) {
  const r = rngFor(seed), L = 30, xf = N(3), n = N(L) + xf;
  const out = filter(brown(n, r), 'lp', 160, 0.7, SR);
  const tire = filter(noise(n, r), 'bp', 650, 0.8, SR);
  for (let k = 0; k < 5; k++) {
    const c = r.range(2, L), w = r.range(2.5, 5), a = r.range(0.4, 1.2);
    for (let i = 0; i < n; i++) { const t = i / SR; const e = Math.exp(-(((t - c) / w) ** 2)); if (e > 0.001) out[i] += (tire[i] * 0.25 + out[i] * 0.6) * e * a; }
  }
  return normalize(loopify(out, xf), 0.5);
}

// ------------------------------------------------------------------ wildlife one-shots
export function owl(seed) {
  const r = rngFor(seed), out = new Float32Array(N(3.4));
  const f = r.range(300, 360);
  const notes = [[0, 0.28], [0.55, 0.18], [0.78, 0.36], [1.45, 0.42], [2.25, 0.45]];
  for (const [t0, d] of notes) {
    const len = N(d), s0 = N(t0);
    for (let i = 0; i < len; i++) {
      const t = i / SR, e = Math.min(1, t / 0.06) * Math.min(1, (d - t) / 0.12);
      const fr = f * (1 - 0.06 * (t / d));
      out[s0 + i] += (Math.sin(TAU * fr * t) + 0.18 * Math.sin(TAU * 2 * fr * t)) * e * 0.6;
    }
  }
  return fade(normalize(filter(out, 'lp', 1400, 0.7, SR), 0.8), SR);
}

// White-tailed deer alarm "blow": a forceful nasal exhale, loud and breathy, with a
// whistling edge (wildlife false alarm, docs/SCARE_RESEARCH.md X4).
export function deerBlow(seed) {
  const r = rngFor(seed), out = new Float32Array(N(0.9));
  const blows = r() < 0.5 ? 1 : 2;
  for (let b = 0; b < blows; b++) {
    const s0 = N(b * r.range(0.35, 0.5)), d = r.range(0.28, 0.42), len = N(d);
    const nz = noise(len, r);
    const body = filter(filter(nz, 'bp', r.range(650, 900), 0.9, SR), 'lp', 2600, 0.7, SR);
    const edge = filter(nz, 'bp', r.range(1700, 2300), 6, SR);
    for (let i = 0; i < len; i++) {
      const t = i / SR, e = env(t, 0.012, d * 0.32);
      out[s0 + i] += (body[i] * 1.0 + edge[i] * 0.35) * e * (b ? 0.75 : 1);
    }
  }
  return fade(normalize(out, 0.9), SR, 0.003, 0.08);
}

// Owl taking off: a few soft, low wing claps (owls are near-silent fliers; this is the
// startle of big wings right above you, not a flutter).
export function wingFlap(seed) {
  const r = rngFor(seed), out = new Float32Array(N(1.2));
  const n = r.int(3, 4);
  for (let k = 0; k < n; k++) {
    const s0 = N(k * r.range(0.2, 0.26)), len = N(0.12);
    const w = filter(filter(noise(len, r), 'lp', r.range(380, 520), 0.8, SR), 'hp', 70, 0.7, SR);
    for (let i = 0; i < len; i++) out[s0 + i] += w[i] * env(i / SR, 0.018, 0.04) * (1 - k * 0.18);
  }
  return fade(normalize(out, 0.85), SR);
}

// his arm cutting the air on a swing: a fast, low-mid noise sweep (attack, owner Oct 25)
export function swing(seed) {
  const r = rngFor(seed), n = N(0.32), out = new Float32Array(n), nz = noise(n, r);
  const bp = new Biquad('bp', 400, 1.3, SR);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    if ((i & 31) === 0) bp.set('bp', 300 + 1600 * Math.sin(Math.PI * k), 1.3);   // the sweep: low -> high -> low
    out[i] = bp.tick(nz[i]) * Math.sin(Math.PI * Math.min(1, k * 1.15)) ** 2;
  }
  return fade(normalize(filter(out, 'lp', 2800, 0.7, SR), 0.8), SR, 0.01, 0.06);
}

// ---- The Puppet (Helium Voice rework, Oct 25): his body's sounds
// joints popping: two or three dry knuckle-cracks with a little body thump
export function jointPop(seed) {
  const r = rngFor(seed), out = new Float32Array(N(0.6)), n = r.int(1, 3);
  let at = 0;
  for (let k = 0; k < n; k++) {
    const len = N(0.03), f = r.range(1400, 2600);
    const nz = filter(filter(noise(len, r), 'bp', f, 2.2, SR), 'hp', 500, 0.7, SR);
    for (let i = 0; i < len; i++) out[N(at) + i] += nz[i] * Math.exp(-i / SR * r.range(160, 260)) * (k ? r.range(0.5, 0.85) : 1);
    const th = N(0.05), tf = r.range(110, 170);
    for (let i = 0; i < th; i++) out[N(at) + i] += Math.sin(TAU * tf * i / SR) * Math.exp(-i / SR * 70) * 0.25;
    at += r.range(0.04, 0.15);
  }
  return normalize(out, 0.85);
}

// A loaded joint creaks, then releases with a dry crack. Lower body resonance
// carries through the hunt hum without bringing back a voice or scream.
export function searchJointCrack(seed) {
  const r = rngFor(seed), out = new Float32Array(N(.65));
  const creak = filter(noise(N(.4), r), 'bp', r.range(650, 1050), 2.8, SR);
  const fundamental = r.range(145, 195);
  for (let i = 0; i < creak.length; i++) {
    const t = i / SR, envelope = Math.sin(Math.PI * t / .4) ** 2;
    const pulse = .45 + .55 * Math.sin(TAU * (24 * t + 32 * t * t)) ** 2;
    out[i] = envelope * pulse * (creak[i] * .3 + Math.sin(TAU * fundamental * t) * .045);
  }
  const crack = jointPop(seed + 19), offset = N(r.range(.17, .24));
  for (let i = 0; i < crack.length && i + offset < out.length; i++) out[i + offset] += crack[i] * .6;
  return fade(normalize(out, .78), SR, .008, .04);
}

// A small stone landing in leaf litter: a dry tick, grit, then two quieter
// settling taps. Deliberately less weight than a footstep or creature impact.
export function pebbleImpact(seed) {
  const r=rngFor(seed),out=new Float32Array(N(.32));
  for(const [at,gain] of [[0,1],[.074,.32],[.139,.12]]){
    const len=N(.055),offset=N(at),grit=filter(noise(len,r),'bp',r.range(1700,2900),1.3,SR);
    const fundamental=r.range(850,1250);
    for(let i=0;i<len;i++){
      const t=i/SR;
      out[offset+i]+=(grit[i]*.5+Math.sin(TAU*fundamental*t)*.32)*Math.exp(-t*105)*gain;
    }
  }
  return fade(normalize(out,.65),SR,.0005,.035);
}

// hands and feet scuttling through leaf litter: a quick, uneven four-beat patter
export function crawlPatter(seed) {
  const r = rngFor(seed), out = new Float32Array(N(0.42));
  const beats = [0, r.range(0.06, 0.1), r.range(0.17, 0.22), r.range(0.26, 0.33)];
  for (const b of beats) {
    const len = N(r.range(0.04, 0.07));
    const nz = filter(filter(noise(len, r), 'bp', r.range(900, 2400), 0.8, SR), 'lp', 4200, 0.7, SR);
    for (let i = 0; i < len; i++) out[N(b) + i] += nz[i] * env(i / SR, 0.004, 0.018) * r.range(0.5, 1);
    const th = N(0.04);
    for (let i = 0; i < th; i++) out[N(b) + i] += Math.sin(TAU * r.range(70, 100) * i / SR) * Math.exp(-i / SR * 60) * 0.35;
  }
  return fade(normalize(out, 0.8), SR, 0.002, 0.03);
}

// knuckles on the boardwalk planks: hollow wooden knocks
export function knuckleWood(seed) {
  const r = rngFor(seed), out = new Float32Array(N(0.35)), n = r.int(2, 3);
  for (let k = 0; k < n; k++) {
    const s0 = N(k * r.range(0.07, 0.12)), len = N(0.12), f = r.range(260, 420);
    const exc = filter(noise(len, r), 'bp', f, 9, SR), body = filter(noise(len, r), 'bp', f * 2.7, 6, SR);
    for (let i = 0; i < len; i++) out[s0 + i] += (exc[i] + body[i] * 0.4) * Math.exp(-i / SR * 45);
  }
  return normalize(out, 0.8);
}

// a limp body dropping into the leaves
export function bodyDrop(seed) {
  const r = rngFor(seed), out = new Float32Array(N(0.9));
  const hit = (at, g) => {
    const len = N(0.25), tf = r.range(55, 80);
    for (let i = 0; i < len; i++) out[N(at) + i] += Math.sin(TAU * tf * i / SR) * Math.exp(-i / SR * 18) * g;
    const nz = filter(noise(len, r), 'bp', r.range(600, 1400), 0.7, SR);
    for (let i = 0; i < len; i++) out[N(at) + i] += nz[i] * Math.exp(-i / SR * 22) * g * 0.6;
  };
  hit(0, 1); hit(r.range(0.12, 0.2), 0.55); hit(r.range(0.3, 0.42), 0.3);
  return fade(normalize(out, 0.9), SR, 0.002, 0.15);
}

// his hands closing on your clothes: a hard fabric grab and drag
export function clothGrab(seed) {
  const r = rngFor(seed), d = 0.5, n = N(d), out = new Float32Array(n), nz = noise(n, r);
  const bp = new Biquad('bp', 1800, 0.9, SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if ((i & 31) === 0) bp.set('bp', 1200 + 2200 * Math.exp(-t * 6) + r.range(-200, 200), 0.9);
    out[i] = bp.tick(nz[i]) * (env(t, 0.006, 0.07) + 0.35 * Math.exp(-((t - 0.22) ** 2) / 0.004));
  }
  return fade(normalize(out, 0.85), SR, 0.002, 0.08);
}

// your own breath cut off: a muffled strangled gasp (the throat / hand-over-face grabs)
export function choke(seed) {
  const r = rngFor(seed), d = 1.2;
  const v = voice(SR, d, {
    f0: (t) => 150 + 40 * Math.sin(t * 9), vowel: (t) => lerpVowel(VOWELS.u, VOWELS.o, t / d), breath: 0.7, formantShift: 0.9, rng: r,
    env: (t) => (0.4 + 0.6 * Math.abs(Math.sin(t * 7.5))) * Math.sin(Math.PI * Math.min(1, t / d)) ** 0.8,
  });
  return fade(normalize(filter(v, 'lp', 900, 0.7, SR), 0.6), SR, 0.02, 0.2);
}

// the lighter (owner: the flashlight is a small lighter now)
// flint wheel: a fast ratchety scratch; `catch` adds the soft whump of the flame taking
export function lighterStrike(seed, catchFlame = true) {
  const r = rngFor(seed), out = new Float32Array(N(catchFlame ? 0.55 : 0.25));
  const grains = r.int(9, 14);
  for (let k = 0; k < grains; k++) {
    const s0 = N(k * 0.006 + r.range(0, 0.004)), len = N(0.004);
    const nz = filter(noise(len, r), 'bp', r.range(3000, 6500), 1.2, SR);
    for (let i = 0; i < len; i++) out[s0 + i] += nz[i] * (1 - k / grains) * r.range(0.5, 1);
  }
  const sp = N(0.05), spark = filter(noise(sp, r), 'hp', 5000, 0.7, SR);
  for (let i = 0; i < sp; i++) out[N(0.06) + i] += spark[i] * Math.exp(-i / SR * 70) * 0.5;
  if (catchFlame) {
    const len = N(0.4), body = filter(filter(noise(len, r), 'lp', 900, 0.7, SR), 'hp', 80, 0.7, SR);
    for (let i = 0; i < len; i++) out[N(0.09) + i] += body[i] * env(i / SR, 0.03, 0.12) * 0.9;
  }
  return fade(normalize(out, 0.8), SR, 0.001, 0.05);
}
// letting go of the gas button: a small click and the flame's last breath
export function lighterRelease(seed) {
  const r = rngFor(seed), out = new Float32Array(N(0.25));
  const len = N(0.012), c = filter(noise(len, r), 'bp', 2200, 2, SR);
  for (let i = 0; i < len; i++) out[i] += c[i] * Math.exp(-i / SR * 300);
  const pf = N(0.15), puff = filter(noise(pf, r), 'lp', 700, 0.7, SR);
  for (let i = 0; i < pf; i++) out[N(0.01) + i] += puff[i] * env(i / SR, 0.01, 0.04) * 0.5;
  return fade(normalize(out, 0.6), SR, 0.001, 0.05);
}

// ================================================================== Update 0.9 "The Long Night"
// a latex balloon bursting: one very sharp crack, a short hollow ring, shreds settling
export function balloonPop(seed) {
  const r = rngFor(seed), out = new Float32Array(N(0.6));
  const cr = N(0.012), nz = noise(cr, r);
  for (let i = 0; i < cr; i++) out[i] += nz[i] * Math.exp(-i / SR * 420) * 1.6;
  const body = N(0.16), bz = filter(noise(body, r), 'bp', r.range(900, 1300), 2.5, SR);
  for (let i = 0; i < body; i++) out[i] += bz[i] * Math.exp(-i / SR * 34) * 0.9;
  const th = N(0.08); for (let i = 0; i < th; i++) out[i] += Math.sin(TAU * 140 * i / SR) * Math.exp(-i / SR * 60) * 0.5;
  const sh = N(0.3), sz = filter(noise(sh, r), 'hp', 3500, 0.7, SR);
  for (let i = 0; i < sh; i++) out[N(0.05) + i] += sz[i] * env(i / SR, 0.01, 0.07) * 0.12;
  return fade(normalize(softclip(out, 1.6), 0.95), SR, 0.0005, 0.08);
}
// rubber squeaking against string as it is untied, then a soft slip
export function balloonSqueak(seed) {
  const r = rngFor(seed), d = 0.7, n = N(d), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, on = (t > 0.05 && t < 0.22) || (t > 0.3 && t < 0.42) ? 1 : 0;
    const f = 1500 + 500 * Math.sin(t * 31) + 200 * Math.sin(t * 77);
    ph += f / SR; out[i] = on * (Math.sin(TAU * ph) * 0.5 + (ph % 1 - 0.5) * 0.3) * (0.6 + 0.4 * Math.sin(t * 190));
  }
  const sl = N(0.2), sz = filter(noise(sl, r), 'bp', 2400, 1, SR);
  for (let i = 0; i < sl; i++) out[N(0.46) + i] += sz[i] * env(i / SR, 0.02, 0.05) * 0.5;
  return fade(normalize(filter(out, 'lp', 5000, 0.7, SR), 0.35), SR, 0.01, 0.08);
}
// a freight train a couple of miles off: a long two-chord horn (the grade-crossing pattern,
// long long short long), smeared by distance, over wheel rumble that swells and fades
export function distantTrain(seed) {
  const r = rngFor(seed), d = 22, n = N(d), out = new Float32Array(n);
  const chord = [311, 370, 415].map((f) => f * r.range(0.985, 1.015));
  const blasts = [[2.0, 2.6], [5.4, 2.6], [8.8, 0.9], [10.4, 3.6]];
  for (const [t0, len] of blasts) {
    const s0 = N(t0), ln = N(len);
    for (let i = 0; i < ln; i++) {
      const t = i / SR, e = Math.min(1, t / 0.25) * Math.min(1, (len - t) / 0.5);
      let v = 0; for (const f of chord) v += Math.sin(TAU * f * (t0 + t) * (1 - 0.004 * (t0 + t) / d)) + 0.35 * Math.sin(TAU * 2 * f * (t0 + t));
      out[s0 + i] += v * e * 0.16;
    }
  }
  const rum = filter(brown(n, r), 'lp', 140, 0.7, SR);
  for (let i = 0; i < n; i++) { const t = i / SR; out[i] += rum[i] * Math.sin(Math.PI * t / d) ** 1.5 * 0.9 * (0.8 + 0.2 * Math.sin(t * 7.3)); }
  // distance: no highs, and a slow wash
  const far = filter(filter(out, 'lp', 900, 0.6, SR), 'lp', 1400, 0.6, SR);
  for (let i = N(0.35); i < n; i++) far[i] += far[i - N(0.35)] * 0.32;
  return fade(normalize(far, 0.8), SR, 1.5, 3);
}
// a farm dog, far off: a few gruff barks with an echo off the tree line
export function farmDog(seed) {
  const r = rngFor(seed), d = 3.6, out = new Float32Array(N(d)), barks = r.int(2, 5), base = r.range(210, 290);
  let t0 = 0.05;
  for (let b = 0; b < barks; b++) {
    const len = r.range(0.11, 0.17);
    const seg = voice(SR, len, { f0: (t) => base * (1.25 - 0.5 * t / len) + Math.sin(t * 90) * 14, vowel: (t) => lerpVowel(VOWELS.a, VOWELS.o, t / len), breath: 0.35, formantShift: 0.95, rng: r,
      env: (t) => Math.min(1, t / 0.012) * Math.exp(-t / (len * 0.55)) });
    mixInto(out, seg, N(t0), r.range(0.7, 1));
    t0 += len + r.range(0.16, b % 2 ? 0.55 : 0.28);
    if (t0 > d - 1) break;
  }
  const dly = N(0.31); for (let i = dly; i < out.length; i++) out[i] += out[i - dly] * 0.28;
  return fade(normalize(filter(filter(softclip(out, 2.2), 'lp', 1500, 0.7, SR), 'hp', 180, 0.7, SR), 0.75), SR, 0.005, 0.4);
}
// a dead limb letting go: a dry crack, a rush of twigs, a heavy thump in the leaves
export function branchFall(seed) {
  const r = rngFor(seed), out = new Float32Array(N(2.4));
  for (const [t0, g] of [[0, 1], [r.range(0.07, 0.13), 0.6]]) {
    const len = N(0.05), nz = filter(noise(len, r), 'bp', r.range(1100, 1900), 1.4, SR);
    for (let i = 0; i < len; i++) out[N(t0) + i] += nz[i] * Math.exp(-i / SR * 110) * g * 1.4;
  }
  const sw = N(0.8), sz = filter(noise(sw, r), 'bp', 2600, 0.6, SR);
  for (let i = 0; i < sw; i++) { const t = i / SR; out[N(0.25) + i] += sz[i] * Math.sin(Math.PI * t / 0.8) ** 2 * 0.3 * (0.6 + 0.4 * Math.sin(t * 60)); }
  const at = N(1.02), th = N(0.5);
  for (let i = 0; i < th; i++) out[at + i] += Math.sin(TAU * r.range(52, 60) * i / SR) * Math.exp(-i / SR * 11) * 1.1;
  const lf = N(0.6), lz = filter(noise(lf, r), 'bp', 1400, 0.6, SR);
  for (let i = 0; i < lf; i++) out[at + i] += lz[i] * env(i / SR, 0.01, 0.12) * 0.55;
  return fade(normalize(out, 0.9), SR, 0.001, 0.3);
}
// a car alarm back at the lot (loops): six rising chirps, then the two-tone
export function carAlarmLoop() {
  const L = 4.8, n = N(L), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; let f;
    if (t < 2.4) { const u = (t % 0.4) / 0.4; f = 1500 + 1500 * u; }
    else f = (Math.floor((t - 2.4) / 0.3) % 2) ? 2100 : 2700;
    ph += f / SR; out[i] = (ph % 1 < 0.5 ? 1 : -1) * 0.5 + Math.sin(TAU * ph) * 0.5;
  }
  return normalize(filter(out, 'lp', 4200, 0.7, SR), 0.5);
}
// co-op ping: two soft taps on wood (quiet, close, nothing like an alarm)
export function pingTick(seed) {
  const r = rngFor(seed), out = new Float32Array(N(0.3));
  for (const [t0, g] of [[0, 1], [0.11, 0.7]]) {
    const len = N(0.07), f = r.range(620, 700);
    for (let i = 0; i < len; i++) out[N(t0) + i] += (Math.sin(TAU * f * i / SR) + 0.4 * Math.sin(TAU * f * 2.7 * i / SR)) * Math.exp(-i / SR * 70) * g;
  }
  return fade(normalize(out, 0.5), SR, 0.001, 0.05);
}
// handheld radio: squelch tail, key click
export function radioBlip(seed) {
  const r = rngFor(seed), out = new Float32Array(N(0.42));
  const nz = filter(noise(out.length, r), 'bp', 2000, 0.8, SR);
  for (let i = 0; i < out.length; i++) { const t = i / SR; out[i] = nz[i] * (t < 0.28 ? 0.55 : 0) + (t > 0.28 && t < 0.3 ? (r() - 0.5) * 1.6 : 0); }
  for (let i = 0; i < N(0.05); i++) out[i] += Math.sin(TAU * 1250 * i / SR) * 0.4 * (1 - i / N(0.05));
  return fade(normalize(softclip(out, 2), 0.5), SR, 0.002, 0.03);
}
// your lungs giving out after holding your breath too long: a ragged gasp in, a shaky breath out
export function gasp(seed) {
  const r = rngFor(seed), d = 1.5, n = N(d), out = new Float32Array(n), nz = noise(n, r);
  const bp = new Biquad('bp', 1500, 1.1, SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR, inh = t < 0.55;
    if ((i & 31) === 0) bp.set('bp', inh ? 900 + 2600 * (t / 0.55) : 1700 - 700 * ((t - 0.6) / 0.9), inh ? 1.6 : 0.9);
    const e = inh ? Math.sin(Math.PI * t / 0.55) ** 0.6 : t < 0.68 ? 0 : Math.sin(Math.PI * (t - 0.68) / 0.82) ** 0.8 * 0.55;
    out[i] = bp.tick(nz[i]) * e * (1 + 0.25 * Math.sin(t * 47));
  }
  return fade(normalize(out, 0.7), SR, 0.01, 0.15);
}

export function coyotes(seed) {
  const r = rngFor(seed), dur = 5.5, out = new Float32Array(N(dur));
  for (let v = 0; v < 4; v++) {
    const start = r.range(0, 1.6), len = r.range(1.6, 3.4), base = r.range(520, 760);
    const yips = r.int(2, 5);
    for (let y = 0; y < yips; y++) {
      const ys = start + y * r.range(0.25, 0.5), yl = r.range(0.15, 0.6);
      const peak = base * r.range(1.4, 2.0);
      const seg = voice(SR, yl, {
        f0: (t) => base + (peak - base) * Math.sin(Math.PI * Math.min(1, t / yl)) + Math.sin(t * 38) * 12,
        vowel: () => VOWELS.u, breath: 0.08, env: (t) => Math.sin(Math.PI * Math.min(1, t / yl)) ** 0.7, formantShift: 1.6, rng: r,
      });
      mixInto(out, seg, N(ys), 0.5);
    }
    const howl = voice(SR, len, {
      f0: (t) => base * (1 + 0.5 * Math.sin(Math.PI * t / len)) + Math.sin(t * 30) * 10,
      vowel: (t) => lerpVowel(VOWELS.u, VOWELS.o, t / len), breath: 0.06, env: (t) => Math.sin(Math.PI * t / len) ** 0.8, formantShift: 1.5, rng: r,
    });
    mixInto(out, howl, N(start + 1.1), 0.6);
  }
  return fade(normalize(filter(out, 'lp', 2600, 0.7, SR), 0.8), SR, 0.02, 0.4);
}

export function creak(seed) {
  const r = rngFor(seed), d = r.range(0.8, 1.6), n = N(d), src = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, rate = 25 + 40 * Math.sin(Math.PI * t / d) + r.range(-5, 5);
    ph += rate / SR;
    if (ph > 1) { ph -= 1; src[i] = r.range(0.5, 1); }
  }
  const a = filter(Float32Array.from(src), 'bp', r.range(380, 520), 12, SR), b = filter(Float32Array.from(src), 'bp', r.range(900, 1300), 10, SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] + b[i] * 0.6) * Math.sin(Math.PI * i / n);
  return normalize(out, 0.7);
}

export function twigSnap(seed, big = false) {
  const r = rngFor(seed), out = new Float32Array(N(0.5));
  const cracks = big ? 3 : r.int(1, 2);
  for (let c = 0; c < cracks; c++) {
    const s0 = N(c * r.range(0.03, 0.09)), len = N(0.05);
    const nz = filter(noise(len, r), 'bp', r.range(2200, 4200), 1.2, SR);
    for (let i = 0; i < len; i++) out[s0 + i] += nz[i] * Math.exp(-i / SR * (90 - c * 20)) * (c === 0 ? 1 : 0.6);
    const thud = N(0.08);
    for (let i = 0; i < thud; i++) out[s0 + i] += Math.sin(TAU * 180 * i / SR) * Math.exp(-i / SR * 45) * 0.4;
  }
  return normalize(out, 0.9);
}

export function frog(seed) {
  const r = rngFor(seed), out = new Float32Array(N(2.2)), clicks = r.int(6, 14);
  for (let k = 0; k < clicks; k++) {
    const s0 = N(k * r.range(0.11, 0.16)), len = N(0.03), f = r.range(3000, 3600);
    for (let i = 0; i < len; i++) { const t = i / SR; out[s0 + i] += Math.sin(TAU * f * t) * Math.exp(-t * 120) * (0.4 + k / clicks); }
  }
  return normalize(out, 0.6);
}

export function dogBark(seed) {
  const r = rngFor(seed), out = new Float32Array(N(2.5)), barks = r.int(2, 4);
  for (let k = 0; k < barks; k++) {
    const d = r.range(0.14, 0.22), f = r.range(280, 360);
    const seg = voice(SR, d, { f0: (t) => f * (1 + 0.3 * Math.sin(Math.PI * t / d)), vowel: () => VOWELS.a, breath: 0.4, env: (t) => env(t, 0.01, 0.06), formantShift: 0.9, rng: r });
    mixInto(out, seg, N(k * r.range(0.35, 0.6)), 1);
  }
  return normalize(filter(out, 'lp', 1500, 0.7, SR), 0.7);
}

// ------------------------------------------------------------------ footsteps & foley
export function footstep(kind, seed) {
  const r = rngFor(seed);
  const grains = (len, count, lo, hi, dec, amp = 1) => {
    const out = new Float32Array(N(len));
    for (let k = 0; k < count; k++) {
      const s0 = N(Math.pow(r(), 1.6) * len * 0.8), l = N(r.range(0.003, 0.012));
      const nz = filter(noise(l, r), 'bp', r.range(lo, hi), 1.5, SR);
      for (let i = 0; i < l; i++) out[s0 + i] += nz[i] * Math.exp(-i / SR * dec) * amp * r.range(0.3, 1);
    }
    return out;
  };
  const thud = (len, f, dec, amp) => { const out = new Float32Array(N(len)); const nz = filter(noise(N(len), r), 'lp', f, 0.7, SR); for (let i = 0; i < out.length; i++) out[i] = nz[i] * Math.exp(-i / SR * dec) * amp; return out; };
  let out;
  switch (kind) {
    case 'litter': out = grains(0.32, 45, 1800, 6500, 300, 0.8); mixInto(out, thud(0.12, 220, 40, 1.4), 0); break;
    case 'dirt': out = thud(0.18, 320, 35, 1.6); mixInto(out, grains(0.12, 10, 1200, 3500, 400, 0.5), 0); break;
    case 'mud': {
      out = thud(0.32, 380, 14, 1.4);
      const sq = filter(noise(N(0.25), r), 'bp', 700, 4, SR);
      for (let i = 0; i < sq.length; i++) { const t = i / SR; sq[i] *= Math.sin(Math.PI * t / 0.25) * 0.8; }
      mixInto(out, sq, N(0.05));
      for (let i = 0; i < N(0.04); i++) out[N(0.22) + i] += Math.sin(TAU * 260 * i / SR) * Math.exp(-i / SR * 80) * 0.6;
      break;
    }
    case 'grass': {
      out = filter(filter(noise(N(0.26), r), 'bp', 3200, 0.7, SR), 'hp', 1500, 0.7, SR);
      for (let i = 0; i < out.length; i++) { const t = i / SR; out[i] *= Math.sin(Math.PI * t / 0.26) ** 1.5 * 0.7; }
      mixInto(out, thud(0.1, 200, 50, 0.9), 0);
      break;
    }
    case 'silt': out = filter(noise(N(0.2), r), 'bp', 1800, 0.8, SR); for (let i = 0; i < out.length; i++) out[i] *= Math.exp(-i / SR * 18) * 0.7; mixInto(out, thud(0.1, 250, 50, 1), 0); break;
    case 'water': {
      out = filter(noise(N(0.5), r), 'bp', 1400, 0.6, SR);
      for (let i = 0; i < out.length; i++) { const t = i / SR; out[i] *= env(t, 0.02, 0.09) * 0.9; }
      for (let k = 0; k < 10; k++) { const s0 = N(r.range(0.03, 0.3)), f = r.range(500, 1600), l = N(0.05); for (let i = 0; i < l; i++) { const t = i / SR; out[s0 + i] += Math.sin(TAU * f * t * (1 + t * 12)) * Math.exp(-t * 70) * 0.35; } }
      break;
    }
    case 'gravel': out = grains(0.3, 70, 1000, 4500, 220, 0.9); mixInto(out, thud(0.12, 260, 40, 1), 0); break;
    case 'wood': {
      out = new Float32Array(N(0.35));
      const f = r.range(120, 160);
      for (let i = 0; i < out.length; i++) { const t = i / SR; out[i] = (Math.sin(TAU * f * t) + 0.5 * Math.sin(TAU * f * 2.3 * t)) * Math.exp(-t * 22) * 0.9; }
      mixInto(out, grains(0.03, 4, 2000, 5000, 500, 0.6), 0);
      break;
    }
    case 'asphalt': out = grains(0.15, 18, 2500, 6000, 600, 0.6); mixInto(out, thud(0.08, 600, 60, 1.2), 0); break;
    case 'brush': {
      out = grains(0.45, 90, 1500, 6000, 150, 0.7);
      const sw = filter(noise(N(0.45), r), 'bp', 2500, 0.6, SR);
      for (let i = 0; i < sw.length; i++) { const t = i / SR; sw[i] *= Math.sin(Math.PI * t / 0.45) * 0.5; }
      mixInto(out, sw, 0);
      break;
    }
    default: out = thud(0.15, 300, 40, 1);
  }
  return fade(normalize(out, 0.85), SR, 0.001, 0.03);
}

export function breath(seed, inhale, heavy) {
  const r = rngFor(seed), d = inhale ? r.range(0.7, 1.0) * (heavy ? 0.6 : 1) : r.range(0.8, 1.2) * (heavy ? 0.6 : 1);
  const v = voice(SR, d, {
    f0: () => 110, vowel: () => (inhale ? VOWELS.o : VOWELS.a), whisper: true, formantShift: 0.95, rng: r,
    env: (t) => Math.sin(Math.PI * Math.min(1, t / d)) ** (inhale ? 0.7 : 1.3),
  });
  return normalize(filter(v, 'lp', inhale ? 3500 : 2200, 0.7, SR), heavy ? 0.8 : 0.5);
}

// The creature's formant-based breath above is part of Helium Voice's identity.
// Player breath audio is loaded from the attributed recording in playerBreath.js.
export const PLAYER_BREATH_VARIANTS = 5;

// Playback and visual strengths are separate: cold breath still condenses when
// the player's resting breathing is almost inaudible.
export function playerBreathMix(exert = 0, _fear = 0, downed = 0) {
  const bounded = (v) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  exert = bounded(exert); downed = bounded(downed);
  const u = bounded((exert - 0.45) / 0.55), effort = u * u * (3 - 2 * u);
  return {
    gain: 0.003 + 0.012 * effort + 0.003 * downed,
    heavy: exert > 0.7,
    rate: 0.95 + 0.08 * effort,
    inhaleGap: 0.18 - 0.06 * effort,
    exhaleGap: 0.65 - 0.4 * effort,
    visualStrength: bounded(exert * 0.55 + downed * 0.4),
  };
}

// Physiology follows exertion/injury, never an unseen creature's distance.
export function playerHeartbeatMix(exert = 0, downed = 0) {
  const effort = Math.max(0, Math.min(1, exert || 0));
  return { gain: 0.006 + effort * 0.014 + (downed ? 0.007 : 0), bpm: 62 + effort * 35, rate: 0.95 + effort * 0.05 };
}

export function heartbeat() {
  const out = new Float32Array(N(0.6));
  const beat = (t0, f, a) => { const s0 = N(t0); for (let i = 0; i < N(0.15); i++) { const t = i / SR; out[s0 + i] += Math.sin(TAU * f * t * (1 - t * 1.5)) * Math.min(1, t / 0.008) * Math.exp(-t * 30) * a; } };
  beat(0, 58, 1); beat(0.27, 46, 0.7);
  return normalize(filter(out, 'lp', 160, 0.7, SR), 0.95);
}

export function click(seed, on) {
  const r = rngFor(seed), out = new Float32Array(N(0.08));
  for (const [t0, f] of [[0, on ? 3200 : 2600], [0.018, on ? 1900 : 1500]]) {
    const s0 = N(t0); for (let i = 0; i < N(0.03); i++) { const t = i / SR; out[s0 + i] += (Math.sin(TAU * f * t) + r.range(-0.4, 0.4)) * Math.exp(-t * 400); }
  }
  return normalize(out, 0.6);
}

export function paper(seed) {
  const r = rngFor(seed), out = filter(noise(N(0.6), r), 'bp', 3800, 0.9, SR);
  for (let i = 0; i < out.length; i++) { const t = i / SR; out[i] *= (0.4 + 0.6 * Math.abs(Math.sin(t * 31))) * Math.sin(Math.PI * t / 0.6); }
  return normalize(out, 0.5);
}

export function clink(seed) {
  const r = rngFor(seed), out = new Float32Array(N(0.5));
  for (const f of [r.range(1800, 2400), r.range(3100, 3900), r.range(5200, 6000)]) for (let i = 0; i < out.length; i++) { const t = i / SR; out[i] += Math.sin(TAU * f * t) * Math.exp(-t * 14) * 0.3; }
  return normalize(out, 0.5);
}

export function work(kind, seed) {
  const r = rngFor(seed);
  if (kind === 'gen') { // pull-cord + sputter
    const out = filter(noise(N(0.9), r), 'bp', 900, 1.2, SR);
    for (let i = 0; i < out.length; i++) { const t = i / SR; out[i] *= (t < 0.45 ? Math.sin(Math.PI * t / 0.45) * (0.6 + 0.4 * Math.sin(TAU * 60 * t)) : 0); }
    for (let k = 0; k < r.int(2, 5); k++) { const s0 = N(0.45 + k * 0.09); for (let i = 0; i < N(0.05); i++) out[s0 + i] += (r() * 2 - 1) * Math.exp(-i / SR * 60) * 0.8; }
    return normalize(filter(out, 'lp', 3000, 0.7, SR), 0.8);
  }
  if (kind === 'relay') return normalize(mixInto(clink(seed), footstep('wood', seed + 1), N(0.05), 0.15), 0.6);
  // radio keypad + static
  const out = filter(noise(N(1.1), r), 'bp', 2000, 0.8, SR);
  for (let i = 0; i < out.length; i++) out[i] *= 0.15 * (0.5 + 0.5 * Math.sin(i / SR * 17));
  for (let k = 0; k < 3; k++) { const s0 = N(0.1 + k * 0.22), f = [941, 1209, 1336][k]; for (let i = 0; i < N(0.12); i++) out[s0 + i] += (Math.sin(TAU * f * i / SR) + Math.sin(TAU * 697 * i / SR)) * 0.25; }
  return normalize(out, 0.6);
}

export function generatorLoop(seed) {
  const r = rngFor(seed), L = 2, n = N(L), out = new Float32Array(n);
  const rate = 28; // firing pulses / s (integer cycles per loop)
  for (let i = 0; i < n; i++) { const t = i / SR, ph = (t * rate) % 1; out[i] = Math.exp(-ph * 9) * (0.8 + 0.2 * Math.sin(TAU * t)) + (r() * 2 - 1) * 0.08; }
  const a = filter(Float32Array.from(out), 'lp', 260, 2, SR), b = filter(Float32Array.from(out), 'bp', 1200, 2, SR);
  for (let i = 0; i < n; i++) out[i] = a[i] + b[i] * 0.3;
  return normalize(out, 0.6);
}

export function humLoop() {
  const n = N(1), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; out[i] = Math.sin(TAU * 60 * t) * 0.5 + Math.sin(TAU * 120 * t) * 0.35 + Math.sin(TAU * 180 * t) * 0.15 + (Math.sin(TAU * 120 * t) > 0.97 ? 0.2 : 0); }
  return normalize(out, 0.4);
}

export function sirenLoop() {
  const L = 8, n = N(L), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, f = 950 + 450 * Math.sin(TAU * t / 4 - Math.PI / 2); ph += f / SR; out[i] = Math.sin(TAU * ph) + 0.3 * Math.sin(TAU * ph * 2) + 0.12 * Math.sin(TAU * ph * 3); }
  return normalize(filter(out, 'lp', 2500, 0.7, SR), 0.6);
}

export function radioCall(seed) {
  const r = rngFor(seed), out = new Float32Array(N(4));
  const st = filter(noise(out.length, r), 'bp', 1800, 0.7, SR);
  for (let i = 0; i < out.length; i++) { const t = i / SR; out[i] = st[i] * (t < 0.15 ? 0.9 : 0.12 + 0.1 * Math.sin(t * 9)); }
  for (const [t0, f] of [[0.4, 853], [0.75, 960], [1.1, 853], [1.45, 960]]) { const s0 = N(t0); for (let i = 0; i < N(0.3); i++) out[s0 + i] += Math.sin(TAU * f * i / SR) * 0.5; }
  const talk = voice(SR, 1.6, { f0: (t) => 120 + Math.sin(t * 7) * 20, vowel: (t) => [VOWELS.a, VOWELS.e, VOWELS.o, VOWELS.i][Math.floor(t * 7) % 4], breath: 0.2, env: (t) => 0.5 + 0.5 * Math.sin(t * 23) ** 2, formantShift: 1, rng: r });
  mixInto(out, filter(filter(talk, 'hp', 400, 0.7, SR), 'lp', 2800, 0.7, SR), N(2.0), 0.6);
  return normalize(softclip(out, 2), 0.7);
}

// ------------------------------------------------------------------ Helium Voice (formant voice, raised pitch + helium-shifted formants)
const HV_SHIFT = 1.42;
export function hvVocal(kind, seed, sig) {
  const r = rngFor(seed);
  let out;
  switch (kind) {
    case 'whisper': {
      const d = r.range(1.2, 2.2), syl = r.int(4, 8), vs = Array.from({ length: syl }, () => r.pick([VOWELS.i, VOWELS.e, VOWELS.a, VOWELS.u]));
      out = voice(SR, d, { f0: () => 200, whisper: true, formantShift: HV_SHIFT, rng: r, vowel: (t) => vs[Math.min(syl - 1, Math.floor(t / d * syl))], env: (t) => 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * t / d * syl)) * Math.sin(Math.PI * t / d) });
      // sibilants
      for (let k = 0; k < r.int(1, 3); k++) { const s0 = N(r.range(0, d - 0.2)), nz = filter(noise(N(0.15), r), 'bp', 6500, 2, SR); for (let i = 0; i < nz.length; i++) out[s0 + i] += nz[i] * Math.sin(Math.PI * i / nz.length) * 0.8; }
      out = normalize(out, 0.7); break;
    }
    case 'breath': { const a = breath(seed, true, false), b = breath(seed + 3, false, false); out = new Float32Array(a.length + b.length + N(0.2)); mixInto(out, a, 0); mixInto(out, b, a.length + N(0.15)); out = pitchShift(out, 1.3, SR); break; }
    case 'inhale': { out = reverse(breath(seed, false, true)); out = pitchShift(out, 1.5, SR); break; }
    case 'giggle': {
      const n = r.int(4, 7), p = r.range(0.14, 0.18), d = n * p + 0.3, base = r.range(480, 560);
      out = voice(SR, d, { f0: (t) => base * (1.25 - 0.3 * t / d) * (1 + 0.04 * Math.sin(t * 40)), vowel: () => VOWELS.i, breath: 0.2, formantShift: HV_SHIFT, rng: r,
        env: (t) => { const u = (t % p) / p; return t < n * p && u < 0.7 ? Math.sin(Math.PI * u / 0.7) ** 2 * (1 - 0.4 * t / d) : 0; } });
      break;
    }
    case 'laugh': {
      const n = r.int(3, 6), sp = r.range(0.17, 0.24), d = n * sp + 0.2, base = r.range(400, 470);
      out = voice(SR, d, { f0: (t) => base * (1.15 - 0.25 * t / d), vowel: (t) => lerpVowel(VOWELS.a, VOWELS.e, (t / sp) % 1), breath: 0.3, formantShift: HV_SHIFT, rng: r, env: (t) => Math.max(0, Math.sin(Math.PI * t / sp)) ** 1.5 * (t < n * sp ? 1 : 0) });
      break;
    }
    case 'hum': {
      const notes = Array.from({ length: r.int(3, 5) }, () => r.pick([392, 440, 466, 523, 349])), nd = r.range(0.45, 0.7), d = notes.length * nd;
      out = voice(SR, d, { f0: (t) => notes[Math.min(notes.length - 1, Math.floor(t / nd))] * (1 + 0.012 * Math.sin(t * 33)), vowel: () => VOWELS.m, breath: 0.05, formantShift: HV_SHIFT, rng: r, env: (t) => Math.min(1, t / 0.2) * Math.min(1, (d - t) / 0.3) * 0.8 });
      out = filter(out, 'lp', 2200, 0.7, SR); break;
    }
    case 'call': {
      const d = r.range(1.3, 2.0), w = r.pick(['heyy', 'hello', 'ohh']);
      const vs = w === 'hello' ? [VOWELS.e, VOWELS.o] : w === 'heyy' ? [VOWELS.e, VOWELS.i] : [VOWELS.o, VOWELS.u];
      out = voice(SR, d, { f0: (t) => (w === 'hello' ? (t < d * 0.35 ? 470 : 560) : 520 - 60 * t / d) * (1 + 0.02 * Math.sin(t * 28)), vowel: (t) => lerpVowel(vs[0], vs[1], Math.min(1, t / d * 1.6)), breath: 0.12, formantShift: HV_SHIFT, rng: r, env: (t) => Math.min(1, t / 0.06) * Math.min(1, (d - t) / 0.4) });
      break;
    }
    case 'cry': {
      const d = r.range(1.6, 2.4);
      out = voice(SR, d, { f0: (t) => 420 * (1 + 0.12 * Math.sin(t * 9) * Math.sin(t * 1.7)), vowel: () => lerpVowel(VOWELS.u, VOWELS.a, 0.3), breath: 0.4, formantShift: HV_SHIFT, rng: r, env: (t) => (0.4 + 0.6 * Math.abs(Math.sin(t * 5.5))) * Math.sin(Math.PI * t / d) });
      break;
    }
    case 'scream': {
      const d = r.range(1.1, 1.6);
      out = voice(SR, d, { f0: (t) => (900 + 350 * Math.sin(Math.PI * t / d)) * (1 + 0.03 * Math.sin(t * 50)), vowel: () => VOWELS.a, breath: 0.5, jitter: 0.05, formantShift: HV_SHIFT * 1.1, rng: r, env: (t) => Math.min(1, t / 0.03) * Math.min(1, (d - t) / 0.25) });
      out = softclip(normalize(out, 1), 3.5); break;
    }
    case 'fragment': default: {
      if (!sig) return hvVocal('giggle', seed);
      const len = Math.min(sig.length - 1, N(r.range(0.35, 0.9))), s0 = r.int(0, Math.max(0, sig.length - len));
      out = sig.slice(s0, s0 + len);
      if (r() < 0.35) out = reverse(out);
      const rate = r.range(0.85, 1.12);
      out = r() < 0.5 ? resample(out, rate) : pitchShift(out, rate, SR);
      if (r() < 0.4) { // stutter
        const rep = out.slice(0, Math.min(out.length, N(0.12))), o2 = new Float32Array(out.length + rep.length * 2);
        mixInto(o2, rep, 0); mixInto(o2, rep, rep.length); mixInto(o2, out, rep.length * 2); out = o2;
      }
      out = fade(out, SR, 0.01, 0.06);
    }
  }
  return fade(normalize(out, 0.9), SR, 0.005, 0.05);
}

// ------------------------------------------------------------------ Sulfur Hexafluoride (skunk-thing)
export function sfVocal(kind, seed) {
  const r = rngFor(seed);
  let out;
  switch (kind) {
    case 'rumble': {
      const d = r.range(1.6, 2.6), n = N(d); out = new Float32Array(n);
      const src = brown(n, r);
      for (let i = 0; i < n; i++) { const t = i / SR; out[i] = (Math.sin(TAU * 42 * t + Math.sin(TAU * 3 * t) * 2) * 0.7 + src[i] * 0.6) * (0.6 + 0.4 * Math.sin(TAU * 7 * t)) * Math.sin(Math.PI * t / d); }
      out = filter(out, 'lp', 140, 0.9, SR); break;
    }
    case 'chitter': {
      out = new Float32Array(N(0.9));
      for (let k = 0; k < r.int(8, 16); k++) { const s0 = N(r.range(0, 0.8)), f = r.range(2200, 4200), l = N(r.range(0.01, 0.03)); for (let i = 0; i < l; i++) { const t = i / SR; out[s0 + i] += Math.sin(TAU * f * t * (1 + t * 20)) * Math.sin(Math.PI * i / l) * r.range(0.3, 1); } }
      break;
    }
    case 'breath': {
      out = new Float32Array(N(1.4));
      for (let k = 0; k < r.int(3, 6); k++) { const s0 = N(r.range(0, 1.2)), nz = filter(noise(N(0.12), r), 'bp', r.range(1200, 2400), 2, SR); for (let i = 0; i < nz.length; i++) out[s0 + i] += nz[i] * Math.sin(Math.PI * i / nz.length); }
      break;
    }
    case 'rustle': out = footstep('brush', seed); out = mixInto(new Float32Array(N(1.2)), out, 0); mixInto(out, footstep('brush', seed + 1), N(0.45), 0.8); break;
    case 'growl': {
      const d = r.range(1.0, 1.6);
      out = voice(SR, d, { f0: (t) => 85 + 25 * Math.sin(t * 6), vowel: () => VOWELS.o, breath: 0.7, jitter: 0.15, formantShift: 0.8, rng: r, env: (t) => Math.min(1, t / 0.08) * Math.min(1, (d - t) / 0.2) });
      out = softclip(normalize(out, 1), 2.5); break;
    }
    case 'warn': { // skunks stamp their front feet and hiss before spraying
      out = new Float32Array(N(1.6));
      for (let k = 0; k < 4; k++) { const s0 = N(k * 0.16); for (let i = 0; i < N(0.08); i++) { const t = i / SR; out[s0 + i] += Math.sin(TAU * 70 * t) * Math.exp(-t * 40) * 1.2; } mixInto(out, footstep('litter', seed + k), s0, 0.3); }
      const h = filter(noise(N(0.9), r), 'hp', 2500, 0.7, SR);
      for (let i = 0; i < h.length; i++) h[i] *= Math.min(1, i / SR / 0.05) * Math.exp(-i / SR * 2.5) * 0.7;
      mixInto(out, h, N(0.7));
      break;
    }
    case 'gas': {
      out = filter(noise(N(2.8), r), 'bp', 1500, 0.5, SR);
      for (let i = 0; i < out.length; i++) { const t = i / SR; out[i] *= Math.min(1, t / 0.04) * Math.exp(-t * 0.9) * (0.8 + 0.2 * Math.sin(t * 40)); }
      out = mixInto(out, filter(brown(out.length, r), 'lp', 120, 0.7, SR), 0, 0.5);
      break;
    }
    case 'bite': { out = twigSnap(seed, true); out = mixInto(new Float32Array(N(0.9)), out, 0); mixInto(out, sfVocal('growl', seed), N(0.05), 0.7); break; }
    default: out = sfVocal('breath', seed);
  }
  return fade(normalize(out, 0.85), SR, 0.005, 0.05);
}

// ------------------------------------------------------------------ stingers & effects
export function stinger(kind, seed) {
  const r = rngFor(seed);
  if (kind === 'reveal') { // reversed swell into silence
    const d = 2.6, n = N(d), out = new Float32Array(n);
    for (const f of [233, 247, 349, 370, 494, 523]) for (let i = 0; i < n; i++) { const t = i / SR; out[i] += Math.sin(TAU * f * t + Math.sin(TAU * 5 * t) * 0.6) * Math.exp(-t * 1.6) * 0.18; }
    mixInto(out, filter(noise(n, r), 'bp', 1200, 0.6, SR).map((v, i) => v * Math.exp(-i / SR * 2) * 0.3), 0);
    return normalize(reverse(out), 0.8);
  }
  if (kind === 'snap') {
    const out = new Float32Array(N(2.4));
    mixInto(out, twigSnap(seed, true), 0, 0.9);
    for (let i = 0; i < out.length; i++) { const t = i / SR; out[i] += Math.sin(TAU * 38 * t) * Math.exp(-t * 2.5) * 0.9; }
    const cl = new Float32Array(out.length);
    for (const f of [1046, 1108, 1567, 1661]) { let ph = 0; for (let i = 0; i < cl.length; i++) { ph += f * (1 + 0.004 * Math.sin(i / SR * 30 + f)) / SR; cl[i] += ((ph % 1) * 2 - 1) * 0.15; } }
    filter(cl, 'lp', 3500, 0.7, SR);
    for (let i = 0; i < cl.length; i++) { const t = i / SR; cl[i] *= Math.min(1, t / 0.01) * Math.exp(-t * 1.8); }
    mixInto(out, cl, 0, 0.6);
    return normalize(out, 0.95);
  }
  // chase: low brass cluster swell + pulses
  const d = 2.4, out = new Float32Array(N(d));
  for (const f of [55, 58.3, 82.4, 87.3, 110]) { let ph = 0; for (let i = 0; i < out.length; i++) { const t = i / SR; ph += f / SR; out[i] += ((ph % 1) * 2 - 1) * Math.min(1, t / 0.3) * Math.exp(-Math.max(0, t - 0.6) * 1.4) * 0.2; } }
  filter(out, 'lp', 900, 1.2, SR);
  for (let k = 0; k < 4; k++) { const s0 = N(k * 0.42); for (let i = 0; i < N(0.2); i++) { const t = i / SR; out[s0 + i] += Math.sin(TAU * 45 * t) * Math.exp(-t * 18) * 0.8; } }
  return normalize(out, 0.9);
}

export function hurt(seed, down) {
  const r = rngFor(seed), d = down ? 1.1 : 0.45;
  const v = voice(SR, d, { f0: (t) => (down ? 160 : 140) * (1 + 0.3 * Math.sin(Math.PI * t / d)), vowel: () => (down ? VOWELS.a : VOWELS.u), breath: 0.35, formantShift: 0.95, rng: r, env: (t) => Math.min(1, t / 0.02) * Math.min(1, (d - t) / 0.2) });
  const out = new Float32Array(N(d + 0.2));
  for (let i = 0; i < N(0.15); i++) { const t = i / SR; out[i] += (r() * 2 - 1) * Math.exp(-t * 35) * 0.9 + Math.sin(TAU * 60 * t) * Math.exp(-t * 20); }
  mixInto(out, v, N(0.03), 0.8);
  return normalize(out, 0.9);
}

// Process a recorded voice phrase into Helium Voice's version of it (used for mimicry).
// pitch up (keeps timing), tape-like wobble, soft distortion, small "throat" resonance.
export function mimicProcess(pcm, sr, pitch, seed) {
  const r = rngFor(seed);
  let out = pitchShift(pcm, pitch * r.range(0.96, 1.05), sr, 45);
  const wob = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr, k = i + Math.sin(TAU * 4.3 * t) * sr * 0.0012 + Math.sin(TAU * 0.7 * t) * sr * 0.002;
    const k0 = Math.floor(k), fr = k - k0; wob[i] = (out[k0] || 0) * (1 - fr) + (out[k0 + 1] || 0) * fr;
  }
  out = filter(filter(wob, 'hp', 220, 0.7, sr), 'peak', 2600, 1.5, sr, 6);
  out = softclip(normalize(out, 0.9), 1.8);
  // occasionally a wrong, slowed final syllable
  if (r() < 0.3 && out.length > sr * 0.5) {
    const tail = out.slice(out.length - Math.floor(sr * 0.35)), slow = resample(tail, 0.72), o2 = new Float32Array(out.length + slow.length);
    o2.set(out); mixInto(o2, slow, out.length - Math.floor(sr * 0.05), 0.8); out = o2;
  }
  return fade(normalize(out, 0.85), sr, 0.01, 0.08);
}
