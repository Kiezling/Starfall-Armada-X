# Starfall Armada X — agent orientation

3D space-fighter roguelite. TypeScript (strict) + Three.js 0.185 + Vite. ~23k lines in `src/`.
Zero external assets: every mesh, texture, and sound is generated at runtime.

**Read this file first and treat it as the map. Do not read `DESIGN.md` (27 KB) or
`CHECKLIST.md` (12 KB) unless the task is genuinely about design intent or release status** —
they are reference documents, not context. `README.md` is for humans running the project.

## Commands

```bash
npm run typecheck   # tsc --noEmit — run this after every change
npm run selftest    # headless simulation assertions (src/selftest.ts)
npm run verify      # static + Playwright checks (scripts/verify.mjs)
npm run check       # all three; the gate before pushing
npm run dev         # vite dev server on :5173
```

`npm run typecheck` is cheap; run it often. `npm run check` before committing.

## Where things live

| Area | Path | Notes |
| --- | --- | --- |
| State machine, system wiring | `src/game.ts` | The hub. Owns every system; ~1.2k lines. Touch surgically. |
| Tunables | `src/core/constants.ts` | `ARENA`, `LIMITS`, `PLAYER`, `FEEL`, `RUN`. Balance changes belong here, not inline. |
| Shared type contract | `src/core/types.ts` | Enums (`GameState`, `Difficulty`, `AimAssist`) and every cross-system interface. |
| Input | `src/core/input.ts`, `src/core/settings.ts` | Keyboard is the primary device. `DEFAULT_KEYBINDS` + fixed `ALT_KEYBINDS`. |
| Flight | `src/ship/flight.ts` | Not Newtonian, deliberately. Boost + drift live here. |
| Combat | `src/combat/` | `weapons.ts` (defs + heat), `targeting.ts` (lock-on), `projectiles.ts`, `damage.ts`. |
| Enemies | `src/enemies/` | `types.ts` (archetype defs), `ai.ts`, `manager.ts` (pool + iteration), `director.ts` (waves). |
| Bosses | `src/enemies/bosses/` | `boss.ts` (shared), `vashkan.ts`, `hexard.ts`, `mawcore.ts`. |
| Rendering | `src/render/` | `arena.ts` (hazards/asteroids), `starfield.ts`, `environment.ts`, `fx/`. |
| HUD & screens | `src/ui/` | `hud.ts` (in-flight), `menus.ts`, `draft.ts` (augment cards), `hangar.ts`, `codex.ts`. |
| Progression | `src/progression/` | `run.ts` (one run), `meta.ts` (persistent salvage/unlocks), `augments.ts`. |
| Assertions | `src/selftest.ts` | Headless. Update it when you deliberately change behaviour it asserts on. |

## Invariants — breaking these is a bug, not a style nit

1. **Simulation never touches presentation.** Flight, weapons, projectiles, and enemies emit on
   the typed event bus; `game.ts:bindEvents` turns those into particles, sound, and shake. This
   is why the module graph has no cycles. Do not import a renderer or the DOM into `src/combat/`
   or `src/enemies/`.
2. **Fixed 60 Hz timestep.** `simulate()` runs on an accumulator; rendering is per-frame. Things
   that must freeze during hit-stop take `dt`; things that must not (UI, camera shake, audio)
   take `rawDt`.
3. **Zero allocation on hot paths.** Scratch vectors (`core/math.ts`), object pools
   (`core/pool.ts`), and instanced meshes are pre-allocated. No `new`, no array/object literals,
   and no closures inside per-frame update methods.
4. **No `any`, no external assets, no network requests.** The no-network property is enforced by
   `npm run verify`, not merely claimed.
5. **Persisted data is untrusted.** Anything from `localStorage` (`core/settings.ts`,
   `core/save.ts`) is re-validated and clamped on load; a stale schema must never yield an
   out-of-range value.

## House style

Doc comments explain **why**, not what — the existing density is the target, so match it rather
than trimming it. Constants get a comment justifying the number. When you change a balance value,
show the arithmetic that produced it.

## Working in parallel

`src/game.ts`, `src/core/constants.ts`, and `src/ui/hud.ts` are the contended files. If several
agents are running, exactly one may own each of those at a time; the others report the edit they
need instead of making it.
