/**
 * exporter.js
 * ----------------------------------------------------------------------------
 * Deterministic, Zero-Lag Video (MP4 / WebM) & Animated GIF Exporter.
 *
 * Why This Exporter Never Lags or Desyncs on Online Maps:
 * 1. Exact Mathematical Web Mercator Projector (`createExportProjector`):
 *    - Never resizes the DOM `#mapViewport` (which Flexbox can squish/skew)
 *      and never captures asynchronous WebGL frames (`glCanvas`).
 *    - Instead, computes exact slippy-map tile coordinates `{z}/{y}/{x}` and
 *      point projections `(x, y)` for the exact `(exportWidth, exportHeight)`
 *      canvas using the identical Web Mercator formula for both map tiles and
 *      the trajectory line.
 * 2. Phase 1 Pre-Fetch Cache for Online Maps (`precacheOnlineTilesForExport`):
 *    - When "Online Street Map" or "Online Satellite" is selected, scans all
 *      export frames first and downloads every required 256x256 tile image into
 *      an in-memory cache BEFORE Frame 0 is encoded.
 *    - During Phase 2 (encoding), every frame draws from RAM in < 2 ms with
 *      ZERO network delay, producing silky-smooth 1080p videos and GIFs where
 *      the map tracks the journey with 100% pixel lock.
 */

window.Exporter = (function () {
  'use strict';

  let cancelRequested = false;
  // Persistent in-memory cache of loaded HTMLImageElement tiles across exports
  const tileImageCache = new Map();

  const TILE_TEMPLATES = {
    streets: [
      'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png'
    ],
    satellite: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
    ]
  };

  function requestCancel() {
    cancelRequested = true;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ==========================================================================
  // Exact Web Mercator Projector & Slippy Tile Compositor
  // ==========================================================================

  function lonToNormX(lon) {
    return (lon + 180) / 360;
  }

  function latToNormY(lat) {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sinPhi = Math.sin((clamped * Math.PI) / 180);
    return 0.5 - Math.log((1 + sinPhi) / (1 - sinPhi)) / (4 * Math.PI);
  }

  function normXToLon(nx) {
    return nx * 360 - 180;
  }

  function normYToLat(ny) {
    const n = Math.PI - 2 * Math.PI * ny;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  /**
   * Creates a deterministic standalone projector for a given camera center,
   * zoom level, and export canvas size (width, height).
   * Implements the same `.project([lon, lat])`, `.getZoom()`, and `.getBounds()`
   * interface as MapLibre so `HUDRenderer` works seamlessly.
   */
  function createExportProjector(centerLon, centerLat, zoom, width, height) {
    // MapLibre uses 512px world size at zoom 0; standard slippy tiles are 256px at zoom+1
    const worldSizePx = 512 * Math.pow(2, zoom);
    const centerX = lonToNormX(centerLon) * worldSizePx;
    const centerY = latToNormY(centerLat) * worldSizePx;
    const halfW = width / 2;
    const halfH = height / 2;

    const westLon = normXToLon((centerX - halfW) / worldSizePx);
    const eastLon = normXToLon((centerX + halfW) / worldSizePx);
    const northLat = normYToLat((centerY - halfH) / worldSizePx);
    const southLat = normYToLat((centerY + halfH) / worldSizePx);

    return {
      centerLon,
      centerLat,
      zoom,
      width,
      height,
      worldSizePx,
      centerX,
      centerY,
      project([lon, lat]) {
        return {
          x: halfW + (lonToNormX(lon) * worldSizePx - centerX),
          y: halfH + (latToNormY(lat) * worldSizePx - centerY)
        };
      },
      getZoom() {
        return zoom;
      },
      getBounds() {
        return {
          getWest: () => westLon,
          getEast: () => eastLon,
          getNorth: () => northLat,
          getSouth: () => southLat
        };
      }
    };
  }

  /**
   * Determines the camera (centerLon, centerLat, zoom) for a given timeline state
   * during export, respecting the user's selected Camera Mode and current Zoom Level.
   */
  function getExportCameraForState(state, liveMapInstance) {
    const camMode = window.MapController.getCameraMode();
    const liveZoom = liveMapInstance ? liveMapInstance.getZoom() : 11.5;
    const liveCenter = liveMapInstance ? liveMapInstance.getCenter() : { lng: state.lon, lat: state.lat };

    if (camMode === 'follow') {
      return {
        lon: state.lon,
        lat: state.lat,
        zoom: liveZoom
      };
    } else {
      // 'overview' or 'manual': keep the fixed viewport camera center and zoom
      return {
        lon: liveCenter.lng,
        lat: liveCenter.lat,
        zoom: liveZoom
      };
    }
  }

  /**
   * Computes all visible 256x256 slippy tiles { z, x, y, screenX, screenY, drawSize }
   * for the given projector, supporting full high-precision Street level (up to Zoom 19)
   * at all waypoints and local movements.
   */
  function getVisibleTilesForProjector(projector, basemapKey = 'streets', isMidLongJump = false) {
    let maxTileZ = basemapKey === 'satellite' ? 18 : 19;
    if (isMidLongJump) {
      // During mid-flight frames across >10 km jumps, cap tile fetch level to avoid
      // downloading hundreds of single-frame desert/ocean tiles while keeping steady zoom
      maxTileZ = Math.min(maxTileZ, 11);
    }
    const tileZ = Math.max(1, Math.min(maxTileZ, Math.round(projector.zoom + 1)));
    const numTiles = Math.pow(2, tileZ);
    const tileDrawSize = projector.worldSizePx / numTiles;

    const minWorldX = projector.centerX - projector.width / 2;
    const maxWorldX = projector.centerX + projector.width / 2;
    const minWorldY = projector.centerY - projector.height / 2;
    const maxWorldY = projector.centerY + projector.height / 2;

    const minTx = Math.floor(minWorldX / tileDrawSize);
    const maxTx = Math.floor(maxWorldX / tileDrawSize);
    const minTy = Math.max(0, Math.floor(minWorldY / tileDrawSize));
    const maxTy = Math.min(numTiles - 1, Math.floor(maxWorldY / tileDrawSize));

    const tiles = [];
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        // Wrap tile X horizontally across antimeridian
        const wrappedTx = ((tx % numTiles) + numTiles) % numTiles;
        const screenX = projector.width / 2 + (tx * tileDrawSize - projector.centerX);
        const screenY = projector.height / 2 + (ty * tileDrawSize - projector.centerY);
        tiles.push({
          z: tileZ,
          x: wrappedTx,
          y: ty,
          screenX,
          screenY,
          drawSize: tileDrawSize
        });
      }
    }
    return tiles;
  }

  function formatTileUrl(template, z, x, y) {
    const subdomains = ['a', 'b', 'c'];
    const sub = subdomains[Math.abs(x + y) % 3];
    return template
      .replace('{s}', sub)
      .replace('{z}', z)
      .replace('{x}', x)
      .replace('{y}', y);
  }

  function loadTileImage(url) {
    if (tileImageCache.has(url)) {
      return Promise.resolve(tileImageCache.get(url));
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => {
        resolve(null);
      }, 4500);
      img.onload = () => {
        clearTimeout(timer);
        tileImageCache.set(url, img);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve(null);
      };
      img.src = url;
    });
  }

  /**
   * Phase 1: Pre-fetches all unique online map tiles needed across the entire
   * export timeline before video/GIF encoding starts.
   */
  async function precacheOnlineTilesForExport(params) {
    const {
      basemapKey,
      width,
      height,
      totalFrames,
      dataset,
      schedule,
      liveMapInstance,
      onProgress
    } = params;

    const templates = TILE_TEMPLATES[basemapKey];
    if (!templates || templates.length === 0) return;

    const urlSet = new Set();

    // Sample camera states across all frames to collect every required tile URL
    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      const progress = totalFrames > 1 ? frameIdx / (totalFrames - 1) : 1;
      const state = window.TimelineEngine.evaluateAtProgress(dataset, schedule, progress);
      const cam = getExportCameraForState(state, liveMapInstance);
      const projector = createExportProjector(cam.lon, cam.lat, cam.zoom, width, height);
      const isMidLongJump =
        state.segmentDistMeters > 10000 &&
        state.rawSegmentProgress > 0.08 &&
        state.rawSegmentProgress < 0.92;
      const visibleTiles = getVisibleTilesForProjector(projector, basemapKey, isMidLongJump);

      for (const t of visibleTiles) {
        for (const tpl of templates) {
          urlSet.add(formatTileUrl(tpl, t.z, t.x, t.y));
        }
      }
    }

    const urls = Array.from(urlSet).filter((u) => !tileImageCache.has(u));
    if (urls.length === 0) return;

    let completed = 0;
    const concurrency = 16;
    let cursor = 0;

    async function worker() {
      while (cursor < urls.length && !cancelRequested) {
        const idx = cursor++;
        await loadTileImage(urls[idx]);
        completed++;
        if (onProgress && (completed % 4 === 0 || completed === urls.length)) {
          onProgress(
            completed,
            urls.length,
            `Pre-caching high-precision map tiles (${completed} / ${urls.length})...`
          );
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, urls.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  }

  /**
   * Draws the pre-cached online raster tiles onto exportCtx for the current frame.
   */
  function drawOnlineTiles2D(exportCtx, projector, basemapKey, isMidLongJump = false) {
    const templates = TILE_TEMPLATES[basemapKey];
    if (!templates) return;

    const visibleTiles = getVisibleTilesForProjector(projector, basemapKey, isMidLongJump);
    for (const tpl of templates) {
      for (const t of visibleTiles) {
        const url = formatTileUrl(tpl, t.z, t.x, t.y);
        const img = tileImageCache.get(url);
        if (img) {
          // Slight +0.6px overlap prevents sub-pixel hairline seams between tiles
          exportCtx.drawImage(
            img,
            Math.floor(t.screenX),
            Math.floor(t.screenY),
            Math.ceil(t.drawSize + 0.6),
            Math.ceil(t.drawSize + 0.6)
          );
        }
      }
    }
  }

  /**
   * Composites a single export frame onto exportCtx using the exact mathematical projector.
   */
  function compositeFrame(exportCtx, exportWidth, exportHeight, state, dataset, hudOptions) {
    const liveMapInstance = hudOptions.mapInstance;
    const cam = getExportCameraForState(state, liveMapInstance);
    const projector = createExportProjector(cam.lon, cam.lat, cam.zoom, exportWidth, exportHeight);
    const basemapKey = window.MapController.getActiveBasemap();
    const isMidLongJump =
      state.segmentDistMeters > 10000 &&
      state.rawSegmentProgress > 0.08 &&
      state.rawSegmentProgress < 0.92;

    // 1. Draw base map (2D Vector World Map underlay + pre-cached Online Tiles if active)
    window.HUDRenderer.drawVectorBaseMap2D(exportCtx, exportWidth, exportHeight, projector);

    if (!window.MapController.isUsingLocalVectorOnly()) {
      drawOnlineTiles2D(exportCtx, projector, basemapKey, isMidLongJump);
    }

    // 2. Draw trajectory line, visited fixes, dwell rings, scale bar & Forensic HUD
    // using the EXACT same projector so the map and trajectory never drift apart!
    window.HUDRenderer.drawForensicHUD(
      exportCtx,
      exportWidth,
      exportHeight,
      state,
      dataset,
      {
        ...hudOptions,
        mapInstance: projector,
        preserveBackground: true,
        isExportFrame: true
      }
    );
  }

  async function runExport(config) {
    cancelRequested = false;

    const {
      format,
      width,
      height,
      fps,
      durationSec,
      dataset,
      schedule,
      tzMode,
      onProgress,
      onRestoreViewport
    } = config;

    const totalFrames = Math.max(10, Math.round(fps * durationSec));
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    const exportCtx = exportCanvas.getContext('2d', { willReadFrequently: format === 'gif' });

    const liveMapInstance = window.MapController.getMapInstance();
    const basemapKey = window.MapController.getActiveBasemap();

    try {
      // Phase 1: If using an online map, pre-cache all visible tiles into memory first
      // so the encoding loop has zero network delay or frame lag!
      if (!window.MapController.isUsingLocalVectorOnly()) {
        await precacheOnlineTilesForExport({
          basemapKey,
          width,
          height,
          totalFrames,
          dataset,
          schedule,
          liveMapInstance,
          onProgress
        });
      }

      if (cancelRequested) return;

      const timestampTag = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

      if (format === 'gif') {
        const gifBlob = await encodeAnimatedGif({
          exportCanvas,
          exportCtx,
          width,
          height,
          fps,
          totalFrames,
          dataset,
          schedule,
          tzMode,
          mapInstance: liveMapInstance,
          onProgress
        });
        if (!cancelRequested && gifBlob) {
          downloadBlob(gifBlob, `journey-${timestampTag}.gif`);
        }
      } else if (typeof VideoEncoder !== 'undefined' && typeof Mp4Muxer !== 'undefined') {
        // Use deterministic WebCodecs H.264 encoder for crisp, zero-lag high-res video
        const mp4Blob = await encodeWebCodecsMp4({
          exportCanvas,
          exportCtx,
          width,
          height,
          fps,
          totalFrames,
          dataset,
          schedule,
          tzMode,
          mapInstance: liveMapInstance,
          onProgress
        });
        if (!cancelRequested && mp4Blob) {
          downloadBlob(mp4Blob, `journey-${timestampTag}.mp4`);
        }
      } else {
        const { blob, ext } = await encodeMediaRecorderVideo({
          exportCanvas,
          exportCtx,
          width,
          height,
          fps,
          totalFrames,
          format,
          dataset,
          schedule,
          tzMode,
          mapInstance: liveMapInstance,
          onProgress
        });
        if (!cancelRequested && blob) {
          downloadBlob(blob, `journey-${timestampTag}.${ext}`);
        }
      }
    } finally {
      if (onRestoreViewport) {
        onRestoreViewport();
      }
    }
  }

  async function encodeWebCodecsMp4(params) {
    const {
      exportCanvas,
      exportCtx,
      width,
      height,
      fps,
      totalFrames,
      dataset,
      schedule,
      tzMode,
      mapInstance,
      onProgress
    } = params;

    const evenW = width % 2 === 0 ? width : width - 1;
    const evenH = height % 2 === 0 ? height : height - 1;

    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: {
        codec: 'avc',
        width: evenW,
        height: evenH
      },
      fastStart: 'in-memory'
    });

    let encoderError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => {
        encoderError = err;
      }
    });

    const codecString = evenW * evenH > 1280 * 720 ? 'avc1.420028' : 'avc1.42001f';
    encoder.configure({
      codec: codecString,
      width: evenW,
      height: evenH,
      bitrate: evenW * evenH > 1280 * 720 ? 10_000_000 : 6_000_000,
      framerate: fps
    });

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      if (cancelRequested || encoderError) break;

      // Respect encoder queue backpressure so 1080p encoding never drops frames or stutters
      while (encoder.encodeQueueSize > 5 && !cancelRequested) {
        await new Promise((r) => setTimeout(r, 4));
      }

      const progress = totalFrames > 1 ? frameIdx / (totalFrames - 1) : 1;
      const state = window.TimelineEngine.evaluateAtProgress(dataset, schedule, progress);

      compositeFrame(exportCtx, evenW, evenH, state, dataset, {
        tzMode,
        speedMultiplier: 1,
        mapInstance,
        pulsePhase: frameIdx * 0.25
      });

      const timestampUs = Math.round((frameIdx * 1_000_000) / fps);
      const durationUs = Math.round(1_000_000 / fps);
      const videoFrame = new VideoFrame(exportCanvas, {
        timestamp: timestampUs,
        duration: durationUs
      });

      encoder.encode(videoFrame, { keyFrame: frameIdx % fps === 0 });
      videoFrame.close();

      if (onProgress && (frameIdx % 3 === 0 || frameIdx === totalFrames - 1)) {
        onProgress(frameIdx + 1, totalFrames, `Encoding HD Video frame ${frameIdx + 1} / ${totalFrames}`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (cancelRequested) {
      encoder.close();
      return null;
    }
    if (encoderError) {
      throw encoderError;
    }

    await encoder.flush();
    encoder.close();
    muxer.finalize();

    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }

  async function encodeMediaRecorderVideo(params) {
    const {
      exportCanvas,
      exportCtx,
      width,
      height,
      fps,
      totalFrames,
      format,
      dataset,
      schedule,
      tzMode,
      mapInstance,
      onProgress
    } = params;

    const mimeCandidates = format === 'mp4'
      ? ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

    let selectedMime = 'video/webm';
    for (const mime of mimeCandidates) {
      if (MediaRecorder.isTypeSupported(mime)) {
        selectedMime = mime;
        break;
      }
    }

    const ext = selectedMime.includes('mp4') ? 'mp4' : 'webm';
    const stream = exportCanvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, {
      mimeType: selectedMime,
      videoBitsPerSecond: 8_000_000
    });

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const stopPromise = new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(chunks, { type: selectedMime }));
      };
    });

    recorder.start();
    const frameIntervalMs = Math.round(1000 / fps);

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      if (cancelRequested) break;
      const t0 = performance.now();

      const progress = totalFrames > 1 ? frameIdx / (totalFrames - 1) : 1;
      const state = window.TimelineEngine.evaluateAtProgress(dataset, schedule, progress);

      compositeFrame(exportCtx, width, height, state, dataset, {
        tzMode,
        speedMultiplier: 1,
        mapInstance,
        pulsePhase: frameIdx * 0.25
      });

      if (onProgress && (frameIdx % 3 === 0 || frameIdx === totalFrames - 1)) {
        onProgress(frameIdx + 1, totalFrames, `Recording ${ext.toUpperCase()} frame ${frameIdx + 1} / ${totalFrames}`);
      }

      const elapsed = performance.now() - t0;
      const waitMs = Math.max(1, frameIntervalMs - elapsed);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    recorder.stop();
    const blob = await stopPromise;
    return { blob: cancelRequested ? null : blob, ext };
  }

  // Built-In Zero-Dependency GIF89a LZW Encoder
  function createGifPalette332() {
    const palette = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const r3 = (i >> 5) & 0x07;
      const g3 = (i >> 2) & 0x07;
      const b2 = i & 0x03;
      palette[i * 3] = Math.round((r3 * 255) / 7);
      palette[i * 3 + 1] = Math.round((g3 * 255) / 7);
      palette[i * 3 + 2] = Math.round((b2 * 255) / 3);
    }
    return palette;
  }

  function quantizeFrameToIndices(rgbaData, width, height, indexedOut) {
    const bayer2x2 = [
      [-6, 2],
      [4, -2]
    ];
    let p = 0;
    for (let y = 0; y < height; y++) {
      const ditherRow = bayer2x2[y & 1];
      for (let x = 0; x < width; x++) {
        const d = ditherRow[x & 1];
        const r = Math.max(0, Math.min(255, rgbaData[p] + d));
        const g = Math.max(0, Math.min(255, rgbaData[p + 1] + d));
        const b = Math.max(0, Math.min(255, rgbaData[p + 2] + d));
        p += 4;

        const r3 = (r * 7 + 127) >> 8;
        const g3 = (g * 7 + 127) >> 8;
        const b2 = (b * 3 + 127) >> 8;
        indexedOut[y * width + x] = (r3 << 5) | (g3 << 2) | b2;
      }
    }
  }

  function lzwEncodeGifFrame(indices, outBytes) {
    const minCodeSize = 8;
    outBytes.push(minCodeSize);

    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;

    const TABLE_SIZE = 8192;
    const keyTable = new Int32Array(TABLE_SIZE);
    const codeTable = new Int16Array(TABLE_SIZE);
    keyTable.fill(-1);

    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    let maxCode = (1 << codeSize) - 1;

    let bitBuf = 0;
    let bitCount = 0;
    const subBlock = new Uint8Array(255);
    let subLen = 0;

    function flushSubBlock() {
      if (subLen > 0) {
        outBytes.push(subLen);
        for (let i = 0; i < subLen; i++) {
          outBytes.push(subBlock[i]);
        }
        subLen = 0;
      }
    }

    function writeCode(code) {
      bitBuf |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        subBlock[subLen++] = bitBuf & 0xff;
        if (subLen === 255) flushSubBlock();
        bitBuf >>= 8;
        bitCount -= 8;
      }
    }

    function resetTable() {
      keyTable.fill(-1);
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
      maxCode = (1 << codeSize) - 1;
    }

    writeCode(clearCode);
    if (indices.length === 0) {
      writeCode(eoiCode);
      if (bitCount > 0) subBlock[subLen++] = bitBuf & 0xff;
      flushSubBlock();
      outBytes.push(0);
      return;
    }

    let prefix = indices[0];

    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const fullKey = (prefix << 8) | k;
      let slot = ((prefix << 5) ^ k) & (TABLE_SIZE - 1);

      let foundCode = -1;
      while (keyTable[slot] !== -1) {
        if (keyTable[slot] === fullKey) {
          foundCode = codeTable[slot];
          break;
        }
        slot = (slot + 1) & (TABLE_SIZE - 1);
      }

      if (foundCode !== -1) {
        prefix = foundCode;
      } else {
        writeCode(prefix);
        if (nextCode < 4096) {
          keyTable[slot] = fullKey;
          codeTable[slot] = nextCode++;
          if (nextCode - 1 > maxCode && codeSize < 12) {
            codeSize++;
            maxCode = (1 << codeSize) - 1;
          }
        } else {
          writeCode(clearCode);
          resetTable();
        }
        prefix = k;
      }
    }

    writeCode(prefix);
    writeCode(eoiCode);

    if (bitCount > 0) {
      subBlock[subLen++] = bitBuf & 0xff;
    }
    flushSubBlock();
    outBytes.push(0);
  }

  async function encodeAnimatedGif(params) {
    const {
      exportCtx,
      width,
      height,
      fps,
      totalFrames,
      dataset,
      schedule,
      tzMode,
      mapInstance,
      onProgress
    } = params;

    const bytes = [];
    const pushStr = (s) => {
      for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
    };
    const pushU16 = (v) => {
      bytes.push(v & 0xff, (v >> 8) & 0xff);
    };

    pushStr('GIF89a');
    pushU16(width);
    pushU16(height);
    bytes.push(0xf7, 0x00, 0x00);

    const palette = createGifPalette332();
    for (let i = 0; i < palette.length; i++) {
      bytes.push(palette[i]);
    }

    bytes.push(0x21, 0xff, 0x0b);
    pushStr('NETSCAPE2.0');
    bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);

    const delayCs = Math.max(2, Math.round(100 / fps));
    const indexedBuffer = new Uint8Array(width * height);

    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
      if (cancelRequested) return null;

      const progress = totalFrames > 1 ? frameIdx / (totalFrames - 1) : 1;
      const state = window.TimelineEngine.evaluateAtProgress(dataset, schedule, progress);

      compositeFrame(exportCtx, width, height, state, dataset, {
        tzMode,
        speedMultiplier: 1,
        mapInstance,
        pulsePhase: frameIdx * 0.3
      });

      const imgData = exportCtx.getImageData(0, 0, width, height);
      quantizeFrameToIndices(imgData.data, width, height, indexedBuffer);

      bytes.push(0x21, 0xf9, 0x04, 0x00);
      pushU16(delayCs);
      bytes.push(0x00, 0x00);

      bytes.push(0x2c);
      pushU16(0);
      pushU16(0);
      pushU16(width);
      pushU16(height);
      bytes.push(0x00);

      lzwEncodeGifFrame(indexedBuffer, bytes);

      if (onProgress && (frameIdx % 2 === 0 || frameIdx === totalFrames - 1)) {
        onProgress(frameIdx + 1, totalFrames, `Encoding GIF frame ${frameIdx + 1} / ${totalFrames}`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    bytes.push(0x3b);
    return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
  }

  /**
   * Pre-caches all online map tiles along the trip for smooth live playback
   * (so big location changes render immediately from RAM + browser cache).
   */
  async function precacheTripForLivePlayback(params) {
    const {
      dataset,
      schedule,
      liveMapInstance,
      onProgress
    } = params;

    if (!dataset || !schedule || !liveMapInstance) return 0;
    const basemapKey = window.MapController.getActiveBasemap();
    if (window.MapController.isUsingLocalVectorOnly()) return 0;

    const container = liveMapInstance.getContainer();
    const width = container ? container.clientWidth : 1280;
    const height = container ? container.clientHeight : 720;

    // Sample every waypoint + 120 intermediate steps across the schedule
    const totalSamples = Math.max(80, dataset.points.length * 3);

    await precacheOnlineTilesForExport({
      basemapKey,
      width,
      height,
      totalFrames: totalSamples,
      dataset,
      schedule,
      liveMapInstance,
      onProgress
    });

    return tileImageCache.size;
  }

  /**
   * Draws pre-cached online tiles directly onto the live 2D canvas whenever
   * MapLibre WebGL is mid-jump across a big location change.
   */
  function drawCachedTilesForLiveMap(ctx, width, height, liveMapInstance) {
    if (!liveMapInstance) return;
    const basemapKey = window.MapController.getActiveBasemap();
    const center = liveMapInstance.getCenter();
    const zoom = liveMapInstance.getZoom();
    const projector = createExportProjector(center.lng, center.lat, zoom, width, height);
    drawOnlineTiles2D(ctx, projector, basemapKey, false);
  }

  return {
    runExport,
    requestCancel,
    precacheTripForLivePlayback,
    drawCachedTilesForLiveMap
  };
})();
