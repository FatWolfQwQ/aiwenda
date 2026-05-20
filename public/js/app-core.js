// MODULE: Shared Core
// Owns DOM references, shared state, request helpers, shared render utilities, and cross-module helpers.
// Feature-specific behavior belongs in auth.js, knowledge-documents.js, chat.js, logs.js, or boot.js.

const statusEl = document.querySelector('#status');
const kbListEl = document.querySelector('#kbList');
const docListEl = document.querySelector('#docList');
const docTitleEl = document.querySelector('#docTitle');
const form = document.querySelector('#createForm');
const uploadForm = document.querySelector('#uploadForm');
const chatForm = document.querySelector('#chatForm');
const refreshBtn = document.querySelector('#refreshBtn');
const knowledgeBaseSelect = document.querySelector('#knowledgeBaseSelect');
const chatDocumentsWrap = document.querySelector('#chatDocumentsWrap');
const chatDocumentSelect = document.querySelector('#chatDocumentSelect');
const chatKbCards = document.querySelector('#chatKbCards');
const backToChatKb = document.querySelector('#backToChatKb');
const enterChatBtn = document.querySelector('#enterChatBtn');
const chatDocStageTitle = document.querySelector('#chatDocStageTitle');
const chatSessionTitle = document.querySelector('#chatSessionTitle');
const chatSessionMeta = document.querySelector('#chatSessionMeta');
const answerModeSelect = document.querySelector('#answerModeSelect');
const answerModeHint = document.querySelector('#answerModeHint');
const openChatSetupBtn = document.querySelector('#openChatSetupBtn');
const openChatHistoryBtn = document.querySelector('#openChatHistoryBtn');
const chatSetupModal = document.querySelector('#chatSetupModal');
const chatHistoryModal = document.querySelector('#chatHistoryModal');
const closeChatHistoryBtn = document.querySelector('#closeChatHistoryBtn');
const chatHistoryList = document.querySelector('#chatHistoryList');
const chatSetupTitle = document.querySelector('#chatSetupTitle');
const chatSetupHint = document.querySelector('#chatSetupHint');
const chatMessagesEl = document.querySelector('#chatMessages');
const refreshLogsBtn = document.querySelector('#refreshLogsBtn');
const exportAllLogsBtn = document.querySelector('#exportAllLogsBtn');
const exportSelectedLogsBtn = document.querySelector('#exportSelectedLogsBtn');
const useDefaultLogPath = document.querySelector('#useDefaultLogPath');
const customLogPathWrap = document.querySelector('#customLogPathWrap');
const customLogPath = document.querySelector('#customLogPath');
const pickLogPath = document.querySelector('#pickLogPath');
const logListEl = document.querySelector('#logList');
const logDetailEl = document.querySelector('#logDetail');
const busyOverlay = document.querySelector('#busyOverlay');
const busyText = document.querySelector('#busyText');
const useDefaultPath = document.querySelector('#useDefaultPath');
const customPathWrap = document.querySelector('#customPathWrap');
const pickCustomPath = document.querySelector('#pickCustomPath');
const tabs = document.querySelectorAll('.tabs [data-tab]');
const pages = document.querySelectorAll('[data-page]');
const appShell = document.querySelector('#appShell');
const authGate = document.querySelector('#authGate');
const authLoginForm = document.querySelector('#authLoginForm');
const authRegisterForm = document.querySelector('#authRegisterForm');
const authMessage = document.querySelector('#authMessage');
const authAvatarGrid = document.querySelector('#authAvatarGrid');
const userPill = document.querySelector('#userPill');
const userCenterInfo = document.querySelector('#userCenterInfo');
const userAvatarGrid = document.querySelector('#userAvatarGrid');
const brandAvatarGrid = document.querySelector('#brandAvatarGrid');
const busyAvatarGrid = document.querySelector('#busyAvatarGrid');
const aiAvatarGrid = document.querySelector('#aiAvatarGrid');
const passwordForm = document.querySelector('#passwordForm');
const userProfilePage = document.querySelector('#userProfilePage');
const userPasswordPage = document.querySelector('#userPasswordPage');
const userCenterTabs = document.querySelectorAll('[data-user-center-tab]');
const logoutBtn = document.querySelector('#logoutBtn');
const adminUsersList = document.querySelector('#adminUsersList');
const refreshAdminUsersBtn = document.querySelector('#refreshAdminUsersBtn');
const toggleUsageGuideBtn = document.querySelector('#toggleUsageGuideBtn');
const usageGuide = document.querySelector('#usageGuide');
const groupCreateForm = document.querySelector('#groupCreateForm');
const groupSearchForm = document.querySelector('#groupSearchForm');
const myGroupsList = document.querySelector('#myGroupsList');
const groupSearchList = document.querySelector('#groupSearchList');
const groupDetailPanel = document.querySelector('#groupDetailPanel');
const groupTabs = document.querySelectorAll('[data-group-tab]');
const groupPages = document.querySelectorAll('[data-group-page]');

let knowledgeBases = [];
let selectedKnowledgeBaseId = '';
let currentDocuments = [];
let chatSelectedKnowledgeBaseId = '';
let chatSelectedDocumentIds = [];
let chatScopeMode = 'knowledgeBase';
let chatConfigured = false;
let answerMode = 'thinking';
let currentUser = null;
let userGroups = [];
let selectedGroupId = '';
let appMode = 'local';
let runtimeConfig = { appMode: 'local', isServerMode: false };
let avatarIds = [
  'wolf', 'fox', 'cat', 'dog', 'bear', 'rabbit', 'panda', 'tiger', 'lion', 'deer',
  'raccoon', 'otter', 'hamster', 'koala', 'red-panda', 'squirrel', 'owl', 'penguin', 'seal', 'dragon'
];

async function requestJson(url, options) {
  const requestOptions = { ...(options || {}) };
  requestOptions.headers = {
    ...(requestOptions.headers || {}),
    ...(currentUser?.id ? { 'X-User-Id': currentUser.id } : {})
  };
  let response;
  try {
    response = await fetch(url, requestOptions);
  } catch {
    throw new Error('无法连接后端服务。请先用项目文件夹里的“打开网站.vbs”启动网站，或确认 http://localhost:3000 可以访问。');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function showBusy(message = '正在处理，请不要进行其他操作。') {
  busyText.textContent = message;
  busyOverlay.classList.remove('hidden');
}

function hideBusy() {
  busyOverlay.classList.add('hidden');
}

function waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withBusy(message, task, minVisibleMs = 0) {
  showBusy(message);
  const startedAt = Date.now();
  try {
    return await task();
  } finally {
    const remain = minVisibleMs - (Date.now() - startedAt);
    if (remain > 0) await waitMs(remain);
    hideBusy();
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}

function renderMarkdownLite(value) {
  let html = escapeHtml(value).replace(/\n/g, '<br>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

const avatarProfiles = {
  wolf: ['小狼', '#7f8b99', '#c8d1d9', '#eef3f7'],
  fox: ['小狐', '#d17832', '#f0a85d', '#fff1d3'],
  cat: ['小猫', '#5f6570', '#9aa1ad', '#f7fbff'],
  dog: ['小狗', '#8a623f', '#c99a68', '#fff1d3'],
  bear: ['小熊', '#6a4a36', '#9b7354', '#f4d4a4'],
  rabbit: ['小兔', '#d8dce4', '#f3f6fb', '#ffd7df'],
  panda: ['熊猫', '#242b35', '#f4f8fb', '#e9eef4'],
  tiger: ['小虎', '#c96d28', '#f0a03d', '#fff1cf'],
  lion: ['小狮', '#b06d2f', '#d9963e', '#fff0bf'],
  deer: ['小鹿', '#8a633e', '#c58b55', '#fff0d4'],
  raccoon: ['浣熊', '#59636f', '#a9b3be', '#f4f7fb'],
  otter: ['水獭', '#70513b', '#a67a55', '#f5dfbf'],
  hamster: ['仓鼠', '#c69055', '#e2b77b', '#fff1d5'],
  koala: ['考拉', '#8d98a5', '#c8d0d8', '#f5f8fb'],
  'red-panda': ['小熊猫', '#a64d2c', '#d97745', '#ffe2c2'],
  squirrel: ['松鼠', '#9b5b32', '#d48a4a', '#ffe1bf'],
  owl: ['小鸮', '#7b6242', '#c1a06a', '#fff4cf'],
  penguin: ['企鹅', '#202a37', '#f4f7fb', '#ffd36e'],
  seal: ['海豹', '#7f94a6', '#c7d6df', '#f6fbff'],
  dragon: ['小龙', '#2f8b73', '#78c49a', '#e6fff1']
};

function avatarName(id) {
  return avatarProfiles[id]?.[0] || '小狼';
}

function pixelAvatarSvg(id = 'wolf') {
  const [, main, light, face] = avatarProfiles[id] || avatarProfiles.wolf;
  const hasLongEars = id === 'rabbit';
  const roundEars = ['bear', 'panda', 'koala', 'hamster', 'seal'].includes(id);
  const beak = ['owl', 'penguin'].includes(id);
  const antlers = id === 'deer';
  return `
    <svg class="pixel-wolf-svg pixel-avatar-svg" viewBox="0 0 64 64" role="img" aria-hidden="true" shape-rendering="crispEdges">
      <rect width="64" height="64" rx="14" fill="#1e2b3d"/>
      ${antlers ? '<rect x="8" y="6" width="4" height="12" fill="#d7b37a"/><rect x="52" y="6" width="4" height="12" fill="#d7b37a"/><rect x="4" y="6" width="8" height="4" fill="#d7b37a"/><rect x="52" y="6" width="8" height="4" fill="#d7b37a"/>' : ''}
      ${hasLongEars ? `<rect x="12" y="6" width="8" height="24" fill="${main}"/><rect x="44" y="6" width="8" height="24" fill="${main}"/><rect x="14" y="10" width="4" height="14" fill="${face}"/><rect x="46" y="10" width="4" height="14" fill="${face}"/>` : roundEars ? `<rect x="10" y="14" width="12" height="12" fill="${main}"/><rect x="42" y="14" width="12" height="12" fill="${main}"/>` : `<rect x="10" y="10" width="10" height="16" fill="${main}"/><rect x="44" y="10" width="10" height="16" fill="${main}"/><rect x="14" y="14" width="6" height="8" fill="${face}"/><rect x="44" y="14" width="6" height="8" fill="${face}"/>`}
      <rect x="18" y="14" width="28" height="8" fill="${main}"/>
      <rect x="14" y="22" width="36" height="18" fill="${light}"/>
      <rect x="18" y="20" width="28" height="8" fill="${face}"/>
      <rect x="20" y="28" width="8" height="8" fill="${id === 'panda' ? '#202a37' : face}"/>
      <rect x="36" y="28" width="8" height="8" fill="${id === 'panda' ? '#202a37' : face}"/>
      <rect x="22" y="30" width="4" height="4" fill="#152033"/>
      <rect x="38" y="30" width="4" height="4" fill="#152033"/>
      ${beak ? '<rect x="28" y="36" width="8" height="6" fill="#ffd36e"/>' : '<rect x="26" y="36" width="12" height="6" fill="#eef3f7"/><rect x="28" y="38" width="8" height="6" fill="#152033"/>'}
      <rect x="20" y="42" width="24" height="10" fill="${face}"/>
      <rect x="16" y="40" width="8" height="6" fill="${light}"/>
      <rect x="40" y="40" width="8" height="6" fill="${light}"/>
      <rect x="24" y="48" width="6" height="4" fill="${main}"/>
      <rect x="34" y="48" width="6" height="4" fill="${main}"/>
    </svg>
  `;
}

function userAvatar(slot = 'avatarId') {
  return currentUser?.[slot] || 'wolf';
}

function applyAvatarSlots() {
  document.querySelectorAll('[data-avatar-slot]').forEach(item => {
    const slot = item.dataset.avatarSlot;
    item.innerHTML = pixelAvatarSvg(userAvatar(slot));
    item.setAttribute('aria-label', `像素${avatarName(userAvatar(slot))}`);
  });
  if (userPill && currentUser) {
    userPill.innerHTML = `<span class="user-pill-avatar">${pixelAvatarSvg(userAvatar('avatarId'))}</span><span>${escapeHtml(currentUser.username)} · ${currentUser.role === 'admin' ? '管理员' : '用户'}</span>`;
  }
}

function pixelWolfSvg() {
  return `
    ${pixelAvatarSvg(userAvatar('aiAvatarId'))}
  `;
}

function normalizeQuestionInput(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function showReplySparkle() {
  const sparkle = document.createElement('div');
  sparkle.className = 'reply-sparkle';
  sparkle.textContent = `${avatarName(userAvatar('aiAvatarId'))}已回复`;
  document.querySelector('.chat-console')?.appendChild(sparkle);
  setTimeout(() => sparkle.remove(), 1600);
}

function confirmTwice(firstMessage, secondMessage) {
  return confirm(firstMessage) && confirm(secondMessage);
}

function formatTime(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function selectedKnowledgeBase() {
  return knowledgeBases.find(item => item.id === selectedKnowledgeBaseId);
}

function isServerMode() {
  return runtimeConfig.isServerMode || appMode === 'server';
}

async function loadAppConfig() {
  runtimeConfig = await requestJson('/api/config');
  appMode = runtimeConfig.appMode || 'local';
  return runtimeConfig;
}

function applyRuntimeModeControls() {
  const serverMode = isServerMode();
  if (useDefaultPath) {
    useDefaultPath.checked = true;
    useDefaultPath.disabled = serverMode;
    useDefaultPath.closest('label')?.classList.toggle('hidden', serverMode);
  }
  customPathWrap?.classList.add('hidden');
  if (pickCustomPath) pickCustomPath.disabled = serverMode;

  const logOptions = document.querySelector('.log-export-options');
  if (logOptions) logOptions.classList.toggle('hidden', serverMode);
  if (useDefaultLogPath) {
    useDefaultLogPath.checked = true;
    useDefaultLogPath.disabled = serverMode;
  }
  customLogPathWrap?.classList.add('hidden');
}

function openDownload(url) {
  const joiner = url.includes('?') ? '&' : '?';
  window.open(currentUser?.id ? `${url}${joiner}userId=${encodeURIComponent(currentUser.id)}` : url, '_blank');
}

function updatePathControls() {
  customPathWrap.classList.toggle('hidden', useDefaultPath.checked);
}

function renderChatDocumentOptions(documents) {
  documents = toArray(documents);
  chatDocumentSelect.innerHTML = documents.length ? documents.map(doc => `
    <label class="chat-doc-card ${chatSelectedDocumentIds.includes(doc.id) ? 'active' : ''}">
      <input type="checkbox" value="${escapeHtml(doc.id)}" ${chatSelectedDocumentIds.includes(doc.id) ? 'checked' : ''} />
      <strong>${escapeHtml(doc.filename)}</strong>
      <span>${escapeHtml(doc.fileType)} · ${doc.chunkCount || 0} 个片段 · ${formatSize(doc.fileSize || 0)}</span>
    </label>
  `).join('') : '<div class="empty">这个知识库还没有上传文档</div>';
}

function setChatStep(step) {
  document.querySelectorAll('[data-chat-step]').forEach(item => item.classList.toggle('active', item.dataset.chatStep === step));
  document.querySelectorAll('[data-chat-step-dot]').forEach(item => item.classList.toggle('active', item.dataset.chatStepDot === step));
  chatSetupTitle.textContent = step === 'kb' ? '选择知识库' : '选择文档范围';
  chatSetupHint.textContent = step === 'kb'
    ? '点击知识库卡片后进入文档范围选择。'
    : '确认使用整个知识库，或勾选指定文档。';
}

function openChatSetup(step = 'kb') {
  renderChatKnowledgeBases();
  updateChatScopeCards();
  chatSetupModal.classList.remove('hidden');
  setChatStep(step);
}

function closeChatSetup() {
  chatSetupModal.classList.add('hidden');
}

function chatKbName() {
  return knowledgeBases.find(item => item.id === chatSelectedKnowledgeBaseId)?.name || '未选择知识库';
}

function renderChatKnowledgeBases() {
  if (!chatKbCards) return;
  chatKbCards.innerHTML = knowledgeBases.length ? knowledgeBases.map(item => `
    <article class="chat-choice-card ${item.id === chatSelectedKnowledgeBaseId ? 'active' : ''}" data-chat-kb-id="${escapeHtml(item.id)}">
      <div class="choice-orb">${escapeHtml((item.name || '知').slice(0, 1))}</div>
      <div>
        <h3>${escapeHtml(item.name)}</h3>
        <p>${escapeHtml(item.description || '暂无描述')}</p>
        <span>${item.documentCount || 0} 个文档 · ${formatTime(item.updatedAt)}</span>
      </div>
    </article>
  `).join('') : '<div class="empty">暂无知识库，请先创建知识库。</div>';
}

async function prepareChatDocuments() {
  const data = await requestJson(`/api/documents?knowledgeBaseId=${encodeURIComponent(chatSelectedKnowledgeBaseId)}`);
  currentDocuments = toArray(data.items);
  chatSelectedDocumentIds = chatSelectedDocumentIds.filter(id => currentDocuments.some(doc => doc.id === id));
  renderChatDocumentOptions(currentDocuments);
  chatDocStageTitle.textContent = `当前知识库：${chatKbName()}。可选择整个知识库，或指定一个 / 多个文档。`;
}

function updateChatScopeCards() {
  document.querySelectorAll('[data-chat-scope]').forEach(button => button.classList.toggle('active', button.dataset.chatScope === chatScopeMode));
  chatDocumentsWrap.classList.toggle('hidden', chatScopeMode !== 'documents');
}

function updateChatSessionMeta() {
  const scopeText = chatScopeMode === 'documents'
    ? `指定 ${chatSelectedDocumentIds.length} 个文档`
    : '整个知识库';
  const modeText = answerMode === 'fast' ? '快速模式' : '思考模式';
  chatSessionTitle.textContent = chatKbName();
  chatSessionMeta.textContent = `${scopeText} · ${modeText}`;
}

function notifyChatContextChanged() {
  const kbName = chatKbName();
  const scopeText = chatScopeMode === 'documents'
    ? `指定文档：${chatSelectedDocumentIds.length} 个`
    : '整个知识库';
  alert(`已更换到知识库：${kbName}\n范围：${scopeText}\n已展开全新的聊天界面，之前的聊天可在“聊天记录”中查看。`);
}

function renderChatExchange(record) {
  chatMessagesEl.innerHTML = '';
  chatMessagesEl.insertAdjacentHTML('beforeend', `<article class="message user"><div class="bubble">${escapeHtml(record.question)}</div></article>`);
  chatMessagesEl.insertAdjacentHTML('beforeend', `
    <article class="message assistant">
      <div class="bubble">
        <div class="answer-text">${renderMarkdownLite(record.answer)}</div>
        ${record.answerMode === 'fast' ? '<div class="citation-note">快速模式提示：当前回答只读取最相关的少量片段，并跳过二次资料依据分析，速度更快，但完整性和引用精细度会低于思考模式。</div>' : ''}
        <div class="meta">模式：${record.answerMode === 'fast' ? '快速模式' : '思考模式'} · 耗时：${record.latencyMs || '-'}ms</div>
        <div class="citation-title">资料依据</div>
        ${renderCitationSection(record)}
      </div>
    </article>
  `);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function clearChatForNewContext() {
  chatMessagesEl.innerHTML = '<div class="chat-placeholder">已切换到新的知识库 / 文档范围。直接输入问题开始新对话。</div>';
}

function switchTab(tabName) {
  if (tabName === 'logs' && currentUser?.role !== 'admin') tabName = 'home';
  if (tabName === 'admin-users' && currentUser?.role !== 'admin') tabName = 'home';
  if (tabName === 'groups' && !isEnterpriseAccount()) tabName = 'home';
  tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabName));
  pages.forEach(page => page.classList.toggle('active', page.dataset.page === tabName));
}

function isEnterpriseAccount() {
  return currentUser?.role === 'admin' || currentUser?.userType === 'enterprise';
}

async function pickFolder(title) {
  const data = await requestJson('/api/select-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  });
  return data.folderPath;
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    binary += String.fromCharCode(...bytes.subarray(i, i + size));
  }
  return btoa(binary);
}

async function checkHealth() {
  try {
    await requestJson('/api/health');
    statusEl.textContent = '后端已连接';
  } catch (error) {
    statusEl.textContent = '后端连接失败';
  }
}



