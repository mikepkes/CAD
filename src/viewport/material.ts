// A small, generalized material system. A MaterialSpec (wood / metal / plastic /
// painted) resolves to a three.js material. Wood is a *procedural 3D grain*
// shader: growth rings are concentric cylinders around a pith axis through the
// board, warped by noise, with latewood bands, long-grain streaks and (for
// open-grain species) pores — so end grain shows rings, faces show cathedrals,
// and each board, cut from its own virtual log, reads as a separate piece.
//
// Everything is driven by a species preset plus overridable parameters, and the
// same factory handles metal (PBR + optional brushed anisotropy) and plastic
// (matte/satin/gloss), so the system generalizes beyond wood.
import * as THREE from "three";

export interface MaterialSpec {
  kind: "wood" | "metal" | "plastic" | "painted";
  species?: string;      // wood: a SPECIES key
  finish?: string;       // metal/plastic: polished | brushed | satin | matte | gloss
  color?: string;        // base/tint override (hex)
  roughness?: number;
  metalness?: number;
  ringScale?: number;    // wood: growth-ring spacing (mm)
  grainContrast?: number;// wood: latewood darkness
  poreStrength?: number; // wood: open-grain pores
}

/** Per-body wood frame: grain runs along `axis`; rings centre on the line through
 *  `pith` along `axis`. Chosen per body so boards look individually sawn. */
export interface WoodFrame { axis: [number, number, number]; pith: [number, number, number]; }

interface Wood {
  early: string; late: string;    // earlywood / latewood colour
  ringScale: number;              // mm between rings
  contrast: number;               // latewood band darkness 0..1
  pore: number;                   // open-grain pore strength 0..1
  grain: number;                  // long-grain streak strength
  ray: number;                    // medullary-ray fleck strength (quartersawn)
  roughness: number;
}

// Species presets (hand-tuned, approximate). Colours are desaturated/greyer than
// a naive tan so oak doesn't read as orange pine. Linear conversion happens later.
export const SPECIES: Record<string, Wood> = {
  "white-oak": { early: "#c3ac7e", late: "#7c6038", ringScale: 9, contrast: 0.6, pore: 0.55, grain: 0.4, ray: 0.9, roughness: 0.64 },
  "red-oak":   { early: "#c29a74", late: "#8a5e40", ringScale: 8, contrast: 0.55, pore: 0.8, grain: 0.4, ray: 0.6, roughness: 0.66 },
  walnut:      { early: "#5f4430", late: "#33220f", ringScale: 11, contrast: 0.5, pore: 0.4, grain: 0.5, ray: 0.15, roughness: 0.55 },
  maple:       { early: "#ddc9a0", late: "#c2a877", ringScale: 6, contrast: 0.3, pore: 0.06, grain: 0.3, ray: 0.2, roughness: 0.42 },
  cherry:      { early: "#ad6e48", late: "#7f4228", ringScale: 8, contrast: 0.38, pore: 0.18, grain: 0.4, ray: 0.2, roughness: 0.46 },
  "hard-maple":{ early: "#e3d3ac", late: "#cbb285", ringScale: 5.5, contrast: 0.26, pore: 0.05, grain: 0.26, ray: 0.2, roughness: 0.4 },
  "southern-pine": { early: "#dcc084", late: "#93622f", ringScale: 13, contrast: 0.78, pore: 0.2, grain: 0.6, ray: 0.1, roughness: 0.6 },
  mahogany:    { early: "#82422f", late: "#54281b", ringScale: 10, contrast: 0.42, pore: 0.35, grain: 0.5, ray: 0.3, roughness: 0.5 },
  // American beech: pale pinkish-cream, fine even (diffuse-porous) texture with
  // low early/late contrast and a dense, fine medullary-ray fleck — its signature.
  beech:       { early: "#e6cba4", late: "#caa273", ringScale: 7, contrast: 0.24, pore: 0.06, grain: 0.2, ray: 0.9, roughness: 0.46 },
  ash:         { early: "#d2bd93", late: "#9a7646", ringScale: 9, contrast: 0.55, pore: 0.55, grain: 0.45, ray: 0.3, roughness: 0.58 },
};
export const SPECIES_KEYS = Object.keys(SPECIES);

const DEFAULT_WOOD: Wood = SPECIES["white-oak"];

// ---- GLSL: 3D simplex noise (Ashima / Stefan Gustavson) + fbm ---------------
const NOISE_GLSL = /* glsl */`
vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ *ns.x + ns.yyyy;
  vec4 y = y_ *ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
float fbm(vec3 p){
  float s = 0.0, a = 0.5;
  for(int i=0;i<4;i++){ s += a*snoise(p); p *= 2.02; a *= 0.5; }
  return s;
}`;

// The 3D wood field. This is one *continuous solid texture* sampled in world
// space (each board carries its own pith + axis), so the grain belongs to the
// PIECE, not to a face: it wraps around every edge, and end-grain circles /
// flatsawn cathedrals / quartersawn lines all emerge from *where a surface cuts
// the same growth-ring cylinders* — never from a surface-normal switch (that was
// the bug that made edge grain not continue onto the long face). Fills `W` with
// colour, a roughness delta and a height for the bump.
const WOOD_GLSL = /* glsl */`
uniform vec3 uAxis; uniform vec3 uPith;
uniform float uRingScale; uniform float uContrast; uniform float uPore; uniform float uGrain; uniform float uRay;
uniform vec3 uEarly; uniform vec3 uLate;
varying vec3 vWPos; varying vec3 vWN;

// anisotropic sample coordinate: squash across the grain, stretch along it, so a
// noise fbm forms fibres that run ALONG the grain axis — the same on every face.
vec3 grainCoord(vec3 p, vec3 a, float across, float alongS){
  float al = dot(p - uPith, a);
  vec3 ac = (p - uPith) - al*a;
  return ac*across + a*(al*alongS);
}
// warped radial distance from the pith axis (the growth-ring parameter), plus
// the local radial/tangential frame used for rays.
float woodRing(vec3 p, vec3 a, out float along, out vec3 rdir, out vec3 tang, out float rlen){
  vec3 v = p - uPith;
  along = dot(v, a);
  vec3 radial = v - along*a;
  rlen = max(length(radial), 1e-3);
  rdir = radial / rlen;
  tang = normalize(cross(a, rdir));
  float r = rlen;
  r += 2.6*fbm(grainCoord(p, a, 0.026, 0.20));   // broad cathedral waver
  r += 0.7*fbm(grainCoord(p, a, 0.10, 0.5));      // finer ring waver
  return r;
}

struct Wood { vec3 col; float rough; float h; };

Wood woodField(vec3 p){
  vec3 a = normalize(uAxis);
  float along; vec3 rdir; vec3 tang; float rlen;
  float r = woodRing(p, a, along, rdir, tang, rlen);

  // Growth rings: one thin dark latewood band per ring. This single 3D field is
  // what makes concentric circles on end grain, arches on the flat face and
  // near-straight lines on the quartered face — continuous across every edge.
  float t = fract(r / uRingScale);
  float band = smoothstep(0.52, 0.76, t) * (1.0 - smoothstep(0.84, 1.0, t));
  float late = clamp(band * (0.5 + uContrast), 0.0, 1.0);

  // Fine fibre texture running along the grain (hairlines), continuous in 3D.
  float fibre = fbm(grainCoord(p, a, 0.13, 0.012));
  float fibreDark = uGrain * 0.16 * (fibre*0.5 + 0.5);

  // Open-grain pores: tubes along the grain → round dots on end grain, fine
  // dashes along the faces. Same field everywhere, so it reads correctly per cut.
  float pore = fbm(grainCoord(p, a, 0.85, 0.06));
  float poreDark = uPore * 0.32 * smoothstep(0.6, 0.92, pore);
  float dark = fibreDark + poreDark;

  // Medullary rays: thin sheets radiating from the pith (fast in the tangential
  // direction, slow radially/axially). A 3D field, so it stays continuous; it
  // naturally shows broadest where the surface lies in the radial plane.
  float rayc = fbm(vec3(dot(p - uPith, tang)*0.55, rlen*0.03, along*0.03));
  float fleck = smoothstep(0.55, 0.82, rayc) * uRay * 0.45;

  // per-board tonal variation (seed from the pith position)
  float seed = fract(sin(dot(uPith, vec3(12.9898,78.233,37.719)))*43758.5453);
  vec3 tint = vec3(1.0 + (seed-0.5)*0.12, 1.0 + (seed-0.5)*0.04, 1.0 - (seed-0.5)*0.10);

  vec3 col = mix(uEarly, uLate, late) * (1.0 - dark);
  col = mix(col, col*1.45 + 0.05, fleck);        // flecks lighten
  col *= tint;

  Wood W;
  W.col = col * 1.06;
  W.rough = 0.16*late + 0.08*dark - 0.22*fleck;  // flecks shinier, latewood rougher
  W.h = late*1.0 + dark*0.5 - fleck*0.35;
  return W;
}`;

function lin(hex: string): THREE.Color { return new THREE.Color(hex).convertSRGBToLinear(); }

function makeWood(spec: MaterialSpec, frame?: WoodFrame): THREE.Material {
  const w = { ...DEFAULT_WOOD, ...(spec.species ? SPECIES[spec.species] : {}) } as Wood;
  const ringScale = spec.ringScale ?? w.ringScale;
  const contrast = spec.grainContrast ?? w.contrast;
  const pore = spec.poreStrength ?? w.pore;
  const early = spec.color ? lin(spec.color) : lin(w.early);
  const late = lin(w.late);
  const axis = frame?.axis ?? [1, 0, 0];
  const pith = frame?.pith ?? [0, -400, 0];

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, metalness: 0, roughness: spec.roughness ?? w.roughness, side: THREE.DoubleSide,
  });
  const uniforms = {
    uAxis: { value: new THREE.Vector3(...axis) },
    uPith: { value: new THREE.Vector3(...pith) },
    uRingScale: { value: ringScale },
    uContrast: { value: contrast },
    uPore: { value: pore },
    uGrain: { value: w.grain },
    uRay: { value: w.ray },
    uEarly: { value: early },
    uLate: { value: late },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos; varying vec3 vWN;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWPos = (modelMatrix*vec4(transformed,1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * normal);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + NOISE_GLSL + "\n" + WOOD_GLSL + "\nWood gWood;")
      .replace("#include <map_fragment>", /* glsl */`
        gWood = woodField(vWPos);
        diffuseColor.rgb *= gWood.col;
      `)
      .replace("#include <roughnessmap_fragment>", /* glsl */`
        float roughnessFactor = clamp(roughness + gWood.rough, 0.04, 1.0);
      `)
      .replace("#include <normal_fragment_maps>", /* glsl */`
        #include <normal_fragment_maps>
        {
          float h = gWood.h;
          vec3 dpx = dFdx(vWPos); vec3 dpy = dFdy(vWPos);
          float dhx = dFdx(h); float dhy = dFdy(h);
          vec3 nn = normalize(normal);
          vec3 r1 = cross(dpy, nn); vec3 r2 = cross(nn, dpx);
          float det = dot(dpx, r1);
          vec3 grad = (r1*dhx + r2*dhy) / max(abs(det), 1e-6);
          normal = normalize(nn - 0.4*grad);
        }
      `);
  };
  mat.customProgramCacheKey = () => "wood";
  mat.userData.woodUniforms = uniforms;
  return mat;
}

function makeMetal(spec: MaterialSpec): THREE.Material {
  const finish = spec.finish ?? "satin";
  const rough = spec.roughness ?? (finish === "polished" ? 0.12 : finish === "brushed" ? 0.4 : 0.3);
  const mat = new THREE.MeshStandardMaterial({
    color: lin(spec.color ?? "#b7bbc0"),
    metalness: spec.metalness ?? 1.0,   // real metals are fully metallic; roughness sets the look
    roughness: rough,
    side: THREE.DoubleSide,
    envMapIntensity: 1.25,
  });
  // Cast-iron microstructure: subtle pitted roughness + bump for the rougher metals,
  // so cast iron reads as a matte, slightly uneven casting rather than flat plastic.
  if (rough >= 0.45) {
    const u = { uCast: { value: 1 } };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWPosM;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWPosM=(modelMatrix*vec4(transformed,1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\n" + NOISE_GLSL + "\nvarying vec3 vWPosM;")
        .replace("#include <roughnessmap_fragment>", "float roughnessFactor = clamp(roughness + 0.12*fbm(vWPosM*0.22) + 0.06*fbm(vWPosM*1.4), 0.2, 1.0);")
        .replace("#include <normal_fragment_maps>", /* glsl */`
          #include <normal_fragment_maps>
          { float h = 0.5*fbm(vWPosM*0.35) + 0.25*fbm(vWPosM*1.6);
            vec3 dpx=dFdx(vWPosM), dpy=dFdy(vWPosM); float dhx=dFdx(h), dhy=dFdy(h);
            vec3 nn=normalize(normal); vec3 r1=cross(dpy,nn), r2=cross(nn,dpx); float det=dot(dpx,r1);
            vec3 g=(r1*dhx+r2*dhy)/max(abs(det),1e-6); normal=normalize(nn - 0.07*g); }
        `);
    };
    mat.customProgramCacheKey = () => "castmetal";
  }
  return mat;
}

function makePlastic(spec: MaterialSpec): THREE.Material {
  const finish = spec.finish ?? "satin";
  const rough = spec.roughness ?? (finish === "gloss" ? 0.15 : finish === "matte" ? 0.8 : 0.45);
  return new THREE.MeshStandardMaterial({
    color: lin(spec.color ?? "#2f6f4f"),
    metalness: spec.metalness ?? 0.0,
    roughness: rough,
    side: THREE.DoubleSide,
  });
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** Choose a wood grain frame for a body from its world bounds: grain runs along
 *  the longest dimension; the pith sits well off the thin face (flat/rift sawn),
 *  jittered per body by `seed` so each board looks individually sawn. */
export function woodFrameFromBounds(b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }, seed: string): WoodFrame {
  const c = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];
  const ext = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
  let long = 0; for (let i = 1; i < 3; i++) if (ext[i] > ext[long]) long = i;
  let thin = 0; for (let i = 1; i < 3; i++) if (ext[i] < ext[thin]) thin = i;
  if (thin === long) thin = (long + 1) % 3;
  const mid = 3 - long - thin;
  const axis: [number, number, number] = [0, 0, 0]; axis[long] = 1;
  const r = hash01(seed);
  const widthMid = ext[mid];
  const pith = [...c] as [number, number, number];
  // Pith sits just off the wide (flatsawn) face — close enough that the growth
  // rings visibly curve across the board (radiality), far enough to read as
  // boards rather than tight bullseyes. Scaled to the board so big and small
  // stock both look right.
  pith[thin] -= 0.9 * ext[thin] + 70 + 150 * r;
  // Lateral offset of the pith (within the wide face) sets how off-centre the
  // cathedral runs — some boards rift/quartered (pith to the side), some flat.
  pith[mid] += (hash01(seed + "m") - 0.5) * (widthMid * 1.6 + 120);
  return { axis, pith };
}

/** Build a three.js material for a spec (+ per-body wood frame). */
export function createMaterial(spec: MaterialSpec, frame?: WoodFrame): THREE.Material {
  switch (spec.kind) {
    case "wood": return makeWood(spec, frame);
    case "metal": return makeMetal(spec);
    case "plastic": return makePlastic(spec);
    case "painted": return makePlastic({ ...spec, finish: spec.finish ?? "satin", metalness: 0 });
    default: return makePlastic(spec);
  }
}
