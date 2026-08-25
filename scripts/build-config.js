'use strict';

require('dotenv').config();
const fs = require('fs');

const clean = value => String(value || '').trim().replace(/\/+$/, '');
const PUBLIC_API_FALLBACK = 'https://dfhkfhkdshfkshshf.onrender.com';
const PUBLIC_GOOGLE_CLIENT_FALLBACK = '371737399022-01c5he6n9ssvof0qqsgli84fsnmof023.apps.googleusercontent.com';
const PUBLIC_FRONTEND_FALLBACK = 'https://morazala.github.io';

const config = {
  apiBaseUrl: clean(process.env.RENDER_API_URL || PUBLIC_API_FALLBACK),
  googleClientId: clean(process.env.GOOGLE_CLIENT_ID || PUBLIC_GOOGLE_CLIENT_FALLBACK),
  frontendOrigin: clean(process.env.FRONTEND_ORIGIN || PUBLIC_FRONTEND_FALLBACK),
  enablePwa: String(process.env.ENABLE_PWA || '').trim().toLowerCase() === 'true'
};

const source = `window.APP_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`;
fs.writeFileSync('app-config.js', source, 'utf8');
console.log('Wrote public app-config.js without private secrets.');
