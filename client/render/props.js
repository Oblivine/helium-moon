// Man-made structures of the refuge: trailhead lot, red/white pipe gate, signs, the
// Stinchcomb granite monument, pump house, wildlife blind, ranger shed, abandoned
// camp, slough footbridge, repeater mast, highway bridge, fence and power line.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial } from './shaderlib.js';
import { makeTextTexture } from './textures.js';
import { makeRng } from '../../shared/math.js';
import { CONFIG } from '../../shared/config.js';

class Builder {
  constructor() { this.parts = new Map(); }
  add(key, geo, m) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(m);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!this.parts.has(key)) this.parts.set(key, []);
    this.parts.get(key).push(g);
  }
}

export const M = (x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));

export function boxUV(w, h, d, uvScale = 1) {
  const g = new THREE.BoxGeometry(w, h, d);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (ny > 0.5) uv.setXY(i, x / uvScale, z / uvScale);
    else if (nx > 0.5) uv.setXY(i, z / uvScale, y / uvScale);
    else uv.setXY(i, x / uvScale, y / uvScale);
  }
  return g;
}

export function makePropMaterials(T) {
  const std = (o, key) => patchMaterial(new THREE.MeshStandardMaterial({ envMapIntensity: 0.3, ...o }), { key });
  return {
    wood: std({ map: T.wood_c, normalMap: T.wood_n, roughness: 0.9, color: 0x9a9286 }, 'wood'),
    woodDark: std({ map: T.wood_c, normalMap: T.wood_n, roughness: 0.92, color: 0x5d5245 }, 'wooddark'),
    concrete: std({ map: T.concrete_c, normalMap: T.concrete_n, roughness: 0.95 }, 'concrete'),
    metal: std({ map: T.metal_c, roughness: 0.5, metalness: 0.75, color: 0xb0b4b8 }, 'metal'),
    corr: std({ map: T.metal_c, normalMap: T.corrugated_n, roughness: 0.55, metalness: 0.7, color: 0xa7abae }, 'corr'),
    red: std({ color: 0x9a1812, roughness: 0.45, metalness: 0.3 }, 'red'),
    white: std({ color: 0xd8d6d0, roughness: 0.5, metalness: 0.2 }, 'white'),
    dark: std({ color: 0x1a1b1d, roughness: 0.7 }, 'dark'),
    rubber: std({ color: 0x111111, roughness: 0.85 }, 'rubber'),
    glass: std({ color: 0x0b0e12, roughness: 0.04, metalness: 0.2, envMapIntensity: 1.2 }, 'glass'),
    granite: std({ map: T.granite_c, roughness: 0.55, color: 0xb9b9bd }, 'granite'),
    gravel: std({ map: T.gravel_c, normalMap: T.gravel_n, roughness: 0.95, color: 0xb0aaa0 }, 'gravel'),
    asphalt: std({ map: T.concrete_c, roughness: 0.9, color: 0x3a3a3c }, 'asphalt'),
    fabric: std({ color: 0x3d5a48, roughness: 0.85, side: THREE.DoubleSide }, 'fabric'),
    orange: std({ color: 0xa2521c, roughness: 0.6 }, 'orange'),
    yellow: std({ color: 0xb08a1c, roughness: 0.55, metalness: 0.2 }, 'yellow'),
    stone: std({ map: T.concrete_c, roughness: 0.95, color: 0x8a8278 }, 'stone'),
    pole: std({ map: T.bark_oak_c, roughness: 0.95, color: 0x6b6054 }, 'pole'),
    roof: std({ map:T.metal_c,normalMap:T.corrugated_n,roughness:.88,metalness:.18,color:0x35423c },'arrivalroof'),
    planting:std({color:0x4e6041,roughness:1,side:THREE.DoubleSide},'arrivalplanting'),
    bronze:std({color:0x5c5748,roughness:.72,metalness:.6},'arrivalbronze'),
  };
}

export class Props {
  constructor(world, bank) {
    this.world = world;
    this.group = new THREE.Group(); this.group.name = 'props';
    this.dynamic = [];
    this.mats = makePropMaterials(bank.tex);
    const B = this.B = new Builder();
    for (const o of world.structures) {
      const fn = this['_' + o.type];
      if (fn) fn.call(this, o, B);
    }
    this._fence(B);
    this._powerLine(B);
    for (const [key, list] of B.parts) {
      const geo = mergeGeometries(list, false);
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.mats[key]);
      mesh.castShadow = key !== 'gravel' && key !== 'asphalt';
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  W(o, x, y, z, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    return M(o.x, o.y, o.z, o.rot).multiply(M(x, y, z, ry, rx, rz, sx, sy, sz));
  }

  _lot(o, B) {
    const w = this.world, seg = 24;
    const g = new THREE.PlaneGeometry(o.hx * 2, o.hz * 2, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position, uv = g.attributes.uv;
    const c = Math.cos(o.rot), s = Math.sin(o.rot);
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), lz = pos.getZ(i);
      // Feather the old gravel boundary with irregular edges instead of a perfect slab.
      const edgeX=Math.abs(lx)>o.hx-.1?Math.sign(lx)*(.45*Math.sin(lz*1.7)+.3*Math.cos(lz*3.1)):0;
      const edgeZ=Math.abs(lz)>o.hz-.1?Math.sign(lz)*(.5*Math.sin(lx*1.3)+.2*Math.cos(lx*3.7)):0;
      const wx = o.x + (lx+edgeX) * c + (lz+edgeZ) * s, wz = o.z - (lx+edgeX) * s + (lz+edgeZ) * c;
      pos.setXYZ(i, wx, w.heightAt(wx, wz) + 0.04, wz);
      uv.setXY(i, lx / 3, lz / 3);
    }
    g.computeVertexNormals();
    B.add('gravel', g, new THREE.Matrix4());
    for (let i = -3; i <= 3; i++) {
      const lx = i * 3.2, lz = -o.hz + 1.2;
      const wx = o.x + lx * c + lz * s, wz = o.z - lx * s + lz * c;
      B.add('concrete', boxUV(1.8, 0.14, 0.25), M(wx, w.heightAt(wx, wz) + 0.1, wz, o.rot));
    }
    // Small stones and leaves ground the edge without changing walkable collision.
    const rng=makeRng(731);
    for(let i=0;i<110;i++){
      const side=i%4, t=rng.range(-1,1), outward=rng.range(-.5,1.2);
      const lx=side<2?(side?1:-1)*(o.hx+outward):t*o.hx;
      const lz=side>=2?(side===2?1:-1)*(o.hz+outward):t*o.hz;
      const x=o.x+lx*c+lz*s,z=o.z-lx*s+lz*c;
      if(i%3===0)B.add('stone',new THREE.DodecahedronGeometry(rng.range(.025,.065),0),M(x,w.heightAt(x,z)+.02,z,rng()*6.28,0,0,1,.5,1));
      else B.add('woodDark',boxUV(rng.range(.05,.12),.004,rng.range(.025,.055)),M(x,w.heightAt(x,z)+.055,z,rng()*6.28,.12));
    }
  }

  _kiosk(o, B) {
    // Open timber visitor shelter. Its columns frame the arrival space rather
    // than occupying the player's first walking line or cutting across the view.
    const ground=(x,z)=>{const p=new THREE.Vector3(x,0,z).applyMatrix4(M(o.x,0,o.z,o.rot));return this.world.heightAt(p.x,p.z)-o.y;};
    for(const x of [-5.25,5.25])for(const z of [-.8,4.3]){
      const gy=ground(x,z),h=3.18-gy;
      B.add('stone',boxUV(.46,.16,.46),this.W(o,x,gy+.08,z));
      B.add('woodDark',boxUV(.24,h,.24),this.W(o,x,gy+h/2,z));
      for(const y of [gy+.22,2.91])B.add('bronze',boxUV(.28,.12,.28),this.W(o,x,y,z));
      this._arrivalBeam(o,B,[x,2.3,z],[x-Math.sign(x)*.7,3.1,z],.11,'wood');
      this._arrivalBeam(o,B,[x,2.4,z],[x,3.1,z+(z<0?.6:-.6)],.11,'wood');
    }
    for(const z of [-.8,4.3])B.add('woodDark',boxUV(10.95,.25,.24),this.W(o,0,3.18,z));
    for(const x of [-5.25,5.25])B.add('woodDark',boxUV(.22,.24,5.55),this.W(o,x,3.18,1.75));
    for(let z=-1.2;z<=4.8;z+=.74){
      this._arrivalBeam(o,B,[-5.75,3.27,z],[0,4.05,z],.12,'wood');
      this._arrivalBeam(o,B,[0,4.05,z],[5.75,3.27,z],.12,'wood');
    }
    for(const x of [-1,1]){
      B.add('roof',boxUV(5.9,.065,6.4),this.W(o,x*2.875,3.69,1.75,0,0,-x*.135));
      B.add('woodDark',boxUV(.14,.16,6.5),this.W(o,x*5.8,3.31,1.75));
    }
    B.add('bronze',boxUV(.22,.06,6.48),this.W(o,0,4.1,1.75));
    // Board retains the existing maintenance memo anchor and collision plane.
    B.add('woodDark',boxUV(2.9,1.73,.16),this.W(o,0,1.55,-.05));
    B.add('wood', boxUV(2.4, 1.3, 0.06), this.W(o, 0, 1.55, 0.03));
    for(const x of [-1.15,1.15])B.add('woodDark',boxUV(.075,1.38,.10),this.W(o,x,1.55,.09));
    for(const y of [.86,2.24])B.add('woodDark',boxUV(2.4,.075,.10),this.W(o,0,y,.09));
    B.add('wood',boxUV(2.7,.11,.28),this.W(o,0,.78,.14));
    for(const x of [-1.28,1.28])for(const y of [.87,2.23])B.add('bronze',new THREE.SphereGeometry(.022,6,4),this.W(o,x,y,.14));
    this._arrivalLabel(o,'STINCHCOMB WILDLIFE REFUGE',4.3,.46,0,2.92,.1,'#2c3b30','#e3d6b4',B);
    for(const x of [-1.9,1.9])B.add('bronze',boxUV(.022,.62,.022),this.W(o,x,3.45,.08));   // hung from the rafters
    this._arrivalLabel(o,'EAST TRAIL  ·  MAP & NOTICES',2.3,.2,0,2.47,.1,'#43382b','#e3d6b4',B);
    for(const x of [-3.1,-2.2])B.add('woodDark',boxUV(.09,1.75,.09),this.W(o,x,.87,.03));   // its own two posts, not wires from the roof
    this._arrivalLabel(o,'LEAVE NO TRACE',1.1,.3,-2.65,1.55,.09,'#33402f','#e1d6b6',B);
    for(const z of [.95,3.4])this._arrivalLantern(o,B,z<2?'trailhead-lantern':'trailhead-shelter-light',0,z<2?3.3:2.95,z<2?1.5:z,z<2?26:24,9);
    const mat = patchMaterial(new THREE.MeshStandardMaterial({ map: this._mapBoardTexture(), color: 0xa39d8c, roughness: .98, envMapIntensity: .15 }), { key: 'kioskmap' });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.15), mat);
    m.applyMatrix4(this.W(o, 0, 1.55, 0.065));
    m.receiveShadow = true;
    this.group.add(m);
  }

  _arrivalBeam(o,B,from,to,width,key='woodDark'){
    const a=new THREE.Vector3(...from),b=new THREE.Vector3(...to),d=b.clone().sub(a);
    const matrix=new THREE.Matrix4().compose(a.add(b).multiplyScalar(.5),new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),d.clone().normalize()),new THREE.Vector3(1,1,1));
    B.add(key,boxUV(width,d.length(),width),M(o.x,o.y,o.z,o.rot).multiply(matrix));
  }

  // A routed-timber park sign: a real board with a frame, letters drawn at the board's own
  // proportions (the old labels stretched one 8:1 texture over every size) and toned down so the
  // lantern in front of them no longer burns them white.
  _arrivalLabel(o,text,width,height,x,y,z,bg,fg,B=null){
    const H=256,Wpx=Math.min(2048,Math.round(H*width/height));
    const cv=document.createElement('canvas');cv.width=Wpx;cv.height=H;const g=cv.getContext('2d');
    g.fillStyle=bg;g.fillRect(0,0,Wpx,H);
    // timber grain and weathering
    for(let i=0;i<90;i++){g.fillStyle=`rgba(${i%2?255:0},${i%2?250:0},${i%2?230:0},${.018+.03*((i*37)%7)/7})`;g.fillRect(0,(i*53)%H,Wpx,1+(i%3));}
    const v=g.createLinearGradient(0,0,0,H);v.addColorStop(0,'rgba(0,0,0,.28)');v.addColorStop(.25,'rgba(0,0,0,0)');v.addColorStop(.8,'rgba(0,0,0,0)');v.addColorStop(1,'rgba(0,0,0,.34)');
    g.fillStyle=v;g.fillRect(0,0,Wpx,H);
    g.strokeStyle=fg;g.globalAlpha=.55;g.lineWidth=5;g.strokeRect(16,16,Wpx-32,H-32);g.globalAlpha=1;
    let size=128;g.textAlign='center';g.textBaseline='middle';
    const spaced=text.split('').join(' ');
    do{g.font=`600 ${size}px "Cormorant Garamond", Georgia, serif`;size-=4;}while(g.measureText(spaced).width>Wpx-90&&size>30);
    g.fillStyle='rgba(0,0,0,.55)';g.fillText(spaced,Wpx/2+3,H/2+7);       // routed shadow
    g.fillStyle=fg;g.fillText(spaced,Wpx/2,H/2+3);
    const tex=new THREE.CanvasTexture(cv);tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=8;
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,height),patchMaterial(new THREE.MeshStandardMaterial({map:tex,color:0x8f8a7c,roughness:.95,envMapIntensity:.08}),{key:'arrivallabel'}));
    mesh.applyMatrix4(this.W(o,x,y,z+.012));mesh.receiveShadow=true;this.group.add(mesh);
    if(B){   // the board it is carved into, proud of whatever is behind it
      B.add('woodDark',boxUV(width+.1,height+.1,.06),this.W(o,x,y,z-.025));
    }
  }

  _arrivalLantern(o,B,name,x,y,z,intensity,range){
    B.add('dark',boxUV(.25,.1,.25),this.W(o,x,y+.16,z));
    B.add('bronze',boxUV(.21,.22,.21),this.W(o,x,y-.02,z));
    const bulb=new THREE.Mesh(new THREE.CylinderGeometry(.075,.09,.12,10),new THREE.MeshBasicMaterial({color:0xc8aa80}));
    bulb.applyMatrix4(this.W(o,x,y-.06,z));this.group.add(bulb);
    const light=new THREE.PointLight(0xffcf96,intensity,range,2);light.name=name;
    light.position.set(x,y-.18,z).applyMatrix4(M(o.x,o.y,o.z,o.rot));this.group.add(light);
  }

  _arrival_court(o,B){
    const w=this.world,localToWorld=(x,z)=>new THREE.Vector3(x,0,z).applyMatrix4(M(o.x,0,o.z,o.rot));
    // Individually grounded stone/gravel apron, with an irregular planted edge.
    const g=new THREE.CircleGeometry(1,64);g.rotateX(-Math.PI/2);
    const p=g.attributes.position,uv=g.attributes.uv;
    for(let i=0;i<p.count;i++){
      const x=p.getX(i)*6.4,z=p.getZ(i)*5.8+1.7,v=localToWorld(x,z);
      p.setXYZ(i,v.x,w.heightAt(v.x,v.z)+.057,v.z);uv.setXY(i,x/2.5,z/2.5);
    }
    g.computeVertexNormals();B.add('gravel',g,new THREE.Matrix4());
    const rng=makeRng(817231);
    for(let i=0;i<58;i++){
      const a=i/58*Math.PI*2,x=Math.cos(a)*6.4,z=Math.sin(a)*5.8+1.7;
      // Leave the forest route and parking approach completely open.
      if((z<-.2&&x>-.2&&x<4.3)||(z>5.3&&Math.abs(x)<2))continue;
      const v=localToWorld(x,z);
      B.add('stone',new THREE.DodecahedronGeometry(rng.range(.15,.23),1),M(v.x,w.heightAt(v.x,v.z)+.055,v.z,rng()*6.28,0,0,1,.42,.8));
    }
    const path=w.arrival.path;
    for(let i=1;i<path.length;i++){
      const [ax,az]=path[i-1],[bx,bz]=path[i],length=Math.hypot(bx-ax,bz-az),nx=(bz-az)/length,nz=-(bx-ax)/length;
      const steps=Math.ceil(length/.9),positions=[],uvs=[],indices=[];
      for(let j=0;j<=steps;j++)for(const side of [-1,1]){
        const t=j/steps,wx=ax+(bx-ax)*t+nx*side*1.65,wz=az+(bz-az)*t+nz*side*1.65;
        positions.push(wx,w.heightAt(wx,wz)+.061,wz);uvs.push(side*.55,j*.3);
      }
      for(let j=0;j<steps;j++){const a=j*2;indices.push(a,a+2,a+1,a+1,a+2,a+3);}
      const ribbon=new THREE.BufferGeometry();ribbon.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));ribbon.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));ribbon.setIndex(indices);ribbon.computeVertexNormals();B.add('gravel',ribbon,new THREE.Matrix4());
      for(let d=.4;d<length;d+=1.2)for(const side of [-1,1]){
        const x=ax+(bx-ax)*d/length+nx*side*1.9,z=az+(bz-az)*d/length+nz*side*1.9;
        B.add('woodDark',boxUV(.12,.08,1.08),M(x,w.heightAt(x,z)+.055,z,Math.atan2(bx-ax,bz-az)));
      }
    }
  }

  _arrival_entry(o,B){
    for(const x of [-2.55,2.55]){
      const p=new THREE.Vector3(x,0,0).applyMatrix4(M(o.x,0,o.z,o.rot)),gy=this.world.heightAt(p.x,p.z)-o.y;
      B.add('stone',boxUV(.5,.2,.5),this.W(o,x,gy+.1,0));
      B.add('woodDark',boxUV(.28,3.45-gy,.28),this.W(o,x,(3.45+gy)/2,0));
      this._arrivalBeam(o,B,[x,2.45,0],[x-Math.sign(x)*.65,3.1,0],.13,'wood');
    }
    B.add('wood',boxUV(5.65,.68,.21),this.W(o,0,3.0,0));
    B.add('roof',boxUV(5.9,.1,.65),this.W(o,0,3.42,0,0,.08));
    this._arrivalLabel(o,'EAST TRAIL',3.6,.5,0,3.0,.12,'#2c3b30','#e3d6b4');
    this._arrivalLabel(o,'OLD RIVER ROAD  ·  FOOT ACCESS ONLY',3.4,.2,0,2.52,.12,'#43382b','#dfd4b7',B);
    this._arrivalLantern(o,B,'trailhead-entry-lantern',-2.2,2.55,.27,20,8);
  }

  _arrival_rail(o,B){
    for(const x of [-1.3,1.3]){
      const p=new THREE.Vector3(x,0,0).applyMatrix4(M(o.x,0,o.z,o.rot)),gy=this.world.heightAt(p.x,p.z)-o.y;
      B.add('woodDark',boxUV(.16,1.04,.16),this.W(o,x,gy+.52,0));
    }
    for(const y of [.4,.85])B.add('wood',boxUV(2.7,.12,.09),this.W(o,0,y,0));
  }

  _arrival_planting(o,B){
    const rng=makeRng(Math.round(o.x*91+o.z*13));
    for(let i=0;i<60;i++){
      const a=rng()*Math.PI*2,r=Math.sqrt(rng())*.95,x=Math.cos(a)*r,z=Math.sin(a)*r;
      const p=new THREE.Vector3(x,0,z).applyMatrix4(M(o.x,0,o.z,o.rot)),gy=this.world.heightAt(p.x,p.z)-o.y;
      const h=rng.range(.28,.8),bend=rng.range(.08,.24),angle=rng()*6.28,width=rng.range(.018,.045);
      const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute([-width,0,0,width,0,0,width*.5,h*.6,bend*.4,0,h,bend,-width*.5,h*.6,bend*.4],3));geo.setIndex([0,1,2,0,2,4,4,2,3]);geo.computeVertexNormals();
      B.add(i%5?'planting':'wood',geo,this.W(o,x,gy+.01,z,angle));
    }
    for(let i=0;i<13;i++){
      const a=i/13*Math.PI*2,x=Math.cos(a)*1.12,z=Math.sin(a)*1.12,p=new THREE.Vector3(x,0,z).applyMatrix4(M(o.x,0,o.z,o.rot));
      B.add('stone',new THREE.DodecahedronGeometry(.18,1),M(p.x,this.world.heightAt(p.x,p.z)+.03,p.z,a,0,0,1,.4,.8));
    }
  }

  _arrival_bench(o,B){this._bench(o,B);for(const y of [.65,.8])B.add('wood',boxUV(1.8,.12,.055),this.W(o,0,y,-.25));}

  _mapBoardTexture() {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 540;
    const g = cv.getContext('2d');
    g.fillStyle = '#d9d2bd'; g.fillRect(0, 0, 1024, 540);
    g.fillStyle = '#4a3b2a'; g.fillRect(0, 0, 1024, 70);
    g.fillStyle = '#efe6c8'; g.font = 'bold 40px Georgia, serif'; g.textAlign = 'center';
    g.fillText('STINCHCOMB WILDLIFE REFUGE', 512, 50);
    g.fillStyle = '#829172'; g.fillRect(40, 90, 620, 420);
    const rng=makeRng(420);
    for(let i=0;i<900;i++){
      g.fillStyle=i%2?'rgba(43,66,39,.13)':'rgba(218,209,162,.12)';
      g.beginPath();g.ellipse(rng.range(45,650),rng.range(95,505),rng.range(2,8),rng.range(1,5),rng()*3,0,Math.PI*2);g.fill();
    }
    const w = this.world;
    const xs = w.trail.map((p) => p[0]), zs = w.trail.map((p) => p[1]);
    const minX = Math.min(...xs) - 60, maxX = Math.max(...xs) + 60, minZ = Math.min(...zs) - 60, maxZ = Math.max(...zs) + 60;
    const sc = Math.min(560 / (maxX - minX), 360 / (maxZ - minZ));
    const P = (p) => [70 + (p[0] - minX) * sc, 115 + (p[1] - minZ) * sc];
    g.save();g.beginPath();g.rect(40,90,620,420);g.clip();
    g.strokeStyle = '#5b7da3'; g.lineWidth = 7; g.beginPath();
    w.river.forEach((p, i) => { const [x, y] = P(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
    g.strokeStyle='#a76e33';g.lineWidth=3;g.setLineDash([5,4]);g.beginPath();
    w.servicePath.forEach((p,i)=>{const[x,y]=P(p);if(i)g.lineTo(x,y);else g.moveTo(x,y);});g.stroke();g.setLineDash([]);
    g.strokeStyle = '#8a2d1d'; g.lineWidth = 4; g.setLineDash([10, 6]); g.beginPath();
    w.trail.forEach((p, i) => { const [x, y] = P(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); g.setLineDash([]);
    const [sx, sy] = P(w.trail[0]);
    g.fillStyle = '#c0261d'; g.beginPath(); g.arc(sx, sy, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#222'; g.font = 'bold 16px Arial'; g.textAlign = 'left'; g.fillText('TRAILHEAD', Math.max(46,Math.min(540,sx+12)), Math.min(495,sy+6));
    for(const key of ['pumphouse','shed','bridge','mast','camp','rivercrossing']){
      const p=w.poi[key];if(!p)continue;
      const [x,y]=P([p.x,p.z]);g.fillStyle='#f2e7c8';g.fillRect(x-4,y-4,8,8);
      g.fillStyle='#273326';g.font='bold 13px Arial';g.fillText(({pumphouse:'PUMP',shed:'SHED',bridge:'BRIDGE',mast:'MAST',camp:'CAMP',rivercrossing:'RIVER CROSSING'})[key],x+7,y+4);
    }
    g.restore();
    g.fillStyle='#273326';g.font='bold 18px Arial';g.fillText('N',620,116);g.beginPath();g.moveTo(626,123);g.lineTo(621,138);g.lineTo(631,138);g.fill();
    g.font = '20px Arial'; g.fillStyle = '#2a2a2a';
    ['EAST TRAIL (old River Road)', 'Open 5:00 AM - 11:00 PM', '', 'NO motorized vehicles', 'Stay on marked trails', 'Waterfowl hunting area -', '  seasonal closures apply', '', 'Report emergencies:', 'Ranger radio at the', 'maintenance shed']
      .forEach((l, i) => g.fillText(l, 690, 120 + i * 32));
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }

  _car(o, B) {
    const key = 'car' + o.color.toString(16);
    if (!this.mats[key]) this.mats[key] = patchMaterial(new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.32, metalness: 0.55, envMapIntensity: 0.8 }), { key: 'carpaint' });
    const s = new THREE.Shape();
    s.moveTo(-2.3, 0.32); s.lineTo(-2.35, 0.72); s.quadraticCurveTo(-2.3, 0.88, -2.05, 0.9); s.lineTo(-1.1, 0.95);
    s.quadraticCurveTo(-0.75, 1.42, -0.4, 1.44); s.lineTo(0.85, 1.44); s.quadraticCurveTo(1.2, 1.42, 1.55, 0.98);
    s.lineTo(2.2, 0.9); s.quadraticCurveTo(2.36, 0.85, 2.36, 0.62); s.lineTo(2.3, 0.32); s.closePath();
    const body = new THREE.ExtrudeGeometry(s, { depth: 1.72, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 3, curveSegments: 8 });
    body.translate(0, 0, -0.86);
    B.add(key, body, this.W(o, 0, 0, 0, Math.PI / 2));
    const w = new THREE.Shape();
    w.moveTo(-1.02, 0.98); w.quadraticCurveTo(-0.72, 1.38, -0.4, 1.39); w.lineTo(0.84, 1.39); w.quadraticCurveTo(1.15, 1.37, 1.46, 0.99); w.closePath();
    const wg = new THREE.ExtrudeGeometry(w, { depth: 1.8, bevelEnabled: false });
    wg.translate(0, 0, -0.9);
    B.add('glass', wg, this.W(o, 0, 0.01, 0, Math.PI / 2));
    const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 16); wheel.rotateZ(Math.PI / 2);
    for (const [x, z] of [[0.82, 1.45], [-0.82, 1.45], [0.82, -1.4], [-0.82, -1.4]]) B.add('rubber', wheel, this.W(o, x, 0.34, z));
    for (const x of [-0.6, 0.6]) B.add('white', boxUV(0.32, 0.12, 0.04), this.W(o, x, 0.72, 2.37));
    for (const x of [-0.65, 0.65]) B.add('red', boxUV(0.3, 0.1, 0.04), this.W(o, x, 0.78, -2.36));
  }

  // A timber ranch gate in the shelter's own wood (owner, Nov 10: the red-and-white pipe gate was out
  // of place and clipped). Posts stand on the ground where they are; the rails run post to post, so
  // nothing floats or sinks on the slope.
  _gate(o, B) {
    const ground=(x,z)=>{const p=new THREE.Vector3(x,0,z).applyMatrix4(M(o.x,0,o.z,o.rot));return this.world.heightAt(p.x,p.z)-o.y;};
    const gl=ground(-2.3,0),gr=ground(2.3,0),at=(x)=>gl+(gr-gl)*(x+2.3)/4.6;
    for(const [x,g] of [[-2.3,gl],[2.3,gr]]){
      B.add('stone',boxUV(.42,.14,.42),this.W(o,x,g+.05,0));
      B.add('woodDark',boxUV(.24,1.62,.24),this.W(o,x,g+.74,0));
      B.add('bronze',boxUV(.3,.05,.3),this.W(o,x,g+1.57,0));
    }
    for(const h of [.42,.8,1.18])this._arrivalBeam(o,B,[-2.2,gl+h,0],[2.2,gr+h,0],h>1?.11:.085,'wood');
    this._arrivalBeam(o,B,[-2.15,gl+.4,.02],[2.15,gr+1.16,.02],.07,'woodDark');          // brace
    for(const x of [-1.1,0,1.1])B.add('woodDark',boxUV(.07,.9,.05),this.W(o,x,at(x)+.8,.05));   // battens
    for(const h of [.5,1.1])B.add('bronze',boxUV(.2,.07,.035),this.W(o,-2.14,gl+h,.075));     // strap hinges
    B.add('bronze',boxUV(.16,.1,.05),this.W(o,2.14,gr+.82,.08));                              // latch
  }

  _sign(o, B) {
    const tex = makeTextTexture([
      { text: 'STINCHCOMB', font: 'bold 92px Georgia, serif' },
      { text: 'WILDLIFE REFUGE', font: 'bold 64px Georgia, serif' },
      { text: 'OKLAHOMA CITY · YUKON · BETHANY', font: '28px Georgia, serif', color: '#e8dca6' },
    ], { w: 1024, h: 360, bg: '#4b3420', fg: '#efd890', pad: 40, border: '#d9c27a' });
    for (const x of [-1.5, 1.5]) B.add('woodDark', boxUV(0.2, 2.6, 0.2), this.W(o, x, 1.3, 0));
    const mat = patchMaterial(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }), { key: 'signface' });
    const back = new THREE.Mesh(boxUV(3.4, 1.2, 0.1), this.mats.woodDark); back.applyMatrix4(this.W(o, 0, 1.75, 0)); back.castShadow = true; this.group.add(back);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 1.12), mat); face.applyMatrix4(this.W(o, 0, 1.75, 0.056)); this.group.add(face);
  }

  _warning(o, B) {
    B.add('metal', new THREE.CylinderGeometry(0.04, 0.04, 3.0, 8), this.W(o, 0, 1.5, 0));
    const t1 = makeTextTexture([
      { text: 'WARNING!', font: 'bold 120px Arial, sans-serif', color: '#c4121a' },
      { text: 'MIGRATORY WATERFOWL HUNTING AREA', font: 'bold 34px Arial', color: '#111' },
      { text: 'Hunting permitted in season.', font: '30px Arial', color: '#222' },
      { text: 'Stay on trails. Wear blaze orange.', font: '30px Arial', color: '#222' },
      { text: 'STINCHCOMB WILDLIFE REFUGE', font: 'bold 32px Arial', color: '#c4121a' },
    ], { w: 900, h: 640, bg: '#f2f0ea', pad: 50, lineH: 1.45 });
    const t2 = makeTextTexture([{ text: 'NO MOTOR', font: 'bold 44px Arial' }, { text: 'VEHICLES', font: 'bold 44px Arial' }], { w: 256, h: 160, bg: '#f2f0ea', pad: 26 });
    const mk = (tex, w, h, y) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), patchMaterial(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide }), { key: 'signpanel' }));
      m.applyMatrix4(this.W(o, 0, y, 0.05)); m.castShadow = true; this.group.add(m);
    };
    mk(t1, 0.9, 0.64, 1.75); mk(t2, 0.4, 0.25, 2.4);
  }

  _monument(o, B) {
    // granite marker: "Stinchcomb Wildlife Refuge Monument - dedicated to Lee and Sarah Stinchcomb, '49ers, by their children"
    const w = this.world;
    B.add('gravel', new THREE.CylinderGeometry(1.7, 1.9, 0.08, 20), M(o.x, w.heightAt(o.x, o.z) + 0.02, o.z));
    const stone = new THREE.BoxGeometry(1.0, 0.62, 0.36, 4, 3, 2);
    const rng = makeRng(42);
    const p = stone.attributes.position;
    for (let i = 0; i < p.count; i++) { if (p.getY(i) > 0.2) p.setY(i, p.getY(i) + (rng() - 0.5) * 0.08); p.setX(i, p.getX(i) * (1 + (rng() - 0.5) * 0.04)); }
    stone.computeVertexNormals();
    B.add('granite', stone, this.W(o, 0, 0.3, 0, 0, -0.18));
    const tex = makeTextTexture([
      { text: 'STINCHCOMB', font: 'bold 54px Georgia, serif' },
      { text: 'WILDLIFE REFUGE MONUMENT', font: '34px Georgia, serif' },
      { text: 'DEDICATED TO', font: '30px Georgia, serif' },
      { text: 'LEE AND SARAH', font: '34px Georgia, serif' },
      { text: "STINCHCOMB, '49ER'S", font: '34px Georgia, serif' },
      { text: 'BY THEIR CHILDREN', font: '30px Georgia, serif' },
    ], { w: 640, h: 400, bg: null, fg: 'rgba(40,40,44,0.92)', pad: 26, lineH: 1.3, emboss: true });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.5), patchMaterial(new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), { key: 'engrave' }));
    m.applyMatrix4(this.W(o, 0, 0.3, 0.19, 0, -0.18));
    this.group.add(m);
  }

  _streetlight(o, B) {
    B.add('pole', new THREE.CylinderGeometry(0.13, 0.17, 8.5, 10), this.W(o, 0, 4.25, 0));
    B.add('metal', new THREE.CylinderGeometry(0.04, 0.04, 2.2, 6), this.W(o, 0, 7.9, 1.0, 0, Math.PI / 2 - 0.15));
    B.add('metal', boxUV(0.35, 0.16, 0.7), this.W(o, 0, 7.95, 2.1));
    const L = new THREE.PointLight(0xffb070, 0, 26, 2);
    L.position.copy(new THREE.Vector3(0, 7.75, 2.1).applyMatrix4(M(o.x, o.y, o.z, o.rot)));
    this.group.add(L);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    bulb.position.copy(L.position); this.group.add(bulb);
    this.dynamic.push({ kind: 'sodium', light: L, bulb, t: 0 });
  }

  _bench(o, B) {
    for (const x of [-0.75, 0.75]) B.add('concrete', boxUV(0.12, 0.45, 0.45), this.W(o, x, 0.22, 0));
    for (const z of [-0.14, 0, 0.14]) B.add('wood', boxUV(1.8, 0.05, 0.12), this.W(o, 0, 0.47, z));
    B.add('wood', boxUV(1.8, 0.12, 0.05), this.W(o, 0, 0.78, -0.24, 0, -0.2));
  }

  _trailhead_bench(o,B){ this._bench(o,B); }

  _trailpost(o,B){
    B.add('woodDark',boxUV(.16,1.75,.16),this.W(o,0,.875,0));
    B.add('wood',boxUV(.9,.32,.07),this.W(o,0,1.43,.02));
    const tex=makeTextTexture([{text:'EAST TRAIL  ↑',font:'bold 46px Arial'},{text:'OLD RIVER ROAD',font:'24px Arial'}],{w:512,h:180,bg:'#3e4b35',fg:'#e8dfbc',pad:20});
    const face=new THREE.Mesh(new THREE.PlaneGeometry(.86,.30),new THREE.MeshStandardMaterial({map:tex,roughness:1,side:THREE.DoubleSide}));
    face.applyMatrix4(this.W(o,0,1.43,.06));this.group.add(face);
    B.add('white',boxUV(.06,.06,.025),this.W(o,0,1.7,.09));
  }

  _pumphouse(o, B) {
    B.add('concrete', boxUV(3.5, 2.8, 3.5, 2), this.W(o, 0, 1.4, 0));
    B.add('concrete', boxUV(3.8, 0.18, 3.8, 2), this.W(o, 0, 2.88, 0));
    B.add('corr', boxUV(1.0, 2.0, 0.06), this.W(o, 0.6, 1.05, 1.76));
    B.add('dark', boxUV(0.6, 0.35, 0.06), this.W(o, -0.9, 2.1, 1.76));
    B.add('metal', new THREE.CylinderGeometry(0.1, 0.1, 1.4, 10), this.W(o, -1.95, 0.7, -0.8));
    const pipe = new THREE.CylinderGeometry(0.1, 0.1, 1.2, 10); pipe.rotateZ(Math.PI / 2);
    B.add('metal', pipe, this.W(o, -2.4, 1.3, -0.8));
    B.add('metal', new THREE.CylinderGeometry(0.06, 0.06, 1.0, 8), this.W(o, 1.2, 3.4, -1.1));
  }

  _blind(o, B) {
    for (const [x, z] of [[-1.7, -1.2], [1.7, -1.2], [-1.7, 1.2], [1.7, 1.2]]) B.add('woodDark', boxUV(0.14, 0.9, 0.14), this.W(o, x, 0.2, z));
    B.add('wood', boxUV(3.6, 0.1, 2.6), this.W(o, 0, 0.62, 0));
    B.add('wood', boxUV(3.6, 1.95, 0.08), this.W(o, 0, 1.6, -1.27));
    B.add('wood', boxUV(0.08, 1.95, 2.6), this.W(o, -1.77, 1.6, 0));
    B.add('wood', boxUV(0.08, 1.95, 2.6), this.W(o, 1.77, 1.6, 0));
    B.add('wood', boxUV(3.6, 0.95, 0.08), this.W(o, 0, 1.12, 1.27));
    B.add('wood', boxUV(3.6, 0.45, 0.08), this.W(o, 0, 2.33, 1.27));
    B.add('woodDark', boxUV(4.0, 0.08, 3.2), this.W(o, 0, 2.7, 0, 0, 0.12));
    B.add('wood', boxUV(0.8, 0.08, 2.0), this.W(o, -0.8, 0.95, -1.9, 0, -0.6));
  }

  _shed(o, B) {
    B.add('concrete', boxUV(6.4, 0.2, 4.4, 2), this.W(o, 0, 0.1, 0));
    B.add('corr', boxUV(6.2, 2.6, 0.06), this.W(o, 0, 1.5, -2.1));
    B.add('corr', boxUV(0.06, 2.6, 4.2), this.W(o, -3.1, 1.5, 0));
    B.add('corr', boxUV(0.06, 2.6, 4.2), this.W(o, 3.1, 1.5, 0));
    B.add('corr', boxUV(3.2, 2.6, 0.06), this.W(o, -1.5, 1.5, 2.1));
    B.add('corr', boxUV(1.6, 0.6, 0.06), this.W(o, 2.3, 2.5, 2.1));
    B.add('corr', boxUV(1.6, 1.0, 0.05), this.W(o, 2.3, 1.85, 2.15));
    const roof = boxUV(3.5, 0.06, 4.8);
    B.add('corr', roof, this.W(o, -1.6, 3.15, 0, 0, 0, 0.32));
    B.add('corr', roof, this.W(o, 1.6, 3.15, 0, 0, 0, -0.32));
    B.add('woodDark', boxUV(2.0, 0.08, 0.8), this.W(o, -1.8, 0.95, -1.6));
    for (const x of [-2.7, -0.9]) for (const z of [-1.9, -1.3]) B.add('woodDark', boxUV(0.08, 0.85, 0.08), this.W(o, x, 0.5, z));
    B.add('orange', boxUV(0.8, 0.6, 0.6), this.W(o, 1.8, 0.5, -1.3));
    B.add('metal', new THREE.CylinderGeometry(0.3, 0.3, 0.9, 14), this.W(o, -2.6, 0.65, 1.4));
  }

  _camp(o, B) {
    const tent = new THREE.SphereGeometry(1.35, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const rng = makeRng(9);
    const p = tent.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setY(i, p.getY(i) * (0.45 + 0.3 * Math.sin(p.getX(i) * 2.0) * 0.5) + (rng() - 0.5) * 0.06);
      p.setX(i, p.getX(i) * 1.15);
    }
    tent.computeVertexNormals();
    B.add('fabric', tent, this.W(o, -2.0, 0.0, -1.2, 0.4));
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      B.add('stone', new THREE.DodecahedronGeometry(0.16 + rng() * 0.06, 0), this.W(o, 1.2 + Math.cos(a) * 0.55, 0.08, 0.6 + Math.sin(a) * 0.55, rng() * 3));
    }
    B.add('dark', boxUV(0.7, 0.04, 0.7), this.W(o, 1.2, 0.03, 0.6));
    B.add('white', boxUV(0.7, 0.4, 0.42), this.W(o, -0.1, 0.2, 1.6, 0.4));
    B.add('fabric', boxUV(0.5, 0.05, 0.5), this.W(o, 2.6, 0.08, -0.4, 0.9, 1.4));
    for (const [x, z] of [[2.4, -0.6], [2.8, -0.2]]) B.add('metal', new THREE.CylinderGeometry(0.015, 0.015, 0.9, 5), this.W(o, x, 0.2, z, 0, 1.3));
  }

  _footbridge(o, B) {
    const L = o.length, w = this.world, width = o.width || 2.6, rail = width/2-.05;
    const deckLocalY = o.deckY - o.y;
    for (let i = 0; i < Math.round(L / 0.32); i++) {
      const z = -L / 2 + 0.16 + i * 0.32;
      B.add('wood', boxUV(width, 0.06, 0.28), this.W(o, 0, deckLocalY - 0.03, z, 0, 0, (i % 3 - 1) * 0.01));
    }
    for (const x of [-rail+.2, rail-.2]) B.add('woodDark', boxUV(0.14, 0.22, L), this.W(o, x, deckLocalY - 0.14, 0));
    const supports = o.type==='riverbridge'?Math.ceil(L/4):4;
    for (let i = 0; i <= supports; i++) {
      const z = -L / 2 + (L / supports) * i;
      for (const x of [-rail, rail]) {
        const gy = w.heightAt(o.x + Math.sin(o.rot) * z + Math.cos(o.rot) * x, o.z + Math.cos(o.rot) * z - Math.sin(o.rot) * x) - o.y;
        const h = deckLocalY + 1.0 - gy + 0.3;
        B.add('woodDark', boxUV(0.12, h, 0.12), this.W(o, x, gy - 0.3 + h / 2, z));
      }
      B.add('woodDark', boxUV(width+.05, 0.16, 0.16), this.W(o, 0, deckLocalY - 0.22, z));
    }
    for (const x of [-rail, rail]) B.add('wood', boxUV(0.08, 0.1, L), this.W(o, x, deckLocalY + 0.95, 0));
    // Timber approaches meet the actual banks; their geometry and deckAt()
    // share the same endpoints so players do not climb invisible steps.
    for (const side of [-1, 1]) {
      const bankY = o.bankY[side < 0 ? 0 : 1] - o.y;
      const slope = side * Math.atan2(deckLocalY - bankY, o.rampLength);
      const count = Math.ceil(o.rampLength / 0.32), step = o.rampLength / count;
      for (let i = 0; i < count; i++) {
        const along = (i + 0.5) * step;
        const y = deckLocalY + (bankY - deckLocalY) * along / o.rampLength;
        B.add('wood', boxUV(width, 0.06, step - 0.025), this.W(o, 0, y - 0.03, side * (L / 2 + along), 0, slope));
      }
      // Grounded end sill carries the span and buries into the bank.
      const z = side * L / 2;
      const gy = w.heightAt(o.x + Math.sin(o.rot) * z, o.z + Math.cos(o.rot) * z) - o.y;
      const h = Math.max(0.22, deckLocalY - gy + 0.18);
      B.add('woodDark', boxUV(width+.1, h, 0.3), this.W(o, 0, deckLocalY - h / 2 - 0.06, z));
    }
  }

  _riverbridge(o,B) {
    this._footbridge(o,B);
    const y=o.deckY-o.y,rail=o.width/2-.05;
    for(const side of [-1,1]) {
      const z=side*(o.length/2-.4);
      for(const x of [-rail,rail]) {
        // Braced portals and buried bank sills support the longer river span.
        B.add('woodDark',boxUV(.2,2.3,.2),this.W(o,x,y+1,z));
        B.add('metal',boxUV(.12,.04,.45),this.W(o,x,y+.22,z));
      }
      B.add('metal',boxUV(o.width+.15,.12,.14),this.W(o,0,y+2.08,z));
    }
  }

  _riverpost(o,B) {
    B.add('woodDark',boxUV(.12,1.7,.12),this.W(o,0,.75,0));
    B.add('orange',boxUV(.6,.25,.045),this.W(o,0,1.48,0));
    const texture=makeTextTexture([
      {text:o.farBank?'EAST TRAIL →':'RIVER CROSSING',font:'bold 25px Arial',color:'#e6dfc9'},
      {text:o.farBank?'Across the bridge':'Far-bank service landing',font:'18px Arial',color:'#c7c8b3'},
    ],{w:512,h:180,bg:'#26362d',pad:20});
    const mat=new THREE.MeshStandardMaterial({map:texture,roughness:.95,side:THREE.DoubleSide});
    const sign=new THREE.Mesh(new THREE.PlaneGeometry(.95,.34),mat);
    sign.matrix.copy(this.W(o,0,1.04,.075));sign.matrixAutoUpdate=false;this.group.add(sign);
  }

  _fishing(o, B) {
    B.add('fabric', boxUV(0.5, 0.04, 0.45), this.W(o, 0, 0.42, 0));
    B.add('fabric', boxUV(0.5, 0.45, 0.04), this.W(o, 0, 0.66, -0.24, 0, -0.2));
    for (const [x, z] of [[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2]]) B.add('metal', new THREE.CylinderGeometry(0.012, 0.012, 0.45, 5), this.W(o, x, 0.2, z));
    B.add('white', new THREE.CylinderGeometry(0.15, 0.13, 0.36, 12), this.W(o, 0.6, 0.18, 0.3));
    B.add('dark', new THREE.CylinderGeometry(0.008, 0.012, 2.4, 5), this.W(o, -0.5, 0.75, 0.9, 0, 1.0));
  }

  _mast(o, B) {
    const H = 24, legs = 3, R0 = 1.1, R1 = 0.35;
    const legPts = [];
    for (let l = 0; l < legs; l++) { const a = (l / legs) * Math.PI * 2; legPts.push([Math.cos(a), Math.sin(a)]); }
    const seg = 12;
    for (let s = 0; s < seg; s++) {
      const y0 = (s / seg) * H, y1 = ((s + 1) / seg) * H;
      const r0 = R0 + (R1 - R0) * (s / seg), r1 = R0 + (R1 - R0) * ((s + 1) / seg);
      for (let l = 0; l < legs; l++) {
        const [cx, cz] = legPts[l], [nx, nz] = legPts[(l + 1) % legs];
        const a = new THREE.Vector3(cx * r0, y0, cz * r0), b = new THREE.Vector3(cx * r1, y1, cz * r1);
        this._rod(B, 'metal', o, a, b, 0.035);
        this._rod(B, 'metal', o, a, new THREE.Vector3(nx * r1, y1, nz * r1), 0.012);
        this._rod(B, 'metal', o, b, new THREE.Vector3(nx * r1, y1, nz * r1), 0.012);
        this._rod(B, 'metal', o, new THREE.Vector3(nx * r0, y0, nz * r0), b, 0.012);
      }
    }
    B.add('metal', boxUV(0.9, 1.4, 0.6), this.W(o, 1.8, 0.7, 0.4));
    B.add('concrete', boxUV(1.4, 0.15, 1.0), this.W(o, 1.8, 0.05, 0.4));
    B.add('metal', new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), this.W(o, 0.3, H + 0.6, 0));
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    beacon.position.copy(new THREE.Vector3(0, H + 0.3, 0).applyMatrix4(M(o.x, o.y, o.z, o.rot)));
    this.group.add(beacon);
    const L = new THREE.PointLight(0xff2010, 0, 30, 2); L.position.copy(beacon.position); this.group.add(L);
    this.dynamic.push({ kind: 'beacon', light: L, bulb: beacon, t: 0 });
  }

  _rod(B, key, o, a, b, r) {
    const d = new THREE.Vector3().subVectors(b, a); const len = d.length();
    const g = new THREE.CylinderGeometry(r, r, len, 5); g.translate(0, len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    B.add(key, g, M(o.x, o.y, o.z, o.rot).multiply(new THREE.Matrix4().compose(a, q, new THREE.Vector3(1, 1, 1))));
  }

  _highwaybridge(o, B) {
    const w = this.world, hw = w.highway;
    const segL = 8;
    for (let x = hw.x0; x < hw.x1; x += segL) {
      const cx = x + segL / 2;
      const rd = w.riverDistAt(cx, hw.z);
      const ground = w.heightAt(cx, hw.z);
      const deckY = rd < 30 ? hw.embank : Math.max(ground, hw.embank - 0.3);
      B.add('asphalt', boxUV(segL + 0.05, 0.3, hw.halfW * 2, 4), M(cx, deckY + 0.05, hw.z));
      for (const side of [-1, 1]) {
        B.add('metal', boxUV(segL, 0.32, 0.08), M(cx, deckY + 0.75, hw.z + side * (hw.halfW - 0.4)));
        B.add('metal', boxUV(0.12, 0.75, 0.12), M(cx, deckY + 0.4, hw.z + side * (hw.halfW - 0.45)));
      }
      B.add('white', boxUV(segL * 0.45, 0.02, 0.12), M(cx, deckY + 0.21, hw.z));
      if (rd < 30) {
        B.add('concrete', boxUV(segL, 1.2, hw.halfW * 2 + 0.6, 2), M(cx, deckY - 0.6, hw.z));
        if (Math.round(cx / segL) % 3 === 0) B.add('concrete', new THREE.CylinderGeometry(0.7, 0.8, deckY - CONFIG.WATER_LEVEL + 3, 12), M(cx, (deckY + CONFIG.WATER_LEVEL - 3) / 2, hw.z));
      }
    }
  }

  _fence(B) {
    const posts = this.world.fencePosts;
    const g = new THREE.CylinderGeometry(0.05, 0.06, 1.45, 6);
    for (const [x, y, z, d] of posts) B.add('pole', g, M(x, y + 0.6, z, d, 0, (Math.abs(x) * 13 % 1) * 0.08));
    const verts = [];
    for (let i = 1; i < posts.length; i++) {
      const a = posts[i - 1], b = posts[i];
      if (Math.hypot(a[0] - b[0], a[2] - b[2]) > 5) continue;
      for (const h of [0.45, 0.8, 1.15]) verts.push(a[0], a[1] + h, a[2], b[0], b[1] + h - 0.02, b[2]);
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.group.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x0c0d0f, transparent: true, opacity: 0.8 })));
  }

  _powerLine(B) {
    const poles = this.world.powerPoles;
    const g = new THREE.CylinderGeometry(0.13, 0.18, 10, 8);
    const arm = boxUV(2.2, 0.12, 0.12);
    const verts = [];
    for (let i = 0; i < poles.length; i++) {
      const [x, y, z, d] = poles[i];
      B.add('pole', g, M(x, y + 4.6, z, d));
      B.add('pole', arm, M(x, y + 9.2, z, d + Math.PI / 2));
      if (i > 0) {
        const [x0, y0, z0, d0] = poles[i - 1];
        if (Math.hypot(x - x0, z - z0) > 70) continue;
        for (const off of [-0.95, 0, 0.95]) {
          const ox0 = Math.cos(d0) * off, oz0 = -Math.sin(d0) * off, ox1 = Math.cos(d) * off, oz1 = -Math.sin(d) * off;
          const n = 8;
          for (let k = 0; k < n; k++) {
            const t0 = k / n, t1 = (k + 1) / n;
            const sag = (t) => -Math.sin(Math.PI * t) * 0.9;
            verts.push(x0 + ox0 + (x + ox1 - x0 - ox0) * t0, y0 + 9.3 + (y - y0) * t0 + sag(t0), z0 + oz0 + (z + oz1 - z0 - oz0) * t0,
              x0 + ox0 + (x + ox1 - x0 - ox0) * t1, y0 + 9.3 + (y - y0) * t1 + sag(t1), z0 + oz0 + (z + oz1 - z0 - oz0) * t1);
          }
        }
      }
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.group.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x07080a })));
  }

  update(dt, time) {
    for (const d of this.dynamic) {
      if (d.kind === 'beacon') {
        const on = (time % 2.2) < 0.9;
        d.light.intensity = on ? 6 : 0;
        d.bulb.material.color.setRGB(on ? 6 : 0.1, on ? 0.4 : 0.01, on ? 0.2 : 0.01);
      } else if (d.kind === 'sodium') {
        d.t -= dt;
        if (d.t < 0) { d.t = 0.05 + Math.random() * (Math.random() < 0.1 ? 3 : 0.25); d.state = Math.random() < 0.18; }
        const k = d.state ? 0.6 + Math.random() * 0.4 : 0;
        d.light.intensity = k * 28;
        d.bulb.material.color.setRGB(k * 8, k * 4, k * 1.5);
      }
    }
  }
}
