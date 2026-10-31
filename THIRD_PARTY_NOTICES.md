# Third-party notices

Chisel CAD's own code is under the [MIT License](LICENSE). It is built on
third-party software under its own licenses. Every package a build ships, with
its license text, is listed in `THIRD_PARTY_LICENSES.txt`, which
`scripts/third-party-licenses.mjs` generates before each build and which ships
with the web app (at `/THIRD_PARTY_LICENSES.txt`) and inside the desktop app.

Almost all of it is under permissive licenses (MIT, Apache-2.0, BSD, ISC,
Zlib, Unicode-3.0, Unlicense). The exceptions are below.

## LGPL libraries

These two libraries are under the GNU Lesser General Public License. Chisel CAD
uses them unmodified, as separate WebAssembly modules loaded at run time, so you
can replace either with your own build of the same interface. The full license
text is in [licenses/LGPL-2.1.txt](licenses/LGPL-2.1.txt).

| Library | What Chisel uses it for | License | Source |
|---|---|---|---|
| OpenCASCADE Technology, packaged as `replicad-opencascadejs` (see `package-lock.json` for the version) | The solid-modelling kernel | LGPL-2.1-only, with the OCCT exception | https://github.com/Open-Cascade-SAS/OCCT, built for the web by https://github.com/sgenoud/replicad (`packages/replicad-opencascadejs`) |
| PlaneGCS, packaged as `@salusoft89/planegcs` | The sketch constraint solver (from FreeCAD) | LGPL-2.0-or-later | https://github.com/Salusoft89/planegcs, from https://github.com/FreeCAD/FreeCAD (`src/Mod/Sketcher/App/planegcs`) |

**Replacing them.** In the web build the modules are the `.wasm` files under
`assets/` next to the JavaScript that loads them; in the desktop app they are
the same files inside the app bundle's web assets. A rebuilt module with the
same exports can be dropped in under the same name, or swapped in by changing
the dependency in `package.json` and rebuilding.

## MPL-2.0 crates (desktop app only)

The desktop app's web view stack (Tauri) pulls in a few crates under the Mozilla
Public License 2.0: `cssparser`, `cssparser-macros`, `selectors`, `dtoa-short`
and `option-ext`. They are used unmodified; their source is on
https://crates.io under those names.
