/**
 * kmlParser.js
 * ----------------------------------------------------------------------------
 * Forensic KML & KMZ Parser for Cellebrite Physical Analyzer & Standard KMLs.
 *
 * Key Forensic Capabilities:
 * 1. Parses both raw .kml XML strings and zipped .kmz archives (via JSZip).
 * 2. Preserves original timezone offsets (e.g., "+02:00" / "UTC+2") from ISO
 *    <TimeStamp><when> or Cellebrite <name>/<description> strings so timestamps
 *    never silently shift to the investigator's browser local timezone.
 * 3. Supports <Placemark> with <TimeStamp>, <TimeSpan>, <gx:Track>, or
 *    timestamps embedded inside HTML <description> / <ExtendedData>.
 * 4. Computes Haversine distance, time deltas, implied speeds, and groups
 *    consecutive stationary fixes into Dwell Clusters.
 */

window.KMLParser = (function () {
  'use strict';

  /**
   * Haversine distance in meters between two WGS84 coordinates.
   */
  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth mean radius in meters
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Formats a duration in seconds into a concise forensic string (e.g., "5d 19h", "23m 40s").
   */
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0s';
    const sec = Math.round(seconds);
    if (sec < 60) return `${sec}s`;
    const days = Math.floor(sec / 86400);
    const hours = Math.floor((sec % 86400) / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const remSec = sec % 60;

    if (days > 0) {
      return `${days}d ${hours}h ${mins}m`;
    }
    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }
    return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
  }

  /**
   * Parses an ISO-8601 timestamp or Cellebrite human timestamp string while
   * extracting the exact source timezone offset in minutes.
   *
   * Examples supported:
   * - "2026-06-30T16:45:00+02:00"
   * - "2026-06-30T14:45:00Z"
   * - "30-Jun-26 4:45:00 PM(UTC+2)"
   */
  function parseForensicTimestamp(isoStr, fallbackText) {
    let raw = (isoStr || '').trim();

    // 1. Standard ISO-8601 parsing with explicit offset capture
    if (raw) {
      const epochMs = Date.parse(raw);
      if (!Number.isNaN(epochMs)) {
        let offsetMinutes = 0;
        let tzLabel = 'UTC';

        const offsetMatch = raw.match(/([+-])(\d{2}):?(\d{2})$/);
        if (offsetMatch) {
          const sign = offsetMatch[1] === '-' ? -1 : 1;
          const hrs = parseInt(offsetMatch[2], 10);
          const mins = parseInt(offsetMatch[3], 10);
          offsetMinutes = sign * (hrs * 60 + mins);
          const minPart = mins > 0 ? `:${String(mins).padStart(2, '0')}` : '';
          tzLabel = `UTC${offsetMatch[1]}${hrs}${minPart}`;
        } else if (raw.endsWith('Z') || raw.endsWith('z')) {
          offsetMinutes = 0;
          tzLabel = 'UTC';
        }

        return { epochMs, offsetMinutes, tzLabel, rawIso: raw };
      }
    }

    // 2. Fallback: Parse Cellebrite PA human date e.g. "30-Jun-26 4:45:00 PM(UTC+2)"
    const text = (fallbackText || '').trim();
    const cbMatch = text.match(
      /(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?\s*\(?UTC([+-]\d+(?::\d{2})?)?\)?/i
    );
    if (cbMatch) {
      const day = parseInt(cbMatch[1], 10);
      const monStr = cbMatch[2].toLowerCase();
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const month = months[monStr] ?? 0;
      let year = parseInt(cbMatch[3], 10);
      if (year < 100) year += 2000;
      let hour = parseInt(cbMatch[4], 10);
      const minute = parseInt(cbMatch[5], 10);
      const second = parseInt(cbMatch[6], 10);
      const ampm = (cbMatch[7] || '').toUpperCase();
      if (ampm === 'PM' && hour < 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;

      let offsetMinutes = 0;
      let tzLabel = 'UTC';
      if (cbMatch[8]) {
        const parts = cbMatch[8].split(':');
        const hrs = parseInt(parts[0], 10);
        const mins = parts[1] ? parseInt(parts[1], 10) : 0;
        offsetMinutes = hrs * 60 + (hrs < 0 ? -mins : mins);
        tzLabel = `UTC${cbMatch[8]}`;
      }

      const utcMs = Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60000;
      return { epochMs: utcMs, offsetMinutes, tzLabel, rawIso: text };
    }

    return null;
  }

  /**
   * Formats an epoch timestamp (ms) into either its preserved source timezone
   * offset or UTC.
   */
  function formatTimestamp(epochMs, offsetMinutes, tzLabel, mode = 'source') {
    if (!Number.isFinite(epochMs)) return 'Unknown Timestamp';
    const useOffset = mode === 'utc' ? 0 : (offsetMinutes || 0);
    const label = mode === 'utc' ? 'UTC' : (tzLabel || 'UTC');
    const shifted = new Date(epochMs + useOffset * 60000);

    const yyyy = shifted.getUTCFullYear();
    const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(shifted.getUTCDate()).padStart(2, '0');
    const hh = String(shifted.getUTCHours()).padStart(2, '0');
    const min = String(shifted.getUTCMinutes()).padStart(2, '0');
    const ss = String(shifted.getUTCSeconds()).padStart(2, '0');

    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} (${label})`;
  }

  /**
   * Strips HTML tags from Cellebrite <description> CDATA blocks and removes
   * redundant timestamp lines so only the clean forensic category/artifact remains.
   */
  function cleanDescription(rawHtml, nameText) {
    if (!rawHtml) return 'Location Fix';
    // Convert <p>, <br>, <tr> to line breaks first
    const withBreaks = rawHtml
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/tr>/gi, '\n');
    const stripped = withBreaks.replace(/<[^>]+>/g, ' ').replace(/\r/g, '');
    const lines = stripped
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l.length > 0);

    // Filter out lines that just repeat the <name> timestamp
    const filtered = lines.filter((line) => {
      if (nameText && line === nameText.trim()) return false;
      if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}\s+\d{1,2}:\d{2}:\d{2}/i.test(line)) return false;
      return true;
    });

    return filtered.length > 0 ? filtered.join(' • ') : (lines[0] || 'Location Fix');
  }

  /**
   * Extracts raw KML XML text from a File object (.kml or .kmz).
   */
  async function extractKmlStringFromFile(file) {
    const fileName = file.name.toLowerCase();
    if (fileName.endsWith('.kmz')) {
      if (typeof JSZip === 'undefined') {
        throw new Error('JSZip library not loaded; cannot extract .kmz archive.');
      }
      const arrayBuffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(arrayBuffer);
      // Locate doc.kml or the first .kml file inside the archive
      let kmlEntry = zip.file(/doc\.kml$/i)[0] || zip.file(/\.kml$/i)[0];
      if (!kmlEntry) {
        throw new Error('No .kml file found inside the .kmz archive.');
      }
      return await kmlEntry.async('string');
    } else {
      return await file.text();
    }
  }

  /**
   * Main KML XML parser. Extracts placemarks and gx:Track records, sorts chronologically,
   * and enriches with forensic telemetry (distance, delta T, speed, dwell clusters).
   */
  function parseKmlXml(xmlString, options = {}) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

    const parseError = xmlDoc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Invalid KML XML format: ' + parseError.textContent);
    }

    const rawPoints = [];
    const placemarks = xmlDoc.getElementsByTagName('Placemark');

    for (let i = 0; i < placemarks.length; i++) {
      const pm = placemarks[i];
      const nameNode = pm.getElementsByTagName('name')[0];
      const descNode = pm.getElementsByTagName('description')[0];
      const nameText = nameNode ? nameNode.textContent.trim() : '';
      const rawDesc = descNode ? descNode.textContent.trim() : '';
      const cleanDesc = cleanDescription(rawDesc, nameText);

      // 1. Check for <gx:Track> inside Placemark
      const gxTracks = pm.getElementsByTagNameNS('*', 'Track');
      if (gxTracks.length > 0) {
        for (let t = 0; t < gxTracks.length; t++) {
          const track = gxTracks[t];
          const whenNodes = track.getElementsByTagName('when');
          const coordNodes = track.getElementsByTagNameNS('*', 'coord');
          const count = Math.min(whenNodes.length, coordNodes.length);
          for (let k = 0; k < count; k++) {
            const whenStr = whenNodes[k].textContent.trim();
            const coordParts = coordNodes[k].textContent.trim().split(/\s+/);
            if (coordParts.length >= 2) {
              const lon = parseFloat(coordParts[0]);
              const lat = parseFloat(coordParts[1]);
              const alt = coordParts[2] ? parseFloat(coordParts[2]) : 0;
              const ts = parseForensicTimestamp(whenStr, nameText);
              if (Number.isFinite(lat) && Number.isFinite(lon) && ts) {
                rawPoints.push({
                  lat,
                  lon,
                  alt,
                  epochMs: ts.epochMs,
                  offsetMinutes: ts.offsetMinutes,
                  tzLabel: ts.tzLabel,
                  rawName: nameText || whenStr,
                  description: cleanDesc
                });
              }
            }
          }
        }
        continue;
      }

      // 2. Standard <Point><coordinates>lon,lat[,alt]</coordinates></Point>
      const pointNode = pm.getElementsByTagName('Point')[0];
      if (!pointNode) continue;
      const coordNode = pointNode.getElementsByTagName('coordinates')[0];
      if (!coordNode) continue;

      const coordStr = coordNode.textContent.trim();
      const parts = coordStr.split(',').map((s) => s.trim());
      if (parts.length < 2) continue;

      const lon = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      const alt = parts[2] ? parseFloat(parts[2]) : 0;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      // Extract timestamp from <TimeStamp><when> or <TimeSpan><begin> or fallback to <name>/<description>
      let whenStr = '';
      const tsNode = pm.getElementsByTagName('TimeStamp')[0];
      if (tsNode) {
        const whenNode = tsNode.getElementsByTagName('when')[0];
        if (whenNode) whenStr = whenNode.textContent.trim();
      }
      if (!whenStr) {
        const spanNode = pm.getElementsByTagName('TimeSpan')[0];
        if (spanNode) {
          const beginNode = spanNode.getElementsByTagName('begin')[0];
          if (beginNode) whenStr = beginNode.textContent.trim();
        }
      }

      const ts = parseForensicTimestamp(whenStr, nameText || rawDesc);
      if (!ts) continue;

      rawPoints.push({
        lat,
        lon,
        alt,
        epochMs: ts.epochMs,
        offsetMinutes: ts.offsetMinutes,
        tzLabel: ts.tzLabel,
        rawName: nameText,
        description: cleanDesc
      });
    }

    if (rawPoints.length === 0) {
      throw new Error('No timestamped geographic coordinates found in the KML/KMZ file.');
    }

    // Sort chronologically by epochMs
    rawPoints.sort((a, b) => a.epochMs - b.epochMs);

    return enrichTrackTelemetry(rawPoints, options);
  }

  /**
   * Computes segment telemetry, identifies Dwell Clusters and Time Gaps, and
   * precomputes Smart Auto-Camera framing targets for each point.
   * When dwellRadiusMeters === 0 (Drone / Precision Mode), dwell clustering is
   * disabled so every point is treated individually.
   */
  function enrichTrackTelemetry(rawPoints, options = {}) {
    const dwellRadiusMeters =
      options.dwellRadiusMeters !== undefined ? Number(options.dwellRadiusMeters) : 30;
    const gapThresholdSeconds =
      options.gapThresholdSeconds !== undefined ? Number(options.gapThresholdSeconds) : 3600;

    const points = rawPoints.map((pt, idx) => ({
      ...pt,
      index: idx,
      number: idx + 1,
      distFromPrevMeters: 0,
      deltaSecFromPrev: 0,
      speedKmh: 0,
      isTimeGap: false,
      isLongTransit: false,
      dwellClusterId: null,
      dwellFixCount: 1,
      dwellDurationSec: 0,
      dwellAccumSec: 0
    }));

    let totalDistanceMeters = 0;
    let gapCount = 0;

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const dist = haversineMeters(prev.lat, prev.lon, curr.lat, curr.lon);
      const dtSec = Math.max(0, (curr.epochMs - prev.epochMs) / 1000);

      curr.distFromPrevMeters = dist;
      curr.deltaSecFromPrev = dtSec;
      curr.speedKmh = dtSec > 0 ? (dist / 1000) / (dtSec / 3600) : 0;
      curr.isTimeGap = dtSec > gapThresholdSeconds;
      curr.isLongTransit = dist > 5000; // > 5 km transition

      totalDistanceMeters += dist;
      if (curr.isTimeGap) gapCount++;
    }

    // Group consecutive stationary points within dwellRadiusMeters into Dwell Clusters
    // (Skipped completely when dwellRadiusMeters <= 0 for Drone / All-Points mode)
    const dwellClusters = [];
    let clusterStartIdx = 0;

    if (dwellRadiusMeters > 0) {
      for (let i = 1; i <= points.length; i++) {
        const anchor = points[clusterStartIdx];
        const curr = i < points.length ? points[i] : null;
        const distFromAnchor = curr ? haversineMeters(anchor.lat, anchor.lon, curr.lat, curr.lon) : Infinity;

        if (distFromAnchor > dwellRadiusMeters) {
          const count = i - clusterStartIdx;
          if (count >= 2) {
            const firstPt = points[clusterStartIdx];
            const lastPt = points[i - 1];
            const totalDwellSec = Math.max(0, (lastPt.epochMs - firstPt.epochMs) / 1000);
            const clusterId = dwellClusters.length + 1;

            dwellClusters.push({
              id: clusterId,
              startIndex: clusterStartIdx,
              endIndex: i - 1,
              fixCount: count,
              totalDurationSec: totalDwellSec,
              lat: firstPt.lat,
              lon: firstPt.lon
            });

            for (let k = clusterStartIdx; k < i; k++) {
              points[k].dwellClusterId = clusterId;
              points[k].dwellFixCount = count;
              points[k].dwellDurationSec = totalDwellSec;
              points[k].dwellAccumSec = Math.max(0, (points[k].epochMs - firstPt.epochMs) / 1000);
            }
          }
          clusterStartIdx = i;
        }
      }
    }

    // Compute overall bounding box
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }

    // Precompute local neighborhood zoom & center for Smart Auto-Camera
    precomputeSmartCameraTargets(points);

    const totalSpanSec = points.length > 1
      ? (points[points.length - 1].epochMs - points[0].epochMs) / 1000
      : 0;

    return {
      points,
      dwellClusters,
      bounds: { minLat, maxLat, minLon, maxLon },
      stats: {
        totalFixes: points.length,
        totalDistanceMeters,
        totalSpanSec,
        dwellClusterCount: dwellClusters.length,
        gapCount
      }
    };
  }

  /**
   * Computes an ideal local neighborhood camera zoom and smoothed anchor center
   * for each point so the Smart Auto-Camera frames local street movements cleanly
   * without jittering on tiny 2-meter GPS drift.
   */
  function precomputeSmartCameraTargets(points) {
    for (let i = 0; i < points.length; i++) {
      const centerPt = points[i];
      // Gather neighboring points within a 5 km local neighborhood window [i-3 .. i+3]
      let minLat = centerPt.lat, maxLat = centerPt.lat;
      let minLon = centerPt.lon, maxLon = centerPt.lon;

      for (let j = Math.max(0, i - 3); j <= Math.min(points.length - 1, i + 3); j++) {
        const d = haversineMeters(centerPt.lat, centerPt.lon, points[j].lat, points[j].lon);
        if (d <= 4500) {
          if (points[j].lat < minLat) minLat = points[j].lat;
          if (points[j].lat > maxLat) maxLat = points[j].lat;
          if (points[j].lon < minLon) minLon = points[j].lon;
          if (points[j].lon > maxLon) maxLon = points[j].lon;
        }
      }

      const spanMeters = haversineMeters(minLat, minLon, maxLat, maxLon);
      // Map local spatial span to a comfortable regional/city zoom level (10.2 to 11.8)
      // Avoids zooming in too close and prevents "Map data not yet available" tiles
      let localZoom = 11.2;
      if (spanMeters < 300) localZoom = 11.5;
      else if (spanMeters < 1500) localZoom = 11.0;
      else if (spanMeters < 5000) localZoom = 10.5;
      else localZoom = 9.8;

      centerPt.localCamera = {
        lat: (minLat + maxLat) * 0.35 + centerPt.lat * 0.65,
        lon: (minLon + maxLon) * 0.35 + centerPt.lon * 0.65,
        zoom: localZoom
      };
    }
  }

  return {
    extractKmlStringFromFile,
    parseKmlXml,
    enrichTrackTelemetry,
    haversineMeters,
    formatDuration,
    formatTimestamp
  };
})();
