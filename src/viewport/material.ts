// A small, generalized material system. A MaterialSpec (wood / metal / plastic /
// painted) resolves to a three.js material. Wood is a *procedural 3D grain*
// shader: growth rings are concentric cylinders around a pith axis through the
// board, warped by noise, with latewood bands, long-grain streaks and (for
// open-grain species) pores — so end grain shows rings, faces show cathedrals,
// and each board, cut from its own virtual log, reads as a separate piece.
//
// Everything is driven by a species preset plus overridable parameters, and the
// same factory handles the physically based kinds (metal, plastic, painted,
// rubber, printed), which share one surface layer: micro-roughness, procedural
// textures, brushing and printed layer lines. Paper has a shader of its own:
// drawn in the sheet's flat coordinates, so its fibres stay put as it folds.
import * as THREE from "three";

export type MaterialAxis = "x" | "y" | "z";

export interface MaterialSpec {
  kind: "wood" | "metal" | "plastic" | "painted" | "rubber" | "printed" | "paper";
  species?: string;      // wood: a SPECIES key
  finish?: string;       // metal/plastic: polished | brushed | satin | matte | gloss (printed: matte | satin | silk)
  color?: string;        // base/tint override (hex)
  backColor?: string;    // the other side of a surface (paper coloured one side)
  roughness?: number;
  metalness?: number;
  ringScale?: number;    // wood: growth-ring spacing (mm)
  grainContrast?: number;// wood: latewood darkness
  poreStrength?: number; // wood: open-grain pores
  texture?: string;      // none | stipple | dimples | knurl | ribs | hex
  textureScale?: number; // texture pitch (mm)
  textureWrap?: boolean; // wrap the texture around the part's long axis (grips, knobs, collars) instead of projecting it
  textureAxis?: MaterialAxis; // ribs: the axis they run across; brushed metal: the brushing direction
  layerHeight?: number;  // printed: layer height (mm)
  printAxis?: MaterialAxis;   // printed: the build direction the layers stack along
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

// ---- the surface layer every non-wood material shares ------------------------
// Fine roughness variation (no real surface is CG-flat), procedural textures and
// printed layer lines, all as a height field turned into a bumped normal in the
// fragment shader. Patterns live in the body's own coordinates, so they stay on
// the part as it moves. Each pattern fades out as it gets finer than a couple
// of pixels, so it never shimmers; layer lines leave a faint sheen behind.
const SURFACE_GLSL = /* glsl */`
uniform int uTex; uniform float uTexScale; uniform float uTexDepth; uniform vec3 uTexAxis;
uniform float uLayer; uniform vec3 uLayerAxis; uniform float uMicro; uniform float uBrush;
varying vec3 vLPos; varying vec3 vLN;
varying vec3 vLayerV;                              // the build direction in view space
#ifdef SURF_WRAP
varying vec4 vWrap;                                // wrapped texture coordinates: (cos, sin) of the arc-length angle, distance along the axis, girth (mm)
#endif
struct Surf { float h; float rough; float slope; float ao; };  // slope: d(height)/d(distance along the build direction), exact, for layer lines too fine to difference
float tri(float x){ return abs(fract(x) - 0.5) * 2.0; }
// Hexagonal grip pads: the distance (hex metric, 0.5 at a cell's flat side) to
// the nearest cell centre of a hex lattice one pitch across its flats.
float hexDist(vec2 p){
  const vec2 s = vec2(1.0, 1.7320508);
  vec4 c = floor(vec4(p, p - vec2(0.5, 0.8660254)) / s.xyxy) + 0.5;
  vec4 h = vec4(p - c.xy * s, p - (c.zw + 0.5) * s);
  vec2 q = abs(dot(h.xy, h.xy) < dot(h.zw, h.zw) ? h.xy : h.zw);
  return max(q.x, dot(q, vec2(0.5, 0.8660254)));
}
float gGroove;                                     // hex: how much of this point is groove (for the shading)
// a 2D pattern on a plane (u, v in pitches): 2 dimples, 3 knurl, 5 hex pads.
// w: the pattern's footprint in pitches per pixel, to soften its edges by.
float pat2(vec2 uv, float w){
  if (uTex == 2) { uv.x += 0.5 * mod(floor(uv.y), 2.0); vec2 f = fract(uv) - 0.5; return -smoothstep(0.36, 0.16, length(f)); }
  if (uTex == 5) {
    // flat-topped pads with rounded shoulders, a groove between: its edges widened to a pixel or more so they never alias
    float d = hexDist(uv);
    float e = max(w, 0.02);
    float pad = 1.0 - smoothstep(0.36 - e, 0.42 + e, d);
    gGroove = 1.0 - pad;
    return pad * (1.0 - 0.35 * d * d) - 0.5;
  }
  return min(tri(uv.x + uv.y), tri(uv.x - uv.y)) - 0.5;
}
float pat2(vec2 uv){ return pat2(uv, 0.0); }
// triplanar: the pattern on each axis plane, blended by the normal, so a face shows a regular grid whichever way it faces
float triplanar(vec3 p){
  vec3 w = pow(abs(normalize(vLN)), vec3(4.0)); w /= (w.x + w.y + w.z);
  return w.x * pat2(p.yz) + w.y * pat2(p.xz) + w.z * pat2(p.xy);
}
Surf surface(vec3 p){
  Surf S; S.h = 0.0; S.slope = 0.0; S.ao = 1.0; S.rough = uMicro * fbm(p * 0.07) + uMicro * 0.5 * fbm(p * 0.6);
  float px = length(fwidth(p));                      // mm per pixel here
  gGroove = 0.0;
#ifdef SURF_WRAP
  // Wrapped round the part: around = the arc-length fraction (aWrap.xy as an
  // angle) times a whole number of cells, so the pattern closes on itself;
  // along = the distance along the part's axis. atan jumps by a whole turn (a
  // whole number of cells: the pattern doesn't see it), but its screen
  // derivative would spike there, so the footprint is taken from the angle's
  // exact derivative, d(atan(y, x)) = (x dy - y dx) / (x² + y²), which is smooth.
  float cells = max(3.0, floor(vWrap.w / uTexScale + 0.5));
  // (aWrap.xy is shortened on faces square to the axis, an end face: the pattern fades out there,
  // and where it is ~0 the angle is meaningless — atan(0, 0) — so it isn't taken)
  float wrapLen = length(vWrap.xy);
  vec2 wrapXY = wrapLen > 1e-3 ? vWrap.xy : vec2(1.0, 0.0);
  float wrapFade = smoothstep(0.2, 0.7, wrapLen);
  float wrapA = atan(wrapXY.y, wrapXY.x) / 6.2831853;
  vec2 dX = dFdx(wrapXY), dY = dFdy(wrapXY);
  float r2 = max(dot(wrapXY, wrapXY), 1e-6);
  float dAng = (abs(wrapXY.x * dX.y - wrapXY.y * dX.x) + abs(wrapXY.x * dY.y - wrapXY.y * dY.x)) / r2 / 6.2831853;
  vec2 wuv = vec2(wrapA * cells, vWrap.z / uTexScale);
  float wpx = max(dAng * cells, fwidth(wuv.y));      // pitches per pixel
#endif
  if (uTex > 0) {
    float aa = 1.0 - smoothstep(0.25, 0.6, px / uTexScale);
    float h = 0.0;
    if (uTex == 1) h = fbm(p / uTexScale);
    else if (uTex == 4) h = smoothstep(0.15, 0.55, tri(dot(p, uTexAxis) / uTexScale));
#ifdef SURF_WRAP
    else { aa = (1.0 - smoothstep(0.25, 0.6, wpx)) * wrapFade; h = aa > 0.0 ? pat2(wuv, wpx) : 0.0; if (aa <= 0.0) gGroove = 0.0; }
#else
    else h = triplanar(p / uTexScale);
#endif
    S.h += uTexDepth * h * aa;
    S.rough += (uTex == 5 ? 0.12 * gGroove : 0.08 * h) * aa;   // hex: the grooves are rougher than the pads
    S.ao *= 1.0 - 0.32 * gGroove * aa;                         // and sit in shadow
  }
  if (uBrush > 0.0) {                                // brushed: fine streaks along the brushing direction
    float al = dot(p, uTexAxis); vec3 ac = p - al * uTexAxis;
    float fine = 1.0 - smoothstep(0.03, 0.12, px);   // the lines are finer than a pixel at most zooms
    float n = fbm(ac * 1.5 + uTexAxis * al * 0.02) * 0.5 + fbm(ac * 9.0 + uTexAxis * al * 0.05) * 0.5 * fine;
    S.rough += uBrush * (0.06 + 0.07 * n);
    S.h += 0.0015 * n * fine;
  }
  if (uLayer > 0.0) {                                // printed layer lines: one smooth ridge per layer
    float x = dot(p, uLayerAxis) / uLayer;
    float fw = fwidth(x);
    float aa = 1.0 - smoothstep(0.2, 0.4, fw);       // a sinusoid aliases only near 2 pixels a layer: drawn down to 2.5
    float c = cos(6.2831853 * x);
    // a sinusoid (no harmonics finer than a layer to alias), sharpened toward a bead only when a layer spans many pixels
    float sharp = 1.0 - smoothstep(0.03, 0.08, fw);
    float d = -sin(6.2831853 * x) * mix(1.0, 1.6 * (0.6 + 0.4 * c), sharp);
    S.slope = 0.075 * 6.2831853 * d * aa;              // the ridge's slope, exact (no pixel differencing)
    S.rough += 0.06 * (0.5 - 0.5 * c) * aa * aa + 0.04 * (1.0 - aa);
    S.ao *= 1.0 - 0.14 * (0.5 - 0.5 * c) * aa;      // the valley between beads sits a little in shadow
  }
  return S;
}`;

type Axis = MaterialAxis | undefined;
const axisVec = (a: Axis, fallback: MaterialAxis) => { const k = a ?? fallback; return new THREE.Vector3(k === "x" ? 1 : 0, k === "y" ? 1 : 0, k === "z" ? 1 : 0); };
const TEXTURES: Record<string, number> = { none: 0, stipple: 1, dimples: 2, knurl: 3, ribs: 4, hex: 5 };

interface SurfaceOpts { texture?: string; textureScale?: number; textureDepth?: number; textureAxis?: Axis; textureWrap?: boolean; micro?: number; brush?: number; layer?: number; layerAxis?: Axis }

/** Whether a material's texture is wrapped round the part (and so needs the `aWrap` attribute, see wrapCoords). */
export function wrapsTexture(spec: MaterialSpec | undefined): boolean {
  return !!spec && spec.kind !== "wood" && !!spec.textureWrap && ["dimples", "knurl", "hex"].includes(spec.texture ?? "");
}

/** Give a PBR material the shared surface layer: micro-roughness, a texture, brushing, layer lines. */
function withSurface<M extends THREE.MeshStandardMaterial>(mat: M, o: SurfaceOpts): M {
  const tex = TEXTURES[o.texture ?? "none"] ?? 0;
  const wrap = !!o.textureWrap && (tex === 2 || tex === 3 || tex === 5);
  const scale = o.textureScale ?? 1.5;
  const uniforms = {
    uTex: { value: tex },
    uTexScale: { value: scale },
    uTexDepth: { value: o.textureDepth ?? scale * (tex === 1 ? 0.06 : tex === 5 ? 0.1 : 0.16) },
    uTexAxis: { value: axisVec(o.textureAxis, "z") },
    uLayer: { value: o.layer ?? 0 },
    uLayerAxis: { value: axisVec(o.layerAxis, "z") },
    uMicro: { value: o.micro ?? 0.05 },
    uBrush: { value: o.brush ?? 0 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const def = wrap ? "#define SURF_WRAP\n" : "";
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLPos; varying vec3 vLN; varying vec3 vLayerV; uniform vec3 uLayerAxis;" + (wrap ? "\nattribute vec4 aWrap; varying vec4 vWrap;" : ""))
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLPos = transformed; vLN = objectNormal; vLayerV = normalMatrix * uLayerAxis;" + (wrap ? " vWrap = aWrap;" : ""));
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + def + NOISE_GLSL + "\n" + SURFACE_GLSL + "\nSurf gSurf;")
      .replace("#include <map_fragment>", /* glsl */`
        #include <map_fragment>
        gSurf = surface(vLPos);
        diffuseColor.rgb *= gSurf.ao;
      `)
      .replace("#include <roughnessmap_fragment>", /* glsl */`
        float roughnessFactor = clamp(roughness + gSurf.rough, 0.03, 1.0);
      `)
      .replace("#include <normal_fragment_maps>", /* glsl */`
        #include <normal_fragment_maps>
        {
          // bump from the height field (mm), in view space: Mikkelsen's surface-gradient form
          vec3 pos = -vViewPosition;
          vec3 dpx = dFdx(pos), dpy = dFdy(pos);
          float dhx = dFdx(gSurf.h), dhy = dFdy(gSurf.h);
          vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
          float det = dot(dpx, r1);
          vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
          normal = normalize(abs(det) * normal - grad);
          // the exact gradient: into view space (gradients transform by the normal matrix), along the surface
          vec3 g = normalize(vLayerV) * gSurf.slope;
          normal = normalize(normal - (g - normal * dot(normal, g)));
        }
      `);
  };
  mat.customProgramCacheKey = () => (wrap ? "surface-wrap" : "surface");
  mat.userData.surfaceUniforms = uniforms;
  return mat;
}

function makeMetal(spec: MaterialSpec): THREE.Material {
  const finish = spec.finish ?? "satin";
  const rough = spec.roughness ?? ({ polished: 0.07, gloss: 0.07, brushed: 0.26, satin: 0.22, matte: 0.42 } as Record<string, number>)[finish] ?? 0.22;
  const cast = rough >= 0.45; // cast iron and the like: a matte, slightly uneven casting
  const mat = new THREE.MeshPhysicalMaterial({
    color: lin(spec.color ?? "#c4c8cc"),
    metalness: spec.metalness ?? 1.0,   // real metals are fully metallic; roughness sets the look
    roughness: rough,
    side: THREE.DoubleSide,
  });
  return withSurface(mat, {
    texture: spec.texture ?? (cast ? "stipple" : "none"), textureScale: spec.textureScale ?? (cast ? 3 : undefined), textureDepth: cast && !spec.texture ? 0.05 : undefined,
    textureAxis: spec.textureAxis, textureWrap: spec.textureWrap, micro: cast ? 0.12 : finish === "polished" ? 0.015 : 0.025, brush: finish === "brushed" ? 1 : 0,
  });
}

function makePlastic(spec: MaterialSpec): THREE.Material {
  const finish = spec.finish ?? "satin";
  const rough = spec.roughness ?? ({ gloss: 0.14, polished: 0.1, satin: 0.42, matte: 0.72 } as Record<string, number>)[finish] ?? 0.42;
  const mat = new THREE.MeshPhysicalMaterial({
    color: lin(spec.color ?? "#2f6f4f"),
    metalness: spec.metalness ?? 0.0,
    roughness: rough,
    clearcoat: finish === "gloss" ? 0.35 : 0,
    clearcoatRoughness: 0.08,
    sheen: finish === "matte" ? 0.25 : 0,
    sheenRoughness: 0.7,
    side: THREE.DoubleSide,
  });
  return withSurface(mat, { texture: spec.texture, textureScale: spec.textureScale, textureAxis: spec.textureAxis, textureWrap: spec.textureWrap, micro: 0.04 });
}

function makePainted(spec: MaterialSpec): THREE.Material {
  // a satin base under a glossy clear coat: the two highlights are what reads as paint
  const mat = new THREE.MeshPhysicalMaterial({
    color: lin(spec.color ?? "#2f343c"), metalness: 0, roughness: spec.roughness ?? 0.5,
    clearcoat: spec.finish === "matte" ? 0.15 : 0.8, clearcoatRoughness: spec.finish === "matte" ? 0.5 : 0.1,
    side: THREE.DoubleSide,
  });
  return withSurface(mat, { texture: spec.texture, textureScale: spec.textureScale, textureAxis: spec.textureAxis, textureWrap: spec.textureWrap, micro: 0.04 });
}

function makeRubber(spec: MaterialSpec): THREE.Material {
  // rubber: a dark, rough, low-specular body with a soft sheen at grazing angles
  // (the velvety rim you see on a tyre or a grip) and a fine moulded stipple
  const base = lin(spec.color ?? "#232427");
  const mat = new THREE.MeshPhysicalMaterial({
    color: base, metalness: 0, roughness: spec.roughness ?? 0.8,
    specularIntensity: 0.4, ior: 1.52,
    sheen: 1, sheenRoughness: 0.5, sheenColor: base.clone().multiplyScalar(2.2).addScalar(0.06),
    side: THREE.DoubleSide,
  });
  return withSurface(mat, { texture: spec.texture ?? "stipple", textureScale: spec.textureScale ?? (spec.texture && spec.texture !== "stipple" ? 2 : 0.35), textureDepth: !spec.texture || spec.texture === "stipple" ? 0.025 : undefined, textureAxis: spec.textureAxis, textureWrap: spec.textureWrap, micro: 0.08 });
}

function makePrinted(spec: MaterialSpec): THREE.Material {
  // an FDM print: the plastic plus its layer lines, stacked along the build direction
  const finish = spec.finish ?? "satin";
  const mat = new THREE.MeshPhysicalMaterial({
    color: lin(spec.color ?? "#e8e4dc"), metalness: 0,
    roughness: spec.roughness ?? ({ matte: 0.62, satin: 0.4, silk: 0.22 } as Record<string, number>)[finish] ?? 0.4,
    sheen: finish === "silk" ? 0.6 : 0.15, sheenRoughness: 0.35, sheenColor: new THREE.Color(1, 1, 1),
    side: THREE.DoubleSide,
  });
  return withSurface(mat, { texture: spec.texture, textureScale: spec.textureScale, textureAxis: spec.textureAxis, textureWrap: spec.textureWrap, micro: 0.04, layer: spec.layerHeight ?? 0.2, layerAxis: spec.printAxis });
}

// ---- paper ---------------------------------------------------------------------
// Matte, fibrous and a little translucent, and (origami paper) coloured on one
// side only: `color` on the front of a surface (the sheet's top), `backColor` on
// its back. The texture lives in the paper's own flat coordinates (the mesh's
// sheetUV attribute: x, y in mm and 1, set for paper folded in steps) so the
// fibres travel with every facet as it folds; anything else falls back to the
// body's coordinates, projected along its dominant normal axis. Three scales,
// each faded out before it's finer than a couple of pixels (no moire at any
// zoom): formation (the cloudy look of paper against the light, ~1 cm), fibre
// flecks (~1 mm) and fibres (a fraction of a mm, seen only up close). Light
// from behind shows through, tinted by both sides' colours.
const PAPER_GLSL = /* glsl */`
uniform vec3 uFront; uniform vec3 uBack; uniform float uFibre; uniform float uTrans;
varying vec3 vSheet; varying vec3 vPLPos; varying vec3 vPLN;
struct Paper { float tone; float h; };
vec2 paperCoord(){
  if (vSheet.z > 0.5) return vSheet.xy;
  vec3 a = abs(vPLN);
  return a.z >= a.x && a.z >= a.y ? vPLPos.xy : a.y >= a.x ? vPLPos.xz : vPLPos.yz;
}
// fibres: noise stretched along a direction (they lie every which way, so three directions overlaid)
float fibres(vec2 q, float ang, float seed){
  vec2 d = vec2(cos(ang), sin(ang));
  vec2 r = vec2(dot(q, d), dot(q, vec2(-d.y, d.x)));
  return snoise(vec3(r.x * 0.9, r.y * 7.0, seed));
}
Paper paperField(vec2 q){
  float px = length(fwidth(q));                         // mm per pixel
  float form = fbm(vec3(q * 0.09, 3.7));                 // formation: soft clouds
  float fleckAA = 1.0 - smoothstep(0.25, 0.7, px);
  float fleck = snoise(vec3(q * 1.3, 11.0)) * fleckAA;
  float fibreAA = 1.0 - smoothstep(0.04, 0.16, px);
  float f = (fibres(q, 0.3, 1.0) + fibres(q, 2.2, 5.0) + fibres(q, 4.1, 9.0)) / 3.0;
  float fib = smoothstep(0.25, 0.75, f * 0.5 + 0.5) * fibreAA;
  Paper P;
  P.tone = 1.0 + uFibre * (0.06 * form + 0.04 * fleck + 0.12 * (fib - 0.25));
  // the relief: the fibre flecks and fibres up close, and a gentle cockle at the formation's scale (paper is never
  // quite flat), so light breaks up a little across a face; each term fades before it's finer than the pixels
  float cockle = snoise(vec3(q * 0.045, 7.3)) * (1.0 - smoothstep(2.0, 6.0, px));
  P.h = uFibre * (0.006 * fleck + 0.01 * fib + 0.035 * cockle);
  return P;
}`;

function makePaper(spec: MaterialSpec): THREE.Material {
  const front = lin(spec.color ?? "#f2efe8");
  const back = spec.backColor ? lin(spec.backColor) : front.clone();
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: spec.roughness ?? 0.88,
    specularIntensity: 0.35, sheen: 0.35, sheenRoughness: 0.8, sheenColor: new THREE.Color(1, 1, 1),
    polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: 2, // a hair back: its own crease lines draw over it, not into it (the layer above still hides them)
    side: THREE.DoubleSide,
  });
  const uniforms = {
    uFront: { value: front }, uBack: { value: back },
    uFibre: { value: 1 }, uTrans: { value: 0.22 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 sheetUV; varying vec3 vSheet; varying vec3 vPLPos; varying vec3 vPLN;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSheet = sheetUV; vPLPos = transformed; vPLN = objectNormal;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + NOISE_GLSL + "\n" + PAPER_GLSL + "\nPaper gPaper; vec3 gOther;")
      .replace("#include <map_fragment>", /* glsl */`
        #include <map_fragment>
        gPaper = paperField(paperCoord());
        diffuseColor.rgb *= (gl_FrontFacing ? uFront : uBack) * gPaper.tone;
        gOther = gl_FrontFacing ? uBack : uFront;
      `)
      .replace("#include <normal_fragment_maps>", /* glsl */`
        #include <normal_fragment_maps>
        {
          vec3 pos = -vViewPosition;
          vec3 dpx = dFdx(pos), dpy = dFdy(pos);
          float dhx = dFdx(gPaper.h), dhy = dFdy(gPaper.h);
          vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
          float det = dot(dpx, r1);
          normal = normalize(abs(det) * normal - sign(det) * (dhx * r1 + dhy * r2));
        }
      `)
      .replace("#include <lights_fragment_maps>", /* glsl */`
        #include <lights_fragment_maps>
        {
          // light through the sheet: what falls on its other side, through both sides' colour
          vec3 through = vec3(0.0);
          #ifdef USE_ENVMAP
            through += getIBLIrradiance(-geometryNormal);
          #endif
          #if NUM_DIR_LIGHTS > 0
            for (int i = 0; i < NUM_DIR_LIGHTS; i++) through += directionalLights[i].color * max(dot(-geometryNormal, directionalLights[i].direction), 0.0);
          #endif
          reflectedLight.indirectDiffuse += uTrans * through * BRDF_Lambert(diffuseColor.rgb * gOther);
        }
      `);
  };
  mat.customProgramCacheKey = () => "paper";
  mat.userData.paperUniforms = uniforms;
  return mat;
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

/** The render spec of a document material: its appearance fields, nothing else. */
export function materialSpec(m: MaterialSpec & { name?: string }): MaterialSpec {
  const out: MaterialSpec = { kind: m.kind };
  for (const k of ["species", "finish", "color", "backColor", "roughness", "metalness", "ringScale", "grainContrast", "poreStrength", "texture", "textureScale", "textureAxis", "textureWrap", "layerHeight", "printAxis"] as const) {
    if (m[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = m[k];
  }
  return out;
}

/** Build a three.js material for a spec (+ per-body wood frame). */
export function createMaterial(spec: MaterialSpec, frame?: WoodFrame): THREE.Material {
  switch (spec.kind) {
    case "wood": return makeWood(spec, frame);
    case "metal": return makeMetal(spec);
    case "plastic": return makePlastic(spec);
    case "painted": return makePainted(spec);
    case "rubber": return makeRubber(spec);
    case "printed": return makePrinted(spec);
    case "paper": return makePaper(spec);
    default: return makePlastic(spec);
  }
}

/**
 * Texture coordinates that wrap a pattern round a part (a grip, a knob, a
 * collar) — the `aWrap` attribute a wrapped texture reads, four per vertex:
 * (cos, sin) of the vertex's place round the part as an angle, its distance
 * along the part's axis (mm), and the part's mean girth (mm).
 *
 * The axis is the vertices' principal direction. The part is cut into slabs
 * along it; round each slab's centre the outline is traced (the farthest vertex
 * in each direction, so a bore inside doesn't count) and measured, and a vertex's
 * place round the part is its share of the outline's ARC LENGTH, not its angle —
 * so cells keep their size over a flattened or winged section (a palm wing) as
 * well as a round one. Slabs blend into their neighbours, so the mapping is
 * smooth along the part; given as an angle, it closes on itself. With the
 * vertex normals, the angle's (cos, sin) is shortened where the surface faces
 * along the axis (an end face), and the pattern fades out there rather than
 * crowd into a starburst.
 */
export function wrapCoords(positions: ArrayLike<number>, normals?: ArrayLike<number>): Float32Array {
  const nv = Math.floor(positions.length / 3);
  const out = new Float32Array(nv * 4);
  if (!nv) return out;
  // ---- principal axis (power iteration on the covariance)
  const c = [0, 0, 0];
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) c[k] += positions[3 * i + k] / nv;
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < nv; i++) {
    const d = [positions[3 * i] - c[0], positions[3 * i + 1] - c[1], positions[3 * i + 2] - c[2]];
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) C[3 * r + q] += d[r] * d[q];
  }
  let a = [1, 0.31, 0.17];
  for (let it = 0; it < 60; it++) {
    const b = [0, 1, 2].map((r) => C[3 * r] * a[0] + C[3 * r + 1] * a[1] + C[3 * r + 2] * a[2]);
    const m = Math.hypot(b[0], b[1], b[2]) || 1;
    a = b.map((x) => x / m);
  }
  const ref = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let e1 = [ref[1] * a[2] - ref[2] * a[1], ref[2] * a[0] - ref[0] * a[2], ref[0] * a[1] - ref[1] * a[0]];
  const m1 = Math.hypot(e1[0], e1[1], e1[2]) || 1; e1 = e1.map((x) => x / m1);
  const e2 = [a[1] * e1[2] - a[2] * e1[1], a[2] * e1[0] - a[0] * e1[2], a[0] * e1[1] - a[1] * e1[0]];
  // ---- each vertex in the axis frame: s along, (x, y) across
  const S = new Float64Array(nv), X = new Float64Array(nv), Y = new Float64Array(nv);
  let s0 = Infinity, s1 = -Infinity;
  for (let i = 0; i < nv; i++) {
    const d = [positions[3 * i] - c[0], positions[3 * i + 1] - c[1], positions[3 * i + 2] - c[2]];
    S[i] = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
    X[i] = d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2];
    Y[i] = d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2];
    s0 = Math.min(s0, S[i]); s1 = Math.max(s1, S[i]);
  }
  const span = Math.max(1e-6, s1 - s0);
  const K = Math.max(1, Math.min(64, Math.round(span / 3)));        // slabs ~3 mm thick
  const slab = (s: number) => Math.min(K - 1, Math.max(0, ((s - s0) / span) * K - 0.5)); // fractional slab index (slab centres at k + 0.5)
  // ---- slab centres: the middle of each slab's extent across, smoothed along
  const lo = Array.from({ length: K }, () => [Infinity, Infinity]), hi = Array.from({ length: K }, () => [-Infinity, -Infinity]);
  for (let i = 0; i < nv; i++) {
    const k = Math.min(K - 1, Math.floor(((S[i] - s0) / span) * K));
    lo[k][0] = Math.min(lo[k][0], X[i]); lo[k][1] = Math.min(lo[k][1], Y[i]);
    hi[k][0] = Math.max(hi[k][0], X[i]); hi[k][1] = Math.max(hi[k][1], Y[i]);
  }
  let cen = lo.map((l, k) => (Number.isFinite(l[0]) ? [(l[0] + hi[k][0]) / 2, (l[1] + hi[k][1]) / 2] : null));
  const known = cen.map((v, k) => (v ? k : -1)).filter((k) => k >= 0);
  cen = cen.map((v, k) => {
    if (v) return v;
    const before = known.filter((j) => j < k).pop(), after = known.find((j) => j > k);
    if (before === undefined) return cen[after!]!; if (after === undefined) return cen[before]!;
    const f = (k - before) / (after - before);
    return [cen[before]![0] * (1 - f) + cen[after]![0] * f, cen[before]![1] * (1 - f) + cen[after]![1] * f];
  });
  for (let pass = 0; pass < 3; pass++) cen = cen.map((v, k) => [0, 1].map((j) => (cen[Math.max(0, k - 1)]![j] + 2 * v![j] + cen[Math.min(K - 1, k + 1)]![j]) / 4));
  // ---- per slab: the outline's radius in M directions, and its arc length to each
  const M = 64;
  const rad = Array.from({ length: K }, () => new Float64Array(M).fill(-1));
  const binOf = (x: number, y: number) => { const t = (Math.atan2(y, x) + Math.PI) / (2 * Math.PI); return Math.min(M - 1, Math.floor(t * M)); };
  // every slab within REACH of a vertex hears of it (a mesher's long triangles leave thin slabs
  // empty); only the outside counts — a vertex facing in (a bore) doesn't
  const thick = span / K, reach = Math.max(1, Math.ceil(6 / thick));
  const nAt = (i: number, x: number, y: number) => {
    if (!normals || normals.length !== positions.length) return 1;
    const nx = normals[3 * i] * e1[0] + normals[3 * i + 1] * e1[1] + normals[3 * i + 2] * e1[2];
    const ny = normals[3 * i] * e2[0] + normals[3 * i + 1] * e2[1] + normals[3 * i + 2] * e2[2];
    return nx * x + ny * y;
  };
  for (let i = 0; i < nv; i++) {
    const k0 = Math.round(slab(S[i]));
    for (let k = Math.max(0, k0 - reach); k <= Math.min(K - 1, k0 + reach); k++) {
      const x = X[i] - cen[k]![0], y = Y[i] - cen[k]![1];
      if (nAt(i, x, y) < 0) continue;
      const b = binOf(x, y), r = Math.hypot(x, y);
      if (r > rad[k][b]) rad[k][b] = r;
    }
  }
  const cum = rad.map((r) => {
    // fill directions no vertex fell in from their neighbours (round the circle)
    const have = [...r.keys()].filter((j) => r[j] >= 0);
    if (!have.length) r.fill(1);
    else for (let j = 0; j < M; j++) if (r[j] < 0) {
      const prev = have.filter((h) => h < j).pop() ?? have[have.length - 1] - M, next = have.find((h) => h > j) ?? have[0] + M;
      const f = (j - prev) / (next - prev);
      r[j] = r[(prev + M) % M] * (1 - f) + r[next % M] * f;
    }
    // smoothed round the outline (a binned maximum is ragged)
    for (let pass = 0; pass < 3; pass++) { const c = Float64Array.from(r); for (let j = 0; j < M; j++) r[j] = (c[(j + M - 1) % M] + 2 * c[j] + c[(j + 1) % M]) / 4; }
    const L = new Float64Array(M + 1), dth = (2 * Math.PI) / M;
    for (let j = 0; j < M; j++) { const ra = r[j], rb = r[(j + 1) % M]; L[j + 1] = L[j] + Math.hypot(((ra + rb) / 2) * dth, rb - ra); }
    return L;
  });
  const girth = cum.reduce((acc, L) => acc + L[M], 0) / K;
  // the share of the outline's length up to angle θ (bin centres at j + 0.5)
  const share = (k: number, th: number) => {
    const L = cum[k], t = ((th + Math.PI) / (2 * Math.PI)) * M - 0.5;
    const j = Math.floor(t), f = t - j;
    const at = (q: number) => (q < 0 ? L[q + M] - L[M] : q > M ? L[q - M] + L[M] : L[q]);
    // arc length at a bin centre = halfway into that bin's step
    const mid = (q: number) => (at(q) + at(q + 1)) / 2;
    return (mid(j) * (1 - f) + mid(j + 1) * f) / L[M];
  };
  for (let i = 0; i < nv; i++) {
    const kf = slab(S[i]), k0 = Math.floor(kf), k1 = Math.min(K - 1, k0 + 1), f = kf - k0;
    const cx = cen[k0]![0] * (1 - f) + cen[k1]![0] * f, cy = cen[k0]![1] * (1 - f) + cen[k1]![1] * f;
    const th = Math.atan2(Y[i] - cy, X[i] - cx);
    const u = share(k0, th) * (1 - f) + share(k1, th) * f;
    let k = 1;
    if (normals && normals.length === positions.length) {
      const along = Math.abs(normals[3 * i] * a[0] + normals[3 * i + 1] * a[1] + normals[3 * i + 2] * a[2]) / (Math.hypot(normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]) || 1);
      const t = Math.min(1, Math.max(0, (along - 0.55) / 0.3));
      k = 1 - t * t * (3 - 2 * t);
    }
    out[4 * i] = k * Math.cos(2 * Math.PI * u); out[4 * i + 1] = k * Math.sin(2 * Math.PI * u);
    out[4 * i + 2] = S[i]; out[4 * i + 3] = girth;
  }
  return out;
}
