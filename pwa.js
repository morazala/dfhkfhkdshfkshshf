'use strict';

(() => {
  if (!('serviceWorker' in navigator)) return;
  const isGitHubPages = /(^|\.)github\.io$/i.test(window.location.hostname);
  const pwaEnabled = Boolean(window.APP_CONFIG?.enablePwa) || isGitHubPages;
  if (!pwaEnabled) {
    // Localhost must keep the original Express audio path and must not be
    // intercepted by a Service Worker left behind from an older build.
    navigator.serviceWorker.getRegistrations().then(registrations => {
      registrations
        .filter(registration => new URL(registration.scope).origin === window.location.origin)
        .forEach(registration => registration.unregister());
    }).catch(() => {});
    return;
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(error => {
      console.warn('[PWA] Không đăng ký được service worker:', error);
    });
  }, { once: true });
})();
