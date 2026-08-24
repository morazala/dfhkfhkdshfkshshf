'use strict';

(() => {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(error => {
      console.warn('[PWA] Không đăng ký được service worker:', error);
    });
  }, { once: true });
})();
