// Plain vanilla JS client of the same REST API the phone app uses -- no
// build step, no framework, so this stays trivially deployable alongside
// the server (see plan doc "Future web application").

const ACCESS_KEY = 'admin_access';
const REFRESH_KEY = 'admin_refresh';

function getAccess() {
  return localStorage.getItem(ACCESS_KEY);
}
function getRefresh() {
  return localStorage.getItem(REFRESH_KEY);
}
function saveSession(access, refresh) {
  localStorage.setItem(ACCESS_KEY, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}
function clearSession() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

async function tryRefresh() {
  const refresh = getRefresh();
  if (!refresh) return false;
  const response = await fetch('/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: refresh }),
  });
  if (!response.ok) return false;
  const body = await response.json();
  saveSession(body.access, body.refresh);
  return true;
}

// Mirrors the app's ApiClient: retries once after a silent refresh on 401,
// then gives up and drops back to the sign-in screen.
async function apiFetch(path, options = {}, retried = false) {
  const access = getAccess();
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status === 401 && !retried) {
    const refreshed = await tryRefresh();
    if (refreshed) return apiFetch(path, options, true);
    clearSession();
    showSignedOut();
    throw new Error('session_expired');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `request_failed_${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function handleCredentialResponse(response) {
  clearError();
  try {
    const res = await fetch('/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: response.credential }),
    });
    if (!res.ok) throw new Error('google_auth_failed');
    const body = await res.json();
    saveSession(body.access, body.refresh);
    await boot();
  } catch (err) {
    showError("Sign-in failed. Please try again.");
  }
}
window.handleCredentialResponse = handleCredentialResponse;

function showPanel(id) {
  for (const panelId of ['signed-out', 'access-denied', 'signed-in']) {
    document.getElementById(panelId).classList.toggle('hidden', panelId !== id);
  }
}
function showSignedOut() {
  showPanel('signed-out');
}
function showAccessDenied() {
  showPanel('access-denied');
}
function showDashboard() {
  showPanel('signed-in');
}

function showError(message) {
  const el = document.getElementById('error-banner');
  el.textContent = message;
  el.classList.remove('hidden');
}
function clearError() {
  document.getElementById('error-banner').classList.add('hidden');
}

async function boot() {
  clearError();
  if (!getAccess()) {
    showSignedOut();
    return;
  }
  try {
    const me = await apiFetch('/me');
    if (!me.isMasterAdmin) {
      showAccessDenied();
      return;
    }
    showDashboard();
    await loadGroups();
  } catch (err) {
    showSignedOut();
  }
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

async function loadGroups() {
  const tbody = document.getElementById('groups-body');
  tbody.innerHTML = '<tr><td colspan="7">Loading&hellip;</td></tr>';
  try {
    const { groups } = await apiFetch('/admin/groups');
    tbody.innerHTML = '';
    if (groups.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7">No messes online yet.</td></tr>';
      return;
    }
    for (const group of groups) {
      tbody.appendChild(renderRow(group));
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7">Couldn’t load messes.</td></tr>';
  }
}

function renderRow(group) {
  const tr = document.createElement('tr');
  const paidUntilValue = group.paidUntil ? String(group.paidUntil).slice(0, 10) : '';

  tr.innerHTML = `
    <td>${escapeHtml(group.name)}</td>
    <td>${escapeHtml(group.ownerEmail || '—')}</td>
    <td><span class="status status-${escapeHtml(group.status)}">${escapeHtml(group.status)}</span></td>
    <td>${group.memberCount}</td>
    <td><code>${escapeHtml(group.inviteCode || '—')}</code></td>
    <td><input type="date" class="paid-until-input" value="${paidUntilValue}" /></td>
    <td class="actions"></td>
  `;

  const actionsCell = tr.querySelector('.actions');

  const saveDateBtn = document.createElement('button');
  saveDateBtn.textContent = 'Save date';
  saveDateBtn.onclick = () => {
    const input = tr.querySelector('.paid-until-input');
    updateGroup(group.id, { paidUntil: input.value || null });
  };
  actionsCell.appendChild(saveDateBtn);

  const extendBtn = document.createElement('button');
  extendBtn.textContent = '+30 days';
  extendBtn.onclick = () => {
    const currentPaidUntil = group.paidUntil ? new Date(group.paidUntil) : null;
    const today = new Date();
    const base = currentPaidUntil && currentPaidUntil > today ? currentPaidUntil : today;
    base.setDate(base.getDate() + 30);
    updateGroup(group.id, { paidUntil: base.toISOString().slice(0, 10), status: 'active' });
  };
  actionsCell.appendChild(extendBtn);

  const toggleBtn = document.createElement('button');
  const isDisabled = group.status === 'disabled';
  toggleBtn.textContent = isDisabled ? 'Enable' : 'Disable';
  toggleBtn.className = isDisabled ? '' : 'danger';
  toggleBtn.onclick = () => updateGroup(group.id, { status: isDisabled ? 'active' : 'disabled' });
  actionsCell.appendChild(toggleBtn);

  return tr;
}

async function updateGroup(id, patch) {
  clearError();
  try {
    await apiFetch(`/admin/groups/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await loadGroups();
  } catch (err) {
    showError("Couldn't update that mess. Please try again.");
  }
}

document.getElementById('refresh-btn').addEventListener('click', loadGroups);
document.getElementById('sign-out-btn').addEventListener('click', () => {
  clearSession();
  showSignedOut();
});

boot();
