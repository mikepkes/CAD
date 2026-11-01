// A procedural photo studio for image-based lighting. Metals are mirrors: what
// makes them read as metal is what they reflect. A flat grey room gives them
// nothing, so they look like grey plastic; a bare gradient looks synthetic.
// This is a believable room instead, the kind an HDR photo of a studio shows:
// a mottled concrete floor running to a dark horizon, walls with a tall window
// of cool daylight (mullions and a transom), a ceiling of rectangular light
// panels, and the photographer's lights: softboxes overhead with dark gaps
// between them, two tall strips, a warm rim and a bounce card. Curved and flat
// metal faces then pick up shaped light, dark falloff and a little structure,
// as in product photography. Built from geometry and one shader (no HDR
// files), so it works offline and in the desktop app. Tuned against brass,
// steel and bronze gears seen from above, where a dark sky turns flat faces black.
import * as THREE from "three";

/** The studio scene (Z up), for PMREMGenerator.fromScene. */
export function studioEnvironmentScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.SphereGeometry(60, 128, 64),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
        float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.1; a *= 0.5; } return s; }
        void main(){
          vec3 d = normalize(vDir);
          float el = asin(clamp(d.z, -1.0, 1.0)), az = atan(d.y, d.x);
          vec3 c;
          if (d.z < 0.0) {
            // floor: polished concrete, mottled, lighter close by (where the lights fall), darker toward the horizon
            vec2 fp = d.xy / max(-d.z, 0.05);
            float m = fbm(fp * 1.3) * 0.6 + fbm(fp * 7.0) * 0.4;
            c = vec3(0.13, 0.125, 0.12) * (0.75 + 0.5 * m) * mix(0.35, 1.0, smoothstep(0.02, 0.5, -d.z));
          } else if (el < 0.75) {
            // walls: dark grey, a little lighter up high, with a soft shadow along the floor line
            float m = fbm(vec2(az * 3.0, el * 6.0));
            c = vec3(0.07, 0.072, 0.078) * (0.85 + 0.3 * m) * (0.55 + 0.45 * smoothstep(0.0, 0.25, el));
            // a tall window of cool daylight, behind and to the left: four panes, a transom
            float wa = az + 2.2, wHalf = 0.42;
            if (abs(wa) < wHalf && el > 0.06 && el < 0.55) {
              float u = (wa + wHalf) / (2.0 * wHalf) * 4.0;
              float mull = step(0.05, abs(fract(u + 0.5) - 0.5));
              float tran = step(0.012, abs(el - 0.38));
              float sky = mix(1.9, 1.3, smoothstep(0.06, 0.55, el));
              c = mix(c, vec3(0.78, 0.86, 1.0) * sky, mull * tran);
            }
          } else {
            // ceiling: a grid of rectangular light panels in a dark grid
            vec2 cp = d.xy / d.z;
            vec2 cell = fract(cp * vec2(1.1, 1.6)) - 0.5;
            float lit = step(abs(cell.x), 0.34) * step(abs(cell.y), 0.3);
            c = mix(vec3(0.05, 0.05, 0.055), vec3(1.15, 1.13, 1.08), lit * smoothstep(0.75, 0.9, el));
          }
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  scene.add(room);

  const panel = (w: number, h: number, intensity: number, color: string, pos: [number, number, number]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.up.set(0, 0, 1);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  // the key: four softboxes overhead with dark gaps between them, so a flat metal face mirrors crisp light and dark
  for (const [x, y] of [[-12, -16], [12, -16], [-12, 6], [12, 6]]) panel(20, 18, 3.4, "#ffffff", [x, y, 36]);
  panel(7, 46, 7.0, "#f4f7ff", [-38, -12, 8]);    // strip, left: a crisp vertical highlight on curved edges
  panel(6, 40, 5.0, "#ffffff", [36, -6, 6]);      // strip, right
  panel(44, 8, 3.0, "#ffd9b0", [4, 40, 16]);      // warm rim, behind
  panel(16, 10, 0.9, "#ffffff", [8, -42, -4]);    // a white bounce card low in front, as a photographer would use
  return scene;
}
