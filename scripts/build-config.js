'use strict';

const fs = require('fs');

const config = {
  apiBaseUrl: process.env.RENDER_API_URL || '',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  frontendOrigin: process.env.FRONTEND_ORIGIN || '',
  enablePwa: process.env.ENABLE_PWA === 'true'
};

const source = `window.APP_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`;
fs.writeFileSync('app-config.js', source, 'utf8');
console.log('Wrote public app-config.js without private secrets.');
