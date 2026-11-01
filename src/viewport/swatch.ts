// Material swatches: each material rendered on a sphere, in the same studio and
// with the same shader the viewport uses, so the library shows what a part will
// look like. One small offscreen renderer, results cached per spec. Returns null
// where there is no WebGL (tests, very old browsers); the UI then draws a flat chip.
import * as THREE from "three";
import { createMaterial, MaterialSpec, wrapCoords } from "./material";
import { studioEnvironmentScene } from "./studioEnvironment";

let ctx: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; ball: THREE.Mesh } | null | undefined;
const cache = new Map<string, string>();

function setup() {
  if (ctx !== undefined) return ctx;
  try {
    const canvas = document.createElement("canvas");
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(studioEnvironmentScene(), 0.02).texture;
    pmrem.dispose();
    scene.add(new THREE.AmbientLight(0xffffff, 0.18));
    const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(1, -1, 2); scene.add(key);
    // a 12 mm ball, so textures and layer lines show at their real pitch
    const ball = new THREE.Mesh(new THREE.SphereGeometry(6, 96, 64));
    // a wrapped texture (a grip's pads) wraps round the ball's axis
    ball.geometry.setAttribute("aWrap", new THREE.BufferAttribute(wrapCoords(ball.geometry.getAttribute("position").array as Float32Array, ball.geometry.getAttribute("normal").array as Float32Array), 4));
    ball.rotation.x = Math.PI / 2;
    scene.add(ball);
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 200);
    camera.up.set(0, 0, 1);
    camera.position.set(9, -20, 9);
    camera.lookAt(0, 0, 0);
    ctx = { renderer, scene, camera, ball };
  } catch { ctx = null; }
  return ctx;
}

/** A PNG data URL of `spec` on a ball, `px` square; null without WebGL. */
export function materialSwatch(spec: MaterialSpec, px = 96): string | null {
  const key = `${px}:${JSON.stringify(spec)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = setup();
  if (!c) return null;
  // the ball is small on screen: thicken printed layers so the swatch still shows them
  const shown = spec.kind === "printed" ? { ...spec, layerHeight: Math.max(spec.layerHeight ?? 0.2, 0.5) } : spec;
  const mat = createMaterial(shown);
  c.ball.material = mat;
  c.renderer.setPixelRatio(1);
  c.renderer.setSize(px * 2, px * 2, false);
  c.renderer.setClearColor(0x000000, 0);
  c.renderer.render(c.scene, c.camera);
  const url = c.renderer.domElement.toDataURL("image/png");
  mat.dispose();
  cache.set(key, url);
  return url;
}
