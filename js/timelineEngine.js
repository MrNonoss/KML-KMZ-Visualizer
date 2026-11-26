/**
 * timelineEngine.js
 * ----------------------------------------------------------------------------
 * Piecewise Virtual Timeline & Smart Gap-Compression Engine.
 *
 * Maps virtual animation progress p in [0, 1] (or virtual time t in [0, totalDurationSec])
 * to an exact interpolated geographic state along the forensic KML trajectory:
 * - Current segment [i, i+1] and local progress u in [0, 1]
 * - Interpolated coordinates (lat, lon)
 * - Interpolated forensic timestamp (epochMs)
 * - Deterministic Smart Auto-Camera state (camLat, camLon, camZoom)
 * - Active status flags (Dwell status, Time Gap Jump banner, telemetry)
 */

window.TimelineEngine = (function () {
  'use strict';

  /**
   * Builds a virtual timeline schedule from the enriched KML dataset.
   *
   * Total duration scales directly with the number of waypoints (no arbitrary
   * fixed-time cutting). Each waypoint-to-waypoint transition receives its own
   * natural duration in seconds at 1.0x speed:
   * - More waypoints = proportionally longer clip
   * - Playback Speed selector (0.5x .. 10x) scales the playback & export duration.
   */
  function buildSchedule(dataset, config = {}) {
    const points = dataset.points;
    const mode = config.timingMode || 'smart';
    const gapThresholdSec = config.gapThresholdSec || 3600;
    const dwellRadiusMeters =
      config.dwellRadiusMeters !== undefined ? Number(config.dwellRadiusMeters) : 30;

    if (!points || points.length === 0) {
      return null;
    }

    if (points.length === 1) {
      return {
        segments: [],
        totalVirtualSec: 2,
        mode
      };
    }

    const segmentDurationsAt1x = [];

    if (mode === 'sequential') {
      // Point-to-Point Sequential: 1.2s per waypoint transition at 1.0x speed
      for (let i = 0; i < points.length - 1; i++) {
        segmentDurationsAt1x.push(1.2);
      }
    } else if (mode === 'linear') {
      // Strict Linear Clock: total duration scales with waypoint count (1.2s per waypoint at 1.0x),
      // distributed strictly proportionally to real elapsed clock time.
      const totalTargetSec = Math.max(4, (points.length - 1) * 1.2);
      const rawDeltas = [];
      for (let i = 0; i < points.length - 1; i++) {
        const dtSec = Math.max(1, (points[i + 1].epochMs - points[i].epochMs) / 1000);
        rawDeltas.push(dtSec);
      }
      const sumDeltas = rawDeltas.reduce((acc, d) => acc + d, 0) || 1;
      for (let i = 0; i < rawDeltas.length; i++) {
        segmentDurationsAt1x.push((rawDeltas[i] / sumDeltas) * totalTargetSec);
      }
    } else {
      // 'smart' Gap-Compression: each waypoint transition gets its natural duration
      // in seconds at 1.0x speed based on movement distance and time delta.
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const dtSec = Math.max(0, (p2.epochMs - p1.epochMs) / 1000);
        const distMeters = p2.distFromPrevMeters;
        const isGap = dtSec > gapThresholdSec;

        let segSec = 1.2;
        if (dwellRadiusMeters > 0 && distMeters <= dwellRadiusMeters) {
          // Stationary dwell fix
          segSec = isGap ? 1.1 : 0.65;
        } else if (distMeters <= 2500) {
          // Street / neighborhood / drone micro-movement
          const timeFactor = isGap ? 1.1 : Math.min(1.6, Math.max(0.85, Math.log10(dtSec + 10) * 0.5));
          segSec = 1.15 * timeFactor;
        } else if (distMeters <= 50000) {
          // City-to-city regional movement
          segSec = 1.85;
        } else {
          // Long-distance national / international jump
          segSec = 2.5;
        }
        segmentDurationsAt1x.push(segSec);
      }
    }

    const segments = [];
    let cursorSec = 0;

    for (let i = 0; i < points.length - 1; i++) {
      const durSec = segmentDurationsAt1x[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const dtSec = Math.max(0, (p2.epochMs - p1.epochMs) / 1000);
      const transitZoom = computeTransitZoom(p2.distFromPrevMeters);

      segments.push({
        index: i,
        startPoint: p1,
        endPoint: p2,
        virtualStartSec: cursorSec,
        virtualEndSec: cursorSec + durSec,
        virtualDurationSec: durSec,
        realDeltaSec: dtSec,
        distMeters: p2.distFromPrevMeters,
        isGapJump: dtSec > gapThresholdSec,
        transitZoom
      });

      cursorSec += durSec;
    }

    return {
      segments,
      totalVirtualSec: cursorSec,
      mode,
      gapThresholdSec
    };
  }

  /**
   * Computes an appropriate overview zoom level to frame two points separated by distMeters.
   */
  function computeTransitZoom(distMeters) {
    if (distMeters < 500) return 11.5;
    if (distMeters < 2500) return 11.0;
    if (distMeters < 10000) return 10.2;
    if (distMeters < 30000) return 9.2;
    if (distMeters < 90000) return 8.2;
    if (distMeters < 450000) return 5.8;   // e.g. Toulouse -> Lyon (360 km)
    if (distMeters < 1500000) return 4.5;
    return 3.1;                            // e.g. Montpellier -> Lomé (4,200 km)
  }

  /**
   * Smoothstep cubic Hermite interpolation (0 -> 1 with zero derivative at endpoints).
   */
  function smoothstep(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
  }

  /**
   * Evaluates the exact trajectory, telemetry, and camera state at normalized progress p in [0, 1].
   */
  function evaluateAtProgress(dataset, schedule, progress) {
    const points = dataset.points;
    const clampedP = Math.max(0, Math.min(1, progress));

    if (points.length === 1 || !schedule || schedule.segments.length === 0) {
      const pt = points[0];
      return {
        progress: clampedP,
        activeIndex: 0,
        segmentProgress: 0,
        lat: pt.lat,
        lon: pt.lon,
        epochMs: pt.epochMs,
        offsetMinutes: pt.offsetMinutes,
        tzLabel: pt.tzLabel,
        currentPoint: pt,
        nextPoint: pt,
        isGapJump: false,
        gapDeltaSec: 0,
        segmentDistMeters: 0,
        camera: {
          lat: pt.lat,
          lon: pt.lon,
          zoom: 15
        }
      };
    }

    const targetVirtualSec = clampedP * schedule.totalVirtualSec;
    const segments = schedule.segments;

    // Locate active segment (use strict '<' with epsilon so exact segment boundaries
    // resolve to the start of segment i with u = 0 rather than the end of segment i-1)
    let seg = segments[segments.length - 1];
    for (let i = 0; i < segments.length; i++) {
      if (targetVirtualSec < segments[i].virtualEndSec - 1e-7 || i === segments.length - 1) {
        seg = segments[i];
        break;
      }
    }

    const rawU = seg.virtualDurationSec > 0
      ? (targetVirtualSec - seg.virtualStartSec) / seg.virtualDurationSec
      : 1;
    const u = Math.max(0, Math.min(1, rawU));
    const smoothU = smoothstep(u);

    const p1 = seg.startPoint;
    const p2 = seg.endPoint;

    // Interpolate geographic position
    const lat = p1.lat + (p2.lat - p1.lat) * smoothU;
    const lon = p1.lon + (p2.lon - p1.lon) * smoothU;

    // Interpolate forensic clock timestamp
    const epochMs = Math.round(p1.epochMs + (p2.epochMs - p1.epochMs) * u);

    // Determine which point metadata is primary in the HUD
    const activePoint = u >= 0.92 ? p2 : p1;

    // Compute deterministic Smart Auto-Camera state (camLat, camLon, camZoom)
    const cam1 = p1.localCamera;
    const cam2 = p2.localCamera;
    let camLat, camLon, camZoom;

    if (seg.distMeters <= 3500) {
      // Local street/neighborhood transition: smooth pan & zoom blend
      camLat = cam1.lat + (cam2.lat - cam1.lat) * smoothU;
      camLon = cam1.lon + (cam2.lon - cam1.lon) * smoothU;
      camZoom = cam1.zoom + (cam2.zoom - cam1.zoom) * smoothU;
    } else {
      // Regional or International transit: zoom out along a smooth arc to show
      // the trajectory line crossing between regions, then zoom into destination
      camLat = lat;
      camLon = lon;

      const endBlendZoom = cam1.zoom + (cam2.zoom - cam1.zoom) * smoothU;
      // Sine envelope peaks at u = 0.5 (mid-transit)
      const arcEnvelope = Math.pow(Math.sin(Math.PI * u), 0.55);
      camZoom = endBlendZoom * (1 - arcEnvelope) + seg.transitZoom * arcEnvelope;
    }

    return {
      progress: clampedP,
      activeIndex: u >= 0.98 ? p2.index : p1.index,
      completedPointIndex: p1.index,
      segmentIndex: seg.index,
      segmentProgress: smoothU,
      rawSegmentProgress: u,
      lat,
      lon,
      epochMs,
      offsetMinutes: activePoint.offsetMinutes,
      tzLabel: activePoint.tzLabel,
      currentPoint: activePoint,
      startPoint: p1,
      endPoint: p2,
      isGapJump: seg.isGapJump && u > 0.04 && u < 0.96,
      gapDeltaSec: seg.realDeltaSec,
      segmentDistMeters: seg.distMeters,
      camera: {
        lat: camLat,
        lon: camLon,
        zoom: camZoom
      }
    };
  }

  /**
   * Finds the normalized virtual progress p in [0, 1] corresponding to a specific datapoint index.
   */
  function getProgressForPointIndex(schedule, pointIndex) {
    if (!schedule || !schedule.segments || schedule.segments.length === 0) return 0;
    if (pointIndex <= 0) return 0;
    if (pointIndex >= schedule.segments.length) return 1;
    return schedule.segments[pointIndex].virtualStartSec / schedule.totalVirtualSec;
  }

  return {
    buildSchedule,
    evaluateAtProgress,
    getProgressForPointIndex
  };
})();
