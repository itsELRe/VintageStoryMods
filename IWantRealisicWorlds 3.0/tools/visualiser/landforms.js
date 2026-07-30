// landforms.js — Landform picker + palette
//
// A priority-based multi-condition picker, carried over from the older
// visualiser (deleted 2026-07-27; in git history). Each entry has a code
// (string the game would read), a display name, a colour for the
// visualiser overlay, a priority, and a loose set of placement
// conditions. The picker walks V.LANDFORMS, keeps entries whose every
// condition passes, returns the highest-priority match. A fallback entry
// has no conditions and priority 0 — guarantees every land pixel gets a
// code.
//
// A landform is a derived READING over the other primitives — never a stored or
// interpolated category, so it inherits their smoothness and the anchor mesh
// never prints through the shapes. Sources (the anchor-based interpolated
// fields, not the old polygon maps):
//   elevation          ← upheaval.detailedHeight[i] / 255
//   province           ← V.PROVINCE_NAMES[provinces.primitiveMap[i]]
//   temp / rain        ← climate.detailedTemp[i] / detailedRain[i], each / 255
//   coastPromoted      ← distToOcean < COAST_NEAR_PIXELS
//   nearActiveBoundary ← getDistToActiveBoundary < nearActiveThreshold
//
// Condition rule types (mirrors v1):
//   [a, b] (numbers)     -> value must be in [a, b] inclusive
//   ['X', 'Y', ...]      -> value must equal one of the strings
//   true | false         -> value must equal the boolean
//   undefined key        -> ignored (matches anything)
//
// IMPORTANT: this is the visualiser-side design playground. It uses v1's
// code names (mountain, highmountain, jungle-*, tundra-*, etc.) which are
// NOT the codes in our bundled landforms.json asset. When this design
// settles and we wire to the C# game side, the v1 codes get mapped to
// vanilla VS landform variant indices via a separate translation step.
// For now the codes are LABELS for what we'd like to paint at each region;
// the visualiser shows the logical assignment.

window.VIS = window.VIS || {};

(function (V) {
  'use strict';

  // Curated landform set — every `code` is a real VS landform variant
  // present in our bundled `assets/game/worldgen/landforms.json` (the
  // FlattenedLandforms-style override). Designed to give the world enough
  // variety across climate × province × elevation so it doesn't read as
  // "veryflat everywhere," while staying inside the VS code set we have.
  //
  // v1's invented codes (mountain, highmountain, jungle-*, tundra-*,
  // volcaniccone, fjordcliffs, etc.) dropped — they're not VS-recognised
  // and there's no translation step. Where v1 had a hot+wet "jungle"
  // variant, we use `densecliffyswamplands` as the closest VS-set
  // equivalent. Where v1 had `saltpan` keyed on the Basin province, that
  // condition is dropped — the "Basin" is the tectonic foothill band,
  // not an endorheic depression, so the assumption doesn't hold.
  // `volcaniccone` becomes `step mountains` (closest stepped-volcanic
  // character available). `coastalflat` uses `above sealevel flat
  // grasslands`. `tundraflats` uses `cold glaciers` so cold lowlands get
  // visibly different decoration than warm flatlands.
  //
  // Priorities tuned so the more specific conditions beat the generic
  // ones at the same elevation tier — fallback (veryflat) loses to any
  // tier default; tier defaults lose to climate/province/coast specifics.
  const LANDFORMS = [
    // ── FALLBACK (lowest priority, no conditions) ──
    { code: 'veryflat',                       priority:  0, conditions: {}, color: '#d8e8b0' },

    // ── PLAINS (elevation < 0.25) ──
    { code: 'realisticflatlands',             priority: 20, conditions: { elevation: [0.00, 0.25] }, color: '#98c870' },
    { code: 'above sealevel flat grasslands', priority: 30, conditions: { elevation: [0.00, 0.25], coastPromoted: true }, color: '#a8c898' },
    { code: 'cold glaciers',                  priority: 50, conditions: { elevation: [0.00, 0.30], temp: [0.00, 0.30] }, color: '#c8dce6' },
    { code: 'densecliffyswamplands',          priority: 55, conditions: { elevation: [0.00, 0.25], rain: [0.65, 1.00] }, color: '#4e834a' },
    { code: 'needledflatlands',               priority: 60, conditions: { elevation: [0.00, 0.25], temp: [0.65, 1.00], rain: [0.00, 0.20] }, color: '#e8c878' },

    // ── HILLS (elevation 0.25 - 0.60) ──
    { code: 'rollinghills',                   priority: 30, conditions: { elevation: [0.25, 0.60] }, color: '#a0b060' },
    { code: 'flathillvalley',                 priority: 35, conditions: { elevation: [0.25, 0.60], province: ['Basin'] }, color: '#b4a878' },
    { code: 'hillplateu',                     priority: 40, conditions: { elevation: [0.25, 0.55], province: ['Platform', 'Shield'] }, color: '#c0a870' },
    { code: 'roundclifflandshilly',           priority: 45, conditions: { elevation: [0.25, 0.60], province: ['Shield'] }, color: '#8c8058' },
    { code: 'sparsecliffyswamplands',         priority: 50, conditions: { elevation: [0.25, 0.60], rain: [0.60, 1.00] }, color: '#6c8666' },
    { code: 'lowrollinghills',                priority: 55, conditions: { elevation: [0.25, 0.60], temp: [0.00, 0.30] }, color: '#a0bcd5' },

    // ── MOUNTAINS (elevation > 0.60) ──
    { code: 'Realistic mountains',            priority: 30, conditions: { elevation: [0.60, 1.00] }, color: '#8a7868' },
    { code: 'mediummillionstepmountains',     priority: 55, conditions: { elevation: [0.60, 1.00], province: ['Orogen'] }, color: '#786454' },
    { code: 'tallmillionstepmountains',       priority: 65, conditions: { elevation: [0.60, 1.00], province: ['Orogen'], nearActiveBoundary: true }, color: '#a09080' },
    { code: 'step mountains',                 priority: 60, conditions: { elevation: [0.60, 1.00], province: ['Large Igneous', 'Extended Crust'], nearActiveBoundary: true }, color: '#6e584c' },
    { code: 'cold mountain range',            priority: 75, conditions: { elevation: [0.60, 1.00], temp: [0.00, 0.32] }, color: '#e8edf3' },

    // ── COAST-SPECIFIC (high priority — distinguishes coastal cliffs) ──
    { code: 'sharp cliff islands',            priority: 80, conditions: { coastPromoted: true, coastalRise: [0.20, 1.00] }, color: '#6a7080' },
    { code: 'cliffislands',                   priority: 65, conditions: { coastPromoted: true, elevation: [0.10, 0.40] }, color: '#808090' },
  ];

  // Picker constants (mirrors v1).
  const COAST_BASELINE = 0.02;
  const COAST_NEAR_PIXELS = 5;     // coastPromoted = within this many pixels of coast
  const NEAR_ACTIVE_BASE = 18;     // multiplied by mapScale at build time

  // Precompute [r,g,b] triples on every entry so renderer doesn't parseInt the hex per pixel.
  for (let i = 0; i < LANDFORMS.length; i++) {
    const hex = LANDFORMS[i].color;
    LANDFORMS[i].rgb = [
      parseInt(hex.substr(1, 2), 16),
      parseInt(hex.substr(3, 2), 16),
      parseInt(hex.substr(5, 2), 16),
    ];
  }

  // Picker: highest-priority entry whose every condition passes.
  function pickLandform(vals) {
    let best = null;
    for (let i = 0; i < LANDFORMS.length; i++) {
      const lf = LANDFORMS[i];
      if (!_matchesAll(lf.conditions, vals)) continue;
      if (!best || lf.priority > best.priority) best = lf;
    }
    return best;
  }

  function _matchesAll(cond, vals) {
    for (const key in cond) {
      if (!_matchesOne(cond[key], vals[key])) return false;
    }
    return true;
  }

  function _matchesOne(rule, value) {
    if (Array.isArray(rule)) {
      if (rule.length === 2 && typeof rule[0] === 'number') {
        return value >= rule[0] && value <= rule[1];
      }
      return rule.includes(value);
    }
    if (typeof rule === 'boolean') return value === rule;
    return true;
  }

  // Build a per-pixel landform palette-index map. Walks every land pixel,
  // constructs the value bag from primitives, picks a landform, stores
  // the LANDFORMS index. Ocean pixels get 255 (sentinel — renderer skips
  // to ocean colour). Optional `usePrimitiveLand` selects the faceted
  // primitive landGrid vs the emergent coast-field mask.
  function buildPixelLandformMap(mapW, mapH, provinces, climate, upheaval, continent, tectonic, usePrimitiveLand, distanceFields, coastField) {
    const out = new Uint8Array(mapW * mapH);
    if (!provinces || !provinces.primitiveMap || !upheaval || !upheaval.detailedHeight) {
      return out; // all-zero (palette index 0 = veryflat fallback)
    }
    const provMap = provinces.primitiveMap;
    const heightMap = upheaval.detailedHeight;
    const enclosedGrid = provinces.enclosedGrid;
    const lgArr = usePrimitiveLand
      ? (continent && continent.landGrid)
      : ((coastField && coastField.landMask) || (continent && continent.landGrid));

    const mapScale = V.phiScale ? V.phiScale(Math.max(mapW, mapH)) : 1.0;
    const nearActiveThreshold = NEAR_ACTIVE_BASE * mapScale;

    const provinceNames = V.PROVINCE_NAMES || [
      'Shield', 'Platform', 'Orogen', 'Basin', 'Large Igneous', 'Extended Crust',
    ];

    for (let z = 0; z < mapH; z++) {
      for (let x = 0; x < mapW; x++) {
        const i = z * mapW + x;

        // Ocean — sentinel index 255, renderer paints ocean colour.
        if (lgArr && lgArr[i] !== 1) { out[i] = 255; continue; }

        const provinceByte = provMap[i];
        const provinceName = provinceNames[provinceByte] || 'Shield';
        const elevation = heightMap[i] / 255;

        // Climate — the interpolated-and-blurred anchor climate rasters.
        const temp = (climate && climate.detailedTemp) ? climate.detailedTemp[i] / 255 : 0.5;
        const rain = (climate && climate.detailedRain) ? climate.detailedRain[i] / 255 : 0.5;

        // Coast — coastPromoted = "near coast" (v1's mesh-promoted-triangle
        // analogue at pixel granularity). NOTE: COAST_NEAR_PIXELS (5px) is
        // tight relative to typical anchor spacing — getDistToOceanAt snaps
        // to the nearest anchor's stored value rather than interpolating,
        // so this may under-resolve a thin coastal strip. Verify visually.
        // The coast field reclassifies columns but never moves space, so the
        // raw coordinate reads the right primitive data in both modes (the
        // swirl-era coordinate pullback is gone with the swirl).
        let coastDist = Infinity;
        if (distanceFields) {
          coastDist = distanceFields.getDistToOceanAt(x, z);
        }
        const coastPromoted = coastDist < COAST_NEAR_PIXELS;
        const coastalRise = coastPromoted ? Math.max(0, elevation - COAST_BASELINE) : 0;

        // Boundary distance — translated v1's `nearActiveBoundary` directly.
        let nearActiveBoundary = false;
        if (tectonic && tectonic.getDistToActiveBoundary) {
          nearActiveBoundary = tectonic.getDistToActiveBoundary(x, z) < nearActiveThreshold;
        }

        const vals = {
          elevation,
          province: provinceName,
          temp, rain,
          coastPromoted, coastalRise,
          nearActiveBoundary,
        };

        const lf = pickLandform(vals);
        out[i] = lf ? LANDFORMS.indexOf(lf) : 0;
      }
    }

    return out;
  }

  V.LANDFORMS = LANDFORMS;
  V.pickLandform = pickLandform;
  V.buildPixelLandformMap = buildPixelLandformMap;
})(window.VIS);
