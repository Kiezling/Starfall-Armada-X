# Starfall Armada X v48 — Tuning Control Board

This is a practical map of **where to tune what** in `starfall_armada_x_v48_sprite_build.html`, with suggested first-pass ranges.

## 0) Fast triage order

1. Wave density floor
2. Boss pacing + lag budget
3. Module readability
4. Tier/value normalization
5. Drop economy

---

## 1) Wave / encounter pacing

| Goal | Primary knobs | Code anchors | First-pass target |
|---|---|---|---|
| Prevent “empty” waves | encounter construction, burst sizes, spawn cadence | `buildEncounterForWave`, `spawnNextEncounterBurst`, `spawnEnemy`, `spawnWave` | Ensure per-wave **minimum total enemy budget** and **minimum active enemies** |
| Smooth difficulty spikes | wave mods and enemy scaling blends | `applyWaveTuning`, `rollWaveMod` | Limit mod multipliers to ±10–15% until stable |
| Keep pacing consistent | wave target/kills + spawn timers | `freshState` (`waveTarget`, `spawnTimer`) | Keep clear-time band within ~70–110 sec on average waves |

---

## 2) Boss pacing and performance

| Goal | Primary knobs | Code anchors | First-pass target |
|---|---|---|---|
| First boss not trivial | first boss HP/shield/damage/speed | `makeEnemy(type=="boss")` + `TUNING.bosses.first*` usage | Target first boss TTK around 25–40s for average build |
| Second boss not brutal wall | later boss base + per-wave scaling | `TUNING.bosses.later*` usage in `makeEnemy` | Cap effective EHP and burst cadence rise |
| Reduce boss lag | projectile density, beams, particles, ring/spiral counts | `updateBossPhase`, `fireRing`, `fireSpiral`, `draw`, collision loops | Reduce simultaneous bullets/effects by 20–35% on boss waves |

---

## 3) Module system clarity (player readability)

| Goal | Primary knobs | Code anchors | First-pass target |
|---|---|---|---|
| Understand what modules are active | persistent visual indicators around ship | `applyHitModules`, `drawShip`, `drawShipGauges`, `syncHud` | Add 4 small colored pips/rings for Arc/Gravity/Plasma/Rupture levels |
| Confirm module impact | proc counters and DPS contribution in HUD | `recordWeaponDamage`, `state.stats.damageByWeapon`, `syncHud` | Show per-wave proc counts + module damage share |
| Preserve slot constraints | slot usage and eligibility | `moduleSlotsUsed`, `canTakeModule`, `addModuleLevel` | Keep hard cap visible: `used/slots` at all times |

---

## 4) Card / tier normalization

| Goal | Primary knobs | Code anchors | First-pass target |
|---|---|---|---|
| Make tier meaningful | card effect magnitudes by tier | `upgradeFactories`, tier machinery (`rollTier`, `boostTier`) | Define min-impact bands per tier (C/B/A/S/X) |
| Stop dominant picks from eclipsing all others | projectile-count and rail-beam power | e.g. `pulseTwin`, `spreadFan`, `railArray`, `missileSalvo` in `upgradeFactories` | Promote to higher tier pool or reduce multipliers/tax less swingy |
| Keep owned-weapon rules intact | card filtering | `cardAllowedForOwnedLoadout`, `selectUpgradeCards` | Do not alter gating semantics |
| Keep reward cadence exciting | spike/high-roll policy | `forceSpikeCard`, `showUpgrades` (menu `%3`, `%10`, pity logic) | Keep cadence but enforce power floor for high tiers |

### Suggested quick “value budget” model
- Assign each card a rough **power score** (e.g., DPS delta + utility score).
- Enforce tier ranges (example):
  - C: 1.0–1.4
  - B: 1.5–2.0
  - A: 2.1–2.8
  - S: 2.9–3.8
  - X: 3.9+ and/or transformational behavior

---

## 5) Drops and reward economy

| Goal | Primary knobs | Code anchors | First-pass target |
|---|---|---|---|
| Make drops feel predictable enough | pity + per-kill drop rates | state fields in `freshState` (`bonusPity`, `shockPity`, `wellPity`), `dropPickup` | Guarantee max drought windows (e.g., no >N kills without key drop) |
| Keep utility loops alive | shock/well charge economy | player shock/well fields in `freshState`, `collectPickup` | Keep average utility use ~every 8–15 sec in midgame |
| Avoid wave-density coupling failures | normalize by wave time not only kills | drop logic + spawn pacing | Consider time-based fallback drops |

---

## 6) Telemetry you already have (use this first)

| Metric | Source |
|---|---|
| Damage by weapon | `state.stats.damageByWeapon`, `recordWeaponDamage` |
| Damage taken | `state.stats.damageTaken` |
| Live HUD refresh | `syncHud`, `maybeSyncHud` |

### Recommended additions
- Time-to-kill per wave
- Boss phase durations
- Average active enemy count
- Module proc counts by type
- Frame-time percentile during boss fights

---

## 7) Safe implementation constraints (from your priorities)

- Keep single-file HTML architecture.
- Keep embedded data-URL sprite implementation.
- Keep tuner/stats/debug visible.
- Keep damage-by-weapon and damage-taken tracking.
- Preserve chain lightning, gravity well/orb behavior, missile target splitting, drone targeting claims, and owned-weapon-only card rules.

---

## 8) Next execution plan (proposed)

1. Add **wave-density floors** and expose their knobs in tuner.
2. Rebalance boss 1/2 stats and projectile budgets with perf caps.
3. Add module visual ring/pips + proc counters.
4. Introduce tier value budget metadata and rebucket outlier cards.
5. Re-tune drop pity/rates with telemetry checkpoints.
