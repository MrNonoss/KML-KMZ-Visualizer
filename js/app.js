/**
 * app.js
 * ----------------------------------------------------------------------------
 * Main Application Controller for the KML/KMZ Timeline Visualizer.
 *
 * Key Behaviors:
 * 1. Shows the full Global World Map on startup before any KML is loaded.
 * 2. Never causes 'move' event recursion: separates drawOverlayOnly() (called when
 *    the user manually pans/zooms the map) from stepCameraAndDraw() (called during
 *    playback or timeline scrubbing).
 * 3. Allows the user to manually zoom in/out and pan the map at any time.
 */

(function () {
  'use strict';

  // Application State
  let rawXmlCache = null;
  let dataset = null;
  let schedule = null;

  let isPlaying = false;
  let currentProgress = 0; // Normalized [0, 1]
  let lastFrameTimeMs = 0;
  let pulsePhase = 0;

  // User Settings (Managed in the consolidated Options Menu)
  let timingMode = 'smart';         // 'smart' | 'sequential' | 'linear'
  let speedMultiplier = 1.0;        // 0.5x .. 10x
  let gapThresholdSec = 3600;       // 1 hour default
  let dwellRadiusMeters = 30;       // 30m default
  let tzMode = 'source';            // 'source' | 'utc'
  const BASE_DURATION_SEC = 30;

  // DOM References
  const fileInput = document.getElementById('fileInput');
  const btnCacheTrip = document.getElementById('btnCacheTrip');
  const btnOpenOptions = document.getElementById('btnOpenOptions');
  const btnOpenExport = document.getElementById('btnOpenExport');

  const stageContainer = document.getElementById('stageContainer');
  const mapViewport = document.getElementById('mapViewport');
  const hudCanvas = document.getElementById('hudCanvas');
  const hudCtx = hudCanvas.getContext('2d');
  const dropZoneOverlay = document.getElementById('dropZoneOverlay');

  const btnRestart = document.getElementById('btnRestart');
  const btnPrevPoint = document.getElementById('btnPrevPoint');
  const btnPlayPause = document.getElementById('btnPlayPause');
  const btnNextPoint = document.getElementById('btnNextPoint');
  const btnFitBounds = document.getElementById('btnFitBounds');
  const timelineSlider = document.getElementById('timelineSlider');
  const lblCurrentTime = document.getElementById('lblCurrentTime');
  const lblPointProgress = document.getElementById('lblPointProgress');
  const lblTotalSpan = document.getElementById('lblTotalSpan');
  const zoomPresetSelect = document.getElementById('zoomPresetSelect');
  const speedSelect = document.getElementById('speedSelect');

  // Options Modal DOM
  const optionsModal = document.getElementById('optionsModal');
  const btnCloseOptions = document.getElementById('btnCloseOptions');
  const btnResetOptions = document.getElementById('btnResetOptions');
  const btnApplyOptions = document.getElementById('btnApplyOptions');
  const btnOpenLicence = document.getElementById('btnOpenLicence');
  const licenceModal = document.getElementById('licenceModal');
  const btnCloseLicence = document.getElementById('btnCloseLicence');
  const btnBackToOptions = document.getElementById('btnBackToOptions');
  const basemapSelect = document.getElementById('basemapSelect');
  const cameraModeSelect = document.getElementById('cameraModeSelect');
  const timingModeSelect = document.getElementById('timingModeSelect');
  const tzModeSelect = document.getElementById('tzModeSelect');
  const gapThresholdSelect = document.getElementById('gapThresholdSelect');
  const dwellRadiusSelect = document.getElementById('dwellRadiusSelect');

  // Sidebar DOM
  const badgeSummary = document.getElementById('badgeSummary');
  const statDistance = document.getElementById('statDistance');
  const statDuration = document.getElementById('statDuration');
  const statDwells = document.getElementById('statDwells');
  const statGaps = document.getElementById('statGaps');
  const pointSearchInput = document.getElementById('pointSearchInput');
  const pointListContainer = document.getElementById('pointListContainer');

  // Export Modal DOM
  const exportModal = document.getElementById('exportModal');
  const btnCloseExport = document.getElementById('btnCloseExport');
  const btnCancelExport = document.getElementById('btnCancelExport');
  const btnStartExport = document.getElementById('btnStartExport');
  const exportFormatSelect = document.getElementById('exportFormatSelect');
  const exportResSelect = document.getElementById('exportResSelect');
  const exportFpsSelect = document.getElementById('exportFpsSelect');
  const exportCalculatedDuration = document.getElementById('exportCalculatedDuration');
  const exportProgressSection = document.getElementById('exportProgressSection');
  const exportStatusText = document.getElementById('exportStatusText');
  const exportPercentText = document.getElementById('exportPercentText');
  const exportProgressBar = document.getElementById('exportProgressBar');

  let lastHighlightedIndex = -1;

  function syncHudCanvasSize() {
    const rect = mapViewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    hudCanvas.width = Math.round(rect.width * dpr);
    hudCanvas.height = Math.round(rect.height * dpr);
    hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverlayOnly();
  }

  /**
   * Redraws the 2D HUD & trajectory canvas at the current map viewport
   * WITHOUT moving the MapLibre camera. Safe to call on map 'move'/'zoom' events!
   */
  function drawOverlayOnly() {
    const rect = mapViewport.getBoundingClientRect();
    const mapInstance = window.MapController.getMapInstance();

    if (!dataset || !schedule) {
      // No KML loaded yet: draw offline global place labels on the world map
      window.HUDRenderer.drawForensicHUD(hudCtx, rect.width, rect.height, null, null, {
        mapInstance,
        isExportFrame: false
      });
      return;
    }

    const state = window.TimelineEngine.evaluateAtProgress(dataset, schedule, currentProgress);

    window.HUDRenderer.drawForensicHUD(
      hudCtx,
      rect.width,
      rect.height,
      state,
      dataset,
      {
        tzMode,
        speedMultiplier,
        mapInstance,
        pulsePhase,
        isExportFrame: false
      }
    );

    timelineSlider.value = Math.round(currentProgress * 1000);
    lblCurrentTime.textContent = window.KMLParser.formatTimestamp(
      state.epochMs,
      state.offsetMinutes,
      state.tzLabel,
      tzMode
    );
    lblPointProgress.textContent = `Fix ${state.currentPoint.number} / ${dataset.points.length}`;

    if (state.activeIndex !== lastHighlightedIndex) {
      lastHighlightedIndex = state.activeIndex;
      const items = pointListContainer.querySelectorAll('.point-item');
      items.forEach((el) => {
        const idx = parseInt(el.dataset.index, 10);
        el.classList.toggle('active', idx === state.activeIndex);
        el.classList.toggle('visited', idx < state.activeIndex);
        if (idx === state.activeIndex) {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    }
  }

  /**
   * Moves the camera (if Smart Auto-Camera or Follow mode is active) AND redraws
   * the 2D overlay. Called during playback, timeline scrubbing, or point stepping.
   */
  function updateCameraAndDraw() {
    if (dataset && schedule) {
      const state = window.TimelineEngine.evaluateAtProgress(dataset, schedule, currentProgress);
      window.MapController.updateCameraForState(state);
    }
    drawOverlayOnly();
  }

  /**
   * Computes the exact playback & export duration in seconds from the waypoint
   * schedule and the user's selected Speed multiplier (never cut by an arbitrary fixed length).
   */
  function getEffectiveClipDurationSec() {
    if (!schedule || !schedule.totalVirtualSec) return 10;
    return Math.max(1.5, schedule.totalVirtualSec / speedMultiplier);
  }

  function updateExportDurationPreview() {
    if (!exportCalculatedDuration || !dataset || !schedule) return;
    const durSec = getEffectiveClipDurationSec();
    const fps = parseInt(exportFpsSelect.value, 10) || 30;
    const totalFrames = Math.max(10, Math.round(durSec * fps));
    exportCalculatedDuration.textContent =
      `${durSec.toFixed(1)}s (${dataset.points.length} pts @ ${speedMultiplier}x • ${totalFrames} frames)`;
  }

  function loadKmlFromString(xmlString) {
    pausePlayback();
    rawXmlCache = xmlString;

    dataset = window.KMLParser.parseKmlXml(xmlString, {
      dwellRadiusMeters,
      gapThresholdSeconds: gapThresholdSec
    });

    schedule = window.TimelineEngine.buildSchedule(dataset, {
      timingMode,
      gapThresholdSec,
      dwellRadiusMeters
    });

    window.MapController.setDataset(dataset);

    btnRestart.disabled = false;
    btnPrevPoint.disabled = false;
    btnPlayPause.disabled = false;
    btnNextPoint.disabled = false;
    btnFitBounds.disabled = false;
    timelineSlider.disabled = false;
    btnOpenExport.disabled = false;
    if (btnCacheTrip) {
      btnCacheTrip.disabled = false;
      btnCacheTrip.textContent = 'Cache';
    }

    updateSummaryStats();
    renderPointSidebarList();

    currentProgress = 0;
    const presetZoom = parseFloat(zoomPresetSelect.value) || 16.5;
    const firstPt = dataset.points[0];
    window.MapController.setZoomLevel(presetZoom, [firstPt.lon, firstPt.lat]);
    updateCameraAndDraw();
  }

  function rebuildScheduleAndTelemetry() {
    if (!rawXmlCache) return;
    const prevProgress = currentProgress;
    dataset = window.KMLParser.parseKmlXml(rawXmlCache, {
      dwellRadiusMeters,
      gapThresholdSeconds: gapThresholdSec
    });
    schedule = window.TimelineEngine.buildSchedule(dataset, {
      timingMode,
      gapThresholdSec,
      dwellRadiusMeters
    });
    window.MapController.setDataset(dataset);
    updateSummaryStats();
    renderPointSidebarList();
    currentProgress = prevProgress;
    drawOverlayOnly();
  }

  function updateSummaryStats() {
    if (!dataset) return;
    const s = dataset.stats;
    badgeSummary.textContent = `${s.totalFixes} fixes`;
    statDistance.textContent = s.totalDistanceMeters >= 1000
      ? `${(s.totalDistanceMeters / 1000).toFixed(1)} km`
      : `${Math.round(s.totalDistanceMeters)} m`;
    statDuration.textContent = window.KMLParser.formatDuration(s.totalSpanSec);
    statDwells.textContent = `${s.dwellClusterCount} clusters`;
    statGaps.textContent = `${s.gapCount} jumps`;
    lblTotalSpan.textContent = `Span: ${window.KMLParser.formatDuration(s.totalSpanSec)}`;
  }

  function renderPointSidebarList() {
    if (!dataset) return;
    const filterQuery = (pointSearchInput.value || '').trim().toLowerCase();
    pointListContainer.innerHTML = '';

    for (const pt of dataset.points) {
      const formattedTs = window.KMLParser.formatTimestamp(
        pt.epochMs,
        pt.offsetMinutes,
        pt.tzLabel,
        tzMode
      );
      const coordStr = `${pt.lat.toFixed(6)}, ${pt.lon.toFixed(6)}`;

      if (filterQuery) {
        const haystack = `${pt.number} ${formattedTs} ${coordStr} ${pt.description}`.toLowerCase();
        if (!haystack.includes(filterQuery)) continue;
      }

      const item = document.createElement('div');
      item.className = 'point-item';
      item.dataset.index = pt.index;

      let badgesHtml = '';
      if (pt.dwellClusterId) {
        badgesHtml += `<span class="mini-tag tag-dwell">⏸ Dwell #${pt.dwellClusterId} (${pt.dwellFixCount} pts • ${window.KMLParser.formatDuration(pt.dwellDurationSec)})</span>`;
      }
      if (pt.isTimeGap) {
        badgesHtml += `<span class="mini-tag tag-gap">⏩ Gap +${window.KMLParser.formatDuration(pt.deltaSecFromPrev)}</span>`;
      }
      if (pt.isLongTransit) {
        badgesHtml += `<span class="mini-tag tag-transit">✈ Transit ${(pt.distFromPrevMeters / 1000).toFixed(1)} km</span>`;
      }

      item.innerHTML = `
        <div class="point-top">
          <span class="point-index">#${pt.number}</span>
          <span class="point-time">${formattedTs}</span>
        </div>
        <div class="point-coords">Lat: ${pt.lat.toFixed(7)}° | Lon: ${pt.lon.toFixed(7)}°</div>
        <div class="point-desc">${pt.description}</div>
        ${badgesHtml ? `<div class="point-badges">${badgesHtml}</div>` : ''}
      `;

      item.addEventListener('click', () => {
        seekToPointIndex(pt.index);
      });

      pointListContainer.appendChild(item);
    }

    lastHighlightedIndex = -1;
  }

  function animationLoop(nowMs) {
    if (!isPlaying) return;

    const dtSec = Math.min(0.1, (nowMs - lastFrameTimeMs) / 1000);
    lastFrameTimeMs = nowMs;
    pulsePhase += dtSec * 5.0;

    const effectiveDurationSec = getEffectiveClipDurationSec();
    currentProgress += dtSec / effectiveDurationSec;

    if (currentProgress >= 1.0) {
      currentProgress = 1.0;
      updateCameraAndDraw();
      pausePlayback();
      return;
    }

    updateCameraAndDraw();
    requestAnimationFrame(animationLoop);
  }

  function startPlayback() {
    if (!dataset) return;
    if (currentProgress >= 0.999) {
      currentProgress = 0;
    }
    isPlaying = true;
    btnPlayPause.textContent = '⏸ Pause';
    lastFrameTimeMs = performance.now();
    requestAnimationFrame(animationLoop);
  }

  function pausePlayback() {
    isPlaying = false;
    btnPlayPause.textContent = '▶ Play';
  }

  function togglePlayPause() {
    if (isPlaying) pausePlayback();
    else startPlayback();
  }

  function seekToPointIndex(pointIdx) {
    if (!dataset || !schedule) return;
    const clampedIdx = Math.max(0, Math.min(dataset.points.length - 1, pointIdx));
    currentProgress = window.TimelineEngine.getProgressForPointIndex(schedule, clampedIdx);
    updateCameraAndDraw();
  }

  async function handleFileUpload(file) {
    if (!file) return;
    try {
      const xmlString = await window.KMLParser.extractKmlStringFromFile(file);
      loadKmlFromString(xmlString);
    } catch (err) {
      alert(`Failed to load ${file.name}: ${err.message}`);
    }
  }

  async function initApp() {
    // Initialize map at full Global World Map view; pass drawOverlayOnly for manual pan/zoom
    await window.MapController.initMap('map', () => {
      drawOverlayOnly();
    });

    window.addEventListener('resize', syncHudCanvasSize);
    syncHudCanvasSize();

    // File Picker & Drag-and-Drop
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleFileUpload(e.target.files[0]);
        fileInput.value = '';
      }
    });

    stageContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZoneOverlay.classList.remove('hidden');
    });
    stageContainer.addEventListener('dragleave', (e) => {
      if (!stageContainer.contains(e.relatedTarget)) {
        dropZoneOverlay.classList.add('hidden');
      }
    });
    stageContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZoneOverlay.classList.add('hidden');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileUpload(e.dataTransfer.files[0]);
      }
    });

    // Pre-Cache Trip Map Button for Zero-Delay Live Playback
    if (btnCacheTrip) {
      btnCacheTrip.addEventListener('click', async () => {
        if (!dataset || !schedule) return;
        pausePlayback();
        btnCacheTrip.disabled = true;
        btnCacheTrip.textContent = '0%';
        try {
          await window.Exporter.precacheTripForLivePlayback({
            dataset,
            schedule,
            liveMapInstance: window.MapController.getMapInstance(),
            onProgress: (done, total) => {
              const pct = Math.round((done / total) * 100);
              btnCacheTrip.textContent = `${pct}%`;
            }
          });
          btnCacheTrip.textContent = '✔ Cached';
        } catch (_) {
          btnCacheTrip.textContent = 'Cache';
        } finally {
          btnCacheTrip.disabled = false;
          drawOverlayOnly();
        }
      });
    }

    // Consolidated Options Modal
    btnOpenOptions.addEventListener('click', () => {
      pausePlayback();
      optionsModal.classList.remove('hidden');
    });
    const closeOptionsModal = () => optionsModal.classList.add('hidden');
    btnCloseOptions.addEventListener('click', closeOptionsModal);
    btnApplyOptions.addEventListener('click', closeOptionsModal);

    // Licence & Legal Notice Modal
    if (btnOpenLicence && licenceModal) {
      btnOpenLicence.addEventListener('click', () => {
        licenceModal.classList.remove('hidden');
      });
      const closeLicenceModal = () => licenceModal.classList.add('hidden');
      if (btnCloseLicence) btnCloseLicence.addEventListener('click', closeLicenceModal);
      if (btnBackToOptions) btnBackToOptions.addEventListener('click', closeLicenceModal);
    }

    btnResetOptions.addEventListener('click', () => {
      basemapSelect.value = 'local_dark';
      cameraModeSelect.value = 'follow';
      timingModeSelect.value = 'smart';
      tzModeSelect.value = 'source';
      gapThresholdSelect.value = '3600';
      dwellRadiusSelect.value = '30';
      zoomPresetSelect.value = '16.5';

      window.MapController.setBasemap('local_dark');
      window.MapController.setCameraMode('follow');
      window.MapController.setZoomLevel(16.5);
      timingMode = 'smart';
      tzMode = 'source';
      gapThresholdSec = 3600;
      dwellRadiusMeters = 30;
      rebuildScheduleAndTelemetry();
    });

    basemapSelect.addEventListener('change', () => {
      window.MapController.setBasemap(basemapSelect.value);
      drawOverlayOnly();
    });
    cameraModeSelect.addEventListener('change', () => {
      window.MapController.setCameraMode(cameraModeSelect.value);
      updateCameraAndDraw();
    });
    tzModeSelect.addEventListener('change', () => {
      tzMode = tzModeSelect.value;
      renderPointSidebarList();
      drawOverlayOnly();
    });
    timingModeSelect.addEventListener('change', () => {
      timingMode = timingModeSelect.value;
      rebuildScheduleAndTelemetry();
    });
    gapThresholdSelect.addEventListener('change', () => {
      gapThresholdSec = parseInt(gapThresholdSelect.value, 10) || 3600;
      rebuildScheduleAndTelemetry();
    });
    dwellRadiusSelect.addEventListener('change', () => {
      const parsed = parseInt(dwellRadiusSelect.value, 10);
      dwellRadiusMeters = Number.isNaN(parsed) ? 30 : parsed;
      rebuildScheduleAndTelemetry();
    });

    // Playback Transport Controls
    btnPlayPause.addEventListener('click', togglePlayPause);
    btnRestart.addEventListener('click', () => {
      pausePlayback();
      currentProgress = 0;
      updateCameraAndDraw();
    });
    btnPrevPoint.addEventListener('click', () => {
      if (!dataset) return;
      pausePlayback();
      const state = window.TimelineEngine.evaluateAtProgress(dataset, schedule, currentProgress);
      // If currently paused mid-segment between two points, snap to the start of the segment;
      // otherwise step backward to the previous fix index.
      const isMidSegment = state.rawSegmentProgress > 0.08 && state.rawSegmentProgress < 0.92;
      const targetIdx = isMidSegment ? state.startPoint.index : state.currentPoint.index - 1;
      seekToPointIndex(targetIdx);
    });
    btnNextPoint.addEventListener('click', () => {
      if (!dataset) return;
      pausePlayback();
      const state = window.TimelineEngine.evaluateAtProgress(dataset, schedule, currentProgress);
      seekToPointIndex(state.currentPoint.index + 1);
    });
    btnFitBounds.addEventListener('click', () => {
      if (!dataset) return;
      pausePlayback();
      window.MapController.fitFullDatasetBounds(dataset, true);
      drawOverlayOnly();
    });

    timelineSlider.addEventListener('input', () => {
      pausePlayback();
      currentProgress = parseInt(timelineSlider.value, 10) / 1000;
      updateCameraAndDraw();
    });

    zoomPresetSelect.addEventListener('change', () => {
      const z = parseFloat(zoomPresetSelect.value) || 16.5;
      let center = null;
      if (dataset && schedule) {
        const state = window.TimelineEngine.evaluateAtProgress(dataset, schedule, currentProgress);
        center = [state.lon, state.lat];
      }
      window.MapController.setZoomLevel(z, center);
      if (btnCacheTrip && dataset) {
        btnCacheTrip.textContent = 'Cache';
      }
      drawOverlayOnly();
    });

    speedSelect.addEventListener('change', () => {
      speedMultiplier = parseFloat(speedSelect.value) || 1.0;
      drawOverlayOnly();
    });

    pointSearchInput.addEventListener('input', renderPointSidebarList);

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (!exportModal.classList.contains('hidden') || !optionsModal.classList.contains('hidden')) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        btnNextPoint.click();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        btnPrevPoint.click();
      }
    });

    // Export Modal Wiring
    btnOpenExport.addEventListener('click', () => {
      pausePlayback();
      updateExportDurationPreview();
      exportProgressSection.classList.add('hidden');
      btnStartExport.disabled = false;
      exportModal.classList.remove('hidden');
    });

    const closeExportModal = () => {
      window.Exporter.requestCancel();
      exportModal.classList.add('hidden');
    };
    btnCloseExport.addEventListener('click', closeExportModal);
    btnCancelExport.addEventListener('click', closeExportModal);

    exportFormatSelect.addEventListener('change', () => {
      if (exportFormatSelect.value === 'gif') {
        exportResSelect.value = '960x540';
        exportFpsSelect.value = '12';
      } else {
        exportResSelect.value = '1280x720';
        exportFpsSelect.value = '30';
      }
      updateExportDurationPreview();
    });

    exportFpsSelect.addEventListener('change', updateExportDurationPreview);

    btnStartExport.addEventListener('click', async () => {
      if (!dataset || !schedule) return;

      btnStartExport.disabled = true;
      exportProgressSection.classList.remove('hidden');
      exportProgressBar.style.width = '0%';
      exportPercentText.textContent = '0%';
      exportStatusText.textContent = 'Initializing deterministic renderer...';

      const [wStr, hStr] = exportResSelect.value.split('x');
      const width = parseInt(wStr, 10);
      const height = parseInt(hStr, 10);
      const fps = parseInt(exportFpsSelect.value, 10);
      const durationSec = getEffectiveClipDurationSec();
      const format = exportFormatSelect.value;

      const savedProgress = currentProgress;

      try {
        await window.Exporter.runExport({
          format,
          width,
          height,
          fps,
          durationSec,
          dataset,
          schedule,
          tzMode,
          onProgress: (done, total, statusMsg) => {
            const pct = Math.round((done / total) * 100);
            exportProgressBar.style.width = `${pct}%`;
            exportPercentText.textContent = `${pct}%`;
            exportStatusText.textContent = statusMsg;
          },
          onRestoreViewport: () => {
            currentProgress = savedProgress;
            syncHudCanvasSize();
          }
        });

        exportStatusText.textContent = 'Export complete! File download started.';
      } catch (err) {
        exportStatusText.textContent = `Export error: ${err.message}`;
      } finally {
        btnStartExport.disabled = false;
      }
    });
  }

  window.addEventListener('DOMContentLoaded', initApp);
})();
