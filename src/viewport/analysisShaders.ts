// The analysis shaders (zebra, draft, curvature colours) in one place, used by
// SceneManager.analysisMaterial for the whole view and by LensPass for the
// masked second pass. Each fragment shader takes an optional mask: the GLSL
// declarations to add and the statement that discards fragments outside the
// lens. The legend swatches (--k-an-* in kit.css) mirror the colours here.

export interface ShaderMask {
  /** Declarations (uniforms, the mask function) pasted before main(). */
  pars: string;
  /** The statement run first in main() (e.g. "lensMask();"). */
  call: string;
}

export const NO_MASK: ShaderMask = { pars: "", call: "" };

/** World position and normal; gl_Position computed as three's built-in materials do, so a second pass lands on the same depth. */
export const WORLD_VERT = `
  varying vec3 vN; varying vec3 vW;
  #include <clipping_planes_pars_vertex>
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }`;

/** As WORLD_VERT, plus the vertex colour (curvature). */
export const COLOR_VERT = `
  varying vec3 vN; varying vec3 vW; varying vec3 vC;
  #include <clipping_planes_pars_vertex>
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); vC = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }`;

/** Reflected environment stripes: they break at a crease (G0), kink at a tangent-only seam (G1) and flow through a G2 one. */
export const zebraFrag = (m: ShaderMask = NO_MASK) => `
  uniform float stripes; varying vec3 vN; varying vec3 vW;
  #include <clipping_planes_pars_fragment>
  ${m.pars}
  void main() {
    #include <clipping_planes_fragment>
    ${m.call}
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(cameraPosition - vW);
    vec3 R = reflect(-V, N);
    float t = fract(atan(R.y, R.x) / 6.2831853 * stripes + R.z * stripes * 0.5);
    float band = smoothstep(0.47, 0.5, t) - smoothstep(0.97, 1.0, t);
    float shade = 0.35 + 0.65 * abs(dot(N, V));
    gl_FragColor = vec4(vec3(mix(0.05, 1.0, band)) * shade, 1.0);
  }`;

/** Draft colours (--k-an-draft-ok / --k-an-draft-steep / --k-an-undercut), as the shader's vec3 literals. */
export const DRAFT_RGB = { ok: "vec3(0.27, 0.78, 0.38)", undercut: "vec3(0.86, 0.27, 0.25)", steep: "vec3(0.93, 0.78, 0.25)" };

/** Faces that draft out of the mould along the pull direction are green, undercuts red, walls steeper than the draft angle yellow. */
export const draftFrag = (m: ShaderMask = NO_MASK) => `
  uniform vec3 pull; uniform float draft; varying vec3 vN; varying vec3 vW;
  #include <clipping_planes_pars_fragment>
  ${m.pars}
  void main() {
    #include <clipping_planes_fragment>
    ${m.call}
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
    float d = dot(N, pull);
    vec3 c = d >= draft ? ${DRAFT_RGB.ok} : d <= -draft ? ${DRAFT_RGB.undercut} : ${DRAFT_RGB.steep};
    float shade = 0.45 + 0.55 * abs(dot(N, normalize(cameraPosition - vW)));
    gl_FragColor = vec4(c * shade, 1.0);
  }`;

/** Shaded vertex colours (the curvature map). */
export const curvatureFrag = (m: ShaderMask = NO_MASK) => `
  varying vec3 vN; varying vec3 vW; varying vec3 vC;
  #include <clipping_planes_pars_fragment>
  ${m.pars}
  void main() {
    #include <clipping_planes_fragment>
    ${m.call}
    vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
    float shade = 0.45 + 0.55 * abs(dot(N, normalize(cameraPosition - vW)));
    gl_FragColor = vec4(vC * shade, 1.0);
  }`;

export type CurvatureQuantity = "mean" | "gaussian" | "max" | "min";

/** Per-vertex curvature colours: blue concave, white flat, red convex, scaled to the 98th percentile
 *  so one sharp fillet doesn't wash out the rest. `curvature` holds (k1, k2) per vertex. */
export function curvatureColors(curvature: Float32Array, quantity: CurvatureQuantity): Float32Array {
  const n = curvature.length / 2;
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k1 = curvature[i * 2], k2 = curvature[i * 2 + 1];
    q[i] = quantity === "gaussian" ? k1 * k2 : quantity === "max" ? k1 : quantity === "min" ? k2 : (k1 + k2) / 2;
  }
  const sorted = Array.from(q, Math.abs).sort((x, y) => x - y);
  const range = Math.max(1e-9, sorted[Math.floor(0.98 * (sorted.length - 1))] ?? 0);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = Math.max(-1, Math.min(1, q[i] / range));
    const [r, g, b] = t >= 0 ? [1, 1 - t, 1 - t] : [1 + t, 1 + t, 1];
    colors.set([r, g, b], i * 3);
  }
  return colors;
}
