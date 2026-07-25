# Starfall Armada X

A 3D space-fighter roguelite built with Three.js. Fly the *Starfall*, draft augments between
waves, break the Armada.

**Zero external assets.** Every mesh, texture, and sound is generated at runtime — procedural
geometry, canvas-drawn textures, GLSL shaders, and Web Audio synthesis. The whole game ships as
one HTML file and one JS bundle, runs offline from any static file server, and makes no network
requests at all. That last property is enforced by an automated check, not just claimed.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build:

```bash
npm run build      # typecheck + bundle into dist/
npm run preview
```

Requires Node 20+ and a browser with WebGL 2.

### Playing it in a browser without a checkout

`.github/workflows/pages.yml` builds the game and publishes `dist/` to GitHub Pages, which
serves it at:

```
https://kiezling.github.io/Starfall-Armada-X/
```

Pages has to be turned on once before the first deploy can succeed: **Settings → Pages →
Build and deployment → Source: GitHub Actions**. The workflow asks `configure-pages` to
create the site automatically, but `GITHUB_TOKEN` is not normally permitted to do so
(`Resource not accessible by integration`), because creating a Pages site needs
repository-admin rights. Until that switch is flipped, the deploy job fails at
`configure-pages` while the build, typecheck, and selftest steps before it still pass.

After enabling it, re-run the latest **Deploy to GitHub Pages** run from the Actions tab —
no new commit is needed.

---

## Controls

**Keyboard only. No mouse is used or required.** The left hand flies the ship's body on WASD;
the right hand flies its nose on the arrow cluster. If you would rather keep both hands on the
home row, `I J K L` steers exactly like the arrows.

| Input | Action |
|---|---|
| `↑` `↓` `←` `→` *(or `I J K L`)* | Steer the nose |
| `W` / `S` | Throttle up / down |
| `A` / `D` | Lateral strafe |
| `Q` / `E` *(or `U` / `O`)* | Manual roll |
| `Space` *(or `/`)* | Fire primary — heat-limited, never runs out of ammo |
| `C` *(or `.`)* | Fire secondary — cooldown and charges |
| `T` *(or `,`)* | **Hold lock** — the nose tracks your target |
| `Tab` *(or `M`)* | Switch target |
| `Left Shift` *(or `Right Shift`)* | Boost |
| `X` *(or `Right Ctrl`)* | **Drift** |
| `F` | Swap weapon (Wraith) |
| `R` | Reroll a draft |
| `Esc` / `P` | Pause |

Menus use the same keys throughout: arrows or WASD move focus, `Enter`/`Space` activates,
`Esc` backs out. Nothing in the game needs a pointer.

Gamepads are also supported, and the primary binding of every action is remappable in Settings.

**Hold lock is how you actually hit things.** Press `Tab` to pick a target, then hold `T`: the
ship walks its nose onto the intercept point — where the target *will be* when your shot
arrives, not where it is now — and a bracket plus a tether line on the HUD shows it happening.
The assist stops the instant you touch a steering key, so it can never fight you for control,
and a ring around the bracket fills up as it approaches its turn-rate limit — when that ring is
full, the target is out-turning the assist and it needs you to help. Let go of the steering keys
and it picks straight back up.

**Drift is the mechanic worth learning.** Holding it decouples your heading from your velocity,
so the ship keeps its momentum while the nose swings free. It is the only way to hold guns on
something that is out-turning you, and it is on a cooldown, so it stays a decision rather than a
mode. Roll auto-levels whenever you are not asking for it, so you can never end up inverted and
lost.

---

## The run

```
Sector 1 · Debris Belt   →  Sector 2 · Ion Storm  →  Sector 3 · The Maw
   Hexard                     Vashkan Prime            The Maw Core
```

Each sector is five waves, an elite wave, and a boss. A draft of three augments follows every
wave. Clearing sector 3 loops the run at a higher Threat Level rather than ending it.

Sector modifiers change the *rules*, not the numbers: asteroids give cover you can shoot enemies
into, EMP fronts disable shields inside them, and The Maw contracts the arena while gravity bends
every shot.

---

## Design notes

The full design document is in [`DESIGN.md`](DESIGN.md), including the research the design is
built on. Four decisions are worth calling out here, because each one is a direct response to a
known failure mode of the genre:

**Assisted arena flight, not 6DOF.** Full six-degrees-of-freedom movement is the genre's classic
disorientation and motion-sickness problem. This game gives full pitch, yaw, and strafing, but
auto-levels roll and bounds the play space in a visible sphere. You always know which way is up
and where the fight is.

**Legible chaos.** Projectile colour is *ownership*, always — player fire is warm and bright,
enemy fire is cool and darker, in every colourblind mode, and the two families are separable by
luminance alone so they survive greyscale. Shape reinforces it: player bolts are elongated, enemy
shots are round. Bosses fire *named patterns* (ring, fan, spiral, wall, aimed-burst, sweep)
because a hundred bullets in one readable shape are easier to dodge than thirty independent ones.

**Randomness is drafted, never dealt.** Augments come as a visible three-card choice with rarity
and full text shown, published odds, a Prototype pity timer, and a reroll. Losing should be
legible in hindsight.

**Meta-progression grants options, never power.** Salvage buys weapons, hulls, augment blueprints,
and liveries — things that widen what a run *can contain*. There is no permanent damage upgrade
anywhere in the tree. A veteran's run 200 has more variety than their run 1, not bigger numbers.
This is asserted by a test: a fully-unlocked profile has byte-identical baseline stats to a
brand-new one.

---

## Verification

```bash
npm run typecheck   # strict TypeScript, no implicit any, no unused locals
npm run selftest    # headless logic tests — no browser needed
npm run verify      # boots a real build in headless Chromium
npm run check       # all three
```

`selftest` covers the invariants a screenshot cannot: that stat recomputation stays finite under
every augment combination, that drafts always fill and never repeat, that every unlock is
reachable, and that the pooling, spatial hash, hit-stop, and RNG behave.

`verify` boots the built game in headless Chromium with a software GL backend and asserts it
loads, holds a WebGL context, keeps its frame loop alive, logs no errors, and — importantly —
issues **zero external requests**. It has already caught two crashes that typechecking could not:
a `mergeGeometries` call returning `null` on mixed indexed/non-indexed input, and a TypeScript
helper name pasted into GLSL source.

---

## Architecture

```
src/
├── core/        contract types, math, pooling, RNG, event bus, fixed-timestep clock, input
├── render/      renderer + adaptive quality, chase camera, starfield, arena, palette, fx/
├── ship/        procedural hull geometry, flight model, player state
├── combat/      pooled projectiles, weapons, damage, targeting
├── enemies/     archetypes, steering AI, pooled manager, wave director, bosses/
├── progression/ augments, run structure, meta unlocks
├── audio/       Web Audio graph, synthesised SFX bank, procedural score
├── ui/          HUD, draft, menus, hangar, codex
└── game.ts      state machine and the wiring between all of it
```

Two rules hold the structure together:

1. **Simulation never touches presentation.** Combat, enemies, and flight never import the
   renderer, the DOM, or the audio graph. They announce what happened on a typed event bus, and
   `game.ts` turns those announcements into particles, sound, and camera shake. That is why the
   module graph has no cycles despite everything reacting to everything.

2. **Nothing allocates in the hot loop.** Every entity is pooled, every projectile and enemy is
   instanced, collision goes through a uniform spatial hash, and vector maths borrows from a
   shared scratch pool. The garbage collector has nothing to do during play, so there are no
   frame hitches.

Simulation runs at a fixed 60 Hz with an accumulator, so behaviour is identical on a 60 Hz laptop
and a 144 Hz monitor. Adaptive quality sheds bloom resolution before bloom before pixel ratio —
it never sheds gameplay.

---

## Accessibility

Screen-shake and hit-stop each have a 0–100% intensity slider that genuinely reaches zero. There
are four colourblind palettes, three aim-assist levels (magnetism only — it never auto-fires or
snaps), four difficulty levels, a flash/bloom reduction toggle, and full keyboard remapping. No
information is conveyed by colour alone; colour is always paired with shape, icon, or label.
