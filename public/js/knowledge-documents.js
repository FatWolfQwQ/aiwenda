// MODULE: Knowledge Bases And Documents
// Owns knowledge-base CRUD UI, document upload/list/open/delete UI, and related event handlers.

function renderKnowledgeBaseOptions() {
  knowledgeBases = toArray(knowledgeBases);
  const uploadableKnowledgeBases = knowledgeBases.filter(item => item.isOwner);
  const options = uploadableKnowledgeBases.map(item => `
    <option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>
  `).join('');
  knowledgeBaseSelect.innerHTML = options;
  knowledgeBaseSelect.disabled = !uploadableKnowledgeBases.length;

  if (uploadableKnowledgeBases.some(item => item.id === selectedKnowledgeBaseId)) {
    knowledgeBaseSelect.value = selectedKnowledgeBaseId;
  } else if (uploadableKnowledgeBases[0]) {
    knowledgeBaseSelect.value = uploadableKnowledgeBases[0].id;
  } else if (knowledgeBases[0] && !selectedKnowledgeBaseId) {
    selectedKnowledgeBaseId = knowledgeBases[0].id;
  }
  if (!knowledgeBases.some(item => item.id === chatSelectedKnowledgeBaseId)) {
    chatSelectedKnowledgeBaseId = '';
    chatSelectedDocumentIds = [];
    chatScopeMode = 'knowledgeBase';
    chatConfigured = false;
  }
  renderChatKnowledgeBases();
}

function renderKnowledgeBases() {
  if (!knowledgeBases.length) {
    kbListEl.innerHTML = '<div class="empty">暂无知识库</div>';
    knowledgeBaseSelect.innerHTML = '';
    return;
  }

  kbListEl.innerHTML = knowledgeBases.map(item => `
    <article class="kb-card selectable ${item.id === selectedKnowledgeBaseId ? 'active' : ''}" data-kb-id="${escapeHtml(item.id)}">
      <div class="row">
        <div>
          <h3>${escapeHtml(item.name)}</h3>
          <p>${escapeHtml(item.description || '暂无描述')}</p>
          <div class="kb-share-badge ${toArray(item.sharedGroups).length ? 'shared' : 'private'}">
            ${item.isOwner
              ? (toArray(item.sharedGroups).length ? `已共享到：${escapeHtml(toArray(item.sharedGroups).map(group => group.name).join('、'))}` : '私有知识库：未共享')
              : `用户组共享：${escapeHtml(toArray(item.sharedGroups).map(group => group.name).join('、') || '已加入用户组')}`}
          </div>
          <div class="meta">文档数量：${item.documentCount} · 更新时间：${formatTime(item.updatedAt)}</div>
          <div class="path-line">知识库文件夹：${escapeHtml(item.folderPath || '未设置')}</div>
          ${typeof renderKnowledgeBaseShareControls === 'function' ? renderKnowledgeBaseShareControls(item) : ''}
        </div>
        <div class="action-stack">
          ${isServerMode() ? `<button type="button" class="ghost small-btn" data-manage-kb="${escapeHtml(item.id)}">管理文档</button>` : `<button type="button" class="ghost small-btn" data-open-kb="${escapeHtml(item.id)}">打开知识库所在位置</button>`}
          ${item.isOwner ? `<button type="button" class="danger small-btn" data-delete-kb="${escapeHtml(item.id)}">删除知识库</button>` : ''}
        </div>
      </div>
    </article>
  `).join('');
}

async function loadKnowledgeBases(showOverlay = false) {
  if (showOverlay) return withBusy('正在刷新知识库，请稍等...', () => loadKnowledgeBases(false));
  kbListEl.innerHTML = '<div class="empty">加载中...</div>';
  const data = await requestJson('/api/knowledge-bases');
  knowledgeBases = toArray(data.items);

  if (!knowledgeBases.some(item => item.id === selectedKnowledgeBaseId)) {
    selectedKnowledgeBaseId = knowledgeBases[0]?.id || '';
  }

  renderKnowledgeBaseOptions();
  renderKnowledgeBases();
  updatePathControls();
  await loadDocuments();
  if (!chatConfigured && knowledgeBases.length) openChatSetup('kb');
}

async function loadDocuments(showOverlay = false) {
  if (showOverlay) return withBusy('正在刷新文档列表，请稍等...', () => loadDocuments(false));
  if (!selectedKnowledgeBaseId) {
    docTitleEl.textContent = '请选择一个知识库';
    docListEl.innerHTML = '<div class="empty">暂无文档</div>';
    return;
  }

  const kb = selectedKnowledgeBase();
  docTitleEl.textContent = `当前知识库：${kb?.name || selectedKnowledgeBaseId}`;
  docListEl.innerHTML = '<div class="empty">加载中...</div>';

  try {
    const data = await requestJson(`/api/documents?knowledgeBaseId=${encodeURIComponent(selectedKnowledgeBaseId)}`);
    currentDocuments = toArray(data.items);
    renderChatDocumentOptions(currentDocuments);
    if (!currentDocuments.length) {
      docListEl.innerHTML = '<div class="empty">这个知识库还没有上传文档</div>';
      return;
    }

    docListEl.innerHTML = currentDocuments.map(doc => `
      <article class="kb-card doc-card">
        <div class="row">
          <div>
            <h3>${escapeHtml(doc.filename)}</h3>
            <p>状态：${escapeHtml(doc.status)} · 切片：${doc.chunkCount || 0} · 类型：${escapeHtml(doc.fileType)} · 大小：${formatSize(doc.fileSize)}</p>
            <div class="meta">上传时间：${formatTime(doc.createdAt)}</div>
            <div class="path-line">保存路径：${escapeHtml(doc.filePath)}</div>
          </div>
          <div class="action-stack">
            ${isServerMode() ? `<button class="ghost small-btn" data-download-doc="${escapeHtml(doc.id)}">下载文档</button>` : `<button class="ghost small-btn" data-open-doc="${escapeHtml(doc.id)}">打开所在位置</button>`}
            ${selectedKnowledgeBase()?.isOwner ? `<button class="danger small-btn" data-delete-doc="${escapeHtml(doc.id)}">删除文档</button>` : ''}
          </div>
        </div>
      </article>
    `).join('');
    if (currentDocuments.some(doc => doc.status === 'processing')) {
      setTimeout(() => loadDocuments(false), 3000);
    }
  } catch (error) {
    docListEl.innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = '创建中...';

  try {
    await withBusy('正在创建知识库，请稍等...', () => requestJson('/api/knowledge-bases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name.value,
        description: form.description.value,
        useDefaultPath: form.useDefaultPath.checked,
        customPath: form.customPath.value
      })
    }));
    form.reset();
    updatePathControls();
    await loadKnowledgeBases(true);
    switchTab('knowledge');
  } catch (error) {
    alert(error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '创建知识库';
  }
});

uploadForm.addEventListener('submit', async event => {
  event.preventDefault();
  const file = uploadForm.documentFile.files[0];
  if (!file) return alert('请选择文档');
  if (!uploadForm.knowledgeBaseId.value) return alert('没有可上传的知识库。只能上传到你自己创建的知识库，请先创建一个个人知识库。');

  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
  const supportedExts = ['.md', '.txt', '.log', '.csv', '.json', '.html', '.htm', '.xml', '.rtf', '.docx', '.pptx', '.xlsx', '.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'];
  if (!supportedExts.includes(ext)) {
    alert('不支持该文档类型。当前支持 md、txt、log、csv、json、html、xml、rtf、docx、pptx、xlsx、pdf、png、jpg、jpeg、bmp、tif、tiff');
    return;
  }

  const submitBtn = uploadForm.querySelector('button');
  submitBtn.disabled = true;
  submitBtn.textContent = '上传中...';

  try {
    const contentBase64 = await fileToBase64(file);
    await withBusy('正在上传文档，上传成功后会在后台自动解析...', () => requestJson('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        knowledgeBaseId: uploadForm.knowledgeBaseId.value,
        filename: file.name,
        contentBase64
      })
    }));
    selectedKnowledgeBaseId = uploadForm.knowledgeBaseId.value;
    uploadForm.reset();
    await loadKnowledgeBases(true);
    switchTab('documents');
  } catch (error) {
    alert(error.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '上传到知识库';
  }
});

knowledgeBaseSelect.addEventListener('change', async event => {
  selectedKnowledgeBaseId = event.target.value;
  renderKnowledgeBases();
  await loadDocuments(true);
});

kbListEl.addEventListener('click', async event => {
  const manageButton = event.target.closest('[data-manage-kb]');
  if (manageButton) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    selectedKnowledgeBaseId = manageButton.dataset.manageKb;
    renderKnowledgeBaseOptions();
    renderKnowledgeBases();
    await loadDocuments(true);
    switchTab('documents');
    return;
  }

  const openButton = event.target.closest('[data-open-kb]');
  if (openButton) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    try {
      await withBusy('正在打开知识库所在位置，请稍等...', () => requestJson(`/api/knowledge-bases/${encodeURIComponent(openButton.dataset.openKb)}/open-folder`, { method: 'POST' }), 1800);
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  const deleteButton = event.target.closest('[data-delete-kb]');
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (!confirmTwice('确定删除这个知识库吗？该知识库下的文档也会一起删除。', '请再次确认：删除知识库后不可从网站恢复。')) return;

    deleteButton.disabled = true;
    deleteButton.textContent = '删除中...';

    try {
      await withBusy('正在删除知识库，请稍等...', () => requestJson(`/api/knowledge-bases/${encodeURIComponent(deleteButton.dataset.deleteKb)}`, { method: 'DELETE' }));
      if (selectedKnowledgeBaseId === deleteButton.dataset.deleteKb) {
        selectedKnowledgeBaseId = '';
      }
      await loadKnowledgeBases(true);
  } catch (error) {
      alert(error.message);
      deleteButton.disabled = false;
      deleteButton.textContent = '删除知识库';
    }
    return;
  }


  const shareButton = event.target.closest('[data-save-kb-share]');
  if (shareButton) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const kbId = shareButton.dataset.saveKbShare;
    const selector = '[data-share-options="' + CSS.escape(kbId) + '"] input:checked';
    const groupIds = [...document.querySelectorAll(selector)].map(input => input.value);
    try {
      await withBusy('\u6b63\u5728\u4fdd\u5b58\u5171\u4eab\u8bbe\u7f6e\uff0c\u8bf7\u7a0d\u7b49...', () => requestJson('/api/knowledge-bases/' + encodeURIComponent(kbId) + '/sharing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupIds })
      }));
      await loadKnowledgeBases(true);
      if (typeof loadGroups === 'function') await loadGroups(false);
      alert(groupIds.length ? `\u5171\u4eab\u8bbe\u7f6e\u5df2\u4fdd\u5b58\uff0c\u5df2\u5171\u4eab\u5230 ${groupIds.length} \u4e2a\u7528\u6237\u7ec4\u3002` : '\u5171\u4eab\u8bbe\u7f6e\u5df2\u4fdd\u5b58\uff0c\u8be5\u77e5\u8bc6\u5e93\u73b0\u5728\u4e3a\u79c1\u6709\u3002');
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  if (event.target.closest('.share-box')) {
    event.stopPropagation();
    event.stopImmediatePropagation();
    return;
  }

  const card = event.target.closest('[data-kb-id]');
  if (!card) return;
  selectedKnowledgeBaseId = card.dataset.kbId;
  renderKnowledgeBaseOptions();
  renderKnowledgeBases();
  await loadDocuments(true);
});

docListEl.addEventListener('click', async event => {
  const downloadButton = event.target.closest('[data-download-doc]');
  if (downloadButton) {
    openDownload(`/api/documents/${encodeURIComponent(downloadButton.dataset.downloadDoc)}/download`);
    return;
  }

  const openButton = event.target.closest('[data-open-doc]');
  if (openButton) {
    try {
      await withBusy('正在打开文档所在位置，请稍等...', () => requestJson(`/api/documents/${encodeURIComponent(openButton.dataset.openDoc)}/open-location`, { method: 'POST' }));
  } catch (error) {
      alert(error.message);
    }
    return;
  }

  const button = event.target.closest('[data-delete-doc]');
  if (!button) return;
  if (!confirmTwice('确定删除这个文档吗？', '请再次确认：删除文档后不可从网站恢复。')) return;

  button.disabled = true;
  button.textContent = '删除中...';

  try {
    await withBusy('正在删除文档，请稍等...', () => requestJson(`/api/documents/${encodeURIComponent(button.dataset.deleteDoc)}`, { method: 'DELETE' }));
    await loadKnowledgeBases(true);
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = '删除文档';
  }
});
