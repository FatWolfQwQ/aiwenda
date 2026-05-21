// MODULE: Auth And User Center
// Owns login, registration, role access, avatar settings, password changes, and admin user management.

let selectedRegisterAvatarId = 'wolf';

function ensureRegisterHints() {
  const passwordInput = authRegisterForm?.password;
  const userTypeWrap = document.querySelector('#userTypeWrap');
  if (passwordInput && !document.querySelector('#registerPasswordHint')) {
    const hint = document.createElement('div');
    hint.id = 'registerPasswordHint';
    hint.className = 'register-hint';
    hint.innerHTML = '<strong>密码要求</strong><span>至少 8 位，同时包含英文字母和数字。</span>';
    passwordInput.closest('label')?.insertAdjacentElement('afterend', hint);
  }
  if (userTypeWrap && !document.querySelector('#registerUserTypeHint')) {
    const hint = document.createElement('div');
    hint.id = 'registerUserTypeHint';
    hint.className = 'register-hint account-type-hint';
    hint.innerHTML = `
      <strong>账号类型说明</strong>
      <span>个人用户：管理自己的知识库和问答。</span>
      <span>企业用户：额外支持用户组、共享知识库和成员协作。</span>
    `;
    userTypeWrap.insertAdjacentElement('afterend', hint);
  }
}

ensureRegisterHints();

function saveCurrentUser(user) {
  currentUser = user;
  localStorage.setItem('feilangCurrentUserId', user.id);
  applyAvatarSlots();
  applyRoleAccess();
  renderUserCenter();
}

function showAuthMessage(message, isError = false) {
  authMessage.textContent = message || '';
  authMessage.classList.toggle('error', Boolean(isError));
}

function renderAvatarButton(id, activeId, slot) {
  return `
    <button type="button" class="avatar-option ${id === activeId ? 'active' : ''}" data-avatar-id="${escapeHtml(id)}" data-avatar-target="${escapeHtml(slot)}">
      ${pixelAvatarSvg(id)}
      <span>${escapeHtml(avatarName(id))}</span>
    </button>
  `;
}

function renderAuthAvatars() {
  if (document.querySelector('[data-auth-preview]')) {
    document.querySelector('[data-auth-preview]').innerHTML = pixelAvatarSvg(selectedRegisterAvatarId);
  }
  authAvatarGrid.innerHTML = avatarIds.map(id => renderAvatarButton(id, selectedRegisterAvatarId, 'register')).join('');
}

function renderAvatarGrid(el, slot) {
  el.innerHTML = avatarIds.map(id => renderAvatarButton(id, userAvatar(slot), slot)).join('');
}

function renderUserCenter() {
  if (!currentUser) return;
  userCenterInfo.textContent = `当前账号：${currentUser.username} · ${currentUser.role === 'admin' ? '管理员' : '用户'}`;
  renderAvatarGrid(userAvatarGrid, 'avatarId');
  renderAvatarGrid(brandAvatarGrid, 'brandAvatarId');
  renderAvatarGrid(busyAvatarGrid, 'busyAvatarId');
  renderAvatarGrid(aiAvatarGrid, 'aiAvatarId');
}

function switchUserCenterPage(page) {
  userCenterTabs.forEach(button => button.classList.toggle('active', button.dataset.userCenterTab === page));
  userProfilePage.classList.toggle('active', page === 'profile');
  userPasswordPage.classList.toggle('active', page === 'password');
}

function applyRoleAccess() {
  const isAdmin = currentUser?.role === 'admin';
  const isEnterprise = isEnterpriseAccount();
  document.querySelectorAll('[data-admin-only]').forEach(item => item.classList.toggle('hidden', !isAdmin));
  document.querySelectorAll('[data-enterprise-only]').forEach(item => item.classList.toggle('hidden', !isEnterprise));
  if (!isAdmin) {
    if (document.querySelector('[data-page="logs"]')?.classList.contains('active')) switchTab('home');
    if (document.querySelector('[data-page="admin-users"]')?.classList.contains('active')) switchTab('home');
    logListEl.innerHTML = '';
    logDetailEl.innerHTML = '普通用户不可查看问答日志';
  }
  if (!isEnterprise && document.querySelector('[data-page="groups"]')?.classList.contains('active')) switchTab('home');
}

async function loadAdminUsers(showOverlay = false) {
  if (!currentUser || currentUser.role !== 'admin') return;
  const task = async () => {
    adminUsersList.innerHTML = '<div class="empty">正在加载用户...</div>';
    const data = await requestJson(`/api/admin/users?userId=${encodeURIComponent(currentUser.id)}`);
    const users = toArray(data.items);
    adminUsersList.innerHTML = users.map(user => `
      <article class="kb-card">
        <div class="row">
          <div>
            <h3>${escapeHtml(user.username)}</h3>
            <p>角色：${user.role === 'admin' ? '管理员' : '用户'} · 注册时间：${formatTime(user.createdAt)}</p>
            <div class="meta">密码：${escapeHtml(user.password)}</div>
          </div>
          <div class="action-stack">
            <div class="user-admin-avatar">${pixelAvatarSvg(user.avatarId)}</div>
            <button type="button" class="ghost small-btn" data-reset-password="${escapeHtml(user.id)}">重置密码</button>
          </div>
        </div>
      </article>
    `).join('');
  };
  if (showOverlay) return withBusy('正在刷新用户列表，请稍等...', task);
  return task();
}

function setAuthMode(mode) {
  document.querySelectorAll('[data-auth-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.authMode === mode));
  document.querySelectorAll('[data-auth-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.authPanel !== mode));
  showAuthMessage('');
}

async function loadAvatarIds() {
  const data = await requestJson('/api/auth/avatars');
  avatarIds = toArray(data.items);
  renderAuthAvatars();
}

async function loadSavedUser() {
  const userId = localStorage.getItem('feilangCurrentUserId');
  if (!userId) return false;
  const data = await requestJson(`/api/auth/user?id=${encodeURIComponent(userId)}`);
  saveCurrentUser(data.user);
  return true;
}

function unlockApp() {
  authGate.classList.add('hidden');
  appShell.classList.remove('auth-locked');
  applyRoleAccess();
  applyAvatarSlots();
}

async function bootAuthGate() {
  await loadAvatarIds();
  try {
    if (await loadSavedUser()) return true;
  } catch {
    localStorage.removeItem('feilangCurrentUserId');
  }
  authGate.classList.remove('hidden');
  appShell.classList.add('auth-locked');
  return false;
}

document.querySelectorAll('[data-auth-mode]').forEach(btn => {
  btn.addEventListener('click', () => setAuthMode(btn.dataset.authMode));
});

userCenterTabs.forEach(button => {
  button.addEventListener('click', () => switchUserCenterPage(button.dataset.userCenterTab));
});

authRegisterForm.role.addEventListener('change', () => {
  document.querySelector('#adminKeyWrap').classList.toggle('hidden', authRegisterForm.role.value !== 'admin');
  document.querySelector('#userTypeWrap')?.classList.toggle('hidden', authRegisterForm.role.value === 'admin');
});

authAvatarGrid.addEventListener('click', event => {
  const btn = event.target.closest('[data-avatar-id]');
  if (!btn) return;
  selectedRegisterAvatarId = btn.dataset.avatarId;
  renderAuthAvatars();
});

authLoginForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const data = await withBusy('正在登录，请稍等...', () => requestJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: authLoginForm.username.value, password: authLoginForm.password.value })
    }));
    saveCurrentUser(data.user);
    unlockApp();
    await initializePage();
  } catch (error) {
    showAuthMessage(error.message, true);
  }
});

authRegisterForm.addEventListener('submit', async event => {
  event.preventDefault();
  const password = authRegisterForm.password.value;
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    showAuthMessage('密码强度不足：至少 8 位，并且必须同时包含英文字母和数字', true);
    return;
  }
  try {
    const data = await withBusy('正在注册，请稍等...', () => requestJson('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: authRegisterForm.username.value,
        password: authRegisterForm.password.value,
        passwordConfirm: authRegisterForm.passwordConfirm.value,
        role: authRegisterForm.role.value,
        userType: authRegisterForm.userType?.value || 'personal',
        adminKey: authRegisterForm.adminKey.value,
        avatarId: selectedRegisterAvatarId
      })
    }));
    saveCurrentUser(data.user);
    unlockApp();
    await initializePage();
  } catch (error) {
    showAuthMessage(error.message, true);
  }
});

async function saveAvatarPreference(slot, id) {
  const payload = {
    userId: currentUser.id,
    avatarId: currentUser.avatarId,
    brandAvatarId: currentUser.brandAvatarId,
    busyAvatarId: currentUser.busyAvatarId,
    aiAvatarId: currentUser.aiAvatarId
  };
  payload[slot] = id;
  const data = await withBusy('正在保存头像设置，请稍等...', () => requestJson('/api/auth/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }));
  saveCurrentUser(data.user);
}

[userAvatarGrid, brandAvatarGrid, busyAvatarGrid, aiAvatarGrid].forEach(grid => {
  grid.addEventListener('click', async event => {
    const btn = event.target.closest('[data-avatar-id]');
    if (!btn) return;
    try {
      await saveAvatarPreference(btn.dataset.avatarTarget, btn.dataset.avatarId);
    } catch (error) {
      alert(error.message);
    }
  });
});

passwordForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const data = await withBusy('正在修改密码，请稍等...', () => requestJson('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser.id,
        oldPassword: passwordForm.oldPassword.value,
        newPassword: passwordForm.newPassword.value,
        newPasswordConfirm: passwordForm.newPasswordConfirm.value
      })
    }));
    saveCurrentUser(data.user);
    passwordForm.reset();
    alert('密码已修改');
  } catch (error) {
    alert(error.message);
  }
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('feilangCurrentUserId');
  currentUser = null;
  appShell.classList.add('auth-locked');
  authGate.classList.remove('hidden');
  setAuthMode('login');
});

refreshAdminUsersBtn.addEventListener('click', () => loadAdminUsers(true).catch(error => alert(error.message)));

adminUsersList.addEventListener('click', async event => {
  const button = event.target.closest('[data-reset-password]');
  if (!button) return;
  const newPassword = await appPrompt('请输入新密码', { type: 'password', title: '重置密码' });
  if (!newPassword) return;
  const newPasswordConfirm = await appPrompt('请再次输入新密码', { type: 'password', title: '确认新密码' });
  if (newPassword !== newPasswordConfirm) {
    alert('两次输入的新密码不一致');
    return;
  }
  try {
    await withBusy('正在重置密码，请稍等...', () => requestJson('/api/admin/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminId: currentUser.id,
        targetUserId: button.dataset.resetPassword,
        newPassword,
        newPasswordConfirm
      })
    }));
    alert('密码已重置');
    await loadAdminUsers(true);
  } catch (error) {
    alert(error.message);
  }
});
