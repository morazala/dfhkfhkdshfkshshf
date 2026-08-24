'use strict';

(() => {
  const config = window.APP_CONFIG || {};
  const apiBaseUrl = String(config.apiBaseUrl || '').replace(/\/$/, '');
  const loginButton = document.querySelector('#loginBtn');
  const logoutButton = document.querySelector('#logoutBtn');
  const status = document.querySelector('#authStatus');

  function apiUrl(path) { return apiBaseUrl ? `${apiBaseUrl}${path}` : path; }
  function setStatus(message, kind = '') {
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }
  function deviceInfo() {
    const platform = navigator.userAgentData?.platform || navigator.platform || 'unknown';
    const mobile = navigator.userAgentData?.mobile ? 'mobile' : 'desktop';
    return `${platform} · ${mobile} · ${window.matchMedia('(display-mode: standalone)').matches ? 'PWA' : 'browser'}`;
  }
  async function api(path, options = {}) {
    const response = await fetch(apiUrl(path), { ...options, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `API lỗi ${response.status}.`);
    return result;
  }
  async function finishGoogleLogin(credential) {
    try {
      const result = await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential, deviceInfo: deviceInfo() }) });
      setStatus(`Đã đăng nhập: ${result.user.email}`, 'success');
      if (loginButton) loginButton.textContent = 'ĐÃ ĐĂNG NHẬP GOOGLE';
      if (logoutButton) logoutButton.hidden = false;
    } catch (error) { setStatus(error.message || 'Đăng nhập thất bại.', 'error'); }
  }
  function waitForGoogle() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      const check = () => {
        if (window.google?.accounts?.id) return resolve(window.google);
        if (Date.now() > deadline) return reject(new Error('Google Sign-In chưa tải được.'));
        setTimeout(check, 100);
      };
      check();
    });
  }
  async function login() {
    if (!apiBaseUrl || !config.googleClientId) {
      setStatus('Bản web hiện chưa được cấu hình API Render/Google OAuth.', 'error');
      return;
    }
    try {
      const google = await waitForGoogle();
      google.accounts.id.initialize({ client_id: config.googleClientId, callback: response => finishGoogleLogin(response.credential), auto_select: false, cancel_on_tap_outside: true });
      google.accounts.id.prompt(notification => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) setStatus('Google không mở popup; hãy cho phép popup rồi thử lại.', 'error');
      });
    } catch (error) { setStatus(error.message || 'Không mở được Google Sign-In.', 'error'); }
  }
  async function checkSession() {
    if (!apiBaseUrl) { if (loginButton) loginButton.hidden = true; return; }
    try {
      const result = await api('/api/auth/me');
      setStatus(`Đã đăng nhập: ${result.user.email}`, 'success');
      if (loginButton) loginButton.textContent = 'ĐÃ ĐĂNG NHẬP GOOGLE';
      if (logoutButton) logoutButton.hidden = false;
    } catch (_) { setStatus('Chưa đăng nhập · có thể dùng chế độ offline.', ''); }
  }
  loginButton?.addEventListener('click', login);
  logoutButton?.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    logoutButton.hidden = true;
    if (loginButton) loginButton.textContent = 'ĐĂNG NHẬP / ĐĂNG KÝ GOOGLE';
    setStatus('Đã đăng xuất.', '');
  });
  checkSession();
  window.PhonicsAuth = Object.freeze({ api, login });
})();
