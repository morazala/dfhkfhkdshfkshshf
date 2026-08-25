(() => {
  'use strict';

  // Hồ sơ người dùng — modal mở từ nút "Hồ sơ người dùng" trên trang chủ.
  // auth-client.js giữ quyền bật/tắt class .hidden khi bấm nút; file này chỉ
  // điền dữ liệu, đồng bộ avatar và bổ sung đóng bằng Esc/nền/nút ×.

  const panel = document.getElementById('accountPanel');
  const trigger = document.getElementById('accountCard');
  if (!panel || !trigger) return;

  const closeButton = document.getElementById('profileCloseBtn');
  const switchButton = document.getElementById('profileSwitchBtn');
  const avatarEl = document.getElementById('profileAvatar');
  const nameEl = document.getElementById('profileCardName');
  const emailEl = document.getElementById('profileCardEmail');
  const roleBadgeEl = document.getElementById('profileRoleBadge');
  const roleDetailEl = document.getElementById('profileRoleDetail');
  const emailDetailEl = document.getElementById('profileEmailDetail');
  const memberSinceEl = document.getElementById('profileMemberSince');
  const lastLoginEl = document.getElementById('profileLastLogin');
  const deviceEl = document.getElementById('profileDeviceDetail');

  const AVATAR_FALLBACK = 'icons/icon.svg';
  const ROLE_LABELS = { admin: 'Quản trị viên', user: 'Học viên' };
  const dateTimeFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' });
  const dateFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'long' });

  function currentUser() {
    return window.PhonicsAuth?.getUser?.() || null;
  }

  function deviceInfo() {
    const platform = navigator.userAgentData?.platform || navigator.platform || 'Không rõ';
    const kind = navigator.userAgentData?.mobile ? 'Điện thoại' : 'Máy tính';
    const mode = window.matchMedia('(display-mode: standalone)').matches ? 'Ứng dụng PWA' : 'Trình duyệt web';
    return `${platform} · ${kind} · ${mode}`;
  }

  function formatDate(value, format) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : format.format(date);
  }

  function render() {
    const user = currentUser();
    if (!user) return;
    const name = String(user.display_name || user.email || 'Tài khoản Google');
    const email = String(user.email || '');
    const roleLabel = ROLE_LABELS[String(user.role || 'user')] || 'Học viên';
    if (nameEl) nameEl.textContent = name;
    if (emailEl) emailEl.textContent = email || '—';
    if (emailDetailEl) emailDetailEl.textContent = email || '—';
    if (roleDetailEl) roleDetailEl.textContent = roleLabel;
    if (roleBadgeEl) {
      roleBadgeEl.textContent = roleLabel;
      roleBadgeEl.hidden = false;
      roleBadgeEl.dataset.role = String(user.role || 'user');
    }
    if (memberSinceEl) memberSinceEl.textContent = formatDate(user.created_at, dateFormat);
    if (lastLoginEl) lastLoginEl.textContent = formatDate(user.last_login, dateTimeFormat);
    if (deviceEl) deviceEl.textContent = deviceInfo();
    if (avatarEl) {
      avatarEl.src = String(user.avatar_url || AVATAR_FALLBACK);
      avatarEl.onerror = () => { avatarEl.src = AVATAR_FALLBACK; };
    }
  }

  function isOpen() {
    return !panel.classList.contains('hidden');
  }

  function close() {
    panel.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.focus();
  }

  // auth-client.js đã toggle .hidden trước (listener đăng ký sớm hơn), nên tại
  // đây chỉ cần nhận biết panel vừa mở để làm tươi dữ liệu và đặt focus.
  trigger.addEventListener('click', () => {
    if (!isOpen()) return;
    render();
    closeButton?.focus();
  });

  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    // Chặn điều hướng từ/độ tốc độ của app khi đang mở hồ sơ.
    if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(event.key)) {
      event.stopPropagation();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = panel.querySelectorAll('button:not([disabled])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  panel.querySelector('[data-profile-close]')?.addEventListener('click', close);
  closeButton?.addEventListener('click', close);

  switchButton?.addEventListener('click', () => {
    close();
    window.PhonicsAuth?.login?.();
  });

  document.addEventListener('phonics-auth-ready', render);
  document.addEventListener('phonics-auth-logged-out', () => panel.classList.add('hidden'));
})();
