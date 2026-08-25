'use strict';

const secret = document.querySelector('#secret');
const status = document.querySelector('#status');
const users = document.querySelector('#users');

function adminFetch(url, options = {}) {
  return fetch(url, { ...options, headers: { ...(options.headers || {}), 'x-admin-secret': secret.value } });
}

function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}

async function loadUsers() {
  if (!secret.value) { status.textContent = 'Hãy nhập Admin Secret.'; return; }
  status.textContent = 'Đang tải…';
  try {
    const response = await adminFetch('/api/admin/users');
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || 'Không tải được danh sách.');
    users.replaceChildren(...result.users.map(user => {
      const row = document.createElement('tr');
      const devices = (user.devices || []).map(device => `<div><b>${safe(device.deviceInfo || 'Không rõ')}</b><br><span class="muted">${safe(device.userAgent)}<br>lần cuối: ${safe(device.lastSeen)}</span></div>`).join('<hr>');
      const status = user.banned
        ? `Đã BAN${user.ban_reason ? `<br><span class="muted">Lý do: ${safe(user.ban_reason)}</span>` : ''}`
        : (user.disabled ? 'Đã khoá' : safe(user.role));
      const banButton = user.banned
        ? `<button data-unban="${safe(user.id)}">Bỏ BAN</button>`
        : `<button class="danger" data-ban="${safe(user.id)}">BAN</button>`;
      row.innerHTML = `<td>${safe(user.email)}<br><span class="muted">${safe(user.display_name)}</span></td><td>${safe(user.created_at)}</td><td>${safe(user.last_login)}</td><td>${devices || 'Chưa có'}</td><td>${status}</td><td>${banButton} <button class="danger" data-delete="${safe(user.id)}">Xoá</button></td>`;
      return row;
    }));
    status.textContent = `Đã tải ${result.users.length} tài khoản.`;
  } catch (error) { status.textContent = error.message || 'Lỗi kết nối.'; }
}

document.querySelector('#load').addEventListener('click', loadUsers);
document.querySelector('#logout').addEventListener('click', () => { secret.value = ''; users.replaceChildren(); status.textContent = 'Đã xoá secret khỏi trang.'; });
users.addEventListener('click', async event => {
  const banButton = event.target.closest('[data-ban],[data-unban]');
  if (banButton) {
    const banning = banButton.hasAttribute('data-ban');
    const reason = banning ? prompt('Lý do BAN tài khoản này:', 'Vi phạm quy định sử dụng.') : '';
    if (banning && reason === null) return;
    if (!banning && !confirm('Bỏ BAN tài khoản này?')) return;
    banButton.disabled = true;
    try {
      const response = await adminFetch(`/api/admin/users/${encodeURIComponent(banButton.dataset.ban || banButton.dataset.unban)}/ban`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ banned: banning, reason: reason || '' })
      });
      const result = await response.json();
      status.textContent = result.ok ? (banning ? 'Đã BAN tài khoản.' : 'Đã bỏ BAN tài khoản.') : (result.error || 'Không cập nhật được trạng thái BAN.');
      if (result.ok) await loadUsers(); else banButton.disabled = false;
    } catch (error) {
      status.textContent = error.message || 'Lỗi kết nối.';
      banButton.disabled = false;
    }
    return;
  }
  const button = event.target.closest('[data-delete]');
  if (!button || !confirm('Xoá tài khoản này?')) return;
  button.disabled = true;
  const response = await adminFetch(`/api/admin/users/${encodeURIComponent(button.dataset.delete)}`, { method: 'DELETE' });
  const result = await response.json();
  status.textContent = result.ok ? 'Đã xoá tài khoản.' : (result.error || 'Không xoá được tài khoản.');
  if (result.ok) await loadUsers(); else button.disabled = false;
});
