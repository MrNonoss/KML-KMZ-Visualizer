/**
 * mapController.js
 * ----------------------------------------------------------------------------
 * High-Performance MapLibre GL Base Map Controller.
 *
 * Key Behaviors:
 * 1. Starts with a full Global World Map view (center: [10, 20], zoom: 1.8)
 *    even before any KML is loaded.
 * 2. Allows unrestricted manual user zooming (up to zoom 18) and panning at all times.
 * 3. Separates programmatic camera movement from map render events so there is
 *    never any 'move' event recursion.
 */

window.MapController = (function () {
  'use strict';

  let map = null;
  let isMapLoaded = false;
  let currentDataset = null;
  let cameraMode = 'follow';        // 'follow' | 'overview' | 'manual'
  let activeBasemap = 'local_dark'; // 'local_dark' | 'streets' | 'satellite'
  let isProgrammaticMove = false;

  // High-Precision Online Tile Sources:
  // - 'streets' uses OpenStreetMap FR (a/b/c.tile.openstreetmap.fr/osmfr) which supports
  //   full Zoom 0..19 street, building, house-number, and intersection detail worldwide
  //   with Access-Control-Allow-Origin: * and no 403 block on local file:// pages!
  // - 'satellite' uses Esri World Imagery up to Zoom 18.
  const ONLINE_BASEMAPS = {
    streets: {
      name: 'Online Street Map (High-Precision OSM)',
      tiles: [
        'https://a.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
        'https://b.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
        'https://c.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png'
      ],
      maxzoom: 19
    },
    satellite: {
      name: 'Online Satellite Imagery',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
      ],
      overlayTiles: [
        'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
      ],
      maxzoom: 18
    }
  };

  function emptyFeatureCollection() {
    return { type: 'FeatureCollection', features: [] };
  }

  function buildMapStyle() {
    const localMap = window.LOCAL_WORLD_MAP || {
      countries: emptyFeatureCollection(),
      lakes: emptyFeatureCollection(),
      cities: emptyFeatureCollection(),
      graticule: emptyFeatureCollection()
    };

    const sources = {
      'local-countries': { type: 'geojson', data: localMap.countries },
      'local-lakes': { type: 'geojson', data: localMap.lakes },
      'local-graticule': { type: 'geojson', data: localMap.graticule }
    };

    const layers = [
      {
        id: 'local-ocean-bg',
        type: 'background',
        paint: { 'background-color': '#09111e' }
      },
      {
        id: 'local-graticule-line',
        type: 'line',
        source: 'local-graticule',
        paint: {
          'line-color': '#16243b',
          'line-width': 1,
          'line-opacity': 0.7
        }
      },
      {
        id: 'local-countries-fill',
        type: 'fill',
        source: 'local-countries',
        paint: {
          'fill-color': '#152033',
          'fill-opacity': 1.0
        }
      },
      {
        id: 'local-lakes-fill',
        type: 'fill',
        source: 'local-lakes',
        paint: {
          'fill-color': '#09111e',
          'fill-opacity': 1.0
        }
      },
      {
        id: 'local-countries-border',
        type: 'line',
        source: 'local-countries',
        paint: {
          'line-color': '#2e4568',
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            1, 0.8,
            6, 1.6,
            14, 2.5
          ]
        }
      }
    ];

    for (const [key, cfg] of Object.entries(ONLINE_BASEMAPS)) {
      const initVis = key === activeBasemap ? 'visible' : 'none';
      sources[`basemap-${key}`] = {
        type: 'raster',
        tiles: cfg.tiles,
        tileSize: 256,
        maxzoom: cfg.maxzoom || 19
      };
      layers.push({
        id: `layer-basemap-${key}`,
        type: 'raster',
        source: `basemap-${key}`,
        layout: { visibility: initVis },
        paint: { 'raster-fade-duration': 0 }
      });

      if (cfg.overlayTiles) {
        sources[`basemap-${key}-labels`] = {
          type: 'raster',
          tiles: cfg.overlayTiles,
          tileSize: 256,
          maxzoom: cfg.maxzoom || 18
        };
        layers.push({
          id: `layer-basemap-${key}-labels`,
          type: 'raster',
          source: `basemap-${key}-labels`,
          layout: { visibility: initVis },
          paint: { 'raster-fade-duration': 0 }
        });
      }
    }

    return { version: 8, sources, layers };
  }

  /**
   * Initializes MapLibre GL showing the full global world map on startup.
   */
  function initMap(containerId, onViewportMove) {
    return new Promise((resolve) => {
      map = new maplibregl.Map({
        container: containerId,
        style: buildMapStyle(),
        center: [12, 22], // Global world map view on startup
        zoom: 1.85,
        minZoom: 1,
        maxZoom: 19,      // Full street & building level zoom up to level 19
        preserveDrawingBuffer: true,
        canvasContextAttributes: {
          preserveDrawingBuffer: true,
          antialias: true
        },
        attributionControl: false
      });

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

      // Redraw 2D overlay labels & trajectory whenever the map moves,
      // guarded against recursion by never calling jumpTo inside onViewportMove.
      map.on('move', () => {
        if (!isProgrammaticMove && onViewportMove) {
          onViewportMove();
        }
      });

      map.on('load', () => {
        isMapLoaded = true;
        resolve(map);
      });
    });
  }

  function setBasemap(basemapKey) {
    if (!map || !isMapLoaded) return;
    activeBasemap = basemapKey;

    for (const key of Object.keys(ONLINE_BASEMAPS)) {
      const vis = key === basemapKey ? 'visible' : 'none';
      const layerId = `layer-basemap-${key}`;
      const labelLayerId = `layer-basemap-${key}-labels`;
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', vis);
      if (map.getLayer(labelLayerId)) map.setLayoutProperty(labelLayerId, 'visibility', vis);
    }

    map.triggerRepaint();
  }

  function getActiveBasemap() {
    return activeBasemap;
  }

  function isUsingLocalVectorOnly() {
    return activeBasemap === 'local_dark';
  }

  function setCameraMode(mode) {
    cameraMode = mode;
    if (mode === 'overview' && currentDataset) {
      fitFullDatasetBounds(currentDataset, false);
    }
  }

  function getCameraMode() {
    return cameraMode;
  }

  function fitFullDatasetBounds(dataset, animate = false) {
    if (!map || !dataset || !dataset.bounds) return;
    const b = dataset.bounds;
    const padLon = Math.max(0.05, (b.maxLon - b.minLon) * 0.15);
    const padLat = Math.max(0.05, (b.maxLat - b.minLat) * 0.15);

    isProgrammaticMove = true;
    try {
      map.fitBounds(
        [
          [b.minLon - padLon, b.minLat - padLat],
          [b.maxLon + padLon, b.maxLat + padLat]
        ],
        {
          padding: { top: 70, bottom: 70, left: 340, right: 60 },
          duration: animate ? 500 : 0,
          maxZoom: 11.5
        }
      );
    } finally {
      isProgrammaticMove = false;
    }
  }

  function setDataset(dataset) {
    currentDataset = dataset;
  }

  /**
   * Sets a specific zoom level preset (Street, City, County, Region, Country)
   * and centers on the active coordinate if available.
   */
  function setZoomLevel(zoomLevel, centerLonLat = null) {
    if (!map || !isMapLoaded) return;
    isProgrammaticMove = true;
    try {
      const opts = { zoom: zoomLevel };
      if (centerLonLat) {
        opts.center = centerLonLat;
      }
      map.jumpTo(opts);
    } finally {
      isProgrammaticMove = false;
    }
  }

  /**
   * Moves the camera to match the timeline state (only called during playback,
   * seeking, or video export—NEVER called from inside a map 'move' listener).
   */
  function updateCameraForState(state) {
    if (!map || !isMapLoaded || !currentDataset || !state) return;

    isProgrammaticMove = true;
    try {
      if (cameraMode === 'follow') {
        map.jumpTo({
          center: [state.lon, state.lat]
        });
      }
    } finally {
      isProgrammaticMove = false;
    }
  }

  function areTilesReady() {
    if (!map) return true;
    if (isUsingLocalVectorOnly()) return true;
    return map.areTilesLoaded();
  }

  function waitForFrameReady(timeoutMs = 700) {
    if (!map) return Promise.resolve();
    if (isUsingLocalVectorOnly()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };

      const timer = setTimeout(finish, timeoutMs);
      if (map.areTilesLoaded()) {
        clearTimeout(timer);
        finish();
      } else {
        map.once('idle', () => {
          clearTimeout(timer);
          finish();
        });
        map.triggerRepaint();
      }
    });
  }

  function getMapInstance() {
    return map;
  }

  function getWebGLCanvas() {
    return map ? map.getCanvas() : null;
  }

  return {
    initMap,
    setBasemap,
    getActiveBasemap,
    isUsingLocalVectorOnly,
    setCameraMode,
    getCameraMode,
    setZoomLevel,
    fitFullDatasetBounds,
    setDataset,
    updateCameraForState,
    areTilesReady,
    waitForFrameReady,
    getMapInstance,
    getWebGLCanvas
  };
})();
