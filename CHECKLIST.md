# Starfall Armada X — Build Checklist

Authoritative completion list. Nothing ships until every box is ticked.
Legend: `[ ]` todo · `[~]` written but not yet integrated/verified · `[x]` done & verified

---

## Phase 0 — Foundation

- [x] Wipe the previous project entirely
- [x] Toolchain: TypeScript 5.9 + Vite 7.3 + Three.js 0.185, strict mode
- [x] Verify build pipeline end-to-end (`tsc --noEmit && vite build`)
- [x] `DESIGN.md` — full design document grounded in genre research
- [x] `CHECKLIST.md` — this file
- [x] `core/types.ts` — shared type contract
- [x] `core/constants.ts` — central tunables
- [x] `core/math.ts` — damping, springs, easing, scratch vectors, zero-alloc helpers
- [x] `core/rng.ts` — seeded mulberry32, weighted pick, shuffle
- [x] `core/pool.ts` — generic zero-alloc object pool
- [x] `core/events.ts` — typed event bus
- [x] `core/time.ts` — fixed timestep, timescale, hit-stop
- [x] `core/spatial.ts` — uniform-grid broad-phase collision
- [x] `core/input.ts` — keyboard, mouse, gamepad, remapping
- [x] `core/settings.ts` — settings model + persistence
- [x] `core/save.ts` — meta-progression persistence

## Phase 1 — Rendering foundation

- [x] `render/renderer.ts` — WebGLRenderer, ACES tone mapping, sRGB output
- [x] Post-processing chain: RenderPass → UnrealBloom (half-res) → Output
- [x] Adaptive quality tiers driven by rolling frame time
- [x] Proper resize handling incl. devicePixelRatio cap
- [x] `render/palette.ts` — colour system + 4 colourblind modes
- [x] `render/camera.ts` — chase camera, critically-damped spring follow
- [x] Trauma-based directional screen shake with accessibility scaling
- [x] FOV kick on boost and heavy hits
- [x] Death camera: slow-motion orbit of the wreck
- [x] Chase camera clamped inside the arena so it never trails through the boundary shell
- [x] `render/starfield.ts` — procedural skybox, nebula, parallax star layers
- [x] `render/arena.ts` — hex-grid boundary shell that brightens near the edge
      (verified in-browser: the hexagon metric was transposed against its lattice and drew
      triangles, `vDir` was un-normalized and flat-shaded the facets, and the angular UV left
      a seam at the atan branch cut — all three fixed and confirmed by screenshot)
- [x] Arena debris/asteroid field (instanced)
- [x] Sector-specific dressing (Debris Belt / Ion Storm / The Maw)

## Phase 2 — Effects

- [~] `render/fx/particles.ts` — single GPU-animated `Points` system, pooled spawns
- [~] Particle emitters: spark, smoke, ember, shockwave-dust, engine-wash
- [~] `render/fx/trails.ts` — ribbon engine trails for player and enemies
- [~] `render/fx/impacts.ts` — hit sparks along reflected vector
- [~] Kill sequence: white flash → expanding ring → debris → smoke
- [x] `render/fx/shields.ts` — hex shield shell renders as a wireframe you can see the ship
      through (the edge test was inverted, filling every cell and hiding the ship). Hit
      ripple itself still unverified — no player damage occurred in any recorded session.
- [~] Shield break: shatter-outward shell effect
- [~] Muzzle flashes per weapon type
- [~] Damage numbers (pooled, toggleable, crit-coloured)
- [~] Chromatic-aberration pulse on player damage — the pulse now decays over 0.4s instead
      of latching on forever, but the harness has never actually taken a hit (0 `player:damaged`
      events across every recorded session), so the visible effect is still unconfirmed
- [~] Screen-edge crimson vignette on low hull — wired and reset on run start; never observed
      firing, because hull has stayed at 100/100 in every session so far

## Phase 3 — The ship

- [x] `ship/geometry.ts` — procedural fighter mesh: fuselage, swept wings, canards, engines
- [x] Panel-line / greeble detail via procedurally generated textures
- [x] Emissive engine bells, cockpit glass, running lights
- [x] Animated control surfaces that respond to steering input
- [x] `ship/hulls.ts` — 4 hulls (Starfall, Vireo, Bastion, Wraith) with distinct silhouettes
- [x] `ship/flight.ts` — velocity approach, angular acceleration + damping
- [x] Visual banking proportional to yaw rate
- [x] Auto-levelling roll
- [x] Boost: speed, FOV, trail intensity, meter drain
- [x] Drift: decoupled heading/velocity with cooldown
- [x] Arena boundary soft-push + hard clamp with warning
- [x] `ship/player.ts` — hull, shields, heat, regeneration, i-frames

## Phase 4 — Combat

> Open question, seen in every recorded browser session: with the primary held down for the
> whole soak (heat climbs to 97%, so the weapon *is* firing), HOSTILES stays at 6, SCORE and
> SALVAGE stay at 0, and `player:damaged` never fires once. Nothing dies and nothing hits
> back. Projectiles are visible leaving the ship, so the suspect is hit resolution rather
> than firing. Needs isolating before any Phase 4 box can be ticked.

- [ ] `combat/projectiles.ts` — instanced pooled projectiles (≥2000 concurrent)
- [ ] Projectile behaviours: linear, homing, piercing, proximity, orbiting, forking
- [ ] `combat/weapons.ts` — 6 primaries implemented and distinct
  - [ ] Pulse Repeater
  - [ ] Lance Driver (charge + pierce)
  - [ ] Scatter Vents (cone + falloff)
  - [ ] Arc Tether (chain lightning, ≤4 targets)
  - [ ] Flak Battery (proximity AoE)
  - [ ] Singularity Coil (pull orb)
- [ ] Heat system: build, cap, forced vent, visual + audio feedback
- [ ] 5 secondaries implemented and distinct
  - [ ] Swarm Missiles (multi-lock homing)
  - [ ] Nova Mine
  - [ ] Phase Lance (sustained beam)
  - [ ] Gravity Well
  - [ ] Aegis Pulse (bullet clear + shield refill)
- [ ] `combat/damage.ts` — resolution, crits, armour arcs (Bulwark front)
- [ ] `combat/targeting.ts` — lock-on, target cycling, lead indicator
- [ ] Aim assist (Off / Light / Strong) as reticle magnetism
- [ ] Collision: spatial-hash broad phase + sphere narrow phase

## Phase 5 — Enemies

- [x] `enemies/types.ts` — 6 archetypes with distinct procedural silhouettes
  - [x] Wasp Drone
  - [x] Interceptor
  - [x] Lancer
  - [x] Bulwark
  - [x] Carrier
  - [x] Mine Layer
- [x] `enemies/ai.ts` — steering behaviours (seek, flee, pursue, orbit, separate, wander)
- [x] Per-archetype brains with distinct engagement ranges and patterns
- [x] Lancer beam telegraph (1.4 s, colour-coded, audible)
- [x] Bulwark frontal shield arc with flanking counterplay
- [ ] Carrier drone spawning
- [ ] Mine Layer persistent mines
- [ ] Elite ("Seraph") variants: aura ring, buffed stats, health bar, guaranteed rare drop
- [ ] `enemies/manager.ts` — pooled lifecycle, per-type instancing
- [ ] `enemies/director.ts` — wave composition, spawn pacing, difficulty scaling
- [ ] Off-arena spawn with warp-in effect (never spawns on top of the player)

## Phase 6 — Bosses

- [x] `enemies/bosses/boss.ts` — shared framework: phases, HP gates, pattern scheduler
- [x] Named bullet patterns: ring, fan, spiral, wall, aimed-burst, sweep
- [ ] Boss health bar with phase segments
- [ ] Phase-transition sequence: time dilation, camera push, palette shift, audio sweep
- [x] `bosses/hexard.ts` — 3 phases, splitting segments, travelling safe wedge
- [x] `bosses/vashkan.ts` — 3 phases, dogfighting AI, beam pylons, telegraphed dash-strike
- [x] `bosses/mawcore.ts` — 3 phases, sequenced shield plates, gravity pull, contracting arena
- [ ] Boss intro sequence with name card
- [ ] Boss death sequence: chained explosions, slow motion, salvage burst

## Phase 7 — Progression

- [x] `progression/augments.ts` — 44+ augments across 4 categories
- [x] Augment effect hook system (stat mods + event-driven rule changes)
- [x] Rarity weighting with visible odds + Prototype pity timer
- [x] All Systems augments from the design doc implemented
- [x] Augment stacking with correct multiplicative/additive semantics
- [x] `progression/run.ts` — run state, sectors, waves, threat level, salvage tally
- [x] Sector modifiers that change rules (asteroid cover, EMP fronts, contracting arena)
- [x] `progression/meta.ts` — salvage, unlock tree, persistence
- [x] Unlocks grant options (weapons/hulls/augments/cosmetics), never flat power

## Phase 8 — Audio

- [~] `audio/engine.ts` — Web Audio graph, master/music/SFX buses, ducking
- [~] Positional audio for enemy fire
- [~] Suspend/resume on tab visibility; unlock on first gesture
- [~] `audio/sfx.ts` — synthesised bank, distinct voice per weapon
- [~] Enemy death, shield break, low-hull warning, pickup, UI cues
- [~] Telegraph cues that duck everything else
- [~] `audio/music.ts` — procedural layered score, intensity-driven layers
- [~] Boss music layer; per-sector key shift
- [~] Volume sliders persisted

## Phase 9 — UI

- [~] `ui/styles.css` — cohesive HUD/menu visual language
- [~] `ui/hud.ts` — hull, shields, heat, boost, weapon state
- [~] 3D radar showing relative position incl. above/below
- [~] Off-screen threat arrows sized by proximity
- [~] Lock-on reticle + lead-indicator pip
- [~] Wave/sector/threat-level readout, run timer, score
- [ ] `ui/draft.ts` — 3-card augment draft with rarity, category colour, full text
- [ ] Reroll (1 per draft, +1 on Starfall hull)
- [ ] `ui/menus.ts` — title, pause, settings, game over, run summary
- [ ] Settings UI wired to every accessibility option
- [ ] `ui/hangar.ts` — salvage spending, unlock tree, hull/weapon selection
- [ ] `ui/codex.ts` — enemy/weapon/augment reference
- [ ] Keyboard and gamepad navigation for all menus

## Phase 10 — Feel & polish

- [ ] Hit-stop at all specified durations, accessibility-scaled
- [ ] Directional trauma shake on all impact events
- [ ] Last-kill-of-wave slow motion
- [ ] Boss phase-break time dilation
- [ ] Enemy hit-flash (emissive ramp to white)
- [ ] Every weapon has muzzle flash + audio + camera response
- [ ] Wave-clear and sector-clear celebration beats
- [ ] Death sequence and run-summary flow
- [ ] First-run onboarding: contextual control prompts

## Phase 11 — Accessibility

- [ ] Screen-shake intensity slider
- [ ] Hit-stop intensity slider
- [ ] Flash/bloom reduction toggle
- [ ] 4 colourblind palettes with verified player/enemy projectile separation
- [ ] Aim assist levels
- [ ] 4 difficulty levels
- [ ] Full keyboard remapping, persisted
- [ ] No information conveyed by colour alone

## Phase 12 — Performance

- [ ] Fixed-timestep loop with accumulator + interpolation, max 5 catch-up steps
- [ ] Zero allocation in the hot loop (audited)
- [ ] All entity types pooled
- [ ] Instanced rendering for projectiles, enemies, debris, particles
- [ ] Spatial hash broad phase (no O(n²))
- [x] Adaptive quality tiers verified to shed effects, not gameplay
- [ ] Draw calls ≤ 120 in a heavy wave
- [ ] Proper disposal on teardown / run restart
- [ ] Verified 60 fps with 200+ live entities
- [ ] Perf overlay (toggleable) showing FPS, draw calls, entity counts

## Phase 13 — Ship it

- [ ] `README.md` — what it is, how to run, controls, design notes
- [ ] Pause on tab blur / window focus loss
- [ ] Handles WebGL context loss gracefully
- [x] Works from a static file server, offline, no external requests
      (`scripts/verify.mjs` serves `dist/` with no egress and asserts 0 external requests)
- [~] GitHub Pages deploy workflow — builds, typechecks, and selftests green on CI; the
      deploy step fails at `configure-pages` until Pages is enabled once by hand
      (Settings → Pages → Source: GitHub Actions). Not verified end-to-end.
- [ ] Final full-run playtest verification
      (blocked below: no wave has been cleared in a recorded session, so Drafting,
      SectorClear, BossIntro, GameOver, and Hangar remain unexercised in-browser)
- [ ] Committed and pushed to `claude/threejs-space-fighter-game-sxus1u`
