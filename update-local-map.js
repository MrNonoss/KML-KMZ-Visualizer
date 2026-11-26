/**
 * update-local-map.js
 * ----------------------------------------------------------------------------
 * Downloads and compacts public-domain Natural Earth vector map data
 * (Countries/Coastlines 1:50m, Major Lakes 1:50m, and 7,300+ World Cities 1:10m)
 * into a single preloaded local JavaScript bundle: js/localWorldMap.js (~1.3 MB).
 *
 * Run anytime to refresh the local offline base map:
 *   node update-local-map.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const URLS = {
  countries: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson',
  lakes: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson',
  cities: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson'
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url} ...`);
    https.get(url, { headers: { 'User-Agent': 'KMZ-Forensic-Visualizer/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchJson(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(text));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Recursively rounds GeoJSON coordinates to 3 decimal places (~100m resolution)
 * to keep the offline vector map lightweight (~1.3 MB) and ultra-fast in WebGL.
 */
function roundCoords(coords, decimals = 3) {
  const factor = Math.pow(10, decimals);
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') {
    return [
      Math.round(coords[0] * factor) / factor,
      Math.round(coords[1] * factor) / factor
    ];
  }
  return coords.map((c) => roundCoords(c, decimals));
}

function compactCountries(geojson) {
  const features = [];
  const labelPoints = [];

  for (const f of geojson.features || []) {
    if (!f.geometry) continue;
    const props = f.properties || {};
    const name = props.NAME || props.ADMIN || '';
    const iso = props.ISO_A3 || '';

    features.push({
      type: 'Feature',
      properties: { name, iso },
      geometry: {
        type: f.geometry.type,
        coordinates: roundCoords(f.geometry.coordinates, 3)
      }
    });

    if (Number.isFinite(props.LABEL_X) && Number.isFinite(props.LABEL_Y) && name) {
      labelPoints.push({
        type: 'Feature',
        properties: { name, scalerank: props.LABELRANK || 3 },
        geometry: {
          type: 'Point',
          coordinates: [
            Math.round(props.LABEL_X * 100) / 100,
            Math.round(props.LABEL_Y * 100) / 100
          ]
        }
      });
    }
  }

  return {
    polygons: { type: 'FeatureCollection', features },
    labels: { type: 'FeatureCollection', features: labelPoints }
  };
}

function compactLakes(geojson) {
  const features = [];
  for (const f of geojson.features || []) {
    if (!f.geometry) continue;
    features.push({
      type: 'Feature',
      properties: { name: (f.properties && f.properties.name) || '' },
      geometry: {
        type: f.geometry.type,
        coordinates: roundCoords(f.geometry.coordinates, 3)
      }
    });
  }
  return { type: 'FeatureCollection', features };
}

function compactCities(geojson) {
  const features = [];
  for (const f of geojson.features || []) {
    if (!f.geometry || f.geometry.type !== 'Point') continue;
    const p = f.properties || {};
    const name = p.name || p.nameascii || '';
    if (!name) continue;
    const scalerank = typeof p.scalerank === 'number' ? p.scalerank : 8;
    if (scalerank > 6) continue;
    const capital = p.adm0cap === 1 ? 1 : 0;

    features.push({
      type: 'Feature',
      properties: {
        name,
        rank: scalerank,
        cap: capital
      },
      geometry: {
        type: 'Point',
        coordinates: roundCoords(f.geometry.coordinates, 4)
      }
    });
  }

  // Add detailed regional towns around common Southern France / West Africa corridors
  const extraTowns = [
    { name: 'Blagnac (TLS Airport)', coords: [1.373, 43.631], rank: 6 },
    { name: 'Colomiers', coords: [1.334, 43.611], rank: 7 },
    { name: 'Muret', coords: [1.326, 43.461], rank: 7 },
    { name: 'Carcassonne', coords: [2.352, 43.213], rank: 5 },
    { name: 'Narbonne', coords: [3.004, 43.184], rank: 5 },
    { name: 'Béziers', coords: [3.219, 43.344], rank: 4 },
    { name: 'Villeneuve-lès-Béziers', coords: [3.235, 43.339], rank: 6 },
    { name: 'Sérignan', coords: [3.278, 43.281], rank: 7 },
    { name: 'Valras-Plage', coords: [3.292, 43.248], rank: 7 },
    { name: 'Agde', coords: [3.476, 43.311], rank: 6 },
    { name: 'Pézenas', coords: [3.423, 43.459], rank: 6 },
    { name: 'Mèze', coords: [3.605, 43.426], rank: 6 },
    { name: 'Sète', coords: [3.697, 43.404], rank: 5 },
    { name: 'Frontignan', coords: [3.756, 43.447], rank: 6 },
    { name: 'Mauguio (MPL Airport)', coords: [3.959, 43.579], rank: 6 },
    { name: 'Lattes', coords: [3.903, 43.568], rank: 7 },
    { name: 'Palavas-les-Flots', coords: [3.931, 43.529], rank: 7 },
    { name: 'La Grande-Motte', coords: [4.085, 43.561], rank: 6 },
    { name: 'Nîmes', coords: [4.360, 43.837], rank: 4 },
    { name: 'Avignon', coords: [4.805, 43.949], rank: 4 },
    { name: 'Valence', coords: [4.892, 44.933], rank: 5 },
    { name: 'Villeurbanne', coords: [4.880, 45.766], rank: 5 },
    { name: 'Lomé (Gnassingbé Eyadéma Intl)', coords: [1.225, 6.193], rank: 5 },
    { name: 'Aného', coords: [1.592, 6.228], rank: 6 },
    { name: 'Tsévié', coords: [1.213, 6.426], rank: 6 },
    { name: 'Kpalimé', coords: [0.632, 6.901], rank: 6 }
  ];

  for (const t of extraTowns) {
    features.push({
      type: 'Feature',
      properties: { name: t.name, rank: t.rank, cap: 0 },
      geometry: { type: 'Point', coordinates: t.coords }
    });
  }

  return { type: 'FeatureCollection', features };
}

function buildGraticule() {
  const features = [];
  for (let lon = -180; lon <= 180; lon += 10) {
    features.push({
      type: 'Feature',
      properties: { label: `${lon}°` },
      geometry: {
        type: 'LineString',
        coordinates: [[lon, -80], [lon, 80]]
      }
    });
  }
  for (let lat = -80; lat <= 80; lat += 10) {
    features.push({
      type: 'Feature',
      properties: { label: `${lat}°` },
      geometry: {
        type: 'LineString',
        coordinates: [[-180, lat], [180, lat]]
      }
    });
  }
  return { type: 'FeatureCollection', features };
}

async function main() {
  console.log('=== Updating Local Preloaded Vector World Map ===');
  const [countriesRaw, lakesRaw, citiesRaw] = await Promise.all([
    fetchJson(URLS.countries),
    fetchJson(URLS.lakes),
    fetchJson(URLS.cities)
  ]);

  const countries = compactCountries(countriesRaw);
  const lakes = compactLakes(lakesRaw);
  const cities = compactCities(citiesRaw);
  const graticule = buildGraticule();

  const bundle = {
    updatedAt: new Date().toISOString(),
    countries: countries.polygons,
    countryLabels: countries.labels,
    lakes,
    cities,
    graticule
  };

  const outPath = path.join(__dirname, 'js', 'localWorldMap.js');
  const jsContent =
    '/* Auto-generated by update-local-map.js — Preloaded Offline Forensic Vector World Map */\n' +
    'window.LOCAL_WORLD_MAP = ' + JSON.stringify(bundle) + ';\n';

  fs.writeFileSync(outPath, jsContent, 'utf8');
  const sizeMb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
  console.log(`Saved ${outPath} (${sizeMb} MB)`);
  console.log(`- Countries: ${countries.polygons.features.length}`);
  console.log(`- Lakes:     ${lakes.features.length}`);
  console.log(`- Cities:    ${cities.features.length}`);
}

main().catch((err) => {
  console.error('Failed to update local map:', err.message);
  process.exit(1);
});
