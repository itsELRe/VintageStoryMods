# IWantRealisticWorlds - How It Works

**A framework for adding custom terrain to Vintage Story**

---

## What This Mod Does

The core mod lets addon mods add terrain features (mountains, rivers, lakes) on top of vanilla terrain. Vanilla generates the world normally, then our mod modifies specific areas where features exist. Everything else stays vanilla.

Two types of features:
- **Node features** - single-point shapes like volcanoes or lakes
- **Network features** - connected paths like ridges or rivers

---

## How Terrain Generation Works

Vanilla VS generates terrain in stages. Our mod hooks in after the first stage:

```
1. GenTerra         - vanilla places all blocks + water, sets heightmaps
2. CustomGenTerra   - OUR MOD modifies feature areas only (delta handler)
3. GenRockStrata    - replaces generic rock with granite, basalt, etc.
4. GenCaves         - carves caves
5. GenBlockLayers   - adds soil, grass, sand on top
```

### The Delta Handler (CustomGenTerra.cs)

For each block column in a chunk:

1. Read vanilla's heightmap (what GenTerra produced)
2. Ask all nearby features: "what height do you want here?"
3. Each feature returns a `HeightOutput` (absolute or relative) or null (no opinion)
4. Resolve all results using two-phase blending (see below)
5. If resolved height is higher than vanilla: add rock blocks above vanilla surface
6. If resolved height is lower than vanilla: clear blocks above resolved surface
7. Update heightmaps so later stages (rock strata, soil) work correctly

**The granite fix:** When we lower terrain, we explicitly clear the blocks between the new surface and the old surface. Without this, GenRockStrata doesn't process those blocks, leaving them as raw granite.

**Water:** Carved areas below sea level fill with water automatically. Features that implement `ILayeredFeature` control their own water placement (e.g. lakes fill their bowl).

**Beach transitions:** The OceanMapPainter runs during MapRegionGeneration (before GenTerra) and paints "land" on the OceanMap wherever features exist, plus a 32-block buffer ring. This makes vanilla GenTerra generate land terrain (not ocean floor) at feature sites, producing natural beach transitions at feature edges.

### Two-Phase Blending

Features express height as either **absolute** ("set Y to 70") or **relative** ("add +80 to current terrain"). The core resolves them in two phases:

**Phase 1 — Absolute features:** All absolute results compete. MAX wins. This overrides vanilla if any absolute feature claims the column. Example: a volcano at Y=180 and a lake floor at Y=55 — the volcano's Y=180 wins.

**Phase 2 — Relative features:** All relative offsets apply on top of the Phase 1 result. Among positive offsets (builders), MAX wins. Among negative offsets (carvers), MIN wins. Both then combine additively.

Example: a ridge returns +80 (relative builder) and a river returns -20 (relative carver) at the same column. Result: Phase 1 base + 80 - 20 = Phase 1 base + 60. The river cuts through the ridge naturally.

If no absolute feature claimed the column, Phase 1 base = vanilla height. Relative features always work regardless of what happened before them.

---

## HeightOutput

The return type from `GetDirectHeight`. A feature returns one of:

| Mode | Meaning | Example |
|------|---------|---------|
| `HeightOutput.Absolute(y)` | "Set terrain to Y" | Lake floor at Y=55, volcano peak at Y=180 |
| `HeightOutput.Relative(offset)` | "Add offset to current terrain" | Ridge adds +80, river cuts -20 |
| `null` | "I have no opinion on this column" | Column is outside this feature |

A single feature can return different modes per column. A lake returns absolute for the bowl and shore, null outside its radius. A ridge returns relative everywhere it has influence, null outside.

---

## Core Files

| File | What it does |
|------|-------------|
| `CustomGenTerra.cs` | Delta handler. Two-phase blending, builds/carves blocks, updates heightmaps. |
| `RealisticWorldsMod.cs` | Entry point. Loads config, creates FeatureNetwork, wires everything up. |
| `Features/IFeature.cs` | Interface all features implement: `HeightOutput? GetDirectHeight()` + bounding box. Also defines `HeightOutput`, `ILayeredFeature`, `ColumnLayer`. |
| `Features/SpawnConfig.cs` | Factory interfaces. `IFeatureFactory` for nodes, `INetworkFactory` for networks. |
| `Features/FeatureSpawnRegistry.cs` | Where addons register their factories. Core reads this during generation. |
| `Features/FeatureNetwork.cs` | Zone/plate grid system. Decides where features spawn, calls factories. Caches OceanMap data for land/ocean placement checks. |
| `Features/FeatureRegistry.cs` | Stable API facade over FeatureNetwork. CustomGenTerra and OceanMapPainter call through here. |
| `OceanMapPainter.cs` | Paints "land" on the OceanMap where features exist, so GenTerra generates land terrain (not ocean) at feature sites. |
| `CoreConfig.cs` | Config fields: plateSize, zoneSize, density, heights, weights. |

---

## The Zone/Plate System

The world is divided into a grid:

```
Plate = 8000x8000 blocks (generated lazily, cached)
Zone  = 512x512 blocks (one feature per zone max)
```

Each plate has 16x16 = 256 zones. When a chunk is generated, nearby plates are loaded (or created on first access). Generation is deterministic — same world seed always produces the same features.

### How Features Get Placed

For each zone in a plate:

1. Roll density check (default 50% chance)
2. Pick a feature type from weighted list (e.g. "volcanoes": 3, "ridges": 5)
3. **Placement check:** Is this land or ocean? Skip if the feature's placement constraint (`Land`, `Ocean`, `Anywhere`) doesn't match. Uses cached OceanMap data from MapRegions, with a simple edge-distance fallback.
4. Check climate at zone center (temperature + rainfall)
5. Jitter position within zone, then check **distance constraints** (same-type minimum distance, any-type minimum distance)
6. Call factory, check bounding-box overlap (skippable for composites), add to plate

---

## Configuration

**Config file:** `assets/iwrw/config/core.json`
**User override:** `ModConfig/IWantRealisticWorlds/core.json`

```json
{
  "globalHeightLimit": 0.88,        // max feature height as % of world height
  "footprintScaleMultiplier": 1.0,  // scales area. 2.0 = radius * sqrt(2)
  "globalLandformDensity": 50,      // % of zones that get a feature
  "plateSize": 8000,                // generation unit size
  "zoneSize": 512,                  // one feature per zone max
  "searchRadius": 1500,             // how far to look for features per chunk
  "featureWeights": {               // relative spawn rates
    "volcanoes": 3
  },
  "debugLogging": false
}
```

Feature weights are auto-updated when addons register. Your edits are preserved.

---

## FAQ

**Q: Does this replace vanilla terrain?**
No. Vanilla GenTerra runs normally. We modify specific columns after it finishes.

**Q: What about the granite bug?**
Fixed. When we carve terrain down, we explicitly clear blocks above the new surface. GenRockStrata then processes the correct height.

**Q: What if features overlap?**
Two-phase blending. Absolute features compete (MAX wins). Relative features stack their offsets on top. A ridge and river overlapping produces a ridge with a river channel cut through it.

**Q: Can features spawn in oceans?**
It depends on the feature's `placement` setting. Features registered with `FeaturePlacement.Land` only spawn on land (the core reads cached OceanMap data to check). Features with `Anywhere` or `Ocean` can spawn in ocean areas. The OceanMapPainter paints land on the OceanMap where features exist (plus a 32-block beach buffer), so vanilla GenTerra generates land terrain with natural beach transitions at feature sites rather than ocean floor.

**Q: How precise are features?**
1-block. `GetDirectHeight` is called for every single block column.

**Q: Does this work with other mods?**
Yes, as long as they don't replace GenTerra entirely. We run after it in the same pass.

**Q: What's the difference between absolute and relative?**
Absolute sets a fixed Y level ("lake floor at Y=55"). Relative adds/subtracts from whatever the terrain is ("ridge adds +80 blocks"). Relative features don't care what happened before them — they just modify the result.

---

## For Addon Developers

See `crash_course_into_addons.md` for how to build your own terrain features.
