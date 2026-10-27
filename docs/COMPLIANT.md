# Compliant mechanisms — what we need

Goal: model parts that move by **bending** (living hinges, flexure pivots, snap
fits, compliant grippers, bistable switches) and **compute their motion**: given
an input (push this point 3 mm, turn this lever 20°, apply 5 N), solve the
equilibrium pose, the force it takes, and whether the material survives it.
Everything stays command-driven, parametric and runnable in the examples harness.

## Where we are

Everything that moves today is rigid and kinematic:

| Area | Today | A compliant mechanism needs |
|---|---|---|
| Materials (`Material`) | visual only: colour, finish, wood grain | stiffness E, Poisson ν, density, allowable strain, **print anisotropy** (XY vs Z) |
| Joints (`Joint`) | ideal rigid / revolute / slider / pin-slot; the value comes from an expression | a joint whose value is **solved from equilibrium** (flexure = joint + spring), with a stiffness derived from geometry |
| Motion | a parameter poses rigid components (FK; the pin-slot root-solve is the only solved joint) | quasi-static equilibrium: inputs → poses + reaction forces |
| Motion study | sweeps revolute drives, fails on volume overlap | also fails on **strain > allowable**, reports **force–displacement** |
| Rendering | per-component rigid transforms (transform-driven animation) | deformed flexure meshes, still without an OCC rebuild per frame |

The pin-slot joint is the precedent to build on: its angle is not given, it is
*solved* in `resolveComponentWorld`. A compliant mechanism generalises that from
"solve one angle so a pin stays in a slot" to "solve every flexure so the
mechanism is in equilibrium".

## The pieces

### 1. Mechanical materials
Add `mechanical?: { E, nu, density, allowableStrain, Ez?, allowableStrainZ? }`
to `Material`, with presets carrying datasheet numbers. Example — Bambu **TPU for
AMS** (68D) technical data sheet: E = 1190 MPa (XY) / **600 MPa (Z)**, tensile
strength 22.4 / **11.2 MPa**, elongation at break > 650 % / **31 %**. The Z
numbers are what a flexure printed upright sees, so a body also needs its **build
direction** (default: sketch-plane normal of its base feature, overridable).
TPU is hyperelastic; linear E is right for small strain and an upper bound on
force at large strain. A tabulated stress–strain curve is the later upgrade.

### 2. Declaring flexures
Two ways in, both commands:
- **`joint.create { kind: "flexure" }`** between two components, with the beam
  section (length, width, thickness) — explicit, cheap, PRBM-ready.
- **Flexure from geometry**: pick a slender region of a body (or a sketch
  centerline + section); the section is measured from the B-rep. Needed so a
  one-piece printed part (living hinge, the star box tongue) is analysable.

### 3. A solver ladder (each rung reuses the one below)
1. **Pseudo-rigid-body model (PRBM)** — each flexure becomes a revolute joint at
   its characteristic pivot (γ ≈ 0.85 of the length from the tip for an end-loaded
   cantilever) with a torsional spring k = γ·K_Θ·EI/L (K_Θ ≈ 2.65); a short
   flexural pivot is a pin at its centre with k = EI/L. Equilibrium = minimise
   Σ ½k(θ−θ₀)² − W_ext over the joint graph, with loop closures as constraints.
   Tens of DOF → interactive on a slider. Accurate to a few % for the cases the
   constants were fitted for; wrong for distributed or buckling-dominated flexures.
2. **Geometrically nonlinear beams** — *prototype in this branch*
   (`src/sim/beam2d.ts`): each flexure is discretised along its centreline into
   co-rotational beam elements; Newton + load stepping follow large rotations.
   Handles distributed compliance, any load direction, displacement or force
   control, reactions, peak strain. Validated (`test/beam2d.test.ts`) against
   small-deflection theory, an exact circular arc under a pure moment, an
   independent RK4 elastica at PL²/EI = 1, 3, 10 (within 0.2 % of L) and Bisshopp
   & Drucker's δ/L = 0.3017. Next: 3D elements (torsion), coupling to rigid
   components through connectors, and **arc-length continuation** for snap-through
   (bistable mechanisms have a falling force curve that load stepping can't cross).
3. **Contact** — snap fits and stops are contact-driven: node-to-surface penalty
   contact between flexure nodes and rigid B-rep faces (the barb sliding over the
   lip), with friction μ. Turns "push the lid on" into a computed insertion force.
4. **Solid FE** (later, offline in a worker) — tetrahedralise from the OCC
   tessellation, neo-Hookean material, contact. For stress concentrations at
   roots and for flexures that aren't beam-like (the star box's female wall is a
   plate whose free top edge also bends). The ladder's lower rungs stay the
   interactive path; this is the check.

### 4. Inputs and studies
- **Drives**: a displacement or force at a connector, or a parameter (reuses the
  parameter-driven pose pipeline: the drive parameter is what the slider moves).
- **Study outputs**: pose per sample, force–displacement curve, peak strain per
  flexure vs allowable, stored energy (shows bistability), collisions of the
  deformed geometry.
- **Motion study / customize**: pass/fail grows from "no overlap" to "no overlap,
  strain under allowable, force under a limit", with a badge such as
  *max strain 2.7 % (limit 5 %) · closing force 70 N*.

### 5. Rendering the deformed shape
Keep the transform-driven animation: rigid components keep their per-frame
matrices; a flexure body's mesh is **skinned** to the beam solution (each vertex
bound once to an arc position s and a section offset; per frame,
`p = x(s) + R(s)·offset`). No OCC rebuild per frame, so turntables and recorded
motions stay at 60 fps. Collision checks against deformed geometry use these
meshes (mesh–mesh), not B-rep booleans.

### 6. Tests
Every compliant example joins the examples harness with a golden
force–displacement curve and peak strain, so a solver change that moves a curve
shows up in review. The validation suite grows with each rung: PRBM vs elastica,
the parallel-guide stiffness, snap-fit insertion force vs the classic
W = P(μ + tan α)/(1 − μ·tan α), a bistable switch's snap-through force.

## Worked example — the star box snap tongue

Each tongue is a 6 × 2 mm cantilever, free from its root at z = 13.4 mm to the
barb band at z ≈ 18.3 mm (L ≈ 4.9 mm). Closing the box pushes the barb 0.85 mm
past the mating lip. It stands upright, so it bends **across the print layers**
(E_Z = 600 MPa). The beam solver (pinned in `test/beam2d.test.ts`), with the
insertion force from the 30° lead-in ramp:

| Tongue | Force to deflect | Peak strain | Linear stress | Insertion force / snap (μ 0.3–0.6) |
|---|---|---|---|---|
| as printed (L 4.9, t 2) | 54 N | **10.8 %** | 65 MPa vs 11.2 MPa Z strength | 57–98 N (×10 snaps at once) |
| L 9.8, t 2 | 6.6 N | 2.7 % | 16 MPa | 7–12 N |
| L 9.8, t 1.4 | 2.2 N | 1.9 % | 11 MPa | 2–4 N |
| **v2 as built**: free from z = 4 (L 14.3), 7 wide, curved back 3.44 → 2.43 | 8.5 N | **1.5 %** | 9 MPa | 9–16 N |

The v1 tongue did break at the root soon after printing. v2 (the current
example) roots the tongue just above the floor behind a 0.6 mm relief slot with
a rounded end (v1's 0.25 mm slot was narrower than a 0.4 mm nozzle line and
ended in a notch on one layer line), and tapers it along a curved back so the
section — and the strain — changes from layer to layer. Root bending strength
(w·t²) is 3.4× v1's while the snap strain is 7× lower.

This is an upper bound: it is linear-elastic (TPU softens at large strain) and
assigns the whole deflection to the tongue (the mating wall's free top edge bows
outward and takes a share — rung 4, or a plate model). Even so, a model that is
off by this much flags the design: the roots are likely to crack along the layers
or the box to be very stiff to close. Lengthening the tongue's free span (detach
it from the wall lower down) is the cheapest fix; strain falls with 1/L².

### Sized per print material

The star box's `material` choice resizes the snap for what it is printed in
(`MATERIALS` in `test/starbox.model.ts`, checked by
`test/starbox.materials.test.ts`). The tongue bends across the layers, so each
material gets its across-layer modulus and a design strain limit. The tongue is
then sized so it stays at or under that limit, while the box closes and pulls
open with about the force of the TPU 68D box that works (~13 N in, ~26 N out per
snap; μ per material):

- **Thickness and deflection:** stiff plastics get a thinner tongue. Its
  deflection fills what the strain limit allows (at most 1.5 mm, which leaves
  0.8 mm of wall behind the pocket).
- **Lead-in angle:** slippier materials get a slightly steeper lead-in, so
  closing takes the same force.
- **Retention face:** stays at 45°, the steepest overhang that prints without
  support.
- **Height:** the deflection scales with the tongue's free span², so the strain
  holds at every box height. Once deflection reaches its 1.5 mm cap (at 40 mm),
  tall boxes hold with less force.

| At height 28 | E_Z (MPa) | limit | tongue root → tip (mm) | deflection (mm) | clearance | lead-in | strain | close / open per snap |
|---|---|---|---|---|---|---|---|---|
| PLA | 2500 | 1 % | 2.5 → 1.75 | 0.75 | 0.2 | 27° | 0.97 % | 12 / 25 N |
| PETG | 1600 | 2 % | 2.35 → 1.6 | 1.1 | 0.25 | 27° | 1.49 % | 12 / 25 N |
| ABS / ASA | 1800 | 1.5 % | 2.5 → 1.7 | 1.0 | 0.3 | 26° | 1.44 % | 13 / 25 N |
| Nylon | 900 | 3 % | 3.0 → 2.05 | 1.2 | 0.25 | 26° | 2.21 % | 13 / 25 N |
| TPU 68D (as printed) | 600 | 1.5 % | 3.5 → 2.4 | 0.85 | 0.25 | 30° | 1.50 % | 13 / 26 N |
| TPU 95A | 26 | 6 % | 4.9 → 3.4 | 1.4 | 0.3 | 30° | 4.18 % | 4 / 9 N |

- **PETG:** reaches the thinnest printable tongue (1.6 mm at the barb) before
  its strain limit, so its deflection is set by force instead.
- **TPU 95A:** too soft to push hard at any size that fits. It holds by its
  grip, at about a third of the force.
- **Material values:** typical FDM values; tune them to your filament.

## Proposed phases
1. **Materials + PRBM flexure joint.** *Largely done* (see below). Remaining:
   print anisotropy (Z properties + build direction) and force-driven
   equilibrium (apply a load, solve the pose) rather than displacement-driven.
2. **Beam flexures in assemblies.** Promote `beam2d` to 3D, couple to rigid
   components via connectors, flexure-from-geometry, skinned rendering,
   force–displacement plots, golden curves in the harness.
3. **Contact and snap-through.** Penalty contact with friction; arc-length
   continuation. Examples: the star box snaps (computed closing force), a
   bistable switch.
4. **Solid FE check** for roots, plates and non-beam flexures.

## Built so far: flexure joints, closed loops, the compliant four-bar

- **Mechanical materials.** `material.create` takes `youngsModulus` (MPa) and
  `allowableStrain`; they live on `Material.mechanical`.
- **Flexure joints.** `joint.create { kind: "flexure", flexure: {length, width,
  thickness} }` moves like a revolute and is modelled as a small-length
  flexural pivot (`src/sim/flexure.ts`): k = E·I/L, ε = t·φ/2L — matched exactly
  by the beam solver under a pure moment (`test/flexure.test.ts`).
- **Closed loops.** Any joint can be `solve: true` (its value is found) and a
  joint with `closes: true` closes a loop by making its two connectors meet
  (`resolveComponentWorld` → `closeLoops`: damped Gauss–Newton seeded from the
  last solution, so a mechanism stays on its assembly branch). Checked against
  the analytic four-bar position solution; a pose that can't close is flagged.
- **Studies.** `flexureState` / `flexureSweep` read each hinge's rotation,
  strain vs allowable, stored energy, and the drive effort dU/d(drive) (the
  input torque). Exact on a parallelogram: torque = 4kθ.
- **Customize mode** shows a live hinge readout (strain bars against the
  limit, input torque, stored energy), and "Save / share for printing" exports a
  flexure model unbent and fused into one solid (`exportFusedBlob`).
- **Examples harness.** A model with flexures must close every loop and keep
  every hinge under its allowable strain across its drive range.
- **Example: `public/examples/fourbar.json`** (`test/fourbar.build.test.ts`).
  A one-piece TPU four-bar printed flat: crank 40, coupler 60.8, rocker 50,
  ground 60 mm, 4 × 1 mm hinge strips. ±20° at the finger pad swings the
  pointer 31.7°; at full push: 163 N·mm (≈ 4.5 N at the pad), peak strain 4.4%
  against 8%. Each hinge strip is split at its pivot between the two links it
  joins, so the rendered hinge kinks about its centre — the PRBM picture;
  skinned bending is phase 2.

## Open questions
- Which mechanisms matter first? Snap fits and living hinges point at phases 1 + 3;
  grippers and flexure stages at 1 + 2.
- Interactive vs accurate: is PRBM-level accuracy (a few %) good enough on the
  slider, with beams/FE as an explicit "check" button?
- Print orientation: infer the build direction per body, or make it explicit?
- Material data: do we need measured stress–strain curves for TPU (large-strain
  snap fits), or are datasheet moduli enough for now?
