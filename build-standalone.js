/**
 * build-standalone.js
 * ----------------------------------------------------------------------------
 * Bundles the entire Forensic KML/KMZ Timeline Visualizer — including all
 * vendor libraries (MapLibre GL, JSZip, MP4-Muxer), styles, the preloaded
 * offline vector world map (242 countries, 412 lakes, 2,438 cities), and all
 * application modules — into a SINGLE 100% offline-capable HTML file:
 *
 *   dist/kmz-visualizer-standalone.html
 *
 * Usage:
 *   node build-standalone.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const VENDOR_DIR = path.join(__dirname, 'vendor');
const DIST_DIR = path.join(__dirname, 'dist');

const VENDOR_ASSETS = [
  {
    name: 'maplibre-gl.css',
    url: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'
  },
  {
    name: 'maplibre-gl.js',
    url: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js'
  },
  {
    name: 'jszip.min.js',
    url: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
  },
  {
    name: 'mp4-muxer.js',
    url: 'https://unpkg.com/mp4-muxer@5.1.3/build/mp4-muxer.js'
  }
];

function downloadText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'KMZ-Visualizer-Bundler/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return resolve(downloadText(redirectUrl));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} while downloading ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

async function ensureVendorAssets() {
  if (!fs.existsSync(VENDOR_DIR)) {
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
  }

  for (const asset of VENDOR_ASSETS) {
    const filePath = path.join(VENDOR_DIR, asset.name);
    if (!fs.existsSync(filePath)) {
      console.log(`Downloading vendor library: ${asset.name} ...`);
      const content = await downloadText(asset.url);
      fs.writeFileSync(filePath, content, 'utf8');
    } else {
      console.log(`Using cached vendor library: vendor/${asset.name}`);
    }
  }
}

/**
 * Escapes '</script' inside inlined JS code so the browser HTML parser never
 * prematurely closes the <script> block.
 */
function safeInlineScript(jsCode, label) {
  const escaped = jsCode.replace(/<\/script/gi, '<\\/script');
  return `\n  <!-- Inlined: ${label} -->\n  <script>\n${escaped}\n  </script>\n`;
}

function safeInlineStyle(cssCode, label) {
  const escaped = cssCode.replace(/<\/style/gi, '<\\/style');
  return `\n  <!-- Inlined: ${label} -->\n  <style>\n${escaped}\n  </style>\n`;
}

async function buildStandalone() {
  console.log('=== Building Single-File Standalone Forensic KML/KMZ Visualizer ===');
  await ensureVendorAssets();

  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  // 1. Read vendor assets
  const maplibreCss = fs.readFileSync(path.join(VENDOR_DIR, 'maplibre-gl.css'), 'utf8');
  const maplibreJs = fs.readFileSync(path.join(VENDOR_DIR, 'maplibre-gl.js'), 'utf8');
  const jszipJs = fs.readFileSync(path.join(VENDOR_DIR, 'jszip.min.js'), 'utf8');
  const mp4MuxerJs = fs.readFileSync(path.join(VENDOR_DIR, 'mp4-muxer.js'), 'utf8');

  // 2. Read app CSS & JS files
  const appCss = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
  const appScripts = [
    'js/localWorldMap.js',
    'js/kmlParser.js',
    'js/timelineEngine.js',
    'js/mapController.js',
    'js/hudRenderer.js',
    'js/exporter.js',
    'js/app.js'
  ];

  // 3. Replace external CDN & stylesheet tags in index.html with inlined blocks
  html = html.replace(
    /<link[^>]+href="https:\/\/unpkg\.com\/maplibre-gl[^>]+>/i,
    () => safeInlineStyle(maplibreCss, 'vendor/maplibre-gl.css')
  );
  html = html.replace(
    /<script[^>]+src="https:\/\/unpkg\.com\/maplibre-gl[^>]+><\/script>/i,
    () => safeInlineScript(maplibreJs, 'vendor/maplibre-gl.js')
  );
  html = html.replace(
    /<script[^>]+src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jszip[^>]+><\/script>/i,
    () => safeInlineScript(jszipJs, 'vendor/jszip.min.js')
  );
  html = html.replace(
    /<script[^>]+src="https:\/\/unpkg\.com\/mp4-muxer[^>]+><\/script>/i,
    () => safeInlineScript(mp4MuxerJs, 'vendor/mp4-muxer.js')
  );
  html = html.replace(
    /<link[^>]+href="styles\.css"[^>]*>/i,
    () => safeInlineStyle(appCss, 'styles.css')
  );

  for (const relPath of appScripts) {
    const code = fs.readFileSync(path.join(__dirname, relPath), 'utf8');
    const escapedAttr = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<script[^>]+src="${escapedAttr}"[^>]*><\\/script>`, 'i');
    html = html.replace(regex, () => safeInlineScript(code, relPath));
  }

  if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
  }

  const outFile = path.join(DIST_DIR, 'kmz-visualizer.html');
  fs.writeFileSync(outFile, html, 'utf8');

  const sizeMb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(2);
  console.log(`\nSuccessfully created single-file bundle:`);
  console.log(`  ${outFile} (${sizeMb} MB)`);
}

buildStandalone().catch((err) => {
  console.error('Build failed:', err.message);
  process.exit(1);
});
