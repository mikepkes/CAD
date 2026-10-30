import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Layering gate: the pure core (document, commands, solver, kernel, sim, math)
// must stay free of the renderer, the UI, the app shell and the DOM, so it runs
// headless (tests, the stdio MCP server, a worker) and the renderer stays
// swappable. Each pure directory lists the directories it may import from; any
// other relative import, a banned package, or a DOM global fails CI.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** Pure layer → the src/ directories it may import. */
const ALLOWED: Record<string, string[]> = {
  math: ["math"],
  util: ["util"],
  geometry: ["geometry", "math"],
  sketch: ["sketch", "geometry", "math"],
  core: ["core", "sim", "sketch", "geometry", "math", "util"],
  sim: ["sim", "core", "sketch", "geometry", "math", "util"],
};

/** Packages that belong to the renderer, the UI or the app shell. */
const BANNED_PACKAGES = [/^three(\/|$)/, /^react(-dom)?(\/|$)/, /^zustand(\/|$)/, /^@tauri-apps\//, /^@anthropic-ai\//, /^@modelcontextprotocol\//, /^mp4-muxer$/];

/** Browser globals the core must not touch (type-only uses are fine). */
const DOM_GLOBALS = /\b(window|document|navigator|localStorage|sessionStorage|requestAnimationFrame|HTMLElement|HTMLCanvasElement|WebGLRenderingContext)\s*[.(]/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

/** Source with comments and string/template contents blanked, so prose can't trip the DOM check. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}

function importsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

describe("layering", () => {
  const violations: string[] = [];
  for (const [layer, allowed] of Object.entries(ALLOWED)) {
    for (const file of files(join(SRC, layer))) {
      const rel = relative(ROOT, file);
      const src = readFileSync(file, "utf8");
      for (const spec of importsOf(src)) {
        if (spec.startsWith(".")) {
          const target = relative(SRC, resolve(dirname(file), spec)).split(/[\\/]/)[0];
          if (!allowed.includes(target)) violations.push(`${rel}: imports src/${target} ("${spec}") — ${layer} may only import ${allowed.join(", ")}`);
        } else if (BANNED_PACKAGES.some((re) => re.test(spec))) {
          violations.push(`${rel}: imports "${spec}" — renderer/UI/app packages stay out of the pure layers`);
        }
      }
      const code = codeOnly(src).split("\n");
      code.forEach((line, i) => {
        if (/^\s*import\s+type\b/.test(line)) return;
        const m = line.match(DOM_GLOBALS);
        if (m) violations.push(`${rel}:${i + 1}: uses the DOM global "${m[1]}"`);
      });
    }
  }

  it("pure layers import only what they are allowed to, and never the DOM", () => {
    expect(violations).toEqual([]);
  });

  it("catches a violation (self-test)", () => {
    expect(importsOf(`import { Scene } from "three";\nconst x = await import("../ui/App");`)).toEqual(["three", "../ui/App"]);
    expect(DOM_GLOBALS.test(codeOnly(`const w = window.innerWidth; // window.x`))).toBe(true);
    expect(DOM_GLOBALS.test(codeOnly(`// window.innerWidth\nconst s = "document.title";`))).toBe(false);
  });
});
