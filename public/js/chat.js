// MODULE: AI Chat
// Owns chat submission, setup modal, document scope selection, citations, and chat history.

function renderCitationSection(data) {
  if (data.citationDecision === 'ai-summary') {
    return '<div class="citation-note">AI 分析后认为这个问题更适合直接总结，不需要展开资料依据。</div>';
  }
  if (data.citationDecision === 'none-high-relevance') {
    return '<div class="citation-note">AI 判断后没有找到需要展示的高相关资料依据。</div>';
  }
  return `<div class="citation-list">${renderCitationCards(data.citations, data.showRelevance)}</div>`;
}

function renderCitationCards(citations, showRelevance) {
  citations = toArray(citations);
  return citations.map(item => `
    <article class="citation-card">
      <div class="citation-head">
        <strong>${escapeHtml(item.filename)} · 资料依据${showRelevance ? ` · 相关度 ${Math.round(item.score * 100)}%` : ''}</strong>
      </div>
      <p>${escapeHtml(item.keyText || item.content)}</p>
      ${item.sourceKind && item.sourceKind !== 'text' ? `<div class="meta">识别方式：从 ${escapeHtml(item.sourceKind)} 文档中自动识别并${item.textPolished ? '由 AI 清洗' : '提取'}关键文字</div>` : ''}
      ${item.reason ? `<div class="meta">采用原因：${escapeHtml(item.reason)}</div>` : ''}
    </article>
  `).join('');
}
async function requestChatStream(payload, loadingId) {
  const response = await fetch('/api/chat-stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(currentUser?.id ? { 'X-User-Id': currentUser.id } : {})
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || '问答请求失败');
  }
  const loadingEl = document.querySelector(`#${loadingId}`);
  if (loadingEl) {
    loadingEl.outerHTML = `<article class="message assistant" id="${loadingId}"><div class="bubble"><div class="answer-text"></div></div></article>`;
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let answer = '';
  let finalData = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const packets = buffer.split('\n\n');
    buffer = packets.pop() || '';
    for (const packet of packets) {
      const event = (packet.match(/^event:\s*(.+)$/m) || [])[1];
      const dataLine = (packet.match(/^data:\s*(.+)$/m) || [])[1];
      if (!event || !dataLine) continue;
      const data = JSON.parse(dataLine);
      if (event === 'delta') {
        answer += data.text || '';
        const answerEl = document.querySelector(`#${loadingId} .answer-text`);
        if (answerEl) answerEl.innerHTML = renderMarkdownLite(answer);
        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
      }
      if (event === 'final') finalData = data;
    }
  }
  return finalData || { answer, citations: [], citationDecision: 'ai-summary', answerMode: payload.answerMode, latencyMs: 0 };
}
chatForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!chatConfigured || !chatSelectedKnowledgeBaseId) {
    openChatSetup('kb');
    return;
  }
  if (chatScopeMode === 'documents' && !chatSelectedDocumentIds.length) {
    alert('请选择至少一个文档');
    return;
  }
  const question = normalizeQuestionInput(chatForm.question.value);
  if (!question) return;
  chatForm.question.value = '';
  const submitBtn = chatForm.querySelector('button');
  submitBtn.disabled = true;
  submitBtn.textContent = '回答中...';

  if (chatMessagesEl.querySelector('.chat-placeholder')) chatMessagesEl.innerHTML = '';
  chatMessagesEl.insertAdjacentHTML('beforeend', `<article class="message user"><div class="bubble">${escapeHtml(question)}</div></article>`);
  const loadingId = `loading_${Date.now()}`;
  chatMessagesEl.insertAdjacentHTML('beforeend', `
    <article class="message assistant ai-loading-message" id="${loadingId}">
      <div class="ai-loading-card">
        <div class="ai-loading-wolf">${pixelWolfSvg()}</div>
        <div class="ai-loading-text">
          <strong>${avatarName(userAvatar('aiAvatarId'))}正在检索知识库</strong>
          <p>${answerMode === 'fast' ? '快速模式会尽量在 10 秒内回复...' : '思考模式会多读取一些代表片段，请稍等...'}</p>
        </div>
      </div>
    </article>
  `);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  try {
    const data = await requestJson('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        knowledgeBaseId: chatSelectedKnowledgeBaseId,
        question,
        answerMode,
        documentIds: chatScopeMode === 'documents' ? chatSelectedDocumentIds : []
      })
    });

    const loadingEl = document.querySelector(`#${loadingId}`);
    if (loadingEl) {
      loadingEl.outerHTML = `
        <article class="message assistant">
          <div class="bubble">
            <div class="answer-text">${renderMarkdownLite(data.answer)}</div>
            ${data.answerMode === 'fast' ? '<div class="citation-note">快速模式提示：当前回答只读取最相关的少量片段，并跳过二次资料依据分析，速度更快，但完整性和引用精细度会低于思考模式。</div>' : ''}
            <div class="meta">模式：${data.answerMode === 'fast' ? '快速模式' : '思考模式'} · 耗时：${data.latencyMs}ms</div>
            <div class="citation-title">资料依据</div>
            ${renderCitationSection(data)}
          </div>
        </article>
      `;
    }
    showReplySparkle();
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  } catch (error) {
    const loadingEl = document.querySelector(`#${loadingId}`);
    if (loadingEl) {
      loadingEl.outerHTML = `
        <article class="message assistant">
          <div class="bubble error">问答失败：${escapeHtml(error.message)}</div>
        </article>
      `;
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '发送';
  }
});

knowledgeBaseSelect.addEventListener('change', async event => {
  selectedKnowledgeBaseId = event.target.value;
  renderKnowledgeBases();
  await loadDocuments(true);
});

chatKbCards.addEventListener('click', async event => {
  const card = event.target.closest('[data-chat-kb-id]');
  if (!card) return;
  chatSelectedKnowledgeBaseId = card.dataset.chatKbId;
  chatSelectedDocumentIds = [];
  chatScopeMode = 'knowledgeBase';
  renderChatKnowledgeBases();
  updateChatScopeCards();
  await withBusy('正在加载该知识库的文档，请稍等...', prepareChatDocuments);
  setChatStep('docs');
});

openChatSetupBtn.addEventListener('click', () => {
  openChatSetup(chatSelectedKnowledgeBaseId ? 'docs' : 'kb');
});

document.querySelectorAll('[data-chat-scope]').forEach(button => {
  button.addEventListener('click', () => {
    chatScopeMode = button.dataset.chatScope;
    updateChatScopeCards();
  });
});

answerModeSelect.addEventListener('change', () => {
  answerMode = answerModeSelect.value === 'fast' ? 'fast' : 'thinking';
  answerModeHint.textContent = answerMode === 'fast'
    ? '快速模式目标 10 秒内回复：只读取少量高相关片段，跳过二次引用分析，可能不如思考模式完整。'
    : '思考模式会读取更多片段并分析资料依据，回答更完整，但耗时更长。';
  if (chatConfigured) updateChatSessionMeta();
});

chatDocumentSelect.addEventListener('change', () => {
  chatSelectedDocumentIds = Array.from(chatDocumentSelect.querySelectorAll('input:checked')).map(input => input.value);
  renderChatDocumentOptions(currentDocuments);
});

backToChatKb.addEventListener('click', () => setChatStep('kb'));

enterChatBtn.addEventListener('click', () => {
  if (chatScopeMode === 'documents' && !chatSelectedDocumentIds.length) {
    alert('请选择至少一个文档');
    return;
  }
  const hadActiveChat = chatConfigured && !chatMessagesEl.querySelector('.chat-placeholder');
  chatConfigured = true;
  updateChatSessionMeta();
  if (hadActiveChat) {
    clearChatForNewContext();
    notifyChatContextChanged();
  } else if (chatMessagesEl.querySelector('.chat-placeholder')) {
    chatMessagesEl.innerHTML = '<div class="chat-placeholder">已连接知识库。直接输入问题开始对话。</div>';
  }
  closeChatSetup();
});

chatForm.question.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

async function openChatHistory() {
  chatHistoryModal.classList.remove('hidden');
  chatHistoryList.innerHTML = '<div class="empty">正在加载聊天记录...</div>';
  try {
    const data = await requestJson('/api/chat-history');
    const items = toArray(data.items);
    chatHistoryList.innerHTML = items.length ? items.map(item => `
      <article class="chat-history-card" data-chat-history-id="${escapeHtml(item.id)}">
        <div class="chat-history-head">
          <strong>${escapeHtml(item.question)}</strong>
          <button type="button" class="danger small-btn" data-delete-chat-history="${escapeHtml(item.id)}">删除</button>
        </div>
        <span>${escapeHtml(item.knowledgeBaseName)} · ${formatTime(item.createdAt)}</span>
        <p>${escapeHtml(String(item.answer || '').slice(0, 90))}${String(item.answer || '').length > 90 ? '...' : ''}</p>
      </article>
    `).join('') : '<div class="empty">暂无聊天记录</div>';
  } catch (error) {
    chatHistoryList.innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
  }
}

openChatHistoryBtn.addEventListener('click', openChatHistory);
closeChatHistoryBtn.addEventListener('click', () => chatHistoryModal.classList.add('hidden'));

chatHistoryList.addEventListener('click', async event => {
  const deleteButton = event.target.closest('[data-delete-chat-history]');
  if (deleteButton) {
    event.stopPropagation();
    if (!await confirmTwice('确定删除这条聊天记录吗？', '请再次确认：删除后这条聊天记录将无法在页面中恢复。')) return;
    try {
      await withBusy('正在删除聊天记录，请稍等...', async () => {
        await requestJson(`/api/chat-history/${encodeURIComponent(deleteButton.dataset.deleteChatHistory)}`, { method: 'DELETE' });
        await openChatHistory();
      });
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  const card = event.target.closest('[data-chat-history-id]');
  if (!card) return;
  if (!await confirmTwice('确定回溯到这条聊天记录吗？', '请再次确认：当前对话界面会切换到该记录当时的知识库和文档范围。')) return;
  try {
    const record = await withBusy('正在恢复聊天记录，请稍等...', () => requestJson(`/api/chat-history/${encodeURIComponent(card.dataset.chatHistoryId)}`));
    chatSelectedKnowledgeBaseId = record.knowledgeBaseId;
    chatSelectedDocumentIds = record.documentIds || [];
    chatScopeMode = chatSelectedDocumentIds.length ? 'documents' : 'knowledgeBase';
    answerMode = record.answerMode === 'fast' ? 'fast' : 'thinking';
    answerModeSelect.value = answerMode;
    answerModeHint.textContent = answerMode === 'fast'
      ? '快速模式目标 10 秒内回复：只读取少量高相关片段，跳过二次引用分析，可能不如思考模式完整。'
      : '思考模式会读取更多片段并分析资料依据，回答更完整，但耗时更长。';
    chatConfigured = true;
    await prepareChatDocuments();
    updateChatScopeCards();
    updateChatSessionMeta();
    renderChatKnowledgeBases();
    renderChatExchange(record);
    chatHistoryModal.classList.add('hidden');
  } catch (error) {
    alert(error.message);
  }
});






