// MODULE: Logs
// Owns admin log listing, log details, log deletion, export, and open exported log location.

async function loadLogs(showOverlay = false) {
  if (showOverlay) return withBusy('正在刷新日志，请稍等...', () => loadLogs(false));
  logListEl.innerHTML = '<div class="empty">加载中...</div>';
  logDetailEl.className = 'log-detail empty';
  logDetailEl.textContent = '请选择一条日志';
  try {
    const data = await requestJson('/api/logs');
    if (!data.items.length) {
      logListEl.innerHTML = '<div class="empty">暂无问答日志</div>';
      return;
    }
    const groups = new Map();
    for (const item of data.items) {
      const bucket = item.bucket || { date: '未知日期', timeLevel: '未分级' };
      const key = `${bucket.date}｜${bucket.timeLevel}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    logListEl.innerHTML = Array.from(groups.entries()).map(([groupName, items]) => `
      <section class="log-group">
        <h3>${escapeHtml(groupName)}</h3>
        ${items.map(item => `
          <article class="kb-card selectable log-card" data-log-id="${escapeHtml(item.id)}">
            <div class="row log-row">
              <label class="log-check"><input type="checkbox" data-log-check="${escapeHtml(item.id)}" /> 选择</label>
              <div class="log-card-main">
                <h3>${escapeHtml(item.title || item.question)}</h3>
                <p>${escapeHtml(item.knowledgeBaseName || '未知知识库')}</p>
                <div class="meta">耗时：${item.latencyMs}ms · ${formatTime(item.createdAt)} · ${item.exported ? '已导出' : '未导出'}</div>
              </div>
              <div class="log-card-actions">
                <button class="danger small-btn" data-delete-log="${escapeHtml(item.id)}">删除记录</button>
                <button class="ghost small-btn" data-open-log="${escapeHtml(item.id)}" ${item.exported ? '' : 'disabled'}>打开位置</button>
              </div>
            </div>
          </article>
        `).join('')}
      </section>
    `).join('');
  } catch (error) {
    logListEl.innerHTML = `<div class="empty">日志加载失败：${escapeHtml(error.message)}</div>`;
  }
}

async function loadLogDetail(logId, showOverlay = false) {
  if (showOverlay) return withBusy('正在打开日志详情，请稍等...', () => loadLogDetail(logId, false));
  if (logDetailEl.dataset.currentLogId === logId && !logDetailEl.classList.contains('empty')) {
    logDetailEl.dataset.currentLogId = '';
    logDetailEl.className = 'log-detail empty';
    logDetailEl.textContent = '请选择一条日志';
    return;
  }
  logDetailEl.className = 'log-detail empty';
  logDetailEl.textContent = '加载日志详情...';
  try {
    const log = await requestJson(`/api/logs/${encodeURIComponent(logId)}`);
    logDetailEl.dataset.currentLogId = logId;
    logDetailEl.className = 'log-detail';
    logDetailEl.innerHTML = `
      <h3>接收内容</h3>
      <pre>${escapeHtml(JSON.stringify(log.messages, null, 2))}</pre>
      <h3>检索片段</h3>
      <pre>${escapeHtml(JSON.stringify(log.retrievedChunks, null, 2))}</pre>
      <h3>思考内容</h3>
      <pre>${escapeHtml(log.reasoning || '无')}</pre>
      <h3>回答内容</h3>
      <pre>${escapeHtml(log.answer)}</pre>
    `;
  } catch (error) {
    logDetailEl.className = 'log-detail empty';
    logDetailEl.textContent = `日志详情加载失败：${error.message}`;
  }
}

logListEl.addEventListener('click', async event => {
  if (event.target.closest('[data-log-check]')) {
    event.stopPropagation();
    return;
  }

  const openButton = event.target.closest('[data-open-log]');
  if (openButton) {
    event.stopPropagation();
    withBusy('正在打开日志所在位置，请稍等...', () => requestJson(`/api/logs/${encodeURIComponent(openButton.dataset.openLog)}/open-location`, { method: 'POST' }))
      .catch(error => alert(error.message));
    return;
  }

  const deleteButton = event.target.closest('[data-delete-log]');
  if (deleteButton) {
    event.stopPropagation();
    if (!confirmTwice('确定删除这条日志记录吗？这只会删除系统里的记录，不会删除已经导出的日志文件。', '请再次确认：删除后这条日志记录将从日志列表中消失。')) return;
    try {
      await withBusy('正在删除日志，请稍等...', async () => {
        await requestJson(`/api/logs/${encodeURIComponent(deleteButton.dataset.deleteLog)}`, { method: 'DELETE' });
        if (logDetailEl.dataset.currentLogId === deleteButton.dataset.deleteLog) {
          logDetailEl.dataset.currentLogId = '';
          logDetailEl.className = 'log-detail empty';
          logDetailEl.textContent = '请选择一条日志';
        }
        await loadLogs(false);
      });
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const card = event.target.closest('[data-log-id]');
  if (!card) return;
  loadLogDetail(card.dataset.logId, true);
});

async function exportLogs(ids = []) {
  if (!useDefaultLogPath.checked && !customLogPath.value) {
    alert('请选择日志导出文件夹，或勾选使用默认导出路径。');
    return;
  }
  const result = await withBusy('正在导出日志，请稍等...', () => requestJson('/api/logs/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ids,
      useDefaultPath: useDefaultLogPath.checked,
      customPath: customLogPath.value
    })
  }));
  alert(`已导出 ${result.count} 条日志`);
  await loadLogs(true);
}

useDefaultLogPath.addEventListener('change', () => {
  customLogPathWrap.classList.toggle('hidden', useDefaultLogPath.checked);
});

pickLogPath.addEventListener('click', async () => {
  try {
    const folderPath = await withBusy('正在打开系统文件夹选择窗口，请稍等...', () => pickFolder('请选择日志导出文件夹'));
    if (folderPath) customLogPath.value = folderPath;
  } catch (error) {
    alert(error.message);
  }
});

exportAllLogsBtn.addEventListener('click', () => {
  exportLogs().catch(error => alert(error.message));
});

exportSelectedLogsBtn.addEventListener('click', () => {
  const ids = Array.from(document.querySelectorAll('[data-log-check]:checked')).map(item => item.dataset.logCheck);
  if (!ids.length) {
    alert('请先选择要导出的日志');
    return;
  }
  exportLogs(ids).catch(error => alert(error.message));
});

