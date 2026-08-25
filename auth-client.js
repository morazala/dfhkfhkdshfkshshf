'use strict';

(() => {
  // Keep the app locked until Render confirms the HttpOnly session cookie.
  document.documentElement.classList.add('auth-pending', 'auth-checking');

  const config = window.APP_CONFIG || {};
  const apiBaseUrl = String(config.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const googleClientId = String(config.googleClientId || '').trim();
  const gate = document.querySelector('#authGate');
  const gateStatus = document.querySelector('#authGateStatus');
  const gateTitle = document.querySelector('#authGateTitle');
  const gateDescription = document.querySelector('#authGateDescription');
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
  let bannedMode = false;
  let sessionCheckInFlight = false;
  let sessionCheckQueued = false;
  const ACTIVE_SESSION_CHECK_MS = 15_000;

  // Bản chạy local chỉ để xem giao diện: không đăng nhập, không gọi Render.
  const LOCAL_PREVIEW = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);

  // Gói miễn phí của Render ngủ sau ~15 phút không có request và mất 50 giây
  // trở lên để dậy. Thay vì báo lỗi giả sau 12 giây, app chủ động "đánh thức"
  // server bằng /api/health và giữ ấm bằng ping định kỳ.
  const WAKE_DEADLINE_MS = 90_000;
  const WAKE_ATTEMPT_TIMEOUT_MS = 8_000;
  const KEEP_ALIVE_INTERVAL_MS = 4 * 60_000;

  function setGateStatus(message, kind = '') {
    if (!gateStatus) return;
    gateStatus.textContent = message;
    gateStatus.dataset.kind = kind;
  }

  function apiUrl(path) { return apiBaseUrl ? `${apiBaseUrl}${path}` : path; }

  async function pingHealth(timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(apiUrl('/api/health'), {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal
      });
      return response.ok;
    } catch (_) {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  // Đánh thức Render: lặp ping nhẹ cho tới khi server trả lời hoặc hết hạn.
  // Server đã dậy thì ping đầu tiên trả lời dưới một giây, không chờ đợi gì.
  async function wakeServer({ quiet = false } = {}) {
    if (!apiBaseUrl || LOCAL_PREVIEW) return false;
    const deadline = Date.now() + WAKE_DEADLINE_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (!navigator.onLine) return false;
      attempt += 1;
      if (!quiet) {
        if (gateTitle) gateTitle.textContent = 'Đang đánh thức server…';
        if (gateDescription) gateDescription.textContent = 'Server miễn phí của Render đi ngủ khi vắng người dùng và cần khoảng một phút để dậy. App đang tự kết nối lại, bạn không cần làm gì cả.';
        setGateStatus(`Đang kết nối với server Render (lần thử ${attempt})…`, 'waking');
      }
      if (await pingHealth(WAKE_ATTEMPT_TIMEOUT_MS)) return true;
    }
    return false;
  }

  // Giữ ấm server: ping định kỳ khi tab đang mở để Render không ngủ giữa chừng.
  function keepRenderAwake() {
    if (!apiBaseUrl || LOCAL_PREVIEW) return;
    if (document.hidden || !navigator.onLine) return;
    pingHealth(10_000);
  }

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
      error.banned = Boolean(result.banned);
      error.reason = String(result.reason || '');
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
    bannedMode = false;
    updateAccount(sessionUser);
    document.documentElement.classList.remove('auth-pending');
    document.documentElement.classList.remove('auth-checking');
    gate?.classList.add('hidden');
    if (startButton) startButton.hidden = false;
    if (accountCard) accountCard.hidden = false;
    if (retryButton) retryButton.hidden = true;
    setGateStatus('Đã đăng nhập.', 'success');
    document.dispatchEvent(new CustomEvent('phonics-auth-ready', { detail: sessionUser }));
  }

  function setLoggedOut(message = 'Hãy đăng nhập bằng Google để bắt đầu.') {
    sessionUser = null;
    bannedMode = false;
    document.documentElement.classList.add('auth-pending');
    document.documentElement.classList.remove('auth-checking');
    gate?.classList.remove('hidden');
    if (startButton) startButton.hidden = true;
    if (accountCard) accountCard.hidden = true;
    if (gateTitle) gateTitle.textContent = 'Đăng nhập để bắt đầu';
    if (gateDescription) gateDescription.textContent = 'Đăng nhập bằng Google để lưu phiên học và sử dụng ứng dụng ổn định trên các thiết bị của bạn.';
    if (loginButton) {
      loginButton.hidden = false;
      loginButton.disabled = false;
    }
    if (retryButton) {
      retryButton.hidden = true;
      retryButton.textContent = 'Thử kiểm tra lại';
    }
    accountPanel?.classList.add('hidden');
    accountCard?.setAttribute('aria-expanded', 'false');
    setGateStatus(message);
    document.dispatchEvent(new CustomEvent('phonics-auth-logged-out'));
  }

  // Localhost: mở khóa giao diện để xem thử, không có tài khoản và không gọi API.
  function unlockLocalPreview() {
    sessionUser = null;
    bannedMode = false;
    document.documentElement.classList.remove('auth-pending', 'auth-checking');
    gate?.classList.add('hidden');
    if (startButton) startButton.hidden = false;
    if (accountCard) accountCard.hidden = true;
    if (loginButton) loginButton.hidden = true;
    if (retryButton) retryButton.hidden = true;
    setGateStatus('');
  }

  function showBanned(reason = '') {
    sessionUser = null;
    bannedMode = true;
    document.documentElement.classList.add('auth-pending');
    document.documentElement.classList.remove('auth-checking');
    gate?.classList.remove('hidden');
    if (startButton) startButton.hidden = true;
    if (accountCard) accountCard.hidden = true;
    accountPanel?.classList.add('hidden');
    accountCard?.setAttribute('aria-expanded', 'false');
    if (gateTitle) gateTitle.textContent = 'Tài khoản đã bị BAN';
    if (gateDescription) gateDescription.textContent = `Lý do: ${reason || 'Vi phạm quy định sử dụng.'} Nếu cần hỗ trợ, hãy liên hệ Zalo 0353200675.`;
    if (loginButton) loginButton.hidden = true;
    if (retryButton) {
      retryButton.hidden = false;
      retryButton.textContent = 'Đăng nhập tài khoản khác';
    }
    setGateStatus('Tài khoản này không được phép truy cập.', 'error');
    document.dispatchEvent(new CustomEvent('phonics-auth-banned', { detail: { reason } }));
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
      if (error.banned) showBanned(error.reason);
      else setGateStatus(error.message || 'Đăng nhập Google thất bại. Hãy thử lại.', 'error');
    } finally {
      loginInProgress = false;
      if (loginButton) loginButton.disabled = false;
    }
  }

  async function login() {
    if (loginInProgress || LOCAL_PREVIEW) return;
    if (!apiBaseUrl || !googleClientId) {
      setGateStatus('Bản PWA chưa có cấu hình API Render hoặc Google OAuth public.', 'error');
      if (retryButton) retryButton.hidden = false;
      return;
    }
    loginInProgress = true;
    if (loginButton) loginButton.disabled = true;
    // Nếu server đang ngủ, đánh thức xong mới mở popup để code đổi token không
    // bị hủy giữa chừng vì timeout.
    if (!await wakeServer()) {
      loginInProgress = false;
      if (loginButton) loginButton.disabled = false;
      setGateStatus('Chưa kết nối được server Render. Hãy kiểm tra mạng rồi bấm đăng nhập lại.', 'error');
      return;
    }
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
    if (LOCAL_PREVIEW) return unlockLocalPreview();
    if (!apiBaseUrl) {
      setLoggedOut('PWA chưa có địa chỉ API Render. Hãy build lại app-config.js với RENDER_API_URL.');
      if (retryButton) retryButton.hidden = false;
      return;
    }
    if (sessionCheckQueued) return;
    sessionCheckQueued = true;
    try {
      if (loginButton) loginButton.hidden = true;
      setGateStatus('Đang kiểm tra phiên đăng nhập…');
      // Chờ Render dậy trước (nếu đang ngủ) rồi mới xác minh cookie phiên,
      // tránh báo "lỗi mạng" giả trong lúc cold start.
      const awake = await wakeServer();
      if (!awake) {
        if (!navigator.onLine) {
          setGateStatus('Máy bạn đang offline. Kết nối mạng rồi bấm thử lại.', 'error');
        } else {
          setGateStatus('Server Render không phản hồi sau hơn một phút. Thường chỉ cần bấm thử lại là được.', 'error');
        }
        if (retryButton) retryButton.hidden = false;
        return;
      }
      if (gateTitle) gateTitle.textContent = 'Đang khôi phục phiên…';
      setGateStatus('Đang kiểm tra phiên đăng nhập…');
      const result = await api('/api/auth/me');
      setAuthenticated(result.user);
    } catch (error) {
      if (error.banned) {
        showBanned(error.reason);
      } else if (error.status !== 401) {
        setGateStatus('Server Render không phản hồi. Thường chỉ cần bấm thử lại là được.', 'error');
        if (retryButton) retryButton.hidden = false;
      } else {
        setLoggedOut();
      }
    } finally {
      sessionCheckQueued = false;
    }
  }

  async function checkActiveSession() {
    if (!sessionUser || sessionCheckInFlight || document.hidden || loginInProgress) return;
    sessionCheckInFlight = true;
    try {
      const result = await api('/api/auth/me');
      sessionUser = result.user || sessionUser;
      updateAccount(sessionUser);
    } catch (error) {
      if (error.banned) showBanned(error.reason);
      else if (error.status === 401 || error.status === 403) setLoggedOut('Phiên đăng nhập đã kết thúc. Hãy đăng nhập lại để tiếp tục.');
      // Lỗi mạng tạm thời không tự đăng xuất; lần kiểm tra kế tiếp sẽ thử lại.
    } finally {
      sessionCheckInFlight = false;
    }
  }

  loginButton?.addEventListener('click', login);
  retryButton?.addEventListener('click', () => {
    if (!bannedMode) return checkSession();
    bannedMode = false;
    retryButton.hidden = true;
    retryButton.textContent = 'Thử kiểm tra lại';
    if (gateTitle) gateTitle.textContent = 'Đăng nhập để bắt đầu';
    if (gateDescription) gateDescription.textContent = 'Nếu tài khoản khác đã được phép, bạn có thể đăng nhập lại bằng Google.';
    if (loginButton) loginButton.hidden = false;
    setGateStatus('');
  });
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

  window.setInterval(checkActiveSession, ACTIVE_SESSION_CHECK_MS);
  window.setInterval(keepRenderAwake, KEEP_ALIVE_INTERVAL_MS);
  window.addEventListener('focus', () => {
    keepRenderAwake();
    checkActiveSession();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      keepRenderAwake();
      checkActiveSession();
    }
  });

  checkSession();
  window.PhonicsAuth = Object.freeze({
    api,
    login,
    openLogin: () => {
      if (LOCAL_PREVIEW) return;
      gate?.classList.remove('hidden');
      loginButton?.focus();
    },
    isAuthenticated: () => LOCAL_PREVIEW || Boolean(sessionUser),
    getUser: () => sessionUser,
    localPreview: LOCAL_PREVIEW
  });
})();
