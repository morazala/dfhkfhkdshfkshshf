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
  // Đăng ký ngay khi app shell chạy để các công cụ đóng gói như PWABuilder
  // kịp phát hiện worker; đường dẫn tương đối vẫn đúng khi chạy dưới GitHub
  // Pages subpath /<repository>/.
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(error => {
    console.warn('[PWA] Không đăng ký được service worker:', error);
  });
})();
