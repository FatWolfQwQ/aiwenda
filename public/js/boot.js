// MODULE: Boot
// Owns initial page loading, tab routing, health check, refresh actions, and shared page startup.

refreshBtn.addEventListener('click', () => loadKnowledgeBases(true));
refreshLogsBtn.addEventListener('click', () => loadLogs(true));
useDefaultPath.addEventListener('change', updatePathControls);
updateChatScopeCards();
tabs.forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});
userPill.addEventListener('click', () => switchTab('user'));
document.querySelectorAll('[data-home-tab]').forEach(button => {
  button.addEventListener('click', () => switchTab(button.dataset.homeTab));
});
toggleUsageGuideBtn.addEventListener('click', () => {
  usageGuide.classList.toggle('hidden');
  toggleUsageGuideBtn.textContent = usageGuide.classList.contains('hidden') ? '打开使用说明' : '收起使用说明';
});
pickCustomPath.addEventListener('click', async () => {
  if (isServerMode()) return;
  pickCustomPath.disabled = true;
  pickCustomPath.textContent = '选择中...';
  try {
    const folderPath = await withBusy('正在打开系统文件夹选择窗口，请稍等...', () => pickFolder('请选择知识库文件夹'));
    if (folderPath) form.customPath.value = folderPath;
  } catch (error) {
    alert(error.message);
  } finally {
    pickCustomPath.disabled = false;
    pickCustomPath.textContent = '选择文件夹';
  }
});

async function initializePage() {
  await withBusy('正在连接后端并加载知识库数据，请稍等...', async () => {
    await loadAppConfig();
    applyRuntimeModeControls();
    await checkHealth();
    if (currentUser?.role === 'admin') {
      await loadLogs();
      await loadAdminUsers();
    }
    if (typeof loadGroups === 'function') {
      await loadGroups();
    }
    await loadKnowledgeBases();
  });
}

bootAuthGate().then(async loggedIn => {
  if (!loggedIn) return;
  unlockApp();
  await initializePage();
}).catch(error => {
  hideBusy();
  statusEl.textContent = '后端连接失败';
  kbListEl.innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
});

