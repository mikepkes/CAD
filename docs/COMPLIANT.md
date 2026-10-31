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
   print anisotropy (Z properties + build direction). Equilibrium: undriven
   axes settle at minimum energy (`planar` joints). Remaining: applying a load
   rather than a displacement as the drive.
2. **Beam flexures in assemblies.** *Started*: in-plane `beam` elements clamped
   between parts (see below). Remaining: 3D beams, flexure-from-geometry,
   rendering the solved shape (today a beam is drawn bent along the small-
   deflection shape), force–displacement plots, golden curves in the harness.
3. **Contact and snap-through.** Snap-through of beams under displacement
   control is done (the bistable switch). Remaining: penalty contact with
   friction (the star box snaps' computed closing force) and arc-length
   continuation (snap-through under a force).
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
  ground 60 mm, 4 × 1 mm hinge strips.
  - **Link-length sliders:** `crank` 30–45, `rocker` 45–65 and `ground`
    45–80 mm. The coupler follows from them, and joint pivots are expression
    connectors.
  - **Swing:** the pointer swings ~crank/rocker as far as the input, 18–40° for
    ±20° in.
  - **Why those ranges:** they keep the crank no longer than the shortest
    rocker, so no hinge turns more than ~21.5°. At every corner, in every
    material, the loop closes and the hinges stay within the strain limit. ±20° at the finger pad swings the
  pointer 31.7°; at full push: 163 N·mm (≈ 4.5 N at the pad), peak strain 4.4%
  against 8%. Each hinge strip is split at its pivot between the two links it
  joins, so the rendered hinge kinks about its centre — the PRBM picture;
  skinned bending is phase 2.
- **Its `material` choice** resizes the hinge strips for what it's printed in.
  The strip thickness and length are expressions (`flexure: { length: "hingeL",
  thickness: "hingeT" }`), and each link's material follows the choice:
  - **Sizing:** every hinge turns through the same ~20° whatever the material
    (the pivots fix the kinematics), and strain is ε = t·φ/2L. So each strip is
    sized to stay at ~80% of its material's limit.
  - **Stiff plastics:** get the thinnest strip that prints well (0.8 mm) and a
    longer one.
  - **Result:** hinge stiffness k = E·w·t³/12L stays within 2× of the TPU part's
    for every material but TPU 95A, which gets a thicker strip so it still
    springs back.

  | In the layer plane | E (MPa) | strain limit | strip t × L (mm) | k (N·mm/rad) | peak strain at ±20° | torque at +20° |
  |---|---|---|---|---|---|---|
  | PLA | 3000 | 2 % | 0.8 × 8.5 | 90 | 1.68 % | 99 N·mm |
  | PETG | 1900 | 3 % | 0.8 × 6 | 81 | 2.39 % | 89 N·mm |
  | ABS / ASA | 2000 | 2.5 % | 0.8 × 7 | 73 | 2.05 % | 80 N·mm |
  | Nylon | 1200 | 5 % | 1 × 4.5 | 133 | 3.98 % | 146 N·mm |
  | PP | 1000 | 10 % | 1 × 4 | 125 | 4.47 % | 137 N·mm |
  | TPU 68D (as designed) | 1190 | 8 % | 1 × 4 | 149 | 4.4 % | 163 N·mm |
  | TPU 95A | 26 | 15 % | 2.4 × 4 | 45 | 10.7 % | 49 N·mm |

  These are typical FDM values; tune them to your filament. PP is the classic
  living-hinge plastic. PLA hinges fatigue: expect hundreds of flexes, not
  thousands. The table lives in `test/flexure-materials.ts`, shared with the
  gripper.
- **Expression strips and pivots.** A flexure's `length` / `width` /
  `thickness` and any joint's connector points may be expressions in the
  parameters (`joint.create { flexure: { thickness: "hingeT" }, baseOrigin: { x:
  "ground", … } }`), so a mechanism's links and hinges follow its sliders.

## Built since: beam elements, rest positions, the bistable switch, the gripper

- **Beam elements.** `joint.create { kind: "beam", beam: { width, thickness,
  profile: "straight" | "cosine" } }` clamps a long strip from a point on
  `base` to a point on `moved`.
  - **It places nothing:** other joints place both parts. As they move, the
    strip is solved as a large-deflection beam (`beam2d`, clamped at the base,
    its far end driven to the moved part's displacement and rotation). The
    solve gives its energy, its peak strain and the force it pushes back with.
  - **Effort without differencing across a snap:** a study's drive effort for a
    beam is that end force times how far the end moves per unit of drive, not a
    difference of energy across a snap.
  - **Solves are reused:** solves are cached by the beam's shape relative to its
    base end, mirrored to point +X. Identical and mirror-image beams then share
    one solve.
  - **Bad branches are re-solved:** a solve that doesn't converge, or that
    lands on a non-physical branch past a snap (over 30% strain), is re-solved
    in finer steps.
  - **Checked against:** the fixed-guided beam F = 12EI·δ/L³ exactly, and the
    curved-beam bistable for slender arches (`test/beam-element.test.ts`).
- **Rest positions.** `flexureEquilibria(doc, param, min, max)` sweeps a drive
  and finds where the effort is zero. A rest position is stable where the
  effort rises through zero and unstable where it falls. The study also gives
  the push needed to snap between two stable states, and the energy barrier.
  - **In customize mode:** the readout shows "bistable: rests at … · snaps over
    at …", or "springs back to …" when there's one rest position, once the
    sliders have been still for a moment. It also reports an input force for a
    length drive and a torque for an angle.
- **Example: `public/examples/bistable.json`** (`test/bistable.build.test.ts`).
  A ring frame, a shuttle, and two parallel curved (cosine) beams clamped wall to
  wall through it: four `beam` elements. The drawn beams bend with the shuttle
  along the fixed-guided shape 3s² − 2s³. The frame is solved as well (see
  "Frame compliance" below).
  - **Published check:** against Qiu, Lang & Slocum, "A curved-beam bistable
    mechanism" (JMEMS 2004). Their figures are for slender arches. Checked on
    the double curved beam in `test/beam-element.test.ts`:

    | | Q = rise/thickness 15 | Q 3.75 | Paper |
    |---|---|---|---|
    | Second rest position | 1.99 h | 1.89 h | just short of 2h |
    | Snap force | 723 EIh/L³ per beam | 617 | ≈ 740 |
    | Pull-back | −358 | −257 | ≈ −370 |

    A stocky arch stretches more on its way over and tips into its lower
    (mode-3) shape sooner. The switch (Q 4, frame held rigid) snaps at 623 and
    pulls back at −269.
  - **Sized by material:** the snap strain goes as about 35·t·h/L², and the snap
    force as E·t³·h/L³. So for the chosen span and arch, each material gets the
    thickest beams that snap at 3/4 of its strain limit (capped at 4%, where the
    stroke runs out), but never under 0.6 mm. That gives 11.9 N to flip in
    TPU 68D and 5.9 N in PLA, against 2–4 N for the first, fixed-size version.
  - **Monostable case:** a flat arch (rise/thickness 1.5) only springs back, as
    theory says it should below ~2.3.
- **Example: `public/examples/gripper.json`** (`test/gripper.build.test.ts`).
  A normally-closed gripper: push the plunger, and both jaws open.
  - **Size:** 8 parts and 10 flexure hinges. The plunger rides a parallelogram
    guide, and a pushrod each side turns a jaw lever.
  - **The solve:** 3 closed loops with 6 unknowns, solved together at every
    pose.
  - **Results:** at the default size, the jaws open 6 → 43 mm for 5 mm of push.
    That's ×3.72 per tip, against a lever ratio of 3.57. The two sides differ by
    0.19 mm (the guide's arc), and the push force rises linearly to 21 N.
  - **Tested:** every material at both jaw lengths stays within its limit, and
    the part clears itself through the stroke.

## Built since: settling free axes, the XY stage

- **Planar joints with free axes.** `joint.create { kind: "planar", planar: {
  x?, y?, angle? } }` places a part in the base's plane.
  - **Driven and free axes:** an axis given an expression is driven by it. One
    left out is free and settles where the stored elastic energy (beams and
    flexures) is least: the part floats on its compliant supports.
  - **The solve:** Newton on the energy's gradient, damped so every step lowers
    the energy. Each beam's part of the gradient is exact (its end force times
    how its end moves with the axis), and the Hessian comes from differencing
    that gradient. It is seeded from the last settled pose.
  - **Architecture:** the compliance layer registers the settler with placement
    (`setEnergySettler`), so every placement in the app, studies and exports
    settles.
  - **Studies:** a study's probes hold the free axes where they settled. At a
    minimum the energy is flat along them, so the drive's effort is the partial
    derivative.
- **Checked on the blade parallelogram** (`test/settle.test.ts`), whose answers
  are exact in linear theory:
  - **Stiffness:** 24EI/L³.
  - **Drift:** 0.6·δ²/L toward the base.
  - **Tilt:** 2T²δ/(L·b²), from the opposite axial forces that balance the
    blades' end moments.
  - **Held level:** the same push is stiffer, since the blades must stretch.
- **Example: `public/examples/xystage.json`** (`test/xystage.build.test.ts`).
  - **Mechanism:** a carriage on four vertical blades (X) carries a platform on
    four horizontal blades (Y): two inputs, eight `beam` elements, and four
    free axes settled together.
  - **Over-constrained:** each axis is held from both sides. The drifts cancel,
    so the platform goes exactly where it's driven, square to well under
    0.001°.
  - **Stiffness:** a small push meets 4·12EI/L³. Further out it stiffens as the
    blades stretch, 3.2 N at 2 mm against 0.63 N linear. That stays under the
    inextensible bound of linear + 2.88·EA·δ³/L³, since a stretched blade
    straightens a little.
  - **Strain:** blades reach 0.74% at the corners of travel, within every
    material's limit.
- **Example: `public/examples/gimbal.json`** (`test/gimbal.build.test.ts`).
  - **Mechanism:** a two-axis flexure gimbal for a fine-steering mirror. A ring
    rides on two yoke posts through cross-blade pivots (axis X), the mirror
    platform inside it on a second pair (axis Y, carried by the ring); ±8° on
    each axis. Each pivot is two Ti-6Al-4V blades (14 × 10 × 0.4 mm) crossing
    at 90° at their midpoints, their halves clamped to either part.
  - **As flexures, not beams:** blades crossing at their midpoints bend in a
    constant-moment arc when the clamps turn (the end shear vanishes at λ = ½),
    which is exactly the small-length flexural pivot: k = EI/L and ε = tφ/2L
    per blade. So each blade is one `flexure` joint about the pivot axis (the
    first on each axis driven, the other three `closes`), and an axis meets
    4·EI/L = 1.74 N·m/rad, which the sweep reproduces to 0.1%. A `beam` joint
    bends in its parts' XY plane and cannot hold a blade standing in a
    vertical plane.
  - **Strain:** 0.2% at 8° on either axis, 0.4 of the allowable.
  - **Not modelled:** a cross-blade pivot's centre shift (a fraction of L·φ²,
    i.e. of 0.27 mm at 8°: the model's pin stays put), the blades' change of
    stiffness under the hung load, and inertia (no mass in the solver, so no
    first mode; the test logs a hand estimate of ~20 Hz for the inner axis).

## Built since: frame compliance

The first bistable switch, a U-frame, sprang back when printed unless its walls
were squeezed. The model called it bistable because it held the frame rigid.

- **Bent strips.** `beam { via: [{x, y}, …] }` runs a strip through corners
  between its ends, each a number or an expression. A frame's bar can then be
  a beam that runs along the base and up a wall. Checked on an L-frame against
  k = EI/(b³/3 + a·b²) (`test/beam-element.test.ts`).
- **Floating frame parts.** The frame's walls (where the beams are clamped) and
  its top bar are parts on free `planar` joints, held by those bar beams. They
  carry no geometry and are drawn as part of the frame, since they move by
  hundredths of a millimetre. They settle with every pose.
- **What it showed:**
  - **The U-frame:** under the beams' push, its long base bends and the walls
    splay (~0.1 mm) and tilt (~0.2°). That's enough to lose the second rest at
    every bar width tried (6–24 mm).
  - **A tie under the beams (an H):** this doesn't fix it. The tie sits below
    the load, so it still bends.
  - **A closed ring:** this holds each wall at both ends. It keeps 98% of the
    rigid frame's stroke and 92% of its snap force at 10 mm bars, and stays
    bistable down to 5 mm bars.
- **A second mode, mid-snap.** Pushed by its knob alone, the shuttle sways and
  tilts up to ~2° through the middle of the snap (the full beam's second
  mode). It starts after the peak, so the snap force and the rest positions
  don't change. Mid-snap the energy is ~5% lower, and the far side is softer
  (−3.1 N against −4.1 N). The square, symmetric pose is a saddle there, so a
  free shuttle goes one way or the other depending on round-off. The example
  holds the shuttle square, and a test pins down the size of the effect.
- **Speed.** A frame study has 9 free axes and 10 beams, so two changes keep it
  to a few seconds instead of ~50:
  - **The settle reuses its curvature:** it keeps its Hessian between poses
    (per document) and updates it with BFGS, rebuilding it only when a step
    won't go downhill.
  - **Solves carry on:** a beam solve continues from a pose that beam was
    already solved at, short of this one on the same line from rest. It
    continues that push rather than ramping from rest again. A stout bar moved
    a sliver of its thickness takes a single step.

## Built since: stable beams, answers independent of history

- **Stable shapes.** Newton finds equilibria, stable or not. A beam pushed
  along a symmetric path keeps to that shape past where a nudge would tip it
  into a lower one (an arch's next mode), as the real strip does.
  - **The check:** `solveBeam` checks where it stops. If the stiffness isn't
    positive definite there (an LDLᵀ meets a pivot that isn't positive), it
    steps along the direction of negative curvature that the factor gives,
    then minimises (damped Newton, every step downhill) to the stable shape.
  - **Why it matters:** before this, the curved beams could ride an unstable
    branch. Their energy then jumped with tiny changes in their ends, a settled
    frame landed in different places from run to run (energies 25–36 mJ at
    one pose), and the snap force read high. That's how a stocky arch
    appeared to match the slender-arch figure.
- **No history.** A beam can hold more than one shape for the same ends. The
  answer is the one pushing straight from rest gives, so a solve only carries
  on from poses on that push. A study is now path-independent: through the
  snap and back gives the same force and energy at a pose, to the settle's
  tolerance. A test checks this.

## Built since: an embedded skeleton, 3MF export

- **Optional features.** `feature.setCondition { feature, when }` builds a
  feature only while `when` is non-zero. Both the full and the incremental
  evaluation skip it. A checkbox can then add or remove a part.
- **The bistable's `skeleton` checkbox.** It embeds a PLA ring of core bars in
  the frame's bars, under a 1.2 mm skin, and cuts the pocket it fills.
  - **The model:** each frame bar is modelled at the thickness that bends like
    the composite section, (t³ + (E_c/E − 1)·(h_c/Hz)·c³)^⅓, which assumes a
    good bond between the two materials. That underrates the bars' stretch,
    which only errs soft.
  - **What it gives:** with 6 mm bars in TPU 95A the snap goes from 0.20 N to
    0.28 N, against 0.34 N held rigid. With 10 mm bars it reaches the rigid
    value. TPU 68D is 40% as stiff as PLA, so a core adds only 1–7% there.
- **3MF export** (`src/core/export/threemf.ts`). The whole model becomes one
  3MF object that holds a part per material. Each part is all that material's
  bodies fused, welded watertight, named and coloured after its material. Save
  / share switches to 3MF when a model has more than one print material. It's
  dependency-free: a zip of stored entries.
  - **Tested:** CRC-32 against the standard check value, each part closed, the
    skeleton inside the frame by its skin, and the parts in place.

## Built since: grip springs and a skeleton for the gripper

- **Grip springs** (`springs`: none to 3). Each is a straight leaf spring,
  drawn bending with the plunger, from the frame's left column to the stem: a
  `beam` element, fixed-guided as the plunger rises.
  - **Why the left only:** that's the guide's side. The plunger drifts toward
    it on the guide's arc by δ²/2R, about what a bent blade's ends draw together
    (0.6·δ²/L). A blade on the far side would be stretched by twice that: 13%
    strain where it should be 4%.
  - **Sized by material:** each material's blade is the thickest (0.6–1.6 mm)
    that bends the full stroke at 70% of its strain limit.
  - **What each adds:** 12EI/L³ of push, within 10% of theory (9.7 N at 5 mm in
    TPU 68D). Held half open on something, the grip per jaw is
    (push)/(2·gain): 1.4 N with none, then 2.1, 2.7 and 3.3 N.
  - **Switched off:** `beam { when }` makes a beam carry nothing while its
    expression is 0. The drawn blades are features with `when`.
- **Skeleton** (checkbox). A PLA core goes in each of the 8 rigid links, under
  a 1.2 mm skin, and a pocket is cut to match.
  - **Each core is a child part** of its link with its own material, so it
    rides with the link. The hinge strips stay TPU.
  - **The model treats the links as rigid already.** In a soft TPU the core
    makes that true.
  - **It saves as a two-part 3MF.**
- **Offset sketches move with their part.** A sketch on an offset plane
  (`sketch.create { offset }`) used to stay where it was drawn when its
  component moved. Origin-plane sketches always followed. Now it keeps its
  as-modelled plane (`localPlane`) and follows the part.
  - **The skeleton's cores need it:** they're drawn lifted off the part's floor.
  - **It also fixed the Roubo vise:** the slot cut through its sliding chop now
    follows the chop, so the crisscross arms pass through it.

## Open questions
- Which mechanisms matter first? Snap fits and living hinges point at phases 1 + 3;
  grippers and flexure stages at 1 + 2.
- Interactive vs accurate: is PRBM-level accuracy (a few %) good enough on the
  slider, with beams/FE as an explicit "check" button?
- Print orientation: infer the build direction per body, or make it explicit?
- Material data: do we need measured stress–strain curves for TPU (large-strain
  snap fits), or are datasheet moduli enough for now?
