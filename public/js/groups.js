// MODULE: User Groups
// Owns group search, join requests, member review, and knowledge-base sharing UI.

async function loadGroups(showOverlay = false) {
  if (!currentUser || !isEnterpriseAccount()) {
    userGroups = [];
    renderMyGroups();
    renderKnowledgeBases();
    return;
  }
  const task = async () => {
    const data = await requestJson('/api/groups');
    userGroups = toArray(data.items);
    renderMyGroups();
    renderKnowledgeBases();
  };
  if (showOverlay) return withBusy('正在刷新用户组，请稍等...', task);
  return task();
}

function groupRoleName(role) {
  return { owner: '组长', admin: '管理员', member: '成员', viewer: '只读成员' }[role] || '未加入';
}

function canManageSelectedGroup(group) {
  return !!group?.canReviewRequests;
}

function canDeleteSelectedGroup(group) {
  return !!group?.canDeleteGroup;
}

function canChangeGroupRoles(group) {
  return !!group?.canChangeMemberRoles;
}

function canRemoveGroupMember(group, member) {
  if (!member || member.role === 'owner') return false;
  if (group?.canChangeMemberRoles) return true;
  return !!group?.canRemoveBasicMembers && ['member', 'viewer'].includes(member.role);
}

function switchGroupPage(page) {
  groupTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.groupTab === page));
  groupPages.forEach(item => item.classList.toggle('active', item.dataset.groupPage === page));
}

function renderMyGroups() {
  if (!myGroupsList) return;
  userGroups = toArray(userGroups);
  if (!userGroups.length) {
    myGroupsList.innerHTML = '<div class="empty">暂无加入的用户组</div>';
    return;
  }
  myGroupsList.innerHTML = userGroups.map(group => `
    <article class="mini-card ${group.id === selectedGroupId ? 'active' : ''}" data-group-id="${escapeHtml(group.id)}">
      <strong>${escapeHtml(group.name)}</strong>
      <span>${escapeHtml(group.description || '暂无简介')}</span>
      <em>${group.memberCount || 0} 人 · 我的角色：${groupRoleName(group.myRole)} · ${group.searchable === false ? '不可搜索' : '可搜索'}</em>
    </article>
  `).join('');
}

function renderGroupSearchResults(items) {
  if (!groupSearchList) return;
  items = toArray(items);
  if (!items.length) {
    groupSearchList.innerHTML = '<div class="empty">没有搜索到用户组</div>';
    return;
  }
  groupSearchList.innerHTML = items.map(group => `
    <article class="mini-card">
      <strong>${escapeHtml(group.name)}</strong>
      <span>${escapeHtml(group.description || '暂无简介')}</span>
      <em>${group.memberCount || 0} 人 · ${group.joinStatus === 'joined' ? '已加入' : group.joinStatus === 'pending' ? '审核中' : '可申请'}</em>
      ${group.joinStatus ? '' : `<button type="button" class="ghost small-btn" data-join-group="${escapeHtml(group.id)}">申请加入</button>`}
    </article>
  `).join('');
}

async function renderGroupDetail(groupId) {
  selectedGroupId = groupId;
  renderMyGroups();
  const group = userGroups.find(item => item.id === groupId);
  if (!group) {
    groupDetailPanel.innerHTML = '<div class="empty">请选择一个用户组</div>';
    return;
  }

  const [membersData, requestsData, knowledgeBaseData] = await Promise.all([
    requestJson(`/api/groups/${encodeURIComponent(groupId)}/members`),
    canManageSelectedGroup(group)
      ? requestJson(`/api/groups/${encodeURIComponent(groupId)}/join-requests`)
      : Promise.resolve({ items: [] }),
    requestJson(`/api/groups/${encodeURIComponent(groupId)}/knowledge-bases`)
  ]);

  const members = toArray(membersData.items);
  const requests = toArray(requestsData.items);
  const groupKnowledgeBases = toArray(knowledgeBaseData.items);

  groupDetailPanel.innerHTML = `
    <div class="group-detail-head">
      <h3>${escapeHtml(group.name)}</h3>
      <p>${escapeHtml(group.description || '暂无简介')}</p>
      <div class="meta">我的角色：${groupRoleName(group.myRole)} · ${group.searchable === false ? '不可搜索' : '可搜索'}</div>
      ${canManageSelectedGroup(group) ? `
        <label class="check-row group-searchable-toggle">
          <input type="checkbox" data-group-searchable="${escapeHtml(group.id)}" ${group.searchable === false ? '' : 'checked'} />
          允许这个用户组被搜索到
        </label>
      ` : ''}
      ${(canDeleteSelectedGroup(group)) ? `<button type="button" class="danger small-btn" data-delete-group="${escapeHtml(group.id)}">删除用户组</button>` : ''}
    </div>
    <h4>组内共享知识库</h4>
    ${groupKnowledgeBases.length ? groupKnowledgeBases.map(kb => `
      <article class="mini-card">
        <strong>${escapeHtml(kb.name)}</strong>
        <span>${escapeHtml(kb.description || '暂无描述')}</span>
        <em>${kb.documentCount || 0} 个文档 · ${kb.isOwner ? '我创建的知识库' : '组内共享知识库'}</em>
      </article>
    `).join('') : '<div class="empty">这个用户组还没有共享知识库</div>'}
    <h4>成员</h4>
    ${members.map(member => `
      <article class="mini-card">
        <strong>${escapeHtml(member.username)}</strong>
        <span>${groupRoleName(member.role)}</span>
        ${(canChangeGroupRoles(group) || canRemoveGroupMember(group, member)) && member.role !== 'owner' ? `
          <div class="inline-actions">
            ${canChangeGroupRoles(group) ? `<button type="button" class="ghost small-btn" data-role-user="${escapeHtml(member.userId)}" data-role="member">设为成员</button>` : ''}
            ${canChangeGroupRoles(group) ? `<button type="button" class="ghost small-btn" data-role-user="${escapeHtml(member.userId)}" data-role="admin">设为管理员</button>` : ''}
            ${canRemoveGroupMember(group, member) ? `<button type="button" class="danger small-btn" data-remove-user="${escapeHtml(member.userId)}">移出</button>` : ''}
          </div>
        ` : ''}
      </article>
    `).join('')}
    <h4>入组申请</h4>
    ${requests.length ? requests.map(req => `
      <article class="mini-card">
        <strong>${escapeHtml(req.username)}</strong>
        <span>${escapeHtml(req.message || '无申请备注')}</span>
        <div class="inline-actions">
          <button type="button" class="ghost small-btn" data-review-request="${escapeHtml(req.id)}" data-action="approve">通过</button>
          <button type="button" class="danger small-btn" data-review-request="${escapeHtml(req.id)}" data-action="reject">拒绝</button>
        </div>
      </article>
    `).join('') : '<div class="empty">暂无待审核申请</div>'}
  `;
}

function renderKnowledgeBaseShareControls(kb) {
  if (!kb.isOwner || !isEnterpriseAccount()) return '';
  userGroups = toArray(userGroups);
  const sharedGroups = toArray(kb.sharedGroups);
  const statusText = sharedGroups.length
    ? `已共享到：${sharedGroups.map(group => group.name).join('、')}`
    : '未共享到任何用户组';
  const options = userGroups.map(group => `
    <label class="check-row">
      <input type="checkbox" value="${escapeHtml(group.id)}" ${(kb.sharedGroupIds || []).includes(group.id) ? 'checked' : ''} />
      ${escapeHtml(group.name)}
    </label>
  `).join('');
  return `
    <details class="share-box">
      <summary>共享到用户组</summary>
      <div class="share-status ${sharedGroups.length ? 'shared' : 'private'}">${escapeHtml(statusText)}</div>
      <div class="share-options" data-share-options="${escapeHtml(kb.id)}">${options || '<div class="empty">你还没有加入任何用户组</div>'}</div>
      <button type="button" class="ghost small-btn" data-save-kb-share="${escapeHtml(kb.id)}">保存共享设置</button>
    </details>
  `;
}

groupCreateForm?.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await withBusy('正在创建用户组，请稍等...', () => requestJson('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: groupCreateForm.name.value,
        description: groupCreateForm.description.value,
        searchable: groupCreateForm.searchable.checked
      })
    }));
    groupCreateForm.reset();
    groupCreateForm.searchable.checked = true;
    await loadGroups(true);
    alert('用户组创建成功');
  } catch (error) {
    alert(error.message);
  }
});

groupSearchForm?.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const keyword = groupSearchForm.keyword.value.trim();
    const data = await withBusy('正在搜索用户组，请稍等...', () => requestJson(`/api/groups/search?q=${encodeURIComponent(keyword)}`));
    renderGroupSearchResults(data.items);
  } catch (error) {
    alert(error.message);
  }
});

groupSearchList?.addEventListener('click', async event => {
  const button = event.target.closest('[data-join-group]');
  if (!button) return;
  const message = await appPrompt('请输入申请备注，可留空', { title: '申请加入用户组', placeholder: '例如：我是项目成员，需要查看共享资料' }) || '';
  try {
    await withBusy('正在提交入组申请，请稍等...', () => requestJson(`/api/groups/${encodeURIComponent(button.dataset.joinGroup)}/join-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    }));
    alert('申请已提交，等待用户组管理员审核');
    const data = await requestJson(`/api/groups/search?q=${encodeURIComponent(groupSearchForm.keyword.value.trim())}`);
    renderGroupSearchResults(data.items);
  } catch (error) {
    alert(error.message);
  }
});

myGroupsList?.addEventListener('click', event => {
  const card = event.target.closest('[data-group-id]');
  if (!card) return;
  withBusy('正在加载用户组详情，请稍等...', () => renderGroupDetail(card.dataset.groupId))
    .then(() => switchGroupPage('detail'))
    .catch(error => alert(error.message));
});

groupTabs.forEach(tab => {
  tab.addEventListener('click', () => switchGroupPage(tab.dataset.groupTab));
});

groupDetailPanel?.addEventListener('change', async event => {
  const input = event.target.closest('[data-group-searchable]');
  if (!input) return;
  const group = userGroups.find(item => item.id === input.dataset.groupSearchable);
  if (!group) return;
  try {
    const data = await withBusy('正在保存用户组搜索设置，请稍等...', () => requestJson(`/api/groups/${encodeURIComponent(group.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: group.name,
        description: group.description || '',
        searchable: input.checked
      })
    }));
    const index = userGroups.findIndex(item => item.id === group.id);
    if (index !== -1) userGroups[index] = data;
    await renderGroupDetail(group.id);
    alert(input.checked ? '已允许该用户组被搜索到' : '已关闭该用户组搜索');
  } catch (error) {
    input.checked = !input.checked;
    alert(error.message);
  }
});

groupDetailPanel?.addEventListener('click', async event => {
  const reviewButton = event.target.closest('[data-review-request]');
  const roleButton = event.target.closest('[data-role-user]');
  const removeButton = event.target.closest('[data-remove-user]');
  const deleteButton = event.target.closest('[data-delete-group]');
  try {
    if (reviewButton) {
      await withBusy('正在处理入组申请，请稍等...', () => requestJson(`/api/groups/${encodeURIComponent(selectedGroupId)}/join-requests/${encodeURIComponent(reviewButton.dataset.reviewRequest)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: reviewButton.dataset.action })
      }));
      await loadGroups(false);
      await renderGroupDetail(selectedGroupId);
    }
    if (roleButton) {
      await withBusy('正在调整成员权限，请稍等...', () => requestJson(`/api/groups/${encodeURIComponent(selectedGroupId)}/members/${encodeURIComponent(roleButton.dataset.roleUser)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: roleButton.dataset.role })
      }));
      await renderGroupDetail(selectedGroupId);
    }
    if (removeButton) {
      if (!await confirmTwice('确定移出该成员吗？', '请再次确认：移出后该成员将无法访问组内共享知识库。')) return;
      await withBusy('正在移出成员，请稍等...', () => requestJson(`/api/groups/${encodeURIComponent(selectedGroupId)}/members/${encodeURIComponent(removeButton.dataset.removeUser)}`, { method: 'DELETE' }));
      await renderGroupDetail(selectedGroupId);
    }
    if (deleteButton) {
      if (!await confirmTwice('确定删除这个用户组吗？', '请再次确认：用户组删除后，共享关系会同时删除。')) return;
      await withBusy('正在删除用户组，请稍等...', () => requestJson(`/api/groups/${encodeURIComponent(deleteButton.dataset.deleteGroup)}`, { method: 'DELETE' }));
      selectedGroupId = '';
      groupDetailPanel.innerHTML = '<div class="empty">请选择一个用户组</div>';
      await loadGroups(true);
    }
  } catch (error) {
    alert(error.message);
  }
});

