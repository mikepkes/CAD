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
  roughness: number;
}

// Species presets (hand-tuned, approximate). Colours are linear-ish sRGB hex.
export const SPECIES: Record<string, Wood> = {
  "white-oak": { early: "#d8bc86", late: "#8f6f42", ringScale: 7, contrast: 0.55, pore: 0.6, grain: 0.55, roughness: 0.62 },
  "red-oak":   { early: "#cda47f", late: "#9c6b4c", ringScale: 6, contrast: 0.5, pore: 0.8, grain: 0.5, roughness: 0.64 },
  walnut:      { early: "#6b4b32", late: "#3c2817", ringScale: 9, contrast: 0.45, pore: 0.45, grain: 0.6, roughness: 0.55 },
  maple:       { early: "#e7d4ac", late: "#cdb483", ringScale: 5, contrast: 0.28, pore: 0.08, grain: 0.35, roughness: 0.42 },
  cherry:      { early: "#b5724a", late: "#8a4a2c", ringScale: 6, contrast: 0.35, pore: 0.2, grain: 0.45, roughness: 0.46 },
  "hard-maple":{ early: "#ecdcb6", late: "#d4bd8c", ringScale: 4.5, contrast: 0.25, pore: 0.06, grain: 0.3, roughness: 0.4 },
  "southern-pine": { early: "#e3c78a", late: "#9c6a33", ringScale: 10, contrast: 0.7, pore: 0.25, grain: 0.7, roughness: 0.6 },
  mahogany:    { early: "#8a4733", late: "#5c2c1e", ringScale: 8, contrast: 0.4, pore: 0.4, grain: 0.55, roughness: 0.5 },
  beech:       { early: "#d8b48a", late: "#b98b5f", ringScale: 5, contrast: 0.35, pore: 0.25, grain: 0.4, roughness: 0.5 },
  ash:         { early: "#d8c49a", late: "#a07b4c", ringScale: 7, contrast: 0.5, pore: 0.6, grain: 0.5, roughness: 0.58 },
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

// The wood height/colour field, shared by colour and bump. Returns latewood mask.
const WOOD_GLSL = /* glsl */`
uniform vec3 uAxis; uniform vec3 uPith;
uniform float uRingScale; uniform float uContrast; uniform float uPore; uniform float uGrain;
uniform vec3 uEarly; uniform vec3 uLate;
varying vec3 vWPos;

// A sample coordinate that is compressed along the grain axis, so noise features
// stretch into long streaks/pores (across = cross-grain scale, alongS = along scale).
vec3 grainCoord(vec3 p, vec3 a, float across, float alongS){
  float al = dot(p - uPith, a);
  vec3 ac = (p - uPith) - al*a;
  return ac*across + a*(al*alongS);
}
// ring coordinate: distance from the pith axis, warped by noise so rings waver.
float woodRing(vec3 p){
  vec3 a = normalize(uAxis);
  vec3 v = p - uPith;
  float along = dot(v, a);
  vec3 radial = v - along*a;
  float r = length(radial);
  // run-out along the length + waviness across → flowing cathedral figure
  r += 3.6*fbm(grainCoord(p, a, 0.028, 0.3));
  r += 0.7*fbm(grainCoord(p, a, 0.11, 0.5));
  return r;
}
// 0 at earlywood, 1 at the dark latewood line.
float woodLate(vec3 p){
  float r = woodRing(p);
  float t = fract(r / uRingScale);
  // sharp dark band near the ring boundary
  float band = smoothstep(0.78, 0.98, t) * (1.0 - smoothstep(0.98, 1.0, t));
  return clamp(band, 0.0, 1.0);
}
// long-grain streaks + pores, as a dark multiplier.
float woodGrainDark(vec3 p){
  vec3 a = normalize(uAxis);
  // streaks: long directional grain lines (the dominant figure)
  float streak = fbm(grainCoord(p, a, 0.11, 0.02));
  float streakDark = uGrain * 0.3 * smoothstep(0.15, 0.95, streak*0.5+0.5);
  // pores: sparse specks, elongated along grain (open-grain species)
  float pore = fbm(grainCoord(p, a, 0.45, 0.1));
  float poreDark = uPore * smoothstep(0.62, 0.9, pore) * 0.3;
  return streakDark + poreDark;
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
    uEarly: { value: early },
    uLate: { value: late },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWPos = (modelMatrix*vec4(transformed,1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + NOISE_GLSL + "\n" + WOOD_GLSL)
      .replace("#include <map_fragment>", /* glsl */`
        float late = woodLate(vWPos);
        float dark = woodGrainDark(vWPos);
        vec3 wood = mix(uEarly, uLate, late*uContrast);
        wood *= (1.0 - dark);
        diffuseColor.rgb *= wood * 1.12;
      `)
      .replace("#include <roughnessmap_fragment>", /* glsl */`
        float roughnessFactor = roughness + 0.18*late + 0.10*dark;
      `)
      .replace("#include <normal_fragment_maps>", /* glsl */`
        #include <normal_fragment_maps>
        {
          float h = late*1.0 + dark*0.6;
          vec3 dpx = dFdx(vWPos); vec3 dpy = dFdy(vWPos);
          float dhx = dFdx(h); float dhy = dFdy(h);
          vec3 nn = normalize(normal);
          vec3 r1 = cross(dpy, nn); vec3 r2 = cross(nn, dpx);
          float det = dot(dpx, r1);
          vec3 grad = (r1*dhx + r2*dhy) / max(abs(det), 1e-6);
          normal = normalize(nn - 0.35*grad);
        }
      `);
  };
  // Force a unique program key per frame so each board keeps its own uniforms.
  mat.customProgramCacheKey = () => "wood";
  mat.userData.woodUniforms = uniforms;
  return mat;
}

function makeMetal(spec: MaterialSpec): THREE.Material {
  const finish = spec.finish ?? "satin";
  const rough = spec.roughness ?? (finish === "polished" ? 0.12 : finish === "brushed" ? 0.42 : 0.28);
  return new THREE.MeshStandardMaterial({
    color: lin(spec.color ?? "#9aa0a6"),
    metalness: spec.metalness ?? 0.95,
    roughness: rough,
    side: THREE.DoubleSide,
  });
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
  const pith = [...c] as [number, number, number];
  pith[thin] -= 220 + 520 * r;           // log centre offset through the thin face
  pith[mid] += (hash01(seed + "m") - 0.5) * 320; // lateral jitter for variety
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
