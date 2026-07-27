# Starfall Armada X — session handoff

Paste the block below into a fresh thread. Everything above the line is context
you need; everything below it is the actual instruction.

---

## Kick-off prompt

Continue the playtest-feedback work on **Starfall Armada X**
(`/home/user/Starfall-Armada-X`, repo `Kiezling/Starfall-Armada-X`).

**Branch state — read this before anything else.** PR #9 has already been
**merged into `main`**, so every fix listed under "Done and pushed" below is on
`main` now (merge commit `de96e1f`). A merged pull request is finished and cannot
track new work: start follow-up work from the latest `main`, not by stacking onto
the old merged history.

```bash
git fetch origin main
git checkout -B claude/<new-topic-branch> origin/main
```

If a session reports that this file "doesn't exist," it is on `main` without
having fetched — this file was pushed after PR #9 merged, so it briefly lived
only on the feature branch. `git fetch origin` fixes it. Do not conclude the
prior session's work is missing on that basis; check `git log origin/main`
first.

### Read this first — it saves a large amount of context

**`CLAUDE.md` at the repo root is the map. Read it and nothing else to orient.**
It was written last session specifically to fix the "this project starts with a
huge context" problem. There was no `CLAUDE.md` before, so every session
re-derived the project layout by reading `DESIGN.md` (27 KB), `CHECKLIST.md`
(12 KB), `README.md` (9 KB) and sprawling through 23k lines of source before
doing any work.

**Do not read `DESIGN.md` or `CHECKLIST.md` unless the task is genuinely about
design intent or release status.** They are reference documents, not context.
`CLAUDE.md` already contains: the commands, a where-things-live table, the five
invariants, the house comment style, and the parallel-work file-ownership rule.
If you find yourself wanting the design docs, grep them for the specific section
instead of reading them whole.

Same discipline applies to subagent prompts: tell each agent to read `CLAUDE.md`
first and stay out of the big docs. That single instruction was worth a lot of
budget last session.

### How to run this — orchestrate, don't do it all inline

The user explicitly wants delegation: *"every task needs to be delegated to the
cheapest model that's capable (but don't forget the two strike rule)."* Sonnet
subagents handled every workstream last session successfully. Use
`Agent(subagent_type: "general-purpose", model: "sonnet", run_in_background: true)`.

**The rule that made parallelism safe: strict file ownership.** Agents share one
working tree, so two agents editing the same file lose each other's work. Give
each agent an explicit list of files it may edit, name the files other agents own,
and instruct it that any change needed outside its set goes in its final report as
a precise copy-pasteable note rather than an edit. This worked cleanly across four
concurrent agents. `src/game.ts`, `src/core/constants.ts`, and `src/ui/hud.ts` are
the contended files — exactly one owner each at a time.

Verify agents' claims rather than trusting them. Two of last session's most
important findings were confirmed by independently checking the underlying
contract (the pool's dense-prefix invariant, the boss/EnemyQuery gap) before
committing.

### Gate before every commit

```bash
npm run typecheck    # must be clean
npm run selftest     # 90/90 currently
npm run verify       # 0 page errors, 0 EXTERNAL requests (the game ships assetless)
```

Never commit red. Parallel agents mean the tree is often mid-write; poll until
green rather than committing a broken build:

```bash
for i in $(seq 1 90); do
  if npx tsc --noEmit >/tmp/tc.log 2>&1 && npm run selftest >/tmp/st.log 2>&1; then
    echo GREEN; exit 0; fi; sleep 10; done
# Must be here: without it the loop falls through with the exit status of the
# last `sleep` — i.e. 0 — so a gate that never went green reports success and
# whatever is downstream happily commits a broken snapshot.
echo "STILL RED after 15min"; grep -c '^\[FAIL\]' /tmp/st.log; exit 1
```

A stop hook demands a clean tree each turn. Commit green snapshots of finished
agents' files only, and label genuinely unfinished features "in progress" in the
commit message.

### Architecture facts already established — don't re-derive these

- **Two different index spaces on enemies.** `EnemyManager.getByIndex(i)` takes a
  *permanent pool-slot identity* (what the spatial grid stores and returns).
  `getLiveByOrdinal(i)` takes an ordinal in `[0, liveCount)` over the pool's dense
  live prefix. Confusing them was the root cause of enemies vanishing from the
  radar. Both are documented in `manager.ts`; read those comments before touching
  any enemy iteration.
- **Bosses are outside the pooled enemy system.** `BossEncounter` tests projectiles
  itself and never registers in the pool or grid. `CombinedEnemyQuery`
  (`enemies/bosses/index.ts`) adapts the live boss into the `EnemyQuery` shape;
  `game.ts` builds it as `this.targetQuery` and passes it to all four targeting
  entry points. Anything that needs "all hostiles including the boss" must use
  `targetQuery`, not `this.enemies`.
- **`Arena.isInEmpField(pos)` exists and nothing calls it.** The sector-2 Ion Storm
  shield-disable mechanic is fully built and completely unwired. This is why the
  effect reads as pointless glare.
- **`Arena.damageAsteroid` / `queryAsteroidsNear` / `raycastAsteroids` exist**; only
  `raycastAsteroids` is used, and only to block projectiles. Rocks are currently
  indestructible and cannot be rammed.
- **Only the Wraith hull has a second primary.** `swapWeapon` is wired correctly
  end-to-end; on the other three hulls it is a legitimate no-op with zero feedback,
  which is why it reads as broken.
- **The difficulty table has only three knobs** (`enemyDamage`, `playerHull`,
  `enemyCount`) in `core/constants.ts`. Nightmare is 1.6×/0.85×/1.45× vs Cadet's
  0.7×/1.3×/0.85×. Enemies never get faster, tankier, smarter, or more aggressive.

### Done and pushed (do not redo)

Items 1 (key rollover → cruise throttle; boost is now a tapped blink, both toggles
removed at the user's request), 2 (EMP glare — five contributors, incl. no
per-pixel distance fade and `reduceFlash` never gating it), 3/13/15 (the radar
index bug), 4 (spread 0.012→0.052 rad on Pulse Repeater, per-weapon identity kept),
5/6/19 (bosses lockable, bigger hitboxes with matched meshes, multi-plane fire,
Hexard 88% resistance gate + segments given real HP — they previously had none and
orbited outside the core hitbox), 7 (overheat now latches: 3.34 s to overheat,
2.0 s recovery, `heatMax` 100→65), 9 (rock density 90→40 + collision API only),
12/18/22/24 (answers), 14 (0.45 s lock dwell, `acquisitionProgress` exposed),
16/21 (heading/pitch readout and horizon ladder removed), 20 (sector-clear card
blocked the draft and was picking cards blindly underneath it).

### Remaining work, in priority order

1. **Batch B wiring — highest value, all built but inert.**
   - Rocks: make them collidable and destructible. `arena.setImpactFX(this.impacts)`
     after `ImpactFX` construction; `arena.setReduceFlash(next.reduceFlash)` in
     `applySettings` (note: `applySettings` is not called at boot, so a persisted
     `reduceFlash: true` never applies until the user reopens Settings — pre-existing
     gap affecting hud/render too, worth fixing with one call after `loadSettings()`).
     Change `blockedByTerrain` to return the hit index instead of a boolean and add a
     `damageAsteroid` hook to `CombatContext` so weapon fire damages rocks. Add player
     ram collision via `queryAsteroidsNear`, gated on `takeDamage` returning > 0 so the
     0.6 s invuln window throttles it. Needs a new `PLAYER.collisionRadius` (~3.5).
   - EMP: call `arena.isInEmpField(player.position)` in `simulate()` and gate/drain
     shields in `player.ts`. This is what gives the effect a purpose.
   - Mines (item 18): they are Mine Layer proximity mines. The palette aliasing bug is
     fixed, but they still need an arming pulse in `combat/projectiles.ts` so they stop
     reading as collectible pickups.
   - `input.resetCruise()` on run start; add a cruise-throttle row to the Settings menu
     (`ui/menus.ts`) — the option currently has no UI, so it is unreachable.
2. **Item 10/17 — difficulty step change + regen.** Add scaling axes beyond the three
   that exist: enemy health, speed, fire rate, AI aggression/reaction, elite frequency,
   wave count. Nightmare should be genuinely brutal. Add difficulty-scaled health regen:
   strong on Cadet, less on Pilot, minimal on Ace, none on Nightmare (vampiric augments
   still work).
3. **Item 8 — widen weapon swapping.** Give more hulls a second primary, or rethink the
   mechanic, so "different styles of play for different enemies" actually lands. Also add
   feedback when swap is a no-op.
4. **Item 11 — flyable pickups.** Temporary augments ejected from kills that can fly out
   of the arena, forcing a chase. Distinct from draft cards; short duration (30 s / wave).
   Likely a new `progression/pickups.ts` plus `game.ts` wiring.
5. **Item 23 — new enemy types.** `enemies/types.ts` + `ai.ts`. Note `ENEMY_ORDER` has 6
   entries and the palette now has exactly 6 `enemyProjectile` colours — **adding a 7th
   archetype requires extending every palette** or the modulo aliasing bug returns.
6. **Item 5 follow-up (optional).** A HUD indicator for Hexard's gate:
   `BossEncounter.coreResistant` and `.liveAddCount` are exposed and unused.

### Known loose ends

- `targeting.update()` runs before `enemies.update()` in `simulate()`, so targeting sees
  a one-frame-stale grid. Negligible for most enemies, matters for fast movers. Fix is
  reordering.
- `game.ts` gives no feedback when `swapPrimary()` returns false.

### Working agreement with the user

They play-test between sessions, so **land work in a playable state and push before the
session ends**. Do not open a pull request unless they ask — they asked what the "create
PR" button does and were told it is theirs to click; they have mentioned wanting a merge
to `main` eventually, so offer it near the end rather than assuming. Keep an eye on
budget and wrap up with a handoff before hitting a limit.
