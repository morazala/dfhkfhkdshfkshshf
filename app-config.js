/* Public runtime configuration. The build step replaces these values from env. */
window.APP_CONFIG = Object.freeze({
  apiBaseUrl: '',
  googleClientId: '',
  frontendOrigin: window.location.origin,
  enablePwa: false
});
