# Starfall Armada X — session handoff

## Current branch

Work in progress is on `agent/heat-blink-feedback`, based on the latest `main` after the
8-colour enemy-projectile palette fix was merged.

Before continuing from another environment:

```bash
git fetch origin
git checkout agent/heat-blink-feedback
npm install
npm run check
```

The GitHub connector used for this pass could commit files but could not clone the repository,
and this repository has no branch-triggered status checks. Therefore the current branch still
needs the full local `npm run check` gate before merge.

## Read first

`CLAUDE.md` is the project map. Do not read all of `DESIGN.md` or `CHECKLIST.md` unless the task
specifically requires design/release context. The core invariants remain:

- Fixed 60 Hz simulation; presentation is separate.
- No DOM/render imports in simulation systems.
- No allocation in hot update loops.
- No `any`, external assets, or network requests.
- Persisted data is validated and clamped.

`src/game.ts`, `src/core/constants.ts`, and `src/ui/hud.ts` are the most contended files. Give each
to only one parallel worker at a time.

## Verification gate

```bash
npm run typecheck
npm run selftest
npm run verify
```

Never merge a red tree.

## Architecture facts that still matter

- `EnemyManager.getByIndex(i)` accepts a permanent pool-slot identity. Iteration over the dense
  live prefix must use `getLiveByOrdinal(i)`.
- Bosses live outside the pooled enemy manager. Anything needing all targetable hostiles must use
  `CombinedEnemyQuery` / `game.ts`'s `targetQuery`.
- Projectiles are pooled and rendered as two instanced meshes in `combat/projectiles.ts`.
- Enemy projectile colour indexes correspond directly to `ENEMY_ORDER`. There are now eight enemy
  archetypes and every palette has eight entries; preserve that one-to-one cardinality.
- Only Wraith currently receives `altPrimary`; the other hulls still produce a no-op on swap.
- Difficulty still scales only enemy damage, player hull, and enemy count.

## Completed and merged on main

- Keyboard-first unrestricted flight, camera fixes, lock-on dwell/assist, boss targeting.
- Real overheat/venting and tapped three-use blink movement.
- Radar/enemy-index fixes, boss hitbox/gating fixes, EMP glare reduction.
- Destructible/rammable Debris Belt asteroids and functional Ion Storm shield suppression.
- Out-of-combat hull regeneration and HUD EMP status.
- Mortar and Warden enemy archetypes.
- Eight-entry accessible enemy-projectile palettes.
- Single-file offline build and verification tooling.

## Completed on `agent/heat-blink-feedback`

1. **Heat-visible player fire**
   - `combat/projectiles.ts` computes current weapon heat once per simulation step.
   - All visible player projectiles progressively blend toward the active palette's danger colour.
   - Default mode therefore moves toward red; colourblind modes use their accessible semantic
     danger colour rather than relying on red discrimination.
   - The curve is intentionally weighted toward the final third of the heat range, preserving each
     weapon's identity at low heat while making imminent overheat obvious near the target.

2. **Blink charge HUD**
   - Added `ui/hud-feedback.css`, loaded from `main.ts`.
   - The old continuous Boost percentage now reads visually as three discrete Blink charge slots.
   - Partial recharge fills the next slot, while complete slots show how many activations are ready.

3. **Mine arming telegraph**
   - Enemy mines grow during their one-second arming window.
   - Armed mines continue a strong size/colour pulse toward the palette's lethal telegraph colour,
     preventing stationary hostile mines from resembling collectible pickups.

## Remaining work, in recommended order

1. **Run and repair the verification gate for this branch.**
   - Pay particular attention to TypeScript, WebGL instance colour updates, CSS import order, and
     the offline/single-file build.

2. **Difficulty step change + difficulty-scaled hull regeneration.**
   - Add enemy health, speed, fire-rate/aggression, elite-frequency, and wave-pressure axes.
   - Target hull-regeneration multipliers: Cadet strong, Pilot baseline, Ace minimal, Nightmare 0.
   - Suggested starting points are 1.6 / 1.0 / 0.4 / 0.0, followed by playtest tuning.

3. **Weapon swapping breadth and feedback.**
   - Give additional hulls purposeful alternate primaries or redesign swapping as a loadout-wide
     mechanic.
   - Always provide feedback when a swap cannot occur; never silently consume the keypress.

4. **Temporary flyable pickups.**
   - Short-duration combat modifiers ejected from kills, distinct from draft cards.
   - They should retain momentum and be able to leave the arena, creating a chase decision.
   - Likely ownership: new `progression/pickups.ts`, rendering/collection wiring in `game.ts`.

5. **Difficulty and roster playtest pass.**
   - Confirm Mortar/Warden threat budgets, palette mappings, mine readability, asteroid attrition,
     EMP shield drain, hull regen, and Nightmare lethality together rather than in isolation.

6. **Optional HUD polish.**
   - Expose Hexard's core-resistance gate using `BossEncounter.coreResistant` and `.liveAddCount`.

## Known loose ends

- `targeting.update()` runs before `enemies.update()`, so targeting sees a one-frame-stale grid.
- The asteroid terrain callback currently applies flat rock damage to both player and enemy shots
  because `blockedByTerrain` receives neither projectile team nor actual shot damage. A cleaner
  contract would return the asteroid index and separately pass team/damage.
- The blink HUD override changes visible text with CSS; when `hud.ts` is next edited, make the DOM
  label itself `Blink charges` so assistive technology receives the same wording.

## Working agreement

The user play-tests between sessions. Push playable snapshots before ending. Do not open a pull
request unless requested; the user normally creates and merges it. Keep this handoff current before
session limits become a risk.
