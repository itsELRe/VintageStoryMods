# Crash Course: Building an Addon

**Everything you need to know to create a terrain feature for IWantRealisticWorlds.**

For detailed examples, look at the three existing addons: Lakes, Ridges, Volcanoes.

---

## What an Addon Is

An addon is a separate VS mod that depends on the core. It provides:

1. A **Feature** — implements `IFeature`, answers "what height do you want at (X, Z)?"
2. A **Factory** — implements `IFeatureFactory`, creates Feature instances with randomized parameters
3. A **ModSystem entry point** — registers the factory with the core during startup

That's it. The core handles spawning, overlap checks, terrain modification, heightmaps, and block placement. Your addon only decides *shape and height*.

---

## The Three Files You Write

### 1. Feature (implements `IFeature`)

The core calls `GetDirectHeight` for every block column in your feature's bounding box. You return a `HeightOutput` or `null`:

```csharp
public HeightOutput? GetDirectHeight(double worldX, double worldZ, int baseHeight, int peakHeight)
{
    // baseHeight = vanilla terrain height at this column
    // peakHeight = world height cap

    double dist = Distance(worldX, worldZ, centerX, centerZ);
    if (dist > radius) return null; // Outside my feature

    // Option A: Absolute — "set terrain to this Y"
    return HeightOutput.Absolute(65);

    // Option B: Relative — "add this offset to current terrain"
    return HeightOutput.Relative(40);   // build 40 blocks up
    return HeightOutput.Relative(-20);  // carve 20 blocks down
}
```

**When to use absolute:** You know the exact Y you want. Lakes (floor at Y=55), plateaus (flat at Y=90).

**When to use relative:** You want to add/remove height regardless of what the terrain is. Ridges (+80 on top of whatever), river channels (-20 below whatever).

**Bounding box:** You also implement `GetMinBounds()` and `GetMaxBounds()` returning `BlockPos`. The core uses these for spatial queries — only features whose bounding box is near the current chunk get queried. Pad generously (better to check a few extra columns than to clip your feature).

### 2. Factory (implements `IFeatureFactory`)

The core calls `CreateFeature` once per spawn location with a deterministic `Random`. You randomize parameters and return a feature instance:

```csharp
public class MyFactory : IFeatureFactory
{
    public IFeature CreateFeature(double worldX, double worldZ, Random rand)
    {
        double radius = 60 + rand.NextDouble() * 120;  // 60-180 blocks
        int depth = 10 + rand.Next(11);                 // 10-20 blocks
        return new MyFeature(worldX, worldZ, radius, depth);
    }

    public double GetMinRadius() => 60;   // Smallest possible footprint
    public double GetMaxRadius() => 200;  // Largest possible footprint (with padding)
}
```

`GetMinRadius` / `GetMaxRadius` are used by the core for overlap checking.

### 3. Entry Point (extends `ModSystem`)

Register your factory with the core. This runs during server startup:

```csharp
public class MyMod : ModSystem
{
    public override double ExecuteOrder() => 0.2; // After core (0.05)
    public override bool ShouldLoad(EnumAppSide side) => side == EnumAppSide.Server;

    public override void StartServerSide(ICoreServerAPI api)
    {
        var factory = new MyFactory();
        FeatureSpawnRegistry.Register("myfeature", factory,
            defaultWeight: 5,                          // Relative spawn rate
            placement: FeaturePlacement.Land,           // Land, Ocean, or Anywhere
            climate: null,                              // null = any climate
            skipOverlapCheck: false,                    // true if features blend naturally (like ridges)
            minSameTypeDistance: 500,                   // Min blocks between same-type features
            minAnyTypeDistance: 0);                     // Min blocks from any other feature
    }
}
```

---

## Registration Parameters

| Parameter | What it does |
|-----------|-------------|
| `name` | Unique string ID. Shows up in config's `featureWeights`. |
| `defaultWeight` | Relative spawn frequency. Higher = more common. |
| `placement` | `Land` (skip ocean zones), `Ocean` (skip land), `Anywhere`. Core reads cached OceanMap data to enforce this. |
| `climate` | `ClimateRange` with min/max temp and rainfall (0-255). Null = no restriction. |
| `skipOverlapCheck` | Skip bounding-box overlap check. Use for features that blend naturally (e.g. ridges with MAX blending). |
| `minSameTypeDistance` | Min center-to-center distance between features of this type. Prevents clustering. |
| `minAnyTypeDistance` | Min distance from any other feature. 0 = only bounding-box overlap check. |

---

## How the Core Processes Your Feature

1. Core divides the world into **zones** (512x512 blocks). One feature per zone max.
2. For each zone, core rolls a density check, picks a weighted feature type.
3. **Placement check**: Uses cached OceanMap data to determine land vs ocean. Features registered as `Land` skip ocean zones, `Ocean` skips land zones, `Anywhere` skips nothing.
4. Checks climate at zone center (temperature + rainfall).
5. Jitters position, checks **distance constraints** (same-type and any-type minimums).
6. Calls your `factory.CreateFeature(x, z, rand)` to instantiate the feature.
7. Checks bounding-box overlap (unless `skipOverlapCheck` is set).
8. During chunk generation, core queries all features near the chunk.
9. For each block column, core calls `GetDirectHeight` on every nearby feature.
10. Results are blended:
    - **Absolute results:** MAX wins (tallest absolute height overrides vanilla)
    - **Relative results:** Positive offsets MAX among them, negative offsets MIN. Both stack on top of the absolute base.
11. Core adds/removes rock blocks to match the resolved height, updates heightmaps.

You never touch blocks directly. You just return heights.

---

## Adding Water (ILayeredFeature)

If your feature needs water, ice, or lava, implement `ILayeredFeature` instead of `IFeature`:

```csharp
public class MyLake : ILayeredFeature
{
    public HeightOutput? GetDirectHeight(...) { /* carve the bowl */ }

    public ColumnLayer[] GetColumnLayers(double worldX, double worldZ, int baseHeight, int peakHeight)
    {
        // baseHeight here = the resolved rock surface (after carving)
        if (baseHeight >= waterLevel) return null; // Rock is above water, no water needed
        return new[] { new ColumnLayer(ColumnBlockType.Water, waterLevel) };
    }
}
```

The core places water blocks between the rock surface and the layer's `TopY`. This runs in the Terrain pass, so vanilla's GenBlockLayers sees the water and generates gravel/sand underneath naturally.

Features that don't need water (ridges, volcanoes) just implement `IFeature` and ignore this entirely.

---

## Project Setup

Your addon is a separate .csproj that references the core:

```xml
<ProjectReference Include="../../IWantRealisticWorlds.csproj">
  <Private>false</Private>
</ProjectReference>
```

And a `modinfo.json` declaring the dependency:

```json
{
  "type": "code",
  "modid": "iwrwmyfeature",
  "name": "IWRW - My Feature",
  "version": "0.1.0-dev",
  "dependencies": {
    "game": "1.21.0",
    "iwantrealisticworlds": "0.1.0-dev"
  },
  "side": "Server"
}
```

Namespace convention: `RealisticWorlds.MyFeature`. Assembly name: `RealisticWorlds.MyFeature`.

---

## Config Loading

If your addon has configurable parameters, follow the same pattern as the core:

1. **Bundle defaults** in `assets/<modid>/config/<name>.json`
2. **On first run**, copy the asset config to `ModConfig/IWantRealisticWorlds/<name>.json`
3. **On subsequent runs**, read from ModConfig (user-editable)
4. **Fallback** to class defaults if both asset and file are missing

```csharp
string modConfigPath = Path.Combine(
    sapi.GetOrCreateDataPath("ModConfig"), "IWantRealisticWorlds", "myfeature.json");

if (File.Exists(modConfigPath))
    json = File.ReadAllText(modConfigPath);
else
{
    var asset = sapi.Assets.Get(new AssetLocation("iwrw-myfeature:config/myfeature.json"));
    if (asset != null)
    {
        json = asset.ToText();
        Directory.CreateDirectory(Path.GetDirectoryName(modConfigPath));
        File.WriteAllText(modConfigPath, json);
    }
}
```

This ensures the bundled asset config is the single source of truth for defaults, and users can edit the copy in ModConfig.

---

## Quick Reference

```
Your addon provides:           The core handles:
--------------------------     --------------------------
IFeature.GetDirectHeight()     Zone/plate spawning
IFeatureFactory.CreateFeature  Land/ocean placement checks
FeatureSpawnRegistry.Register  Overlap & distance checks
Config loading (optional)      Block placement (rock/air)
                               Heightmap updates
                               Water fill below sea level
                               Two-phase height blending
                               Beach transitions (OceanMapPainter)
```

The existing addons (Lakes, Ridges, Volcanoes) in `Addons/` are the reference implementations. Start there.
