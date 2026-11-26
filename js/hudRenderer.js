/**
 * hudRenderer.js
 * ----------------------------------------------------------------------------
 * Unified High-Speed 2D Canvas Renderer for:
 * 1. Fast Bounding-Box-Culled 2D Vector World Map Renderer (for instant offline export).
 * 2. Offline Country & City Place Labels + Metric Scale Bar.
 * 3. Progressive Trajectory Polyline, Ghost Preview Line, Visited Point Nodes,
 *    Stationary Dwell Halos, and Active Pulsing Markerhead.
 * 4. Top-Left Burned-In Forensic HUD Data Card.
 */

window.HUDRenderer = (function () {
  'use strict';

  let ringBoundsInitialized = false;

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  /**
   * Precomputes per-ring [minLon, minLat, maxLon, maxLat] bounding boxes once
   * so 1080p video exports cull offscreen country rings in nanoseconds.
   */
  function ensureRingBounds(localMap) {
    if (ringBoundsInitialized || !localMap) return;
    ringBoundsInitialized = true;

    function annotateFeatures(fc) {
      if (!fc || !fc.features) return;
      for (const f of fc.features) {
        const geom = f.geometry;
        if (!geom) continue;
        const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
        geom._ringBboxes = [];
        for (let p = 0; p < polys.length; p++) {
          const rings = polys[p];
          if (!rings || !rings[0] || rings[0].length === 0) {
            geom._ringBboxes.push(null);
            continue;
          }
          const outer = rings[0];
          let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
          for (let i = 0; i < outer.length; i++) {
            const lon = outer[i][0];
            const lat = outer[i][1];
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
          geom._ringBboxes.push([minLon, minLat, maxLon, maxLat]);
        }
      }
    }

    annotateFeatures(localMap.countries);
    annotateFeatures(localMap.lakes);
  }

  /**
   * Direct 2D Canvas renderer for the Preloaded Local Vector World Map
   * (Ocean, 10° Graticule, Countries, Coastlines, Lakes) with exact per-ring culling.
   */
  function drawVectorBaseMap2D(ctx, width, height, projector) {
    const localMap = window.LOCAL_WORLD_MAP;
    ctx.fillStyle = '#09111e';
    ctx.fillRect(0, 0, width, height);
    if (!localMap || !projector) return;

    ensureRingBounds(localMap);

    const bounds = projector.getBounds();
    const west = bounds.getWest() - 2;
    const east = bounds.getEast() + 2;
    const south = bounds.getSouth() - 2;
    const north = bounds.getNorth() + 2;

    // 1. Graticule lines
    if (localMap.graticule && localMap.graticule.features) {
      ctx.beginPath();
      for (const f of localMap.graticule.features) {
        const coords = f.geometry.coordinates;
        if (coords.length < 2) continue;
        const p1 = projector.project(coords[0]);
        const p2 = projector.project(coords[1]);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
      }
      ctx.strokeStyle = '#16243b';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    function traceGeometry(geom) {
      if (!geom) return;
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
      const bboxes = geom._ringBboxes || [];

      for (let p = 0; p < polys.length; p++) {
        const bbox = bboxes[p];
        if (bbox) {
          // Fast per-polygon viewport intersection test
          if (bbox[2] < west || bbox[0] > east || bbox[3] < south || bbox[1] > north) {
            continue;
          }
        }

        const rings = polys[p];
        if (!rings) continue;
        for (let r = 0; r < rings.length; r++) {
          const ring = rings[r];
          for (let i = 0; i < ring.length; i++) {
            const pt = projector.project(ring[i]);
            if (i === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
          }
          ctx.closePath();
        }
      }
    }

    // 2. Country Polygons & Borders
    if (localMap.countries && localMap.countries.features) {
      ctx.beginPath();
      for (const f of localMap.countries.features) {
        traceGeometry(f.geometry);
      }
      ctx.fillStyle = '#152033';
      ctx.fill();
      ctx.strokeStyle = '#2e4568';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // 3. Major Lakes
    if (localMap.lakes && localMap.lakes.features) {
      ctx.beginPath();
      for (const f of localMap.lakes.features) {
        traceGeometry(f.geometry);
      }
      ctx.fillStyle = '#09111e';
      ctx.fill();
    }
  }

  /**
   * Renders offline country and city labels with fast viewport culling.
   */
  function drawLocalVectorLabels(ctx, width, height, projector, scale) {
    const localMap = window.LOCAL_WORLD_MAP;
    if (!localMap || !projector) return;

    const zoom = projector.getZoom();
    const bounds = projector.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();

    const placedBoxes = [
      { x1: 0, y1: 0, x2: 390 * scale, y2: 175 * scale }
    ];

    function canPlaceBox(x1, y1, x2, y2) {
      if (x1 < 6 || y1 < 6 || x2 > width - 6 || y2 > height - 16) return false;
      for (let i = 0; i < placedBoxes.length; i++) {
        const b = placedBoxes[i];
        if (x1 < b.x2 && x2 > b.x1 && y1 < b.y2 && y2 > b.y1) {
          return false;
        }
      }
      placedBoxes.push({ x1, y1, x2, y2 });
      return true;
    }

    // 1. Country Labels
    if (zoom <= 8.5 && localMap.countryLabels && localMap.countryLabels.features) {
      ctx.font = `700 ${Math.round(11 * scale)}px Inter, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';

      for (const f of localMap.countryLabels.features) {
        const rank = f.properties.scalerank || 3;
        if (zoom < 3.8 && rank > 3) continue;
        if (zoom < 5.2 && rank > 5) continue;

        const [lon, lat] = f.geometry.coordinates;
        if (lon < west || lon > east || lat < south || lat > north) continue;

        const pt = projector.project([lon, lat]);
        const label = f.properties.name.toUpperCase();
        const tw = label.length * 7 * scale;
        const x1 = pt.x - tw / 2;
        const y1 = pt.y - 9 * scale;

        if (canPlaceBox(x1, y1, x1 + tw, y1 + 18 * scale)) {
          ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
          ctx.fillText(label, x1, pt.y);
        }
      }
    }

    // 2. City & Regional Town Labels (Capped at 24 visible labels max)
    if (zoom >= 3.5 && localMap.cities && localMap.cities.features) {
      let maxRank = 2;
      if (zoom >= 4.8) maxRank = 4;
      if (zoom >= 6.5) maxRank = 5;
      if (zoom >= 8.0) maxRank = 7;

      ctx.font = `600 ${Math.round(11 * scale)}px Inter, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';

      let drawnCities = 0;
      for (const f of localMap.cities.features) {
        if (drawnCities >= 24) break;
        const rank = f.properties.rank ?? 6;
        if (rank > maxRank) continue;

        const [lon, lat] = f.geometry.coordinates;
        if (lon < west || lon > east || lat < south || lat > north) continue;

        const pt = projector.project([lon, lat]);
        const name = f.properties.name;
        const tw = name.length * 6.5 * scale;
        const x1 = pt.x + 6 * scale;
        const y1 = pt.y - 8 * scale;

        if (canPlaceBox(x1 - 6, y1, x1 + tw + 6, y1 + 16 * scale)) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 2.5 * scale, 0, Math.PI * 2);
          ctx.fillStyle = '#94a3b8';
          ctx.fill();

          ctx.strokeStyle = 'rgba(9, 17, 30, 0.9)';
          ctx.lineWidth = 3 * scale;
          ctx.strokeText(name, x1, pt.y);
          ctx.fillStyle = '#cbd5e1';
          ctx.fillText(name, x1, pt.y);
          drawnCities++;
        }
      }
    }
  }

  /**
   * Draws the KML trajectory polyline, ghost track, visited datapoint markers,
   * dwell halos, and active markerhead directly onto the 2D Canvas.
   */
  function drawTrajectoryOnCanvas(ctx, state, dataset, projector, scale, pulsePhase) {
    if (!projector || !dataset || !state) return;

    const points = dataset.points;
    const completedIdx = state.completedPointIndex ?? state.activeIndex;

    const screenPts = points.map((p) => projector.project([p.lon, p.lat]));
    const activeScreenPt = projector.project([state.lon, state.lat]);

    // 1. Subtle dashed ghost line of full trajectory
    if (screenPts.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(screenPts[0].x, screenPts[0].y);
      for (let i = 1; i < screenPts.length; i++) {
        ctx.lineTo(screenPts[i].x, screenPts[i].y);
      }
      ctx.setLineDash([4 * scale, 6 * scale]);
      ctx.strokeStyle = 'rgba(100, 116, 139, 0.45)';
      ctx.lineWidth = 2 * scale;
      ctx.stroke();
      ctx.restore();
    }

    // 2. Progressive trajectory line (with dark casing + bright cyan core)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(screenPts[0].x, screenPts[0].y);
    for (let i = 1; i <= completedIdx; i++) {
      ctx.lineTo(screenPts[i].x, screenPts[i].y);
    }
    ctx.lineTo(activeScreenPt.x, activeScreenPt.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = 'rgba(9, 17, 30, 0.88)';
    ctx.lineWidth = 6.5 * scale;
    ctx.stroke();

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3.5 * scale;
    ctx.stroke();
    ctx.restore();

    // 3. Visited datapoint dots & dwell halos
    const visitedLimit = state.progress >= 0.999 ? points.length - 1 : completedIdx;
    for (let i = 0; i <= visitedLimit; i++) {
      const pt = points[i];
      const sp = screenPts[i];
      const isDwell = Boolean(pt.dwellClusterId);

      if (isDwell) {
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 10 * scale, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.22)';
        ctx.fill();
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.4 * scale;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 4.5 * scale, 0, Math.PI * 2);
      ctx.fillStyle = isDwell ? '#fbbf24' : '#10b981';
      ctx.fill();
      ctx.strokeStyle = '#09111e';
      ctx.lineWidth = 1.5 * scale;
      ctx.stroke();
    }

    // 4. Active Markerhead Puck & Pulsing Radar Ring
    const px = activeScreenPt.x;
    const py = activeScreenPt.y;
    const pt = state.currentPoint;
    const isDwell = Boolean(pt && pt.dwellClusterId);

    const pulseRadius = (16 + (Math.sin(pulsePhase) * 0.5 + 0.5) * 14) * scale;
    ctx.beginPath();
    ctx.arc(px, py, pulseRadius, 0, Math.PI * 2);
    ctx.fillStyle = isDwell ? 'rgba(245, 158, 11, 0.18)' : 'rgba(249, 115, 22, 0.20)';
    ctx.fill();
    ctx.strokeStyle = isDwell ? 'rgba(245, 158, 11, 0.85)' : 'rgba(56, 189, 248, 0.85)';
    ctx.lineWidth = 2 * scale;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(px, py, 7 * scale, 0, Math.PI * 2);
    ctx.fillStyle = '#f97316';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5 * scale;
    ctx.stroke();

    // 5. Floating Callout Tag next to the active markerhead
    const calloutText = isDwell
      ? `DWELL (${pt.dwellFixCount} fixes • ${window.KMLParser.formatDuration(pt.dwellDurationSec)})`
      : `Fix #${pt.number}`;

    ctx.font = `700 ${Math.round(11 * scale)}px "JetBrains Mono", Consolas, monospace`;
    const textWidth = ctx.measureText(calloutText).width;
    const boxW = textWidth + 16 * scale;
    const boxH = 22 * scale;
    const boxX = px + 16 * scale;
    const boxY = py - boxH / 2;

    roundRect(ctx, boxX, boxY, boxW, boxH, 5 * scale);
    ctx.fillStyle = isDwell ? 'rgba(120, 53, 15, 0.92)' : 'rgba(15, 23, 42, 0.90)';
    ctx.fill();
    ctx.strokeStyle = isDwell ? '#f59e0b' : '#38bdf8';
    ctx.lineWidth = 1.2 * scale;
    ctx.stroke();

    ctx.fillStyle = isDwell ? '#fef3c7' : '#f0f9ff';
    ctx.textBaseline = 'middle';
    ctx.fillText(calloutText, boxX + 8 * scale, boxY + boxH / 2);
  }

  /**
   * Draws a dynamic geographic distance scale bar in the bottom-right corner.
   */
  function drawMetricScaleBar(ctx, width, height, state, projector, scale) {
    if (!projector || !state) return;

    const zoom = projector.getZoom();
    const metersPerPx = (156543.03392 * Math.cos((state.lat * Math.PI) / 180)) / Math.pow(2, zoom);
    const targetPx = 110 * scale;
    const rawMeters = metersPerPx * targetPx;

    const niceSteps = [
      50, 100, 200, 500, 1000, 2000, 5000, 10000,
      20000, 50000, 100000, 200000, 500000, 1000000
    ];
    let snappedMeters = niceSteps[0];
    for (const s of niceSteps) {
      if (s <= rawMeters * 1.3) snappedMeters = s;
    }

    const barPx = Math.max(40 * scale, Math.min(160 * scale, snappedMeters / metersPerPx));
    const label = snappedMeters >= 1000 ? `${snappedMeters / 1000} km` : `${snappedMeters} m`;

    const boxW = barPx + 24 * scale;
    const boxH = 26 * scale;
    const boxX = width - boxW - 52 * scale;
    const boxY = height - 42 * scale;

    roundRect(ctx, boxX, boxY, boxW, boxH, 5 * scale);
    ctx.fillStyle = 'rgba(11, 15, 23, 0.84)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 1 * scale;
    ctx.stroke();

    const lineX = boxX + 12 * scale;
    const lineY = boxY + 18 * scale;
    ctx.beginPath();
    ctx.moveTo(lineX, lineY - 4 * scale);
    ctx.lineTo(lineX, lineY);
    ctx.lineTo(lineX + barPx, lineY);
    ctx.lineTo(lineX + barPx, lineY - 4 * scale);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2 * scale;
    ctx.stroke();

    ctx.font = `700 ${Math.round(10 * scale)}px "JetBrains Mono", Consolas, monospace`;
    ctx.fillStyle = '#e2e8f0';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lineX + 4 * scale, boxY + 9 * scale);
  }

  /**
   * Draws a visible Map Data Attribution Pill in the bottom-left corner
   * to comply with OpenStreetMap (ODbL) and Esri attribution requirements.
   */
  function drawMapAttributionBadge(ctx, width, height, scale) {
    const basemap = window.MapController ? window.MapController.getActiveBasemap() : 'streets';
    let attrText = 'Map data © OpenStreetMap contributors (ODbL) • Tiles: OSM France';
    if (basemap === 'satellite') {
      attrText = 'Satellite Imagery © Esri, Maxar, Earthstar Geographics';
    } else if (basemap === 'local_dark') {
      attrText = 'Offline Vector Map • Public Domain Natural Earth Data';
    }

    ctx.font = `600 ${Math.round(10 * scale)}px Inter, "Segoe UI", sans-serif`;
    const tw = ctx.measureText(attrText).width;
    const boxW = tw + 16 * scale;
    const boxH = 20 * scale;
    const boxX = 14 * scale;
    const boxY = height - boxH - 12 * scale;

    roundRect(ctx, boxX, boxY, boxW, boxH, 4 * scale);
    ctx.fillStyle = 'rgba(11, 15, 23, 0.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.lineWidth = 1 * scale;
    ctx.stroke();

    ctx.fillStyle = '#cbd5e1';
    ctx.textBaseline = 'middle';
    ctx.fillText(attrText, boxX + 8 * scale, boxY + boxH / 2);
  }

  /**
   * Main entry point to render the overlay.
   */
  function drawForensicHUD(ctx, width, height, state, dataset, options = {}) {
    if (!options.preserveBackground) {
      ctx.clearRect(0, 0, width, height);
      // During live playback, if an online map is mid-jump and WebGL tiles are still
      // refreshing, draw pre-cached RAM tiles immediately so there is zero blank delay!
      if (
        !options.isExportFrame &&
        window.MapController &&
        !window.MapController.isUsingLocalVectorOnly() &&
        !window.MapController.areTilesReady() &&
        window.Exporter &&
        window.Exporter.drawCachedTilesForLiveMap
      ) {
        window.Exporter.drawCachedTilesForLiveMap(ctx, width, height, options.mapInstance);
      }
    }

    const tzMode = options.tzMode || 'source';
    const projector = options.mapInstance || null;
    const pulsePhase = options.pulsePhase || 0;
    const isExportFrame = Boolean(options.isExportFrame);
    const scale = Math.min(1.25, Math.max(0.78, width / 1280));

    ctx.save();

    // 1. Offline Place Labels (rendered when using Local Offline Map)
    if (projector && window.MapController.isUsingLocalVectorOnly()) {
      drawLocalVectorLabels(ctx, width, height, projector, scale);
    }

    // Always draw Map Data Attribution badge (OpenStreetMap / Esri / Natural Earth)
    drawMapAttributionBadge(ctx, width, height, scale);

    if (!state || !dataset) {
      ctx.restore();
      return;
    }

    // 2. Trajectory Polyline, Visited Dots, Dwell Rings & Active Markerhead
    drawTrajectoryOnCanvas(ctx, state, dataset, projector, scale, pulsePhase);

    // 3. Metric Scale Bar
    drawMetricScaleBar(ctx, width, height, state, projector, scale);

    // 4. Top-Left Forensic HUD Data Card
    const cardX = Math.round(16 * scale);
    const cardY = Math.round(16 * scale);
    const cardW = Math.round(355 * scale);
    const cardH = Math.round(142 * scale);

    roundRect(ctx, cardX, cardY, cardW, cardH, 10 * scale);
    ctx.fillStyle = 'rgba(11, 15, 23, 0.90)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.lineWidth = 1.5 * scale;
    ctx.stroke();

    roundRect(ctx, cardX, cardY, 5 * scale, cardH, 3 * scale);
    ctx.fillStyle = state.isGapJump
      ? '#a855f7'
      : state.currentPoint.dwellClusterId
      ? '#f59e0b'
      : '#38bdf8';
    ctx.fill();

    const innerX = cardX + Math.round(16 * scale);
    let cursorY = cardY + Math.round(18 * scale);

    ctx.font = `700 ${Math.round(10.5 * scale)}px Inter, "Segoe UI", sans-serif`;
    ctx.fillStyle = '#38bdf8';
    ctx.textBaseline = 'middle';
    ctx.fillText('LOCATION TIMELINE', innerX, cursorY);

    const fixCounterText = `FIX ${state.currentPoint.number} / ${dataset.points.length}`;
    ctx.font = `700 ${Math.round(11 * scale)}px "JetBrains Mono", Consolas, monospace`;
    const counterW = ctx.measureText(fixCounterText).width;
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(fixCounterText, cardX + cardW - counterW - 14 * scale, cursorY);

    cursorY += Math.round(24 * scale);
    const formattedTs = window.KMLParser.formatTimestamp(
      state.epochMs,
      state.offsetMinutes,
      state.tzLabel,
      tzMode
    );
    ctx.font = `700 ${Math.round(15 * scale)}px "JetBrains Mono", Consolas, monospace`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(formattedTs, innerX, cursorY);

    cursorY += Math.round(22 * scale);
    ctx.font = `600 ${Math.round(12 * scale)}px Inter, "Segoe UI", sans-serif`;
    ctx.fillStyle = '#cbd5e1';
    const descText = state.currentPoint.description || 'GPS Location Fix';
    ctx.fillText(descText.slice(0, 42), innerX, cursorY);

    cursorY += Math.round(21 * scale);
    const coordText = `LAT ${state.lat.toFixed(7)}°   LON ${state.lon.toFixed(7)}°`;
    ctx.font = `500 ${Math.round(11.5 * scale)}px "JetBrains Mono", Consolas, monospace`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(coordText, innerX, cursorY);

    cursorY += Math.round(26 * scale);
    let pillText = '';
    let pillBg = 'rgba(16, 185, 129, 0.18)';
    let pillBorder = '#10b981';
    let pillColor = '#6ee7b7';

    if (state.isGapJump) {
      pillText = `⏩ TIME GAP JUMP: +${window.KMLParser.formatDuration(state.gapDeltaSec)} (${(state.segmentDistMeters / 1000).toFixed(1)} km)`;
      pillBg = 'rgba(168, 85, 247, 0.22)';
      pillBorder = '#a855f7';
      pillColor = '#e9d5ff';
    } else if (state.currentPoint.dwellClusterId) {
      const pt = state.currentPoint;
      pillText = `⏸ STATIONARY DWELL • ${pt.dwellFixCount} fixes (${window.KMLParser.formatDuration(pt.dwellDurationSec)})`;
      pillBg = 'rgba(245, 158, 11, 0.20)';
      pillBorder = '#f59e0b';
      pillColor = '#fde68a';
    } else {
      const distStr = state.segmentDistMeters >= 1000
        ? `${(state.segmentDistMeters / 1000).toFixed(2)} km`
        : `${Math.round(state.segmentDistMeters)} m`;
      pillText = `▶ TRANSIT SEGMENT • Δd: ${distStr} • Δt: ${window.KMLParser.formatDuration(state.gapDeltaSec)}`;
    }

    const pillH = Math.round(22 * scale);
    const pillW = cardW - Math.round(28 * scale);
    roundRect(ctx, innerX, cursorY - pillH / 2, pillW, pillH, 5 * scale);
    ctx.fillStyle = pillBg;
    ctx.fill();
    ctx.strokeStyle = pillBorder;
    ctx.lineWidth = 1 * scale;
    ctx.stroke();

    ctx.font = `700 ${Math.round(10.5 * scale)}px "JetBrains Mono", Consolas, monospace`;
    ctx.fillStyle = pillColor;
    ctx.fillText(pillText, innerX + 8 * scale, cursorY);

    if (isExportFrame) {
      const edgeH = Math.round(4 * scale);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(0, height - edgeH, width, edgeH);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(0, height - edgeH, Math.max(0, Math.min(1, state.progress)) * width, edgeH);
    }

    ctx.restore();
  }

  return {
    drawForensicHUD,
    drawVectorBaseMap2D
  };
})();
