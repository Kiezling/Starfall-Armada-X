# Starfall Armada X — Game Design Document

> A 3D space-fighter roguelite. Fly the *Starfall*, draft augments between waves, break the armada.
> Built with Three.js. Zero external assets — every mesh, texture, and sound is generated at runtime.

---

## 1. Design pillars

These four pillars settle every ambiguous decision. When a feature conflicts with a pillar, the pillar wins.

1. **Legible chaos.** Hundreds of things on screen, and the player always knows what will kill them.
   Threats read at a glance through colour, shape, and sound — never through reading text.
2. **Weight in every trigger pull.** Firing, hitting, and killing are multi-sensory events. If an
   action does not produce visual + audio + camera feedback within one frame, it is unfinished.
3. **Runs are decisions, not dice.** Randomness is always drafted, never dealt. The player sees the
   options, understands the odds, and picks. Losing is legible in hindsight.
4. **It runs anywhere.** 60 fps on integrated graphics at 1080p, from a static file server, offline.

---

## 2. Research findings that shaped this design

Condensed from a survey of the genre, its post-mortems, and its criticism.

| Finding | Source of the lesson | What we do about it |
|---|---|---|
| Full 6DOF causes disorientation and motion sickness; auto-levelling is the standard mitigation | Descent/Overload lineage, 6DOF design writing | Assisted arena flight: full pitch/yaw, *auto-levelling roll*, strafe on a limited resource. No inverted-world states. |
| Players get lost in open 3D space; "where is the fight" is the genre's biggest usability failure | Space-sim usability critique | Bounded spherical arena with a visible energy boundary, plus off-screen threat arrows and a 3D radar. |
| 100 bullets in one legible pattern are easier to dodge than 30 independent ones | Bullet-hell design analysis | All boss and elite fire is emitted in *named patterns* (ring, fan, spiral, wall, aimed-burst). No per-enemy random aiming at high counts. |
| Telegraphs must be visible *and* audible; each boss phase must feel distinct | Boss-design literature (Cuphead-era analysis) | Every heavy attack has a wind-up decal, a colour-coded tell, and a dedicated audio cue. Bosses have 3 phases with different movesets and palettes. |
| Meta-progression that grants raw power drives veterans away; it should unlock *options* | Roguelite progression post-mortems (Hades, Rogue Legacy 2, Cult of the Lamb) | Salvage unlocks **weapons, hulls, and new augments into the draft pool** — never flat stat boosts. |
| Randomness must be legible: drafts and shops beat raw drops | Slay the Spire / Balatro design analysis | Augments are always a 3-card draft with rarity, category colour, and full text shown. One reroll per wave. |
| Sound is half the UI in busy fights | Vampire Survivors readability analysis | Distinct synthesised voice per weapon, per enemy death, per pickup, with a ducking mixer so cues stay audible. |
| Similar DPS differentiated by risk/reward and projectile behaviour creates real choice | Weapon-design practice (Overwatch-style differentiation) | All primaries sit within ±15% baseline DPS. They differ in range, spread, projectile speed, heat, and combo potential. |
| Screen shake should be directional and trauma-based, not random jitter | Game-feel writing ("The Art of Screenshake" lineage) | Trauma accumulator, quadratic decay, directional impulse along the damage vector, and a user-facing intensity slider. |
| Hit-stop of a few dozen ms sells impact | Action-game feel practice | 25 ms on kill, 45 ms on heavy hit, 90 ms on boss phase break. Scaled by an accessibility setting. |
| Genre entries with great feel still fail on shallow structure and repetitive mid-game | Chorus / Squadrons criticism | Sector modifiers, elite waves, and escalating Threat Levels change the *rules*, not just the numbers. |
| Post-processing is the usual Three.js frame-rate killer | Three.js performance guidance | Half-resolution bloom, single composer chain, adaptive quality that sheds effects before it sheds frame rate. |
| Object churn causes GC hitches at scale | Three.js/JS performance guidance | Everything is pooled. Zero allocation in the hot loop. Instanced projectiles, enemies, and particles. |

---

## 3. The fantasy

You are the last pilot of the *Starfall*, a prototype interceptor, holding a collapsing corridor
against the Armada. You cannot win the war. You can go deeper than the last pilot did.

Tone: clean, hard sci-fi. Cold blues and whites for your systems, hot magenta and amber for
the Armada. Silence between waves, pressure during them.

---

## 4. Controls

**Keyboard-first, pointer-free.** The design constraint is absolute: everything the game asks
of a player must be reachable from two hands on a keyboard, with no mouse present. That is not
an accessibility bolt-on — it changes the flight model, the aiming model, and the HUD, and each
of those is designed around it below.

The left hand flies the ship's *body* on WASD; the right hand flies its *nose* on the arrow
cluster. `I J K L` mirrors the arrows for players who prefer both hands on the home row, and
the arrow hand gets its own fire/boost/drift/lock keys so neither hand has to travel.

| Input | Action |
|---|---|
| `↑` `↓` `←` `→` (or `I J K L`) | Steer the nose (pitch / yaw) |
| `Space` (or `/`) | Fire primary (heat-limited, no ammo) |
| `C` (or `.`) | Fire secondary (cooldown + charges) |
| `W` / `S` | Throttle up / down |
| `A` / `D` | Lateral strafe |
| `Q` / `E` (or `U` / `O`) | Manual roll |
| `T` (or `,`) | **Hold lock** — nose tracking assist at full authority |
| `Tab` (or `M`) | Cycle locked target |
| `LShift` (or `RShift`) | Boost |
| `X` (or `RCtrl`) | **Drift** — decouple heading from velocity for 1.5 s |
| `F` | Swap weapon (Wraith) |
| `R` | Reroll draft (once per draft) |
| `Esc` / `P` | Pause |
| Gamepad | Full support: sticks steer/strafe, triggers fire, bumpers drift/target |

**Steering axes.** Held keys feed a spring, so the nose eases in and out and reads as analog
rather than digital. The axes rest at *exactly* zero, which is the property that matters:
releasing the keys holds the current heading. (The original mouse model had no rest position —
with no pointer, the axes sat wherever the cursor last happened to be, and the ship pitched
continuously until it flipped. That is the bug this layout exists to make impossible.)

**Unlimited pitch, with an attitude reference.** Orientation is integrated as a quaternion in
body axes, so the nose can loop all the way over the top and keep going — there is no clamp and
no sudden stop mid-pull. The earlier ±78° clamp traded that away for disorientation-proofing,
and in play it did the opposite: the nose stopping without warning is exactly what made "which
way am I facing?" unanswerable. Orientation confidence now comes from information instead of
restriction — the HUD carries a true-horizon ladder, world zenith/nadir pips, and a
heading/pitch readout, all derived from world axes so they stay honest inverted. Roll still
auto-levels whenever manual roll is not held and the ship is not mid-loop, so the ship settles
level on its own without ever fighting the player for the nose.

Pitch defaults to stick-style (Up = nose down); **Settings → Gameplay → Invert Y** flips it.

**Hold lock** is the keyboard's answer to a mouse's aiming resolution. With a target locked,
the ship converges its nose on the *intercept point* (where the target will be when the shot
lands) at a bounded rate. Two rules keep it honest:

1. It **yields entirely to manual steering** — the instant a steering key goes down, the assist
   contributes nothing. It can never fight the player for the nose.
2. It is **rate-limited, not a snap** — capped below the ship's own turn rate, so a fast
   crossing target still has to be flown to. The HUD fills a ring around the lock bracket as
   the assist approaches that cap, which is the cue to turn and help it.

Aim assist (the shot-bending cone, separate from the tracking assist) defaults to Strong and is
still a Settings option down to Off. Cone half-angles are sized for keyboard steering
resolution: a near-miss that a mouse would have made must be forgiven, or coarse input reads as
an unresponsive game rather than a hard one.

**Drift** is the depth mechanic. Holding it lets the ship keep its velocity vector while the nose
swings freely — the space equivalent of a handbrake turn, and the only way to keep guns on a
target that is out-turning you. It has a cooldown, so it is a decision, not a mode.

---

## 5. Flight model

Not Newtonian, and deliberately so — pure Newtonian drift is the genre's least readable option.

- Velocity follows a target vector derived from throttle + strafe, with an exponential approach
  (critically damped, no overshoot).
- Turn rate is angular-velocity based with acceleration and damping, so the ship has *heft*.
- Banking: the ship visually rolls into turns proportional to yaw rate. Pure cosmetics, huge feel.
- Boost overrides throttle cap for 2 s, drains the boost meter, adds FOV punch + trail bloom.
- Arena boundary: at 95% radius the player gets a warning ring and a soft inward force; at 100%
  a hard velocity clamp. The player is never teleported and never insta-killed by geometry.

---

## 6. Run structure

```
RUN
├── Sector 1 · Debris Belt      (5 waves → elite wave → BOSS: Hexard)
├── Sector 2 · Ion Storm        (5 waves → elite wave → BOSS: Vashkan Prime)
└── Sector 3 · The Maw          (5 waves → elite wave → BOSS: The Maw Core)
     └── clear → Threat Level +1, loop with escalating modifiers (endless mastery mode)
```

- A wave is 30–60 s. A run is 18–25 minutes. A boss is 2–4 minutes.
- **After every wave:** a 3-card augment draft. One reroll available.
- **After every boss:** a weapon/hull choice, a full repair, and a Threat Level checkpoint.
- **Sector modifiers** change the rules, not the numbers. Examples:
  - *Debris Belt* — destructible asteroids provide cover and can be shot into enemies.
  - *Ion Storm* — periodic EMP fronts sweep the arena, disabling shields inside them.
  - *The Maw* — arena slowly contracts; gravity wells bend projectiles.

**Death** ends the run. Salvage earned = (sector reached × 100) + (enemies killed × 2) +
(bosses × 250), spent in the hangar between runs.

---

## 7. Progression — two layers

### 7.1 Run-scoped: Augments (the power fantasy)

Drafted 3-at-a-time after each wave. ~44 augments. Four categories, colour-coded:

| Category | Colour | Theme |
|---|---|---|
| **Offense** | Crimson | Damage, fire rate, projectile behaviour |
| **Defense** | Azure | Hull, shields, damage reduction, recovery |
| **Mobility** | Emerald | Speed, turn rate, drift, boost |
| **Systems** | Amber | **Rule-changers.** The build-defining picks. |

Rarity weights are shown to the player: Common 60% / Rare 30% / Prototype 10%. Prototype odds
rise by 5% per wave without one (pity timer — legible RNG).

Augments **stack** and are designed to **combine**. A non-exhaustive taste of Systems augments:

- **Overcharge Vents** — heat no longer caps fire rate; instead, overheating vents an explosion.
- **Chain Reaction** — enemy deaths detonate for 30% of their max HP.
- **Echo Rounds** — every 5th shot fires a delayed phantom copy.
- **Kinetic Battery** — damage dealt charges a bar; full bar makes the next shot a Lance.
- **Vampiric Coils** — kills restore hull; overhealing becomes temporary shield.
- **Time Dilation Core** — near-misses slow time for 0.4 s.
- **Split Payload** — projectiles fork on their first impact.
- **Aegis Reversal** — shields reflect the projectile that broke them.

Design rule: no augment is a pure stat stick without a visible or audible consequence.

### 7.2 Meta: Unlocks (the option fantasy)

Salvage is spent in the **Hangar** between runs. Per the research, this unlocks *options*, never
raw power:

- **Weapons** — new primaries and secondaries entering the run pool.
- **Hulls** — 4 ships with genuinely different playstyles (see §9).
- **Augment blueprints** — add new augments to the draft pool.
- **Cosmetics** — hull liveries and engine-trail colours.

Everything unlocked is available on run 1 of the next session. Nothing is +5% damage forever.

---

## 8. Weapons

All primaries sit within ±15% of baseline sustained DPS. They differ in *how* you earn it.
Primaries generate **heat**; overheating forces a 2 s vent. There is no ammo on primaries.

| Primary | Feel | Trade |
|---|---|---|
| **Pulse Repeater** | Fast, tight, forgiving. The baseline. | Lowest per-shot damage; poor vs armour. |
| **Lance Driver** | Charge-and-release railgun. Pierces everything in a line. | Charge commits you; missing costs the whole cycle. |
| **Scatter Vents** | Shotgun cone. Deletes things at knife range. | Damage falls off hard past 40 m. |
| **Arc Tether** | Auto-connecting chain lightning, hits 4 targets. | Low single-target; needs crowds to pay off. |
| **Flak Battery** | Proximity-fused AoE shells. | Slow projectiles; punishes bad leading. |
| **Singularity Coil** | Slow orb that drags enemies into a clump. | Almost no direct damage — a setup tool. |

Secondaries use charges on a cooldown:

| Secondary | Effect |
|---|---|
| **Swarm Missiles** | Locks up to 6 targets, fires a homing volley. |
| **Nova Mine** | Deployable proximity charge, large AoE. |
| **Phase Lance** | Sustained piercing beam while held; drains a meter. |
| **Gravity Well** | Thrown singularity; pulls and slows for 4 s. |
| **Aegis Pulse** | Shockwave that clears bullets and refills shields. |

---

## 9. Hulls

| Hull | Role | Distinguishing rule |
|---|---|---|
| **Starfall** (default) | All-rounder | Balanced. Extra augment reroll per draft. |
| **Vireo** | Glass-cannon interceptor | +40% speed/turn, −40% hull. Drift has no cooldown. |
| **Bastion** | Assault gunship | +80% hull, −25% speed. Shields regenerate mid-combat. |
| **Wraith** | Technical | Starts with two primaries and swaps between them freely. |

---

## 10. Enemies

Every enemy answers "how do I beat it?" through silhouette and colour alone.

| Enemy | Silhouette | Behaviour | Counter |
|---|---|---|---|
| **Wasp Drone** | Small, angular, fast | Swarms, kamikaze arcs | Any AoE; don't get surrounded |
| **Interceptor** | Sleek delta | Dogfights, strafes, dodges when locked | Lead your shots; drift to hold the angle |
| **Lancer** | Long, thin, glowing spine | Stationary sniper with a 1.4 s beam telegraph | Break line of sight; close the gap |
| **Bulwark** | Wide, plated, front-heavy | Advances slowly behind a frontal shield arc | Flank it — rear is unarmoured |
| **Carrier** | Bulky, hangar-lit | Spawns Wasps continuously | Priority target; kill it first |
| **Mine Layer** | Segmented, blinking | Drops persistent proximity mines | Range it down; don't chase through the field |
| **Seraph** (elite) | Any of the above + aura | Buffed stats, extra pattern, drops guaranteed rare | Focus fire, use secondaries |

Elites are visually unmistakable: a rotating aura ring, a brighter palette, and a health bar.

---

## 11. Bosses

Each boss has 3 phases, a distinct palette shift per phase, and a unique arena rule.

### 11.1 Hexard, the Splitting Fortress (Sector 1)
A hexagonal battlecruiser. **Phase 1:** rotating radial bullet rings with a safe wedge that
travels — the player learns to read rotation. **Phase 2:** at 66% HP it splits into three
independently-orbiting segments, each firing aimed fans; killing a segment removes its pattern.
**Phase 3:** the core exposes, charges a slow arena-wide sweep, and the player must use asteroid
cover. Teaches: pattern reading, target prioritisation, cover.

### 11.2 Vashkan Prime, the Lance Sovereign (Sector 2)
An agile duellist that flies like the player. **Phase 1:** classic dogfight — it drifts, it leads
its shots, it breaks off. **Phase 2:** deploys four beam pylons that sweep the arena in a rotating
cross; the fight becomes dodge-while-shooting. **Phase 3:** it goes aggressive with a dash-strike
that telegraphs with a red vector line 0.9 s before it fires. Teaches: dogfighting mastery, drift.

### 11.3 The Maw Core (Sector 3)
A station core behind six rotating shield plates. **Phase 1:** plates must be destroyed in the
order they light up, while turret rings suppress. **Phase 2:** the core pulls the player inward
with a gravity field; Carriers spawn on the rim. **Phase 3:** the arena contracts to 40%, the core
fires an expanding spiral wall, and the only survival is precise drift through the gaps.
Teaches: everything at once.

---

## 12. Game feel — the juice specification

This is a *requirements list*, not a nice-to-have.

**Hit-stop** (time-scale to ~0.02 for a duration, then ease back)
- Light hit: 0 ms · Heavy hit: 45 ms · Kill: 25 ms · Elite kill: 60 ms · Boss phase break: 120 ms
- Player takes damage: 70 ms. Scaled by accessibility slider (0–100%).

**Camera**
- Trauma-based shake: `shake = trauma²`, trauma decays at 1.6/s, capped at 1.0.
- Directional impulse along the damage/impact vector, then spring-return.
- FOV: 62° base → 78° at full boost, eased. FOV punch of +4° on heavy hits.
- Chase camera lags the ship with a critically-damped spring; it *never* clips through geometry.
- Death: slow-motion to 0.25×, camera orbits the wreck for 2 s.

**Impacts**
- Sparks along the reflected impact vector, count scaled by damage.
- Enemy hit-flash: emissive ramps to white for 60 ms.
- Kill: white flash → expanding ring shockwave → debris chunks → smoke puff → audio.
- Damage numbers, small and short-lived, colour-coded by crit (toggleable).

**Player damage**
- Screen-edge crimson vignette pulse, chromatic aberration spike, directional shake.
- Shield break is a distinct, unmissable event: a hexagonal shell shatters outward.

**Pacing**
- Last enemy of a wave dies in 0.35× time for 0.8 s.
- Boss phase transitions: 0.15× time, camera pushes in, audio filter sweep.

---

## 13. Readability rules (non-negotiable)

- **Projectile colour is ownership, always.** Player = warm gold/white. Enemy = cyan/magenta.
  These two families never swap, never overlap, and remain distinct in all colourblind modes.
- **Telegraph colours.** Yellow = aimed at you, dodgeable. Red = lethal, will not be survived
  standing still. Nothing else uses saturated red.
- **Off-screen threats** get an edge arrow, sized by proximity, only for enemies actively firing.
- **A locked target** shows a lead-indicator pip where you should aim.
- **The arena boundary** is always visible as a subtle hex-grid shell that brightens near the edge.
- **A 3D radar** in the HUD corner shows relative enemy positions including above/below.

---

## 14. Audio

100% synthesised via Web Audio — no files, no downloads.

- **Music**: a procedural, layered ambient/industrial bed. Layers enter with wave intensity; a
  driving percussive layer arrives at boss start. Key shifts per sector.
- **Weapons**: each has a distinct synth voice (Pulse = short square blip; Lance = charging saw
  sweep into a sub-bass crack; Scatter = filtered noise burst; Arc = ring-modulated zap).
- **Ducking mixer**: gameplay-critical cues (incoming telegraph, shield break, low hull) duck
  music and other SFX so they are never masked.
- **Spatialisation**: PannerNode positioning for enemy fire so threats can be heard off-screen.
- Master, music, and SFX volume sliders. Muted on tab blur.

---

## 15. Accessibility

- Screen-shake intensity: 0–100%
- Hit-stop intensity: 0–100%
- Flash/bloom reduction toggle (removes strobing, caps bloom)
- Colourblind palettes: Default / Deuteranopia / Protanopia / Tritanopia
- Aim assist: Off / Light / Strong — shot-bending magnetism, never auto-fire. Defaults to
  Strong, since keyboard steering is coarser than a pointer and the game has to forgive that.
- Difficulty: **Cadet** (0.7× enemy damage, 1.3× player hull) / **Pilot** (baseline) /
  **Ace** (1.3× damage, +30% enemy count) / **Nightmare** (1.6× damage, elite modifiers on all waves)
- Full keyboard remapping, persisted.
- All HUD text ≥ 14 px effective; no information conveyed by colour alone (shape + colour always).

---

## 16. Technical architecture

**Stack:** TypeScript · Three.js 0.185 · Vite 7. No runtime dependencies beyond Three.

**Zero external assets.** All geometry is built procedurally from `BufferGeometry`. All textures are
generated to canvas or produced in shaders. All audio is Web Audio synthesis. The entire game ships
as one JS bundle and one HTML file.

### 16.1 Performance budget (1080p, integrated GPU, 60 fps = 16.6 ms)

| System | Budget |
|---|---|
| Render (draw calls ≤ 120) | 7 ms |
| Post-processing (half-res bloom) | 3 ms |
| Simulation (all entities) | 3 ms |
| Particles | 1.5 ms |
| UI | 1 ms |
| Headroom | 1 ms |

### 16.2 Hard performance rules

1. **Zero allocation in the update loop.** No `new`, no array literals, no closures per frame.
   Scratch vectors are module-level singletons. This is enforced by review.
2. **Everything is pooled** — projectiles, enemies, particles, damage numbers, audio voices.
3. **Instancing everywhere** — one `InstancedMesh` per projectile type, per enemy type, per debris
   type. Set `.count` to the live number rather than hiding instances off-screen.
4. **Particles** are a single `Points` system with a custom shader; the CPU writes only spawn data
   and the GPU animates from `age`.
5. **Broad-phase collision** via a uniform spatial hash grid. No O(n²) loops.
6. **Fixed-timestep simulation** at 60 Hz with an accumulator and render interpolation, so
   behaviour is frame-rate independent. Max 5 catch-up steps to avoid spiral-of-death.
7. **Adaptive quality**: a rolling frame-time average drives a quality tier that sheds, in order —
   particle density → bloom resolution → bloom entirely → shadow-ish effects. Never sheds gameplay.
8. **Dispose properly**: geometries, materials, and render targets are released on teardown.

### 16.3 Module map

```
src/
├── main.ts                     bootstrap + loop wiring
├── game.ts                     top-level state machine
├── core/
│   ├── types.ts                shared types + enums          [contract - do not change lightly]
│   ├── constants.ts            tunables in one place
│   ├── math.ts                 damping, springs, easing, scratch vectors
│   ├── rng.ts                  seeded mulberry32 + weighted pick
│   ├── pool.ts                 generic object pool
│   ├── events.ts               typed event bus
│   ├── time.ts                 fixed timestep, timescale, hit-stop
│   ├── input.ts                keyboard-first (+ optional mouse/gamepad), remapping
│   ├── spatial.ts              uniform-grid broad phase
│   ├── settings.ts             user settings + persistence
│   └── save.ts                 meta-progression persistence
├── render/
│   ├── renderer.ts             WebGLRenderer + composer + adaptive quality
│   ├── palette.ts              colour system incl. colourblind modes
│   ├── camera.ts               chase camera, trauma shake, FOV
│   ├── starfield.ts            skybox, nebula, parallax stars
│   ├── arena.ts                boundary shell, debris, sector dressing
│   └── fx/
│       ├── particles.ts        GPU particle system
│       ├── trails.ts           ribbon engine trails
│       ├── impacts.ts          sparks, shockwaves, explosions
│       └── shields.ts          hex shield shell + break shatter
├── ship/
│   ├── geometry.ts             procedural fighter mesh construction
│   ├── hulls.ts                the 4 hull definitions
│   ├── flight.ts               flight model + drift + boost
│   └── player.ts               player entity, health, heat, systems
├── combat/
│   ├── projectiles.ts          instanced pooled projectile manager
│   ├── weapons.ts              weapon definitions + firing logic
│   ├── damage.ts               damage resolution, crits, armour arcs
│   └── targeting.ts            lock-on, lead indicator, aim assist
├── enemies/
│   ├── types.ts                enemy archetype definitions
│   ├── ai.ts                   steering behaviours + per-type brains
│   ├── manager.ts              pooled enemy lifecycle + instancing
│   ├── director.ts             wave composition + spawn pacing
│   └── bosses/
│       ├── boss.ts             shared boss framework (phases, patterns)
│       ├── hexard.ts
│       ├── vashkan.ts
│       └── mawcore.ts
├── progression/
│   ├── augments.ts             the augment pool + effect hooks
│   ├── run.ts                  run state, sectors, threat level
│   └── meta.ts                 salvage, unlocks, hangar state
├── audio/
│   ├── engine.ts               Web Audio graph, mixer, ducking
│   ├── sfx.ts                  synthesised sound bank
│   └── music.ts                procedural layered score
└── ui/
    ├── styles.css
    ├── hud.ts                  health, shields, heat, radar, indicators
    ├── draft.ts                augment draft screen
    ├── menus.ts                title, pause, settings, game over
    ├── hangar.ts               meta-progression spending screen
    └── codex.ts                enemy/weapon/augment reference
```

### 16.4 Architectural contracts

- `core/types.ts` is the **contract**. Every module imports from it. Changing it is a
  cross-cutting decision, not a local one.
- Modules communicate through the **typed event bus** or through explicit parameters — never
  through globals or circular imports.
- Rendering never mutates simulation state. Simulation never touches DOM.
- Every system exposes `update(dt: number, ctx: GameContext): void` and, where relevant,
  `reset(): void` for run restarts.

---

## 17. What "done" looks like

- `npm run build` passes with zero TypeScript errors under `strict`.
- A full run is completable: title → 3 sectors → 3 bosses → loop or death → hangar → new run.
- 60 fps at 1080p with 200+ live entities on integrated graphics.
- Every item in `CHECKLIST.md` is ticked.
- The game is fully playable on the keyboard alone, and with a gamepad, and readable in every
  colourblind mode.
