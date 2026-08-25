'use strict';

(() => {
  // Keep the app locked until Render confirms the HttpOnly session cookie.
  document.documentElement.classList.add('auth-pending');

  const config = window.APP_CONFIG || {};
  const apiBaseUrl = String(config.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const googleClientId = String(config.googleClientId || '').trim();
  const gate = document.querySelector('#authGate');
  const gateStatus = document.querySelector('#authGateStatus');
  const retryButton = document.querySelector('#authRetryBtn');
  const loginButton = document.querySelector('#googleLoginBtn');
  const startButton = document.querySelector('#startBtn');
  const accountCard = document.querySelector('#accountCard');
  const accountPanel = document.querySelector('#accountPanel');
  const accountLogoutButton = document.querySelector('#accountLogoutBtn');
  const accountName = document.querySelector('#accountName');
  const accountEmail = document.querySelector('#accountEmail');
  const accountAvatar = document.querySelector('#accountAvatar');
  const accountProfileText = document.querySelector('#accountProfileText');
  let sessionUser = null;
  let loginInProgress = false;

  function setGateStatus(message, kind = '') {
    if (!gateStatus) return;
    gateStatus.textContent = message;
    gateStatus.dataset.kind = kind;
  }

  function apiUrl(path) { return apiBaseUrl ? `${apiBaseUrl}${path}` : path; }

  function deviceInfo() {
    const platform = navigator.userAgentData?.platform || navigator.platform || 'unknown';
    const mobile = navigator.userAgentData?.mobile ? 'mobile' : 'desktop';
    return `${platform} · ${mobile} · ${window.matchMedia('(display-mode: standalone)').matches ? 'PWA' : 'browser'}`;
  }

  async function api(path, options = {}) {
    if (!apiBaseUrl) throw new Error('PWA chưa có địa chỉ API Render công khai.');
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
      response = await fetch(apiUrl(path), {
        ...options,
        credentials: 'include',
        signal: options.signal || controller.signal,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
      });
    } finally {
      window.clearTimeout(timeoutId);
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `API lỗi ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function updateAccount(user) {
    const name = String(user?.display_name || user?.email || 'Tài khoản Google');
    const email = String(user?.email || '');
    if (accountName) accountName.textContent = name;
    if (accountEmail) accountEmail.textContent = email;
    if (accountProfileText) accountProfileText.textContent = email ? `Đang dùng tài khoản ${email}` : 'Đã đăng nhập Google.';
    if (accountAvatar) {
      accountAvatar.src = String(user?.avatar_url || 'icons/icon.svg');
      accountAvatar.onerror = () => { accountAvatar.src = 'icons/icon.svg'; };
    }
  }

  function setAuthenticated(user) {
    sessionUser = user || null;
    updateAccount(sessionUser);
    document.documentElement.classList.remove('auth-pending');
    gate?.classList.add('hidden');
    if (startButton) startButton.hidden = false;
    if (accountCard) accountCard.hidden = false;
    if (retryButton) retryButton.hidden = true;
    setGateStatus('Đã đăng nhập.', 'success');
    document.dispatchEvent(new CustomEvent('phonics-auth-ready', { detail: sessionUser }));
  }

  function setLoggedOut(message = 'Hãy đăng nhập bằng Google để bắt đầu.') {
    sessionUser = null;
    document.documentElement.classList.add('auth-pending');
    gate?.classList.remove('hidden');
    if (startButton) startButton.hidden = true;
    if (accountCard) accountCard.hidden = true;
    accountPanel?.classList.add('hidden');
    accountCard?.setAttribute('aria-expanded', 'false');
    setGateStatus(message);
  }

  function waitForGoogle() {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 12_000;
      const check = () => {
        if (window.google?.accounts?.oauth2?.initCodeClient) return resolve(window.google);
        if (Date.now() > deadline) return reject(new Error('Google Sign-In chưa tải được. Hãy kiểm tra kết nối mạng rồi thử lại.'));
        window.setTimeout(check, 100);
      };
      check();
    });
  }

  async function finishGoogleCode(code) {
    try {
      const result = await api('/api/auth/google', {
        method: 'POST',
        body: JSON.stringify({ code, deviceInfo: deviceInfo() })
      });
      setAuthenticated(result.user);
    } catch (error) {
      setGateStatus(error.message || 'Đăng nhập Google thất bại. Hãy thử lại.', 'error');
    } finally {
      loginInProgress = false;
      if (loginButton) loginButton.disabled = false;
    }
  }

  async function login() {
    if (loginInProgress) return;
    if (!apiBaseUrl || !googleClientId) {
      setGateStatus('Bản PWA chưa có cấu hình API Render hoặc Google OAuth public.', 'error');
      if (retryButton) retryButton.hidden = false;
      return;
    }
    loginInProgress = true;
    if (loginButton) loginButton.disabled = true;
    setGateStatus('Đang mở cửa sổ chọn tài khoản Google…');
    try {
      const google = await waitForGoogle();
      const codeClient = google.accounts.oauth2.initCodeClient({
        client_id: googleClientId,
        scope: 'openid profile email',
        ux_mode: 'popup',
        select_account: true,
        callback: response => {
          if (response?.error) {
            loginInProgress = false;
            if (loginButton) loginButton.disabled = false;
            setGateStatus('Bạn chưa hoàn tất đăng nhập Google. Hãy thử lại.', 'error');
            return;
          }
          finishGoogleCode(response?.code);
        },
        error_callback: error => {
          loginInProgress = false;
          if (loginButton) loginButton.disabled = false;
          if (error?.type === 'popup_failed_to_open') {
            setGateStatus('Trình duyệt đã chặn cửa sổ Google. Hãy cho phép popup cho trang này rồi bấm lại.', 'error');
          } else {
            setGateStatus('Không mở được cửa sổ Google. Hãy thử lại.', 'error');
          }
        }
      });
      codeClient.requestCode();
    } catch (error) {
      loginInProgress = false;
      if (loginButton) loginButton.disabled = false;
      setGateStatus(error.message || 'Không mở được Google Sign-In.', 'error');
    }
  }

  async function checkSession() {
    if (!apiBaseUrl) {
      setLoggedOut('PWA chưa có địa chỉ API Render. Hãy build lại app-config.js với RENDER_API_URL.');
      if (retryButton) retryButton.hidden = false;
      return;
    }
    setGateStatus('Đang kiểm tra phiên đăng nhập…');
    try {
      const result = await api('/api/auth/me');
      setAuthenticated(result.user);
    } catch (error) {
      if (error.status !== 401) {
        setGateStatus('Chưa kết nối được Render. Hãy kiểm tra mạng rồi thử lại.', 'error');
        if (retryButton) retryButton.hidden = false;
      } else {
        setLoggedOut();
      }
    }
  }

  loginButton?.addEventListener('click', login);
  retryButton?.addEventListener('click', checkSession);
  accountCard?.addEventListener('click', () => {
    const open = accountPanel?.classList.toggle('hidden') === false;
    accountCard.setAttribute('aria-expanded', String(open));
  });
  accountLogoutButton?.addEventListener('click', async () => {
    accountLogoutButton.disabled = true;
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    accountLogoutButton.disabled = false;
    setLoggedOut('Đã đăng xuất. Hãy đăng nhập lại để bắt đầu.');
  });

  checkSession();
  window.PhonicsAuth = Object.freeze({
    api,
    login,
    openLogin: () => { gate?.classList.remove('hidden'); loginButton?.focus(); },
    isAuthenticated: () => Boolean(sessionUser),
    getUser: () => sessionUser
  });
})();
