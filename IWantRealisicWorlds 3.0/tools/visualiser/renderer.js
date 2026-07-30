// renderer.js — canvas rendering + pan/zoom + legend
//
// Approach (ported from v1): each canvas matches the canvas-area size, NOT
// the map size. Every render iterates SCREEN pixels and inverse-maps each
// to a map pixel:
//
//   mx = floor((sx - panX) / zoom)
//   my = floor((sy - panY) / zoom)
//
// This avoids the fractional-zoom shimmer the previous CSS-transform
// approach had, and gives crisp pixel display at any zoom level.

window.VIS = window.VIS || {};

(function (V) {

  const OCEAN_COLOR_RGB = [22, 58, 95];          // #163a5f
  const LAND_COLOR_RGB = [122, 140, 95];         // #7a8c5f — muted olive
  const OUTSIDE_RGB = [10, 10, 26];              // background outside the map (#0a0a1a)
  // B&W silhouette palette used as backdrop for vector overlays (wind, ocean
  // current later). High-contrast against coloured arrows.
  const BW_LAND_RGB = [200, 200, 200];
  const BW_OCEAN_RGB = [60, 60, 60];
  // v1 plate colours — semi-transparent so they stay readable across both
  // dark ocean and the lighter province palette.
  const PLATE_BOUNDARY_COLOR = 'rgba(0,0,0,0.8)';
  const FOSSIL_BOUNDARY_COLOR = 'rgba(180,180,180,0.7)';
  const HOTSPOT_COLOR = '#ff5050';
  const COAST_OUTLINE_COLOR = 'rgba(255,255,255,0.85)';
  const CONTINENT_SEED_COLOR = '#ffeb3b';
  const ANCHOR_COLOR = '#ff9800';
  const LATTICE_EDGE_COLOR = 'rgba(255,255,255,0.18)';
  const LATTICE_COAST_EDGE_COLOR = 'rgba(255,235,120,0.85)';

  // Two-column legend: left column is overlay-specific, right column is the
  // marker key (lines, dots) — always rendered so it's a stable reference
  // regardless of which overlay is active.
  function markersColumnHTML() {
    return '<div class="legend-col">' +
      '<div class="legend-item"><div class="legend-line" style="border-top:3px solid #000"></div>Active Plate</div>' +
      '<div class="legend-item"><div class="legend-line" style="border-top:2px solid #aaa"></div>Fossil Boundary</div>' +
      '<div class="legend-item"><div class="legend-line" style="border-top:2px solid #fff"></div>Continent Outline</div>' +
      '<div class="legend-item"><div class="legend-line" style="border-top:3px solid #f4d34a"></div>Plate Vector</div>' +
      '<div class="legend-item"><div style="width:8px;height:8px;border-radius:50%;background:#ffeb3b;flex-shrink:0"></div>Continent Seed</div>' +
      '<div class="legend-item"><div style="width:8px;height:8px;border-radius:50%;background:#ff3030;flex-shrink:0"></div>Hotspot</div>' +
      '<div class="legend-item"><div style="width:10px;height:10px;border-radius:50%;border:2px solid #ff00ff;flex-shrink:0"></div>Spawn</div>' +
      '</div>';
  }

  class Renderer {
    constructor() {
      this.mainCanvas = document.getElementById('mainCanvas');
      this.overlayCanvas = document.getElementById('overlayCanvas');
      this.highlightCanvas = document.getElementById('highlightCanvas');
      this.canvasArea = document.getElementById('canvasArea');
      this.zoomInfo = document.getElementById('zoomInfo');
      this.hoverGeneral = document.getElementById('hoverGeneral');
      this.hoverSpecific = document.getElementById('hoverSpecific');
      this.legendBox = document.getElementById('legendBox');

      this.mainCtx = this.mainCanvas.getContext('2d');
      this.overlayCtx = this.overlayCanvas.getContext('2d');
      this.highlightCtx = this.highlightCanvas.getContext('2d');

      this.mapW = 512;
      this.mapH = 512;
      // Vanilla world height, for turning bytes into the blocks the hover strip
      // reports — the byte is a proportion, the block count is what you measure
      // standing in the world.
      this.worldHeight = 320;
      this.model = null;       // TectonicModel
      this.continent = null;   // ContinentGen
      this.coastField = null;  // CoastField
      this.provinces = null;   // ProvinceMap
      this.upheaval = null;    // UpheavalMap
      this.drainage = null;    // DrainageGraph
      this.wind = null;        // WindModel
      this.currents = null;    // CurrentsModel
      this.climate = null;     // ClimateModel
      this.ridges = null;      // RidgeNetworks
      this.lakes = null;       // LakeFeatures
      this.rivers = null;      // RiverNetworks

      // panX, panY = pixel offset of map origin in canvas coords
      // zoom = canvas pixels per map pixel
      this.panX = 0;
      this.panY = 0;
      this.zoom = 1;

      // Strip the CSS transform/sizing left from the previous renderer so the
      // canvases sit at the canvas-area top-left and fill it.
      for (const c of [this.mainCanvas, this.overlayCanvas, this.highlightCanvas]) {
        c.style.transform = '';
        c.style.transformOrigin = '';
        c.style.width = '';
        c.style.height = '';
      }

      this._wireEvents();
      this._resizeCanvases();
      this._fitInitialZoom();
    }

    setSize(w, h) {
      const changed = (w !== this.mapW || h !== this.mapH);
      this.mapW = w;
      this.mapH = h;
      if (changed) this._fitInitialZoom();
    }

    setModel(model) { this.model = model; }
    setContinent(continent) { this.continent = continent; }
    setCoastField(coastField) { this.coastField = coastField; }
    setWorldHeight(h) { this.worldHeight = h || 320; }
    setMesh(mesh) { this.mesh = mesh; }
    setProvinces(provinces) { this.provinces = provinces; }
    setUpheaval(upheaval) { this.upheaval = upheaval; }
    setDrainage(drainage) { this.drainage = drainage; }
    setWind(wind) { this.wind = wind; }
    setCurrents(currents) { this.currents = currents; }
    setClimate(climate) { this.climate = climate; }
    setRidges(ridges) { this.ridges = ridges; }
    setLakes(lakes) { this.lakes = lakes; }
    setRivers(rivers) { this.rivers = rivers; }
    setLandformMaps(prim, det) { this.primLandformMap = prim; this.detailedLandformMap = det; }

    // ===== Canvas sizing =====
    _resizeCanvases() {
      if (!this.canvasArea) return;
      const rect = this.canvasArea.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      for (const c of [this.mainCanvas, this.overlayCanvas, this.highlightCanvas]) {
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
      }
    }

    _fitInitialZoom() {
      if (!this.canvasArea) return;
      const rect = this.canvasArea.getBoundingClientRect();
      const fitX = rect.width / this.mapW;
      const fitY = rect.height / this.mapH;
      this.zoom = Math.min(fitX, fitY) * 0.95;
      this.panX = (rect.width - this.mapW * this.zoom) / 2;
      this.panY = (rect.height - this.mapH * this.zoom) / 2;
      if (this.zoomInfo) this.zoomInfo.textContent = `Zoom: ${this.zoom.toFixed(2)}x`;
    }

    // ===== Top-level render — rAF-throttled =====
    scheduleRender() {
      if (this._renderPending) return;
      this._renderPending = true;
      requestAnimationFrame(() => {
        this._renderPending = false;
        this.render();
      });
    }

    render() {
      this._resizeCanvases();
      this._safeDraw('background', () => this.renderBackground());
      this._safeDraw('overlay', () => this.renderOverlay());
      this._safeDraw('legend', () => this.updateLegend());
      if (this.zoomInfo) this.zoomInfo.textContent = `Zoom: ${this.zoom.toFixed(2)}x`;
    }

    // Runs a draw step inside try/catch: a throw logs ONCE per label and is
    // swallowed, so a broken layer can't blank the whole map or freeze pan/zoom.
    // Belt to the per-feature failsafe in ui.js generate(). Light by design; a
    // deeper per-system hardening pass comes after the feature rework.
    _safeDraw(label, fn) {
      try { fn(); }
      catch (e) {
        this._drawErr = this._drawErr || {};
        if (!this._drawErr[label]) {
          console.error(`[render] ${label} failed — skipped:`, e);
          this._drawErr[label] = true;
        }
      }
    }

    // ===== Background + pixel markers (single per-screen-pixel pass) =====
    // Painting markers via per-pixel mask lookup eliminates the fractional-zoom
    // alpha-banding that the previous fillRect approach produced (sparse
    // tectonic lines especially). Order applied per pixel: base colour first,
    // then markers blended in (subtle → prominent).
    renderBackground() {
      const ctx = this.mainCtx;
      const W = this.mainCanvas.width;
      const H = this.mainCanvas.height;
      const overlay = document.querySelector('input[name="overlay"]:checked')?.value;
      const mapW = this.mapW, mapH = this.mapH;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const [or, og, ob] = OCEAN_COLOR_RGB;
      const [lr, lg, lb] = LAND_COLOR_RGB;
      const [ox, oy, oz] = OUTSIDE_RGB;

      // Reuse the ImageData buffer when canvas size hasn't changed.
      if (!this._mainImg || this._mainImg.width !== W || this._mainImg.height !== H) {
        this._mainImg = ctx.createImageData(W, H);
      }
      const img = this._mainImg;
      const data = img.data;

      const usePrimitive = overlay && overlay.startsWith('prim');
      // Primitive = the faceted face-label raster; Detailed = the emergent
      // coast field's mask (coast-field.js).
      const lgArr = this.continent
        ? (usePrimitive
            ? this.continent.landGrid
            : ((this.coastField && this.coastField.landMask) || this.continent.landGrid))
        : null;
      const provinceMap = this.provinces ? this.provinces.provinceMap : null;
      const primProvinceMap = this.provinces ? this.provinces.primitiveMap : null;
      const palette = V.PROVINCE_RGB;
      const upheavalRGB = V.upheavalRGB;
      const oceanDepthRGB = V.oceanDepthRGB;
      // Detailed Upheaval / Ocean maps: full-raster barycentric interpolation of
      // the anchor (height, depth) points (sampleFields), built once in
      // upheaval.computePointTerrain. The PRIMITIVE views instead fall through to
      // the continent silhouette below and draw the anchor points as dots on the
      // overlay canvas (see _drawAnchorValueLayer).
      const detailedHeight = this.upheaval ? this.upheaval.detailedHeight : null;
      const detailedDepth  = this.upheaval ? this.upheaval.detailedDepth  : null;
      // Climate overlays — pre-resolve the gradient + the data source. Primitive
      // draws the per-anchor bytes as dots (over the continent silhouette);
      // detailed fills from the interpolated-and-blurred raster.
      const climate = this.climate;
      let climateColorFn = null;
      let climateDetailedMap = null;   // blurred raster, for the detailed fill
      const isClimateOverlay = overlay && (
        overlay === 'primClimateTemp' || overlay === 'detailedClimateTemp' ||
        overlay === 'primClimateRain' || overlay === 'detailedClimateRain' ||
        overlay === 'primClimateGeo'  || overlay === 'detailedClimateGeo');
      if (isClimateOverlay && climate) {
        if (overlay.endsWith('Temp')) { climateColorFn = V.climateTempRGB; climateDetailedMap = climate.detailedTemp; }
        else if (overlay.endsWith('Rain')) { climateColorFn = V.climateRainRGB; climateDetailedMap = climate.detailedRain; }
        else { climateColorFn = V.climateGeoRGB; climateDetailedMap = climate.detailedGeo; }
      }

      // Resolve marker masks based on toggles + warp state.
      const showPlates = document.getElementById('showPlates')?.checked;
      const showFossils = document.getElementById('showFossils')?.checked;
      const showContBounds = document.getElementById('showContBounds')?.checked;
      const showEnclosedShields = document.getElementById('showEnclosedShields')?.checked;

      const plateGrid = (showPlates && this.model) ? this.model.activeBoundaryGrid : null;
      const fossilGrid = (showFossils && this.model) ? this.model.fossilBoundaryGrid : null;
      const enclosedGrid = (showEnclosedShields && this.provinces)
        ? this.provinces.enclosedGrid
        : null;
      // Coast outline: faceted primitive coast vs the emergent field coast.
      // (The lattice marker is vector-drawn in renderOverlay, not a mask.)
      const coastGrid = (showContBounds && this.continent)
        ? (usePrimitive
            ? this.continent.coastGrid
            : (this.coastField && this.coastField.coastMask))
        : null;

      for (let sy = 0; sy < H; sy++) {
        const my = Math.floor((sy - panY) / zoom);
        const inRowY = my >= 0 && my < mapH;
        for (let sx = 0; sx < W; sx++) {
          const j = (sy * W + sx) * 4;
          const mx = Math.floor((sx - panX) / zoom);
          if (!inRowY || mx < 0 || mx >= mapW) {
            data[j] = ox; data[j + 1] = oy; data[j + 2] = oz; data[j + 3] = 255;
            continue;
          }
          const mi = my * mapW + mx;

          // ---- Base colour ----
          let r, g, b;
          if (overlay === 'detailedProvinces' && provinceMap && palette) {
            const c = palette[provinceMap[mi]];
            if (c) { r = c[0]; g = c[1]; b = c[2]; }
            else   { r = ox; g = oy; b = oz; }
          } else if (overlay === 'primProvinces' && primProvinceMap && palette) {
            const c = palette[primProvinceMap[mi]];
            if (c) { r = c[0]; g = c[1]; b = c[2]; }
            else   { r = ox; g = oy; b = oz; }
          } else if ((overlay === 'primLandforms' || overlay === 'detailedLandforms')
                     && V.LANDFORMS) {
            // Landforms overlay: per-pixel palette index from the v1-style
            // multi-condition picker (built once at gen time in landforms.js
            // `buildPixelLandformMap`, reads province + elevation + climate
            // + coast + boundary). Ocean = sentinel index 255 → ocean colour.
            const lfMap = (overlay === 'primLandforms')
              ? this.primLandformMap
              : this.detailedLandformMap;
            if (lfMap) {
              const lfIdx = lfMap[mi];
              if (lfIdx === 255) {
                r = or; g = og; b = ob;
              } else {
                const entry = V.LANDFORMS[lfIdx];
                if (entry && entry.rgb) {
                  r = entry.rgb[0]; g = entry.rgb[1]; b = entry.rgb[2];
                } else {
                  r = ox; g = oy; b = oz;
                }
              }
            } else {
              r = ox; g = oy; b = oz;
            }
          } else if (overlay === 'detUpheaval' && detailedHeight && upheavalRGB) {
            // Detailed upheaval: the smooth land-elevation surface — barycentric
            // interpolation of the anchor height points. Ocean stays continent
            // blue; land coloured by interpolated height (the coast ramps up
            // from 0 rather than stepping).
            if (lgArr && lgArr[mi] === 1) {
              const c = upheavalRGB(detailedHeight[mi]);
              r = c[0]; g = c[1]; b = c[2];
            } else {
              r = or; g = og; b = ob;
            }
          } else if (overlay === 'detailedOceanDepth' && detailedDepth && oceanDepthRGB) {
            // Detailed Ocean Map: the smooth ocean-depth surface — barycentric
            // interpolation of the anchor depth points. Land stays continent
            // green; ocean coloured by interpolated depth.
            if (lgArr && lgArr[mi] === 1) {
              r = lr; g = lg; b = lb;
            } else {
              const c = oceanDepthRGB(detailedDepth[mi]);
              r = c[0]; g = c[1]; b = c[2];
            }
          } else if (overlay === 'primWind' || overlay === 'detailedWind' ||
                     overlay === 'primCurrents' || overlay === 'detailedCurrents') {
            // B&W continent silhouette as backdrop for vector arrows.
            if (lgArr && lgArr[mi] === 1) {
              r = BW_LAND_RGB[0]; g = BW_LAND_RGB[1]; b = BW_LAND_RGB[2];
            } else {
              r = BW_OCEAN_RGB[0]; g = BW_OCEAN_RGB[1]; b = BW_OCEAN_RGB[2];
            }
          } else if (isClimateOverlay && !usePrimitive && climateColorFn && climateDetailedMap) {
            // Detailed: fill from the interpolated-and-blurred anchor raster.
            // (Primitive falls through to the silhouette below + draws dots.)
            const c = climateColorFn(climateDetailedMap[mi]);
            r = c[0]; g = c[1]; b = c[2];
          } else if (lgArr) {
            if (lgArr[mi] === 1) { r = lr; g = lg; b = lb; }
            else                 { r = or; g = og; b = ob; }
          } else {
            r = or; g = og; b = ob;
          }

          // ---- Marker overlays (subtle → prominent) ----
          // Enclosed shields: warm orange tint to flag "could be uplifted"
          // regions (shield not reachable from ocean without crossing
          // orogen). rgba(255, 170, 80, 0.5) blended over the base colour.
          if (enclosedGrid && enclosedGrid[mi]) {
            r = r * 0.5 + 127.5;
            g = g * 0.5 + 85;
            b = b * 0.5 + 40;
          }
          // Continent outline: rgba(255,255,255,0.85)
          if (coastGrid && coastGrid[mi]) {
            r = r * 0.15 + 217; g = g * 0.15 + 217; b = b * 0.15 + 217;
          }
          // Fossil boundary: rgba(180,180,180,0.7)
          if (fossilGrid && fossilGrid[mi]) {
            r = r * 0.30 + 126; g = g * 0.30 + 126; b = b * 0.30 + 126;
          }
          // Active plate boundary: rgba(0,0,0,0.85)
          if (plateGrid && plateGrid[mi]) {
            r = r * 0.15;       g = g * 0.15;       b = b * 0.15;
          }

          data[j] = r | 0; data[j + 1] = g | 0; data[j + 2] = b | 0; data[j + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    // ===== Vector overlay (hotspots, seeds, spawn, wind arrows) =====
    // Pixel markers (plates, fossils, coast) are painted by renderBackground
    // via per-pixel masks. This pass handles vector items that don't snap to
    // single pixels (circles, arrows, the lattice wireframe).
    renderOverlay() {
      const ctx = this.overlayCtx;
      const W = this.overlayCanvas.width;
      const H = this.overlayCanvas.height;
      ctx.clearRect(0, 0, W, H);

      const overlay = document.querySelector('input[name="overlay"]:checked')?.value;
      const showHotspots = document.getElementById('showHotspots')?.checked;
      const showSeeds = document.getElementById('showSeeds')?.checked;
      const showLattice = document.getElementById('showLattice')?.checked;
      const showAnchors = document.getElementById('showAnchors')?.checked;
      const showVectors = document.getElementById('showVectors')?.checked;
      const showSpawn = document.getElementById('showSpawn')?.checked;
      const showRidges = document.getElementById('showRidges')?.checked;
      const showLakes = document.getElementById('showLakes')?.checked;
      const showRivers = document.getElementById('showRivers')?.checked;
      const showDrainage = document.getElementById('showDrainage')?.checked;

      const panX = this.panX, panY = this.panY, zoom = this.zoom;

      // Wind overlay: draw arrows over the B&W continent backdrop.
      if ((overlay === 'primWind' || overlay === 'detailedWind') && this.wind) {
        this._drawWindOverlay(ctx, overlay === 'primWind');
      }

      // Currents overlay: same shape, ocean polygons only.
      if ((overlay === 'primCurrents' || overlay === 'detailedCurrents') && this.currents) {
        this._drawCurrentsOverlay(ctx, overlay === 'primCurrents');
      }

      // Ridge polylines on top of any background overlay.
      if (showRidges && this.ridges) {
        this._safeDraw('ridges', () => this._drawRidges(ctx));
      }

      // Drainage Graph — the primitive downhill web on the data points
      // (drainage.js). Drawn BENEATH lakes/rivers so those stay legible on top.
      if (showDrainage && this.mesh && this.drainage) {
        this._safeDraw('drainage', () => this._drawDrainage(ctx));
      }

      // Lake feature objects — drawn after ridges so they sit on top of any
      // ridge polylines that happen to overlap.
      if (showLakes && this.lakes) {
        this._safeDraw('lakes', () => this._drawLakes(ctx));
      }

      // River springs/ends/connections + deflector markers.
      if (showRivers && this.rivers) {
        this._safeDraw('rivers', () => this._drawRivers(ctx));
      }

      // Lattice wireframe — the triangular mesh the data lives on. Drawn as
      // vector lines (crisp at any zoom), with coast segments (edges between
      // a land and an ocean face) highlighted.
      if (showLattice && this.mesh && this.continent) {
        this._safeDraw('lattice', () => this._drawLattice(ctx));
      }

      if (showSeeds && this.continent && this.continent._continentSeeds) {
        ctx.fillStyle = CONTINENT_SEED_COLOR;
        for (const s of this.continent._continentSeeds) {
          const sx = s.x * zoom + panX, sy = s.z * zoom + panY;
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (showAnchors && this.mesh) {
        ctx.fillStyle = ANCHOR_COLOR;
        for (let t = 0; t < this.mesh.numAnchors; t++) {
          const ax = this.mesh.a_x[t], az = this.mesh.a_z[t];
          if (ax < 0 || ax >= this.mapW || az < 0 || az >= this.mapH) continue;
          const sx = ax * zoom + panX, sy = az * zoom + panY;
          ctx.beginPath();
          ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (showVectors && this.model) {
        this._drawPlateVectorOverlay(ctx);
      }

      // Anchor value markers — coloured dots + numeric labels for whichever
      // value/climate field the active overlay shows (height, depth, temp, rain,
      // geo), on BOTH the primitive and detailed views of that field.
      //   • Primitive overlay: the dots ARE the map, so dots always draw; the
      //     "Anchor Values" marker adds the numeric labels on top.
      //   • Detailed overlay: the raster is the base map, so the primitive
      //     points are an overlay — dots AND labels draw together only when the
      //     marker is on (handy for spotting interpolation error against the
      //     source points).
      const avField = this._anchorValueField(overlay);
      if (avField) {
        const marker = !!document.getElementById('showAnchorValues')?.checked;
        const isPrimitive = overlay.startsWith('prim');
        this._drawAnchorValueLayer(ctx, avField.arr, avField.fn, {
          drawDots: isPrimitive || marker,
          drawLabels: marker,
          grayAt0: avField.grayAt0,
        });
      }

      if (showHotspots && this.model && this.model.hotspots) {
        ctx.lineWidth = 1;
        for (const h of this.model.hotspots) {
          const sx = h.x * zoom + panX, sy = h.z * zoom + panY;
          ctx.fillStyle = HOTSPOT_COLOR;
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,80,80,0.4)';
          ctx.beginPath();
          ctx.arc(sx, sy, h.radius * zoom, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Spawn marker: magenta crosshair circle at the map centre. Always at
      // (mapW/2, mapH/2). The continent BFS guarantees this cell is land
      // (calibrate's fallback forces the spawn cell to land if the BFS missed it).
      if (showSpawn) {
        const cx = (this.mapW / 2) * zoom + panX;
        const cy = (this.mapH / 2) * zoom + panY;
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ff00ff';
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 9, cy); ctx.lineTo(cx + 9, cy);
        ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 9);
        ctx.stroke();
      }
    }

    // ===== Plate-vector debug overlay (spec §3.1) =====
    // Two layers, both reading data computed at world init (never per-pixel):
    //   1. Boundary segments coloured by collision intensity — red = converging
    //      (mountain), blue = diverging (rift), grey = glancing (transform),
    //      brightness ∝ |intensity|. This is the OUTPUT to verify.
    //   2. Motion arrows from every seed (majors prominent, fossils subtle),
    //      length ∝ speed, direction = the plate's drift vector. The INPUT.
    // Subduction asymmetry (seg.tallerSide) is stored but not drawn here — it
    // becomes visible when item 5 paints one side taller than the other.
    _drawPlateVectorOverlay(ctx) {
      const model = this.model;
      if (!model) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;

      const segs = model.lines && model.lines.segments;
      if (segs) {
        ctx.lineWidth = 2;
        for (const seg of segs) {
          const poly = seg.polyline;
          if (!poly || !poly.x || poly.x.length < 2) continue;
          if (!seg.pairKey || seg.pairKey[0] === 'E') continue; // skip map-edge frame
          const inten = seg.intensity || 0;
          const mag = Math.min(1, Math.abs(inten));
          let r, g, b;
          if (inten > 0.15)       { r = 230; g = 60;  b = 50;  } // converging → mountain
          else if (inten < -0.15) { r = 60;  g = 120; b = 230; } // diverging → rift
          else                    { r = 150; g = 150; b = 150; } // glancing → transform
          ctx.strokeStyle = `rgba(${r},${g},${b},${(0.35 + 0.6 * mag).toFixed(3)})`;
          ctx.beginPath();
          for (let i = 0; i < poly.x.length; i++) {
            const sx = poly.x[i] * zoom + panX, sy = poly.z[i] * zoom + panY;
            if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
          }
          ctx.stroke();
        }
      }

      const seeds = model.allSeeds;
      if (seeds) {
        // World-unit arrow length at speed 1 (~half a plate cell). Speed folds
        // into vec magnitude, so slower plates get shorter arrows for free.
        const arrowLen = (model.gridSpacing || 120) * 0.5;
        for (const s of seeds) {
          if (!s.vec) continue;
          if (s.x < 0 || s.x >= this.mapW || s.z < 0 || s.z >= this.mapH) continue;
          const major = s.isMajor;
          const ox = s.x * zoom + panX, oy = s.z * zoom + panY;
          const ex = (s.x + s.vec[0] * arrowLen) * zoom + panX;
          const ey = (s.z + s.vec[1] * arrowLen) * zoom + panY;
          ctx.strokeStyle = major ? 'rgba(255,235,120,0.95)' : 'rgba(170,215,255,0.6)';
          ctx.lineWidth = major ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke();
          const ang = Math.atan2(ey - oy, ex - ox);
          const head = major ? 6 : 4;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - head * Math.cos(ang - 0.4), ey - head * Math.sin(ang - 0.4));
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - head * Math.cos(ang + 0.4), ey - head * Math.sin(ang + 0.4));
          ctx.stroke();
          ctx.fillStyle = major ? 'rgba(255,235,120,0.95)' : 'rgba(170,215,255,0.5)';
          ctx.beginPath(); ctx.arc(ox, oy, major ? 2.5 : 1.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // Draw the per-anchor value points for a primitive value map. `slot` is
    // 'height' (Upheaval) or 'depth' (Ocean) — the map reads that slot off
    // every anchor. EVERY anchor is drawn (no point removed): coloured by the
    // slot's palette when it has a value, GRAY at 0 (the point exists but has
    // no value on this map — ocean anchors on Upheaval, land anchors on Ocean).
    // `withLabels` (the "Anchor Values" marker) overlays the numeric value.
    // Maps the active overlay to the per-anchor value field it shows:
    // { arr (the per-anchor byte array), fn (its palette), grayAt0 }. Covers
    // both the primitive and detailed id of each field. Height/depth gray at 0
    // ("no value" for that map); climate covers land AND ocean, so never gray.
    // null for overlays that aren't a value/climate field.
    _anchorValueField(overlay) {
      const uph = this.upheaval, cl = this.climate;
      switch (overlay) {
        case 'primUpheaval': case 'detUpheaval':
          return uph && uph.anchorHeight ? { arr: uph.anchorHeight, fn: V.upheavalRGB, grayAt0: true } : null;
        case 'primOceanDepth': case 'detailedOceanDepth':
          return uph && uph.anchorDepth ? { arr: uph.anchorDepth, fn: V.oceanDepthRGB, grayAt0: true } : null;
        case 'primClimateTemp': case 'detailedClimateTemp':
          return cl && cl.anchorTemp ? { arr: cl.anchorTemp, fn: V.climateTempRGB, grayAt0: false } : null;
        case 'primClimateRain': case 'detailedClimateRain':
          return cl && cl.anchorRain ? { arr: cl.anchorRain, fn: V.climateRainRGB, grayAt0: false } : null;
        case 'primClimateGeo': case 'detailedClimateGeo':
          return cl && cl.anchorGeo ? { arr: cl.anchorGeo, fn: V.climateGeoRGB, grayAt0: false } : null;
        default: return null;
      }
    }

    // Draws the anchor-value layer for one field: coloured dots and/or numeric
    // labels. Shared by every value/climate field, primitive and detailed.
    // Dots carry the value colour (gray at 0 when grayAt0); labels are dark
    // text + white halo (so they read on any dot/backdrop) with screen-space
    // dedup so they thin out when zoomed out. Colour rule matches updateLegend
    // so a dot always matches its legend swatch.
    _drawAnchorValueLayer(ctx, arr, paletteFn, { drawDots, drawLabels, grayAt0 }) {
      const mesh = this.mesh;
      if (!mesh || !arr || !paletteFn || (!drawDots && !drawLabels)) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const W = this.overlayCanvas.width, H = this.overlayCanvas.height;
      const GRAY = 'rgb(135,135,135)';

      if (drawDots) {
        // Thin dark ring keeps every dot legible on any backdrop (the "no
        // value" gray sits on the olive land's luminance and would vanish).
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        for (let t = 0; t < mesh.numAnchors; t++) {
          const ax = mesh.a_x[t], az = mesh.a_z[t];
          if (ax < 0 || ax >= this.mapW || az < 0 || az >= this.mapH) continue;
          const sx = ax * zoom + panX, sy = az * zoom + panY;
          if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;
          const v = arr[t];
          if (grayAt0 && v === 0) {
            ctx.fillStyle = GRAY;
          } else {
            const c = paletteFn(v);
            ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
          }
          ctx.beginPath();
          ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      if (!drawLabels) return;

      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const MIN_DIST_SQ = 26 * 26;
      const placedX = [], placedY = [];
      for (let t = 0; t < mesh.numAnchors; t++) {
        const ax = mesh.a_x[t], az = mesh.a_z[t];
        if (ax < 0 || ax >= this.mapW || az < 0 || az >= this.mapH) continue;
        const sx = ax * zoom + panX, sy = az * zoom + panY;
        if (sx < -20 || sx > W + 20 || sy < -10 || sy > H + 20) continue;
        let tooClose = false;
        for (let p = 0; p < placedX.length; p++) {
          const ddx = sx - placedX[p], ddy = sy - placedY[p];
          if (ddx * ddx + ddy * ddy < MIN_DIST_SQ) { tooClose = true; break; }
        }
        if (tooClose) continue;
        placedX.push(sx); placedY.push(sy);

        const label = String(arr[t]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeText(label, sx, sy + 4);
        ctx.fillStyle = 'rgba(20,20,20,0.95)';
        ctx.fillText(label, sx, sy + 4);
      }
    }

    // ===== Drainage Graph marker =====
    // Draws the primitive downhill web computed in drainage.js: each stored
    // connection (land anchor → strictly-lower neighbour) as a line, an
    // arrowhead at its MIDPOINT pointing downhill, and the height-difference
    // byte labelled beside it (labels reuse the value markers' screen-space
    // dedup — lines + arrows always draw; the numbers thin out when there's no
    // room). Reads DrainageGraph's flat from/to/drop arrays + the mesh anchor
    // positions; computes nothing itself.
    _drawDrainage(ctx) {
      const mesh = this.mesh, dr = this.drainage;
      if (!mesh || !dr || !dr.from || dr.from.length === 0) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const W = this.overlayCanvas.width, H = this.overlayCanvas.height;
      const from = dr.from, to = dr.to, drop = dr.drop;
      const N = from.length;
      const AR = 4; // arrowhead half-size (screen px)

      // Pass 1 — connection lines + midpoint downhill arrows.
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(90,150,170,0.55)';
      ctx.fillStyle = 'rgba(70,130,150,0.9)';
      for (let i = 0; i < N; i++) {
        const a = from[i], b = to[i];
        const sx = mesh.a_x[a] * zoom + panX, sy = mesh.a_z[a] * zoom + panY;
        const tx = mesh.a_x[b] * zoom + panX, ty = mesh.a_z[b] * zoom + panY;
        // cull if the whole segment is off one edge of the screen
        if ((sx < -20 && tx < -20) || (sx > W + 20 && tx > W + 20) ||
            (sy < -20 && ty < -20) || (sy > H + 20 && ty > H + 20)) continue;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        // arrowhead centred on the midpoint, pointing downhill (from → to)
        const mx = (sx + tx) * 0.5, my = (sy + ty) * 0.5;
        let dx = tx - sx, dy = ty - sy;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const px = -dy, py = dx;
        ctx.beginPath();
        ctx.moveTo(mx + dx * AR, my + dy * AR);
        ctx.lineTo(mx - dx * AR + px * AR * 0.8, my - dy * AR + py * AR * 0.8);
        ctx.lineTo(mx - dx * AR - px * AR * 0.8, my - dy * AR - py * AR * 0.8);
        ctx.closePath();
        ctx.fill();
      }

      // Pass 2 — height-difference labels at midpoints (deduped, offset off the
      // arrow so the two don't overlap).
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const MIN_DIST_SQ = 26 * 26;
      const placedX = [], placedY = [];
      for (let i = 0; i < N; i++) {
        const a = from[i], b = to[i];
        const sx = mesh.a_x[a] * zoom + panX, sy = mesh.a_z[a] * zoom + panY;
        const tx = mesh.a_x[b] * zoom + panX, ty = mesh.a_z[b] * zoom + panY;
        const mx = (sx + tx) * 0.5, my = (sy + ty) * 0.5;
        if (mx < -20 || mx > W + 20 || my < -20 || my > H + 20) continue;
        let tooClose = false;
        for (let p = 0; p < placedX.length; p++) {
          const ddx = mx - placedX[p], ddy = my - placedY[p];
          if (ddx * ddx + ddy * ddy < MIN_DIST_SQ) { tooClose = true; break; }
        }
        if (tooClose) continue;
        placedX.push(mx); placedY.push(my);
        let dx = tx - sx, dy = ty - sy;
        const len = Math.hypot(dx, dy) || 1;
        const ox = (-dy / len) * 7, oy = (dx / len) * 7;
        const label = String(drop[i]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeText(label, mx + ox, my + oy);
        ctx.fillStyle = 'rgba(20,20,20,0.95)';
        ctx.fillText(label, mx + ox, my + oy);
      }
    }

    // ===== Legend (two columns: overlay items + markers key) =====
    updateLegend() {
      if (!this.legendBox) return;
      const overlay = document.querySelector('input[name="overlay"]:checked')?.value;

      let itemsCol = '';
      if ((overlay === 'detailedProvinces' || overlay === 'primProvinces') && V.PROVINCE_RGB) {
        const items = V.PROVINCE_RGB.map((c, i) => {
          return `<div class="legend-item"><span class="legend-swatch" style="background:rgb(${c[0]},${c[1]},${c[2]})"></span>${i}  ${V.PROVINCE_NAMES[i]}</div>`;
        }).join('');
        itemsCol = `<div class="legend-col">${items}</div>`;
      } else if ((overlay === 'primUpheaval' || overlay === 'detUpheaval') && V.upheavalRGB) {
        // Named elevation landmarks (not byte tiers). On the PRIMITIVE dots 0 is
        // gray "no value" (ocean / exact sea level); on the DETAILED fill 0 is
        // the palette's sea-level green (a continuous surface, nothing "absent").
        const isPrim = overlay === 'primUpheaval';
        const stops = [
          isPrim ? { v: 0, gray: true, label: 'Sea level (no value)' }
                 : { v: 0, label: 'Sea level' },
          { v: 40,  label: 'Lowlands' },
          { v: 110, label: 'Hills' },
          { v: 190, label: 'Mountains' },
          { v: 255, label: 'Peaks' },
        ];
        const items = stops.map(s => {
          const c = s.gray ? [135, 135, 135] : V.upheavalRGB(s.v);
          return `<div class="legend-item"><span class="legend-swatch" style="background:rgb(${c[0]|0},${c[1]|0},${c[2]|0})"></span>${s.label}</div>`;
        }).join('');
        itemsCol = `<div class="legend-col">${items}</div>`;
      } else if ((overlay === 'primOceanDepth' || overlay === 'detailedOceanDepth') && V.oceanDepthRGB) {
        // Named depth landmarks. PRIMITIVE dots: 0 gray "no value" (land / coast).
        // DETAILED fill: 0 is the palette's coast green (continuous surface).
        const isPrim = overlay === 'primOceanDepth';
        const stops = [
          isPrim ? { v: 0, gray: true, label: 'Coast (no value)' }
                 : { v: 0, label: 'Coast' },
          { v: 70,  label: 'Shelf' },
          { v: 150, label: 'Slope' },
          { v: 210, label: 'Deep sea' },
          { v: 255, label: 'Abyss' },
        ];
        const items = stops.map(s => {
          const c = s.gray ? [135, 135, 135] : V.oceanDepthRGB(s.v);
          return `<div class="legend-item"><span class="legend-swatch" style="background:rgb(${c[0]|0},${c[1]|0},${c[2]|0})"></span>${s.label}</div>`;
        }).join('');
        itemsCol = `<div class="legend-col">${items}</div>`;
      } else if (overlay === 'primOcean' || overlay === 'detailedOcean' || overlay === 'default') {
        const [or, og, ob] = OCEAN_COLOR_RGB;
        const [lr, lg, lb] = LAND_COLOR_RGB;
        itemsCol = '<div class="legend-col">' +
          `<div class="legend-item"><span class="legend-swatch" style="background:rgb(${lr},${lg},${lb})"></span>0  Land</div>` +
          `<div class="legend-item"><span class="legend-swatch" style="background:rgb(${or},${og},${ob})"></span>255  Ocean</div>` +
          '</div>';
      } else if ((overlay === 'primClimateTemp' || overlay === 'detailedClimateTemp') && V.climateTempRGB) {
        const stops = [
          { v: 0, label: '0  Polar (−20 °C)' },
          { v: 64, label: '64  Subarctic' },
          { v: 128, label: '128  Temperate' },
          { v: 192, label: '192  Subtropical' },
          { v: 255, label: '255  Equatorial (40 °C)' },
        ];
        const items = stops.map(s => {
          const c = V.climateTempRGB(s.v);
          return `<div class="legend-item"><span class="legend-swatch" style="background:rgb(${c[0]|0},${c[1]|0},${c[2]|0})"></span>${s.label}</div>`;
        }).join('');
        itemsCol = `<div class="legend-col">${items}</div>`;
      } else if ((overlay === 'primClimateRain' || overlay === 'detailedClimateRain') && V.climateRainRGB) {
        const stops = [
          { v: 0, label: '0  Desert' },
          { v: 64, label: '64  Semi-arid' },
          { v: 128, label: '128  Temperate' },
          { v: 192, label: '192  Humid' },
          { v: 255, label: '255  Rainforest' },
        ];
        const items = stops.map(s => {
          const c = V.climateRainRGB(s.v);
          return `<div class="legend-item"><span class="legend-swatch" style="background:rgb(${c[0]|0},${c[1]|0},${c[2]|0})"></span>${s.label}</div>`;
        }).join('');
        itemsCol = `<div class="legend-col">${items}</div>`;
      } else if ((overlay === 'primClimateGeo' || overlay === 'detailedClimateGeo') && V.climateGeoRGB) {
        const stops = [
          { v: 0, label: '0  Calm' },
          { v: 100, label: '100  Mild' },
          { v: 180, label: '180  Active' },
          { v: 255, label: '255  Volcanic peak' },
        ];
        const items = stops.map(s => {
          const c = V.climateGeoRGB(s.v);
          return `<div class="legend-item"><span class="legend-swatch" style="background:rgb(${c[0]|0},${c[1]|0},${c[2]|0})"></span>${s.label}</div>`;
        }).join('');
        itemsCol = `<div class="legend-col">${items}</div>`;
      } else if ((overlay === 'primWind' || overlay === 'detailedWind' ||
                  overlay === 'primCurrents' || overlay === 'detailedCurrents') && V.latColor) {
        const stops = [
          { lat: 90,  label: 'Pole (cold)' },
          { lat: 60,  label: '60° (cool)' },
          { lat: 30,  label: '30° (warm)' },
          { lat: 0,   label: 'Equator (warm)' },
        ];
        const items = stops.map(s => {
          const c = V.latColor(s.lat);
          return `<div class="legend-item"><span class="legend-swatch" style="background:rgb(${c[0]},${c[1]},${c[2]})"></span>${s.label}</div>`;
        }).join('');
        itemsCol = `<div class="legend-col">${items}</div>`;
      }

      if (!itemsCol) {
        this.legendBox.style.display = 'none';
        this.legendBox.innerHTML = '';
        return;
      }

      this.legendBox.style.display = 'flex';
      this.legendBox.innerHTML = itemsCol + markersColumnHTML();
    }

    // ===== Lake rendering =====
    // Lakes are an independent primitive feature class (lakes.lakes),
    // not derived from the river graph. Each lake = {type, center,
    // outline (closed polygon, primitive-irregular), size, maxDepth}.
    // Drawn AFTER river polylines so where a river crosses a lake's
    // outline, the lake interior fill visually hides the river segment
    // inside — the "river flowing into / through a lake" look.
    //
    // maxDepth is data only here; the upheaval carve hookup lives on
    // the detail-upheaval-rebuild thread.
    _drawLakes(ctx) {
      const lakes = this.lakes;
      if (!lakes || !lakes.lakes || !lakes.lakes.length) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const W = this.overlayCanvas.width, H = this.overlayCanvas.height;
      const overlay = document.querySelector('input[name="overlay"]:checked')?.value;
      const isDetailed = overlay === 'detUpheaval';

      // Detail-upheaval view: uniform blue across all water in land, with
      // depth darkening (radial gradient — dark navy at lake centre,
      // lighter blue at outline). Climate drives PARTIAL FILL — in dry
      // climates the water polygon shrinks toward centre; the rim between
      // shrunk water and outline shows the underlying upheaval (dried
      // lakebed). High rain → full outline filled. Low rain → minimal
      // centre fill only.
      // Other overlays: per-lake family colour (seed-based — basin lakes
      // each own; cluster members share the cluster seed). Semi-transparent
      // so river polylines under stay visible.
      const strokeStyle = 'rgba(20, 50, 100, 0.9)';
      const FALLBACK_FAMILY = [80, 130, 180];
      const climate = this.climate;

      for (const lake of lakes.lakes) {
        const outline = lake.outline;
        if (!outline || outline.length < 3) continue;

        const sx = lake.center.x * zoom + panX;
        const sy = lake.center.z * zoom + panY;
        const sr = lake.size * zoom * 1.3;
        if (sx + sr < 0 || sx - sr > W || sy + sr < 0 || sy - sr > H) continue;

        // Climate-driven fill fraction for detail view. rainByte 40..160
        // maps to fill 0.25..1.0. Below 40 = nearly empty (just a centre
        // pool); above 160 = full extent. Wet climate fills the bowl,
        // dry climate shrinks toward centre.
        let fillFrac = 1;
        if (isDetailed && climate && climate.getClimateAt) {
          const c = climate.getClimateAt(lake.center.x, lake.center.z);
          if (c) {
            const r = c.rainByte;
            fillFrac = Math.max(0.25, Math.min(1, (r - 40) / 120));
          }
        }

        if (isDetailed) {
          // Radial gradient — outer radius scales with fillFrac so the
          // depth ramp fits the (possibly shrunk) water polygon.
          const grad = ctx.createRadialGradient(
            sx, sy, 0,
            sx, sy, Math.max(1, lake.size * zoom * fillFrac)
          );
          grad.addColorStop(0, 'rgba(15, 40, 80, 0.95)');
          grad.addColorStop(1, 'rgba(70, 130, 180, 0.65)');
          ctx.fillStyle = grad;
        } else {
          const c = lake.familyColor || FALLBACK_FAMILY;
          ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.55)`;
        }
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = 1;

        ctx.beginPath();
        // Scale outline toward centre by fillFrac (detail view only). In
        // primitive views fillFrac is always 1 — full outline drawn.
        if (isDetailed && fillFrac < 1) {
          const cx = lake.center.x, cz = lake.center.z;
          ctx.moveTo(
            (cx + (outline[0].x - cx) * fillFrac) * zoom + panX,
            (cz + (outline[0].z - cz) * fillFrac) * zoom + panY
          );
          for (let i = 1; i < outline.length; i++) {
            ctx.lineTo(
              (cx + (outline[i].x - cx) * fillFrac) * zoom + panX,
              (cz + (outline[i].z - cz) * fillFrac) * zoom + panY
            );
          }
        } else {
          ctx.moveTo(outline[0].x * zoom + panX, outline[0].z * zoom + panY);
          for (let i = 1; i < outline.length; i++) {
            ctx.lineTo(outline[i].x * zoom + panX, outline[i].z * zoom + panY);
          }
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // ===== River rendering =====
    // First pass (placement + activation + pairing, no flow data yet).
    // Three layers drawn in order so points sit on top of connection lines:
    //   1. Connection lines (active spring → paired end), end's colour.
    //   2. Candidate / active points.
    //   3. Deflector markers (red x's sampled along the deflector list).
    //
    // Coloring (hydrological-map convention): the END is the colour anchor.
    // Each end carries its own golden-angle colour; springs paired to it
    // inherit that colour, so each watershed reads as one group. Orphan
    // active springs (no valid end) are white. Inactive springs are gray.
    _drawRivers(ctx) {
      const rivers = this.rivers;
      if (!rivers) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const W = this.overlayCanvas.width, H = this.overlayCanvas.height;
      const SPRING_INACTIVE_RGBA = 'rgba(160,160,160,0.55)';
      const ORPHAN_FILL = 'rgb(245,245,245)';
      // Detail-upheaval view: rivers render as uniform blue (matches the
      // lake palette — "all water in land same colour"). Watershed family
      // colours stay in primitive views for debug differentiation.
      const overlay = document.querySelector('input[name="overlay"]:checked')?.value;
      const isDetailed = overlay === 'detUpheaval';
      const DETAIL_WATER_RGB = [70, 130, 180];

      // Resolve a candidate's display colour. For ends, own colour. For
      // springs, the colour of their paired end (== watershed). Orphan
      // springs (pairedTo === -1) handled separately in the caller.
      const colorFor = (c) => {
        if (c.type !== 'spring') return c.color;
        if (c.pairedTo >= 0) {
          const end = rivers.candidates[c.pairedTo];
          if (end) return end.color;
        }
        return c.color;
      };

      // 1) Connection lines — walk each connection's polyline (built by
      // rivers._buildPolylines, ridges-style wander + Laplacian
      // smoothing). Watershed colour for the LIVE portion of the
      // polyline length, gray for the DRY portion. `liveFraction` in
      // [0,1] is the fraction of polyline arc-length that's live (1 in
      // primitive — the detail-water pass will populate < 1 cases when
      // it lands). `isCrossing` segments render DASHED (gorge marker
      // for future).
      ctx.lineCap = 'round';
      const GRAY_DRY = 'rgba(140, 140, 140, 0.85)';
      for (const conn of rivers.connections) {
        const poly = conn.polyline;
        if (!poly || poly.length < 2) continue;

        // Screen-space vertices + bbox cull.
        const sxArr = new Array(poly.length);
        const syArr = new Array(poly.length);
        let minSx = Infinity, maxSx = -Infinity;
        let minSy = Infinity, maxSy = -Infinity;
        for (let i = 0; i < poly.length; i++) {
          const px = poly[i].x * zoom + panX;
          const py = poly[i].z * zoom + panY;
          sxArr[i] = px; syArr[i] = py;
          if (px < minSx) minSx = px;
          if (px > maxSx) maxSx = px;
          if (py < minSy) minSy = py;
          if (py > maxSy) maxSy = py;
        }
        if (maxSx < -10 || minSx > W + 10 || maxSy < -10 || minSy > H + 10) continue;

        // Per-subsegment arc-lengths (primitive coords) — used for both
        // the live/dry split point and the chevron midpoint. Cheap
        // enough to recompute per draw; not worth caching on conn.
        const segLens = new Array(poly.length - 1);
        let totalLen = 0;
        for (let i = 0; i < poly.length - 1; i++) {
          const ldx = poly[i + 1].x - poly[i].x;
          const ldz = poly[i + 1].z - poly[i].z;
          const l = Math.sqrt(ldx * ldx + ldz * ldz);
          segLens[i] = l;
          totalLen += l;
        }

        const watershedNode = (conn.watershed !== undefined)
          ? rivers.candidates[conn.watershed]
          : rivers.candidates[conn.toIdx];
        const toCand = rivers.candidates[conn.toIdx];

        // Detail view climate-driven drying: query rain at the polyline's
        // midpoint. Below threshold = dry → faded gray-blue. Above = wet →
        // uniform blue. Per-connection sample (one rain query per river)
        // for Phase 1; per-subseg drying could land later for partial dry
        // runs along long rivers.
        let isDry = false;
        if (isDetailed && this.climate && this.climate.getClimateAt) {
          const midIdx = poly.length >>> 1;
          const mid = poly[midIdx];
          if (mid) {
            const c = this.climate.getClimateAt(mid.x, mid.z);
            if (c && c.rainByte < 60) isDry = true;
          }
        }

        const colArr = isDetailed
          ? (isDry ? [150, 145, 130] : DETAIL_WATER_RGB)
          : ((watershedNode && watershedNode.color)
              ? watershedNode.color
              : (toCand && toCand.color));
        if (!colArr) continue;
        const liveColor = isDetailed && isDry
          ? `rgba(${colArr[0]},${colArr[1]},${colArr[2]},0.55)`
          : `rgb(${colArr[0]},${colArr[1]},${colArr[2]})`;
        const lineW = 2.5;
        const fraction = (conn.liveFraction !== undefined) ? conn.liveFraction : 1;

        ctx.lineWidth = lineW;
        if (conn.isCrossing) ctx.setLineDash([5, 4]); else ctx.setLineDash([]);

        // Stroke the full polyline in one of the three modes.
        if (fraction >= 0.999) {
          ctx.strokeStyle = liveColor;
          ctx.beginPath();
          ctx.moveTo(sxArr[0], syArr[0]);
          for (let i = 1; i < poly.length; i++) ctx.lineTo(sxArr[i], syArr[i]);
          ctx.stroke();
        } else if (fraction <= 0.001) {
          ctx.strokeStyle = GRAY_DRY;
          ctx.beginPath();
          ctx.moveTo(sxArr[0], syArr[0]);
          for (let i = 1; i < poly.length; i++) ctx.lineTo(sxArr[i], syArr[i]);
          ctx.stroke();
        } else {
          // Live from upstream (vertex 0) along `fraction` of arc-length,
          // gray for the rest. Find which subsegment the boundary falls
          // inside and interpolate the split point.
          const targetLen = totalLen * fraction;
          let acc = 0;
          let splitIdx = segLens.length - 1;
          let splitT = 1;
          for (let i = 0; i < segLens.length; i++) {
            if (acc + segLens[i] >= targetLen) {
              splitIdx = i;
              splitT = segLens[i] > 0 ? (targetLen - acc) / segLens[i] : 0;
              break;
            }
            acc += segLens[i];
          }
          const splitSx = sxArr[splitIdx] + (sxArr[splitIdx + 1] - sxArr[splitIdx]) * splitT;
          const splitSy = syArr[splitIdx] + (syArr[splitIdx + 1] - syArr[splitIdx]) * splitT;

          ctx.strokeStyle = liveColor;
          ctx.beginPath();
          ctx.moveTo(sxArr[0], syArr[0]);
          for (let i = 1; i <= splitIdx; i++) ctx.lineTo(sxArr[i], syArr[i]);
          ctx.lineTo(splitSx, splitSy);
          ctx.stroke();

          ctx.strokeStyle = GRAY_DRY;
          ctx.beginPath();
          ctx.moveTo(splitSx, splitSy);
          for (let i = splitIdx + 1; i < poly.length; i++) ctx.lineTo(sxArr[i], syArr[i]);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // Descent chevron at the polyline's arc-length midpoint. Drawn
        // only when there's any live portion (no chevron for a fully dry
        // valley). Direction = local tangent of the midpoint subsegment.
        if (fraction > 0.001 && totalLen > 8) {
          const halfLen = totalLen * 0.5;
          let acc = 0;
          let midIdx = segLens.length - 1;
          let midT = 1;
          for (let i = 0; i < segLens.length; i++) {
            if (acc + segLens[i] >= halfLen) {
              midIdx = i;
              midT = segLens[i] > 0 ? (halfLen - acc) / segLens[i] : 0;
              break;
            }
            acc += segLens[i];
          }
          const midSx = sxArr[midIdx] + (sxArr[midIdx + 1] - sxArr[midIdx]) * midT;
          const midSy = syArr[midIdx] + (syArr[midIdx + 1] - syArr[midIdx]) * midT;
          const ddx = sxArr[midIdx + 1] - sxArr[midIdx];
          const ddy = syArr[midIdx + 1] - syArr[midIdx];
          const len = Math.sqrt(ddx * ddx + ddy * ddy);
          if (len > 0.001) {
            const ux = ddx / len, uy = ddy / len;
            const tipX = midSx + ux * 3;
            const tipY = midSy + uy * 3;
            const ang = 0.45;
            const cosA = Math.cos(ang), sinA = Math.sin(ang);
            const back = 4 + lineW;
            const hx1 = -ux * cosA + uy * sinA;
            const hy1 = -uy * cosA - ux * sinA;
            const hx2 = -ux * cosA - uy * sinA;
            const hy2 = -uy * cosA + ux * sinA;
            ctx.strokeStyle = liveColor;
            ctx.beginPath();
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(tipX + hx1 * back, tipY + hy1 * back);
            ctx.moveTo(tipX, tipY);
            ctx.lineTo(tipX + hx2 * back, tipY + hy2 * back);
            ctx.stroke();
          }
        }
      }

      // 2) Points. Lake ends are drawn as filled circles in _drawLakes so
      // we skip them here to avoid double-marking; the lake circle IS the
      // candidate marker. Coast ends and springs render here.
      for (const c of rivers.candidates) {
        const sx = c.x * zoom + panX;
        const sy = c.z * zoom + panY;
        if (sx < -6 || sx > W + 6 || sy < -6 || sy > H + 6) continue;
        const isSpring = c.type === 'spring';
        // Lakes are drawn in _drawLakes; merge nodes (tributary join points)
        // are internal graph nodes — the connecting lines are the visible
        // feature, no dot/ring at the merge itself.
        if (c.type === 'lake' || c.type === 'merge') continue;

        if (!c.active) {
          // Inactive: gray ring for springs, own-colour ring for ends.
          ctx.lineWidth = 1;
          if (isSpring) {
            ctx.strokeStyle = SPRING_INACTIVE_RGBA;
          } else {
            const col = c.color;
            ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.45)`;
          }
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, Math.PI * 2);
          ctx.stroke();
          continue;
        }

        // Active: filled dot with dark outline.
        let fillStyle;
        if (isSpring && c.pairedTo < 0) {
          fillStyle = ORPHAN_FILL;
        } else {
          const col = colorFor(c);
          fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
        }
        ctx.fillStyle = fillStyle;
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.stroke();
      }

      // 2b/2c) Stepping-stone + connection-point bullseyes are debug
      // diagnostics for routing geometry. Skipped in detail-upheaval view
      // so the "what the player sees" rendering stays clean — bullseyes
      // only appear in primitive views.
      if (!isDetailed) {
        // 2b) Stepping-stone bullseyes — every lake-type graph node.
        // These are routing-graph nodes (river checkpoints), not lakes.
        // Drawn so the router's intermediate stones are visible. Real
        // lakes are an independent feature class drawn in _drawLakes
        // (typically on top of these markers, hiding the ones underneath
        // the lake interior).
        for (const c of rivers.candidates) {
          if (c.type !== 'lake') continue;
          const sx = c.x * zoom + panX;
          const sy = c.z * zoom + panY;
          if (sx < -6 || sx > W + 6 || sy < -6 || sy > H + 6) continue;
          ctx.strokeStyle = 'rgba(20, 50, 100, 0.55)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(sx, sy, 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(40, 90, 150, 0.85)';
          ctx.beginPath();
          ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // 2c) Connection-point bullseyes — colored by watershed. Drawn at
        // every node touched by a river polyline so the join points are
        // visible against the polyline (diagnostic for sharp-corner
        // placement: a corner AT a dot = junction issue, a corner BETWEEN
        // dots = mid-polyline wander). Overlays springs / coasts /
        // lakes / orphan teal bullseyes with the watershed colour.
        const drewConnDot = new Set();
        for (const conn of rivers.connections) {
          const wsCand = (conn.watershed !== undefined && conn.watershed >= 0)
            ? rivers.candidates[conn.watershed]
            : rivers.candidates[conn.toIdx];
          if (!wsCand || !wsCand.color) continue;
          const col = wsCand.color;
          const ringStyle  = `rgba(${col[0]},${col[1]},${col[2]},0.75)`;
          const fillStyle  = `rgb(${col[0]},${col[1]},${col[2]})`;
          for (let k = 0; k < 2; k++) {
            const idx = k === 0 ? conn.fromIdx : conn.toIdx;
            if (drewConnDot.has(idx)) continue;
            drewConnDot.add(idx);
            const c = rivers.candidates[idx];
            const sx = c.x * zoom + panX;
            const sy = c.z * zoom + panY;
            if (sx < -6 || sx > W + 6 || sy < -6 || sy > H + 6) continue;
            ctx.strokeStyle = ringStyle;
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.arc(sx, sy, 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = fillStyle;
            ctx.beginPath();
            ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // 3) Deflectors — red x's. The deflectors list is fine-spaced for the
      // mask; for display we stride it so x's don't visually fuse along the
      // spine. Stride 5 over arc-spacing 3 gives ~15 px between x's.
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(255,80,80,0.85)';
      ctx.lineCap = 'butt';
      const stride = 5;
      const defs = rivers.deflectors;
      if (defs && defs.length) {
        for (let i = 0; i < defs.length; i += stride) {
          const d = defs[i];
          const sx = d.x * zoom + panX;
          const sy = d.z * zoom + panY;
          if (sx < -6 || sx > W + 6 || sy < -6 || sy > H + 6) continue;
          const r = 2.5;
          ctx.beginPath();
          ctx.moveTo(sx - r, sy - r); ctx.lineTo(sx + r, sy + r);
          ctx.moveTo(sx + r, sy - r); ctx.lineTo(sx - r, sy + r);
          ctx.stroke();
        }
      }

      // 4) Hydrology marker — numeric labels per spring (flow), per end
      // (accumulatedFlow), per segment midpoint (segment flow = spring.flow).
      // Values below 0.01 are skipped so unconnected ends / negligible
      // springs don't clutter the screen.
      const showHydrology = document.getElementById('showHydrology')?.checked;
      if (showHydrology) this._drawHydrologyLabels(ctx, rivers);
    }

    // Numeric labels — sources and termini only. Lake-type checkpoints
    // are routing stones (not lakes), so they get no label here;
    // mid-segment labels were dropped earlier as debug noise.
    //   • Springs:        flow + outgoing velocity.
    //   • Coast termini:  accumulatedFlow + incoming velocity.
    // Values below MIN_VALUE skipped so unconnected ends don't clutter.
    _drawHydrologyLabels(ctx, rivers) {
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const W = this.overlayCanvas.width, H = this.overlayCanvas.height;
      const MIN_VALUE = 0.01;

      // Detail view climate-modulates the hydrology numbers — same as the
      // visible river drying / lake partial-fill. Primitive view shows the
      // structural primitive flows + velocities unmodified.
      const overlay = document.querySelector('input[name="overlay"]:checked')?.value;
      const isDetailed = overlay === 'detUpheaval';
      const climate = (isDetailed && this.climate && this.climate.getClimateAt)
        ? this.climate : null;

      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.lineWidth = 2.5;

      const label = (sx, sy, text) => {
        ctx.strokeText(text, sx, sy);
        ctx.fillText(text, sx, sy);
      };

      for (const c of rivers.candidates) {
        const isSpring = c.type === 'spring';
        const isCoast  = c.type === 'coast';
        if (!isSpring && !isCoast) continue;

        const sx = c.x * zoom + panX;
        const sy = c.z * zoom + panY;
        if (sx < -20 || sx > W + 20 || sy < -10 || sy > H + 10) continue;

        const flowVal = isSpring ? (c.flow || 0) : (c.accumulatedFlow || 0);
        if (flowVal < MIN_VALUE) continue;

        const velVal = isSpring
          ? (c.maxOutgoingVelocity || 0)
          : (c.maxIncomingVelocity || 0);

        let text;
        if (climate) {
          // Climate-modulated: rainByte 40→0.2× scale, 160→1.4× scale.
          // Below rainByte 60 the source is dry → show "dry" instead.
          const cc = climate.getClimateAt(c.x, c.z);
          if (cc && cc.rainByte < 60) {
            text = 'dry';
          } else {
            const scale = cc
              ? Math.max(0.2, Math.min(1.4, (cc.rainByte - 40) / 100))
              : 1;
            const f = flowVal * scale;
            const v = velVal * scale;
            text = velVal >= MIN_VALUE
              ? `${f.toFixed(2)} (${v.toFixed(2)})`
              : f.toFixed(2);
          }
        } else {
          text = velVal >= MIN_VALUE
            ? `${flowVal.toFixed(2)} (${velVal.toFixed(2)})`
            : flowVal.toFixed(2);
        }
        label(sx, sy - 10, text);
      }

      // Lake labels — primitive view shows structural metrics
      // "B r12.4 d70" (type / radius / max carve depth). Detail view
      // replaces depth with climate-driven fill fraction "B r12.4 f0.60"
      // matching the visible partial-fill shrink.
      const lakes = this.lakes;
      if (lakes && lakes.lakes) {
        for (const lake of lakes.lakes) {
          const sx = lake.center.x * zoom + panX;
          const sy = lake.center.z * zoom + panY;
          if (sx < -30 || sx > W + 30 || sy < -10 || sy > H + 10) continue;
          const typeTag = (lake.type === 'basin') ? 'B' : 'C';
          let text;
          if (climate) {
            const cc = climate.getClimateAt(lake.center.x, lake.center.z);
            const fillFrac = cc
              ? Math.max(0.25, Math.min(1, (cc.rainByte - 40) / 120))
              : 1;
            text = `${typeTag} r${lake.size.toFixed(1)} f${fillFrac.toFixed(2)}`;
          } else {
            text = `${typeTag} r${lake.size.toFixed(1)} d${lake.maxDepth}`;
          }
          label(sx, sy, text);
        }
      }
    }

    // ===== Lattice wireframe =====
    // Every shared lattice edge as a thin line; edges between a LAND and an
    // OCEAN face (the primitive coast segments) highlighted on top. Vector
    // lines instead of a pixel mask so the wireframe stays crisp under zoom.
    _drawLattice(ctx) {
      const mesh = this.mesh;
      const state = this.continent.faceState;
      if (!mesh || !state) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const W = this.overlayCanvas.width, H = this.overlayCanvas.height;
      const ax = mesh.a_x, az = mesh.a_z;

      const drawPass = (coastPass) => {
        ctx.beginPath();
        for (let f = 0; f < mesh.numFaces; f++) {
          const nbrs = mesh.faceEdgeNeighbors(f);
          for (let i = 0; i < nbrs.length; i++) {
            const g = nbrs[i];
            if (g < f) continue;                                   // each edge once
            const isCoast = (state[f] > 0) !== (state[g] > 0);
            if (isCoast !== coastPass) continue;
            const [a0, a1, a2] = mesh.faceCorners(f);
            const [b0, b1, b2] = mesh.faceCorners(g);
            let p = -1, q = -1;
            for (const c of [a0, a1, a2]) {
              if (c === b0 || c === b1 || c === b2) { if (p < 0) p = c; else q = c; }
            }
            const x1 = ax[p] * zoom + panX, y1 = az[p] * zoom + panY;
            const x2 = ax[q] * zoom + panX, y2 = az[q] * zoom + panY;
            if ((x1 < 0 && x2 < 0) || (x1 > W && x2 > W) ||
                (y1 < 0 && y2 < 0) || (y1 > H && y2 > H)) continue;
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
          }
        }
        ctx.stroke();
      };

      ctx.lineWidth = 1;
      ctx.strokeStyle = LATTICE_EDGE_COLOR;
      drawPass(false);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = LATTICE_COAST_EDGE_COLOR;
      drawPass(true);
    }

    // ===== Ridge rendering =====
    // Architecture rule: primitives generate everything; the coast field
    // enters as a CLIP MASK at detail render time (line features are never
    // warped — spec §7). Applied here:
    //   Seed dots — drawn in BOTH views as part of the ridge marker. Land
    //     seeds = solid filled; ocean seeds (primitive sense) = faded outline.
    //   Network polylines — drawn in BOTH views. Primitive view: unclipped
    //     (the full primitive data). Detailed view: clipped per the coast
    //     field's land mask, so polyline runs over emergent ocean are hidden.
    _drawRidges(ctx) {
      const ridges = this.ridges;
      if (!ridges) return;
      const overlay = document.querySelector('input[name="overlay"]:checked')?.value;
      const isPrimitive = overlay && overlay.startsWith('prim');
      this._drawRidgeNetworks(ctx, !isPrimitive);
      this._drawRidgeSeedDots(ctx);
    }

    _drawRidgeSeedDots(ctx) {
      const ridges = this.ridges;
      if (!ridges.anchors) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const W = this.overlayCanvas.width, H = this.overlayCanvas.height;

      // Anchors that produced a grown network get the contrast-outlined
      // marker so the seed reads clearly on top of the polyline trunk that
      // starts at it. Anchors that didn't grow (blocked early, no nearby
      // attractors) get the simpler flat dot. Ocean anchors stay as faded
      // outline regardless.
      const grownAnchors = new Set();
      if (ridges.networks) {
        for (const net of ridges.networks) grownAnchors.add(net.anchorIdx);
      }

      for (const anchor of ridges.anchors) {
        const sx = anchor.x * zoom + panX;
        const sy = anchor.z * zoom + panY;
        if (sx < -6 || sx > W + 6 || sy < -6 || sy > H + 6) continue;
        const c = anchor.color;
        if (anchor.inOcean) {
          // 1) Faded outline — visible but signals "inert / clipped in detailed".
          ctx.lineWidth = 1;
          ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.45)`;
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, Math.PI * 2);
          ctx.stroke();
        } else if (grownAnchors.has(anchor.index)) {
          // 3) Land seed that grew a network — filled colored dot with a
          //    dark outline so it stands out on top of the polyline trunk
          //    passing through it.
          ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
          ctx.beginPath();
          ctx.arc(sx, sy, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.stroke();
        } else {
          // 2) Land seed that didn't grow into a network — flat solid dot.
          ctx.lineWidth = 1;
          ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
          ctx.beginPath();
          ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // One coloured polyline per chain inside each network. Line width scales
    // with the chain's max flow fraction (trunks thicker, branches thinner).
    // Viewport bbox skip per polyline keeps draw cost bounded when zoomed in.
    // When `clipPerDetailedLand` is true (detailed view), polyline points are
    // clipped against the coast field's land mask: only on-land vertices are
    // drawn, ocean stretches lift the pen (moveTo without a preceding
    // lineTo). When false (primitive view), the full polyline draws
    // regardless of where its points land — primitive shows everything per
    // the architecture rule.
    _drawRidgeNetworks(ctx, clipPerDetailedLand) {
      const ridges = this.ridges;
      if (!ridges.networks) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const W = this.overlayCanvas.width, H = this.overlayCanvas.height;
      const mapW = this.mapW, mapH = this.mapH;
      const detailedLand = this.coastField ? this.coastField.landMask : null;
      const onDetailedLand = (clipPerDetailedLand && detailedLand)
        ? (x, z) => {
            const ix = x | 0, iz = z | 0;
            if (ix < 0 || iz < 0 || ix >= mapW || iz >= mapH) return false;
            return detailedLand[iz * mapW + ix] === 1;
          }
        : (x, z) => true;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const net of ridges.networks) {
        const c = net.color;
        ctx.strokeStyle = `rgb(${c[0]},${c[1]},${c[2]})`;

        for (const polyline of net.polylines) {
          const pts = polyline.points;
          if (pts.length < 2) continue;

          // Bounding box in screen space — skip if entirely off-canvas.
          let minSx = Infinity, maxSx = -Infinity, minSy = Infinity, maxSy = -Infinity;
          for (const pt of pts) {
            const sx = pt.x * zoom + panX;
            const sy = pt.z * zoom + panY;
            if (sx < minSx) minSx = sx; if (sx > maxSx) maxSx = sx;
            if (sy < minSy) minSy = sy; if (sy > maxSy) maxSy = sy;
          }
          if (maxSx < -10 || minSx > W + 10 || maxSy < -10 || minSy > H + 10) continue;

          // Width by max flow fraction in the chain (1..3.5 px at zoom=1).
          let maxFlow = 0;
          for (const pt of pts) if (pt.flowFrac > maxFlow) maxFlow = pt.flowFrac;
          ctx.lineWidth = Math.max(1, 1 + maxFlow * 2.5);

          // Clipped run-stroke: walk vertices, lineTo while on detailed land,
          // moveTo (lift pen) when ocean breaks a run.
          ctx.beginPath();
          let inRun = false;
          for (let i = 0; i < pts.length; i++) {
            const pt = pts[i];
            const sx = pt.x * zoom + panX;
            const sy = pt.z * zoom + panY;
            if (onDetailedLand(pt.x, pt.z)) {
              if (inRun) ctx.lineTo(sx, sy);
              else { ctx.moveTo(sx, sy); inRun = true; }
            } else {
              inRun = false;
            }
          }
          ctx.stroke();
        }
      }
    }

    // ===== Wind arrow rendering =====
    // Primitive: one arrow per anchor (data point) — the raw per-anchor wind
    // vector. Detailed: a regular grid, each arrow sampled from the interpolated
    // anchor field (mesh.sampleVec). Both read the standalone per-anchor vectors
    // (wind.computeAnchorWinds), not the polygon path.
    _drawWindOverlay(ctx, isPrimitive) {
      const wind = this.wind, mesh = this.mesh;
      if (!wind || !mesh || !wind.anchorWindDx) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const mapW = this.mapW, mapH = this.mapH;
      const ARROW_LEN_PRIM = 24;
      const ARROW_LEN_DET  = 14;
      const SPACING_DET    = 24;
      const wdx = wind.anchorWindDx, wdz = wind.anchorWindDz;
      const dxg = wind.detailedWindDx, dzg = wind.detailedWindDz; // blurred detailed field

      if (isPrimitive) {
        // One arrow per anchor (data point) — the raw per-anchor wind vector,
        // decoded from its signed component bytes.
        for (let t = 0; t < mesh.numAnchors; t++) {
          const ax = mesh.a_x[t], az = mesh.a_z[t];
          if (ax < 0 || ax >= mapW || az < 0 || az >= mapH) continue;
          const dx = V.decodeSignedByte(wdx[t], V.WIND_MAX), dz = V.decodeSignedByte(wdz[t], V.WIND_MAX);
          const mag = Math.sqrt(dx * dx + dz * dz);
          if (mag < 0.02) continue;
          const sx = ax * zoom + panX, sy = az * zoom + panY;
          this._drawArrow(ctx, sx, sy, dx, dz, ARROW_LEN_PRIM * zoom * mag, V.latColor(wind.latitudeAt(az)), 2);
        }
      } else {
        // Regular grid; each arrow reads the blurred detailed field (climate-
        // wide blur of the interpolated anchor vectors).
        if (!dxg) return;
        for (let mz = SPACING_DET / 2; mz < mapH; mz += SPACING_DET) {
          const sy = mz * zoom + panY;
          if (sy < -10 || sy > this.overlayCanvas.height + 10) continue;
          for (let mx = SPACING_DET / 2; mx < mapW; mx += SPACING_DET) {
            const sx = mx * zoom + panX;
            if (sx < -10 || sx > this.overlayCanvas.width + 10) continue;
            const idx = (mz | 0) * mapW + (mx | 0);
            const vdx = dxg[idx], vdz = dzg[idx];
            const mag = Math.sqrt(vdx * vdx + vdz * vdz);
            if (mag < 0.02) continue;
            this._drawArrow(ctx, sx, sy, vdx, vdz, ARROW_LEN_DET * zoom * mag, V.latColor(wind.latitudeAt(mz)), 1.2);
          }
        }
      }

      // Anchor Values marker → magnitude labels over the arrows.
      if (document.getElementById('showAnchorValues')?.checked) {
        this._drawVectorMagLabels(ctx, isPrimitive, wdx, wdz, dxg, dzg, false);
      }
    }

    // ===== Ocean current arrow rendering =====
    // Same shape as wind, ocean anchors only. Coloured by latitude band (matches
    // wind's colour language). Primitive = raw per-anchor vectors; detailed =
    // grid arrows sampled from the interpolated anchor field.
    _drawCurrentsOverlay(ctx, isPrimitive) {
      const currents = this.currents, mesh = this.mesh, wind = this.wind;
      if (!currents || !mesh || !wind || !currents.anchorCurrentDx) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const mapW = this.mapW, mapH = this.mapH;
      const ARROW_LEN_PRIM = 24;
      const ARROW_LEN_DET  = 14;
      const SPACING_DET    = 24;
      const cdx = currents.anchorCurrentDx, cdz = currents.anchorCurrentDz;
      const dxg = currents.detailedCurrentDx, dzg = currents.detailedCurrentDz; // blurred detailed field

      if (isPrimitive) {
        // One arrow per ocean anchor (land anchors carry no current → 0),
        // decoded from its signed component bytes.
        for (let t = 0; t < mesh.numAnchors; t++) {
          const ax = mesh.a_x[t], az = mesh.a_z[t];
          if (ax < 0 || ax >= mapW || az < 0 || az >= mapH) continue;
          const dx = V.decodeSignedByte(cdx[t], V.WIND_MAX), dz = V.decodeSignedByte(cdz[t], V.WIND_MAX);
          const mag = Math.sqrt(dx * dx + dz * dz);
          if (mag < 0.02) continue;
          const sx = ax * zoom + panX, sy = az * zoom + panY;
          this._drawArrow(ctx, sx, sy, dx, dz, ARROW_LEN_PRIM * zoom * mag, V.latColor(wind.latitudeAt(az)), 2);
        }
      } else {
        if (!dxg) return;
        const wlg = this.coastField && this.coastField.landMask;
        for (let mz = SPACING_DET / 2; mz < mapH; mz += SPACING_DET) {
          const sy = mz * zoom + panY;
          if (sy < -10 || sy > this.overlayCanvas.height + 10) continue;
          for (let mx = SPACING_DET / 2; mx < mapW; mx += SPACING_DET) {
            const sx = mx * zoom + panX;
            if (sx < -10 || sx > this.overlayCanvas.width + 10) continue;
            const idx = (mz | 0) * mapW + (mx | 0);
            if (wlg && wlg[idx] === 1) continue; // land — no current
            const vdx = dxg[idx], vdz = dzg[idx];
            const mag = Math.sqrt(vdx * vdx + vdz * vdz);
            if (mag < 0.02) continue;
            this._drawArrow(ctx, sx, sy, vdx, vdz, ARROW_LEN_DET * zoom * mag, V.latColor(wind.latitudeAt(mz)), 1.2);
          }
        }
      }

      // Anchor Values marker → magnitude labels over the arrows.
      if (document.getElementById('showAnchorValues')?.checked) {
        this._drawVectorMagLabels(ctx, isPrimitive, cdx, cdz, dxg, dzg, true);
      }
    }

    // Magnitude labels for a vector overlay (wind / currents), drawn when the
    // Anchor Values marker is on. Shows the magnitude as a 0–255 BYTE
    // (mag / WIND_MAX, clamped) — consistent with the other value markers; the
    // arrow carries direction. Primitive reads the signed component BYTES and
    // decodes them; detailed reads the decoded-float raster. Reuses the value
    // markers' 26px screen-space label dedup.
    _drawVectorMagLabels(ctx, isPrimitive, aDx, aDz, dDx, dDz, oceanOnly) {
      const mesh = this.mesh;
      if (!mesh || !aDx) return;
      const panX = this.panX, panY = this.panY, zoom = this.zoom;
      const mapW = this.mapW, mapH = this.mapH;
      const W = this.overlayCanvas.width, H = this.overlayCanvas.height;
      const WMAX = V.WIND_MAX;
      const wlg = oceanOnly && this.coastField ? this.coastField.landMask : null;
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const MIN_DIST_SQ = 26 * 26;
      const placedX = [], placedY = [];
      const place = (sx, sy, mag) => {
        if (sx < -20 || sx > W + 20 || sy < -10 || sy > H + 20) return;
        for (let p = 0; p < placedX.length; p++) {
          const ddx = sx - placedX[p], ddy = sy - placedY[p];
          if (ddx * ddx + ddy * ddy < MIN_DIST_SQ) return;
        }
        placedX.push(sx); placedY.push(sy);
        const label = String(Math.max(0, Math.min(255, Math.round(mag / WMAX * 255))));
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeText(label, sx, sy + 4);
        ctx.fillStyle = 'rgba(20,20,20,0.95)';
        ctx.fillText(label, sx, sy + 4);
      };
      if (isPrimitive) {
        for (let t = 0; t < mesh.numAnchors; t++) {
          const ax = mesh.a_x[t], az = mesh.a_z[t];
          if (ax < 0 || ax >= mapW || az < 0 || az >= mapH) continue;
          const dx = V.decodeSignedByte(aDx[t], WMAX), dz = V.decodeSignedByte(aDz[t], WMAX);
          const mag = Math.sqrt(dx * dx + dz * dz);
          if (mag < 0.02) continue;
          place(ax * zoom + panX, az * zoom + panY, mag);
        }
      } else if (dDx) {
        const SP = 24; // matches SPACING_DET in the arrow overlays
        for (let mz = SP / 2; mz < mapH; mz += SP) {
          for (let mx = SP / 2; mx < mapW; mx += SP) {
            const idx = (mz | 0) * mapW + (mx | 0);
            if (wlg && wlg[idx] === 1) continue;
            const vdx = dDx[idx], vdz = dDz[idx];
            const mag = Math.sqrt(vdx * vdx + vdz * vdz);
            if (mag < 0.02) continue;
            place(mx * zoom + panX, mz * zoom + panY, mag);
          }
        }
      }
    }

    // Single arrow with shaft + V-shaped head. (sx, sy) is the tail (origin);
    // arrow points along (dx, dz) for `length` screen pixels. Magnitude is
    // already baked into `length` by the caller.
    _drawArrow(ctx, sx, sy, dx, dz, length, color, lineWidth) {
      const mag = Math.sqrt(dx * dx + dz * dz);
      if (mag < 0.001 || length < 1) return;
      const ux = dx / mag, uz = dz / mag;
      const x2 = sx + ux * length;
      const y2 = sy + uz * length;
      const css = `rgb(${color[0]},${color[1]},${color[2]})`;
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = css;
      ctx.lineCap = 'round';
      // Shaft
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      // Head (two short strokes back from the tip at ±25°)
      const headLen = Math.max(3, length * 0.35);
      const ang = 0.45;
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      const hx1 = -ux * cosA + uz * sinA;
      const hz1 = -uz * cosA - ux * sinA;
      const hx2 = -ux * cosA - uz * sinA;
      const hz2 = -uz * cosA + ux * sinA;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 + hx1 * headLen, y2 + hz1 * headLen);
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 + hx2 * headLen, y2 + hz2 * headLen);
      ctx.stroke();
    }

    // ===== Mouse interaction =====
    _wireEvents() {
      let dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;

      this.canvasArea.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        dragStartX = e.clientX; dragStartY = e.clientY;
        panStartX = this.panX; panStartY = this.panY;
        this.canvasArea.classList.add('dragging');
      });

      window.addEventListener('mousemove', (e) => {
        if (dragging) {
          this.panX = panStartX + (e.clientX - dragStartX);
          this.panY = panStartY + (e.clientY - dragStartY);
          this.scheduleRender();
        } else {
          this._updateHover(e);
        }
      });

      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        this.canvasArea.classList.remove('dragging');
      });

      this.canvasArea.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = this.canvasArea.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newZoom = Math.max(0.05, Math.min(64, this.zoom * factor));
        // Anchor zoom on the point under the cursor.
        this.panX = cx - (cx - this.panX) * (newZoom / this.zoom);
        this.panY = cy - (cy - this.panY) * (newZoom / this.zoom);
        this.zoom = newZoom;
        this.scheduleRender();
      }, { passive: false });

      this.canvasArea.addEventListener('dblclick', () => {
        this._fitInitialZoom();
        this.render();
      });

      // Window resize → re-fit canvases and re-render.
      window.addEventListener('resize', () => {
        this._resizeCanvases();
        this.render();
      });

      // Panel resize (CSS width changes on #leftPanel) doesn't fire window
      // resize. ResizeObserver on canvas-area picks it up.
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          this._resizeCanvases();
          this.render();
        });
        ro.observe(this.canvasArea);
      }
    }

    // Convert a screen position to map coordinates and update the hover line.
    // GLOBAL readout: top-left origin, +x right, +z DOWN — matches the game
    //   (VS 0,0,0 is top-left, axes increase right/down) — same axes as
    //   LOCAL, just not centred: global = (mx, mz) × 32.
    // LOCAL readout: GLOBAL re-centred on spawn — local = (mx - mapW/2,
    //   mz - mapH/2) × 32.
    //
    // Line 2 is overlay-aware: shows the bytes / vectors most relevant to
    // the active overlay so you can compare polygons by their actual values
    // instead of squinting at the colour gradient.
    _updateHover(e) {
      const rect = this.canvasArea.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const mx = Math.floor((sx - this.panX) / this.zoom);
      const mz = Math.floor((sy - this.panY) / this.zoom);
      if (mx < 0 || mx >= this.mapW || mz < 0 || mz >= this.mapH) {
        if (this.hoverGeneral) this.hoverGeneral.textContent = 'Hover over map';
        if (this.hoverSpecific) this.hoverSpecific.textContent = '';
        return;
      }

      const blkX = mx * 32;
      const blkZ = mz * 32;
      const localX = (mx - (this.mapW >> 1)) * 32;
      const localZ = (mz - (this.mapH >> 1)) * 32;

      const idx = mz * this.mapW + mx;
      const wh = this.worldHeight;
      const seaY = Math.floor(0.4313725490196078 * wh);

      const uph = this.upheaval;
      const heightB = (uph && uph.detailedHeight) ? uph.detailedHeight[idx] : 0;
      const depthB = (uph && uph.detailedDepth) ? uph.detailedDepth[idx] : 0;

      // Land/ocean from the EMERGENT coastline — the signal the ocean map and the
      // column builder use, not the faceted face labels.
      const landMask = this.coastField && this.coastField.landMask;
      const isLand = landMask ? landMask[idx] === 1
        : !(this.continent && this.continent.landGrid) || this.continent.landGrid[idx] === 1;

      // Neither map stores a block height — both store a BYTE. The column builder
      // derives land Y from the upheaval byte (ColumnBuilder.AltitudeForByte) and
      // vanilla derives the sea floor from the ocean byte (GenTerra's
      // oceanicityFac); this mirrors both. One pixel covers a whole 32x32 chunk,
      // so it is the chunk's average surface, never a per-block value.
      const avgY = isLand
        ? Math.round(seaY + heightB / 255 * (wh - seaY))
        : seaY - Math.round(depthB * (wh / 256 * 0.33333));

      const haveClimate = this.climate && this.mesh && this.climate.anchorTemp;
      const tempB = haveClimate ? this.mesh.sampleScalar(mx, mz, this.climate.anchorTemp) : 0;

      // Line 1 — coordinates, then the two averages worth reading at a glance.
      let line = `chunk(${mx}, ${mz})  global(${blkX}, ${blkZ})  local(${localX}, ${localZ})  avg. y = ${avgY}`;
      // VS reads the temp byte back as roughly -20..+40 °C; altitude cooling is
      // the game's job and is deliberately not folded in.
      if (haveClimate) line += `  avg temp = ${(-20 + tempB / 255 * 60).toFixed(1)}°C`;

      // Line 2 — the pixel's own resolved values, always shown whatever overlay is
      // selected. ONE style throughout: lowercase label=value, two spaces apart,
      // raw values with no unit conversions (conversions belong on line 1).
      const parts = [isLand ? 'land' : 'ocean'];

      if (this.mesh) parts.push(`cell=${this.mesh.faceAt(mx, mz)}`);
      if (this.model) parts.push(`plate=${this.model.getPlateAt(mx, mz)}`);
      if (this.provinces && this.provinces.provinceMap && V.PROVINCE_NAMES) {
        parts.push(`province=${V.PROVINCE_NAMES[this.provinces.provinceMap[idx]] ?? '?'}`);
      }
      if (V.LANDFORMS && this.detailedLandformMap) {
        const lf = this.detailedLandformMap[idx];
        parts.push(`landform=${lf === 255 ? 'ocean' : (V.LANDFORMS[lf] ? V.LANDFORMS[lf].code : '?')}`);
      }

      // Field values, in pipeline order.
      if (uph && uph.detailedHeight) {
        parts.push(`height=${heightB}`);
        parts.push(`depth=${depthB}`);
      }
      if (haveClimate) {
        parts.push(`temp=${Math.round(tempB)}`);
        parts.push(`precip=${Math.round(this.mesh.sampleScalar(mx, mz, this.climate.anchorRain))}`);
        parts.push(`geo=${Math.round(this.mesh.sampleScalar(mx, mz, this.climate.anchorGeo))}`);
      }
      if (this.wind && this.mesh && this.wind.anchorWindDx) {
        const s = this.mesh.sampleVec(mx, mz, this.wind.anchorWindDx, this.wind.anchorWindDz);
        parts.push(`wind=(${V.decodeSignedByte(s.dx, V.WIND_MAX).toFixed(2)}, ` +
                   `${V.decodeSignedByte(s.dz, V.WIND_MAX).toFixed(2)})`);
      }
      if (this.currents && this.mesh && this.currents.anchorCurrentDx) {
        const s = this.mesh.sampleVec(mx, mz, this.currents.anchorCurrentDx, this.currents.anchorCurrentDz);
        const dx = V.decodeSignedByte(s.dx, V.WIND_MAX), dz = V.decodeSignedByte(s.dz, V.WIND_MAX);
        parts.push(Math.sqrt(dx * dx + dz * dz) >= 0.001
          ? `current=(${dx.toFixed(2)}, ${dz.toFixed(2)})`
          : 'current=none');
      }

      const line2 = parts.join('  ');

      if (this.hoverGeneral) this.hoverGeneral.textContent = line;
      if (this.hoverSpecific) this.hoverSpecific.textContent = line2;
    }
  }

  V.Renderer = Renderer;

})(window.VIS);
