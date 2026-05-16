// ==================== 讲师端控制逻辑 ====================
let sessionCode = null;
let sessionData = {
  session: null,
  groups: [],
  scenes: [],
  participants: []
};

// ==================== 创建场次 ====================
async function createPresetSession() {
  const btn = document.querySelector('#stepCreate .btn-secondary');
  const origText = btn.textContent;
  btn.textContent = '正在创建...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/preset/salon-621', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message || '创建失败');

    sessionCode = data.session.code;
    sessionData.session = { code: sessionCode, id: data.session.id, title: data.session.title, current_scene: 0 };

    socket.emit('instructor:join', sessionCode);

    document.getElementById('stepCreate').style.display = 'none';
    document.getElementById('contentArea').style.display = 'block';
    document.getElementById('codeSection').style.display = 'block';
    document.getElementById('sessionCode').textContent = sessionCode;
    document.getElementById('pageTitle').textContent = '喙语621号店 · 沉浸式沟通沙龙';
    document.getElementById('pageSubtitle').textContent = `场次码: ${sessionCode}`;
    document.getElementById('headerActions').style.display = 'flex';

    toggleStep('stepGroups');
    toast('🎭 预设沙龙创建成功！', 'success');
  } catch (err) {
    toast(err.message || '创建失败', 'error');
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

async function createSession() {
  const title = document.getElementById('sessionTitle').value.trim() || '沟通沙龙';
  const btn = document.querySelector('#stepCreate .btn');
  btn.textContent = '正在创建...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message || '创建失败');

    sessionCode = data.session.code;
    sessionData.session = data.session;

    // 加入 socket 房间
    socket.emit('instructor:join', sessionCode);

    // UI 切换
    document.getElementById('stepCreate').style.display = 'none';
    document.getElementById('contentArea').style.display = 'block';
    document.getElementById('codeSection').style.display = 'block';
    document.getElementById('sessionCode').textContent = sessionCode;
    document.getElementById('pageTitle').textContent = title;
    document.getElementById('pageSubtitle').textContent = `场次码: ${sessionCode}`;
    document.getElementById('headerActions').style.display = 'flex';

    // 默认展开第 1 步
    toggleStep('stepGroups');

    toast('场次创建成功！', 'success');
  } catch (err) {
    toast(err.message || '创建失败', 'error');
  } finally {
    btn.textContent = '创建场次';
    btn.disabled = false;
  }
}

// ==================== 步骤折叠 ====================
function toggleStep(id) {
  const step = document.getElementById(id);
  if (!step) return;
  const isActive = step.classList.contains('active');
  // 关闭所有
  document.querySelectorAll('#stepsList .step').forEach(s => s.classList.remove('active'));
  if (!isActive) {
    step.classList.add('active');
  }
}

// ==================== Socket 事件 ====================
socket.on('instructor:init', (data) => {
  sessionData.groups = data.groups || [];
  sessionData.scenes = data.scenes || [];
  sessionData.participants = data.participants || [];
  renderAll();
});

socket.on('session_updated', (data) => {
  if (data.groups) {
    // 重新获取完整数据
    fetchFullData();
  }
  if (data.roles) {
    // 更新特定组的角色
    const groupId = data.roles.groupId;
    const group = sessionData.groups.find(g => g.id === groupId);
    if (group) group.roles = data.roles.roles;
    renderRoles();
  }
  if (data.scenes) {
    sessionData.scenes = data.scenes;
    renderScenes();
    renderSceneControls();
  }
});

socket.on('participants_updated', (data) => {
  sessionData.participants = data.participants;
  renderParticipants();
  renderSceneControls();
});

socket.on('scene:pushed', (data) => {
  sessionData.session.current_scene = data.currentScene;
  renderSceneControls();
});

socket.on('session:ended', () => {
  toast('场次已结束', 'info');
  document.getElementById('contentArea').style.display = 'none';
  document.getElementById('codeSection').style.display = 'none';
  document.getElementById('pageSubtitle').textContent = '场次已结束';
});

// ==================== 获取完整数据 ====================
async function fetchFullData() {
  if (!sessionCode) return;
  try {
    const res = await fetch(`/api/session/${sessionCode}/full`);
    const data = await res.json();
    if (data.success) {
      sessionData.groups = data.groups || [];
      sessionData.scenes = data.scenes || [];
      sessionData.participants = data.participants || [];
      renderAll();
    }
  } catch (err) {
    console.error('获取数据失败:', err);
  }
}

// ==================== 添加小组 ====================
async function addGroup() {
  const input = document.getElementById('groupInput');
  const name = input.value.trim();
  if (!name) { toast('请输入小组名称', 'error'); return; }

  try {
    const res = await fetch(`/api/session/${sessionCode}/group`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.success) {
      input.value = '';
      toast('小组已添加', 'success');
    }
  } catch (err) {
    toast('添加失败', 'error');
  }
}

// ==================== 删除小组 ====================
async function deleteGroup(groupId) {
  if (!confirm('确定删除该小组及其所有角色？')) return;
  try {
    await fetch(`/api/session/${sessionCode}/group/${groupId}`, { method: 'DELETE' });
    toast('已删除', 'info');
  } catch (err) {
    toast('删除失败', 'error');
  }
}

// ==================== 添加角色 ====================
async function addRole(groupId) {
  const input = document.getElementById(`roleInput_${groupId}`);
  const descInput = document.getElementById(`roleDesc_${groupId}`);
  const name = input.value.trim();
  if (!name) { toast('请输入角色名称', 'error'); return; }

  try {
    const res = await fetch(`/api/session/${sessionCode}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId,
        name,
        description: descInput ? descInput.value.trim() : ''
      })
    });
    const data = await res.json();
    if (data.success) {
      input.value = '';
      if (descInput) descInput.value = '';
      toast('角色已添加', 'success');
    }
  } catch (err) {
    toast('添加失败', 'error');
  }
}

// ==================== 删除角色 ====================
async function deleteRole(roleId) {
  if (!confirm('确定删除该角色？')) return;
  try {
    await fetch(`/api/session/${sessionCode}/role/${roleId}`, { method: 'DELETE' });
    toast('已删除', 'info');
  } catch (err) {
    toast('删除失败', 'error');
  }
}

// ==================== 添加剧本 ====================
async function addScene() {
  const title = document.getElementById('sceneTitle').value.trim();
  const content = document.getElementById('sceneContent').value.trim();
  if (!title) { toast('请输入幕次标题', 'error'); return; }
  if (!content) { toast('请输入剧本内容', 'error'); return; }

  try {
    const res = await fetch(`/api/session/${sessionCode}/scene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('sceneTitle').value = '';
      document.getElementById('sceneContent').value = '';
      toast('剧本已添加', 'success');
    }
  } catch (err) {
    toast('添加失败', 'error');
  }
}

// ==================== 删除剧本 ====================
async function deleteScene(sceneId) {
  if (!confirm('确定删除该幕剧本？')) return;
  try {
    await fetch(`/api/session/${sessionCode}/scene/${sceneId}`, { method: 'DELETE' });
    toast('已删除', 'info');
  } catch (err) {
    toast('删除失败', 'error');
  }
}

// ==================== 推送剧本 ====================
function pushScene(sceneNumber) {
  if (!confirm(`确定推送第 ${sceneNumber} 幕？`)) return;
  socket.emit('instructor:push_scene', { code: sessionCode, sceneNumber });
  toast(`第 ${sceneNumber} 幕已推送`, 'success');
}

// ==================== 结束场次 ====================
function endSession() {
  if (!confirm('确定结束场次？所有学员将收到结束通知。')) return;
  socket.emit('instructor:end', sessionCode);
}

// ==================== 复制场次码 ====================
function copyCode() {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(sessionCode).then(() => {
      toast('场次码已复制', 'success');
    });
  } else {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = sessionCode;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('场次码已复制', 'success');
  }
}

// ==================== 渲染 ====================

function renderAll() {
  renderGroups();
  renderRoles();
  renderScenes();
  renderParticipants();
  renderSceneControls();
}

function renderGroups() {
  const container = document.getElementById('groupList');
  const empty = document.getElementById('groupEmpty');
  const groups = sessionData.groups;

  if (!groups || groups.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'block';
    // 标记步骤为未完成
    document.getElementById('stepGroups').classList.remove('done');
    return;
  }

  empty.style.display = 'none';
  document.getElementById('stepGroups').classList.add('done');

  container.innerHTML = groups.map(g => `
    <div class="list-item">
      <div class="list-item-label">
        <span style="font-size:18px">👥</span>
        <span>${escapeHtml(g.name)}</span>
        <span class="badge">${(g.roles || []).length} 角色</span>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="deleteGroup(${g.id})" style="color:var(--accent)">删除</button>
    </div>
  `).join('');
}

function renderRoles() {
  const container = document.getElementById('rolesContent');
  const groups = sessionData.groups;

  if (!groups || groups.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">👥</div>
        <div class="text">请先在「小组管理」中添加小组</div>
      </div>`;
    return;
  }

  let hasRoles = false;
  container.innerHTML = groups.map(g => {
    const roles = g.roles || [];
    if (roles.length > 0) hasRoles = true;
    return `
      <div class="card" style="margin-bottom:12px">
        <div class="card-header">
          <div class="card-title">${escapeHtml(g.name)}</div>
          <span class="badge">${roles.length} 角色</span>
        </div>
        <div class="inline-form">
          <input class="input" id="roleInput_${g.id}" placeholder="角色名称" maxlength="20" style="font-size:14px">
          <button class="btn btn-primary btn-sm" onclick="addRole(${g.id})">添加</button>
        </div>
        ${roles.length > 0 ? `
          <div class="list">
            ${roles.map(r => `
              <div class="list-item">
                <div class="list-item-label">
                  <span>🎭</span>
                  <span>${escapeHtml(r.name)}</span>
                  ${r.description ? `<span style="font-size:12px;color:var(--text-muted)">${escapeHtml(r.description)}</span>` : ''}
                </div>
                <button class="btn btn-ghost btn-sm" onclick="deleteRole(${r.id})" style="color:var(--text-muted)">✕</button>
              </div>
            `).join('')}
          </div>
        ` : `
          <div style="font-size:13px;color:var(--text-muted);text-align:center;padding:8px">暂无角色</div>
        `}
      </div>
    `;
  }).join('');

  if (hasRoles) {
    document.getElementById('stepRoles').classList.add('done');
  } else {
    document.getElementById('stepRoles').classList.remove('done');
  }
}

function renderScenes() {
  const container = document.getElementById('sceneList');
  const empty = document.getElementById('sceneEmpty');
  const scenes = sessionData.scenes;

  if (!scenes || scenes.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'block';
    document.getElementById('stepScenes').classList.remove('done');
    return;
  }

  empty.style.display = 'none';
  document.getElementById('stepScenes').classList.add('done');

  container.innerHTML = scenes.map(s => `
    <div class="scene" style="animation:none;opacity:1">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div class="scene-number">第 ${s.scene_number} 幕</div>
          <div class="scene-title">${escapeHtml(s.title)}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="deleteScene(${s.id})" style="color:var(--text-muted);flex-shrink:0">✕</button>
      </div>
      <div class="scene-content" style="font-size:14px;max-height:120px;overflow:hidden">${escapeHtml(s.content)}</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:8px;color:var(--text-muted);font-size:12px" onclick="this.previousElementSibling.style.maxHeight='none'">展开全部</button>
    </div>
  `).join('');
}

function renderParticipants() {
  const container = document.getElementById('participantList');
  const countEl = document.getElementById('participantCount');
  const participants = sessionData.participants;

  countEl.textContent = participants ? participants.length : 0;

  if (!participants || participants.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding:16px">
        <div class="icon" style="font-size:24px">👤</div>
        <div class="text">还没有学员加入</div>
      </div>`;
    return;
  }

  // 按小组分组
  const byGroup = {};
  participants.forEach(p => {
    if (!byGroup[p.group_name]) byGroup[p.group_name] = [];
    byGroup[p.group_name].push(p);
  });

  container.innerHTML = Object.keys(byGroup).map(gName => `
    <div class="participant-group">
      <div class="participant-group-title">${escapeHtml(gName)}</div>
      <div class="participant-list">
        ${byGroup[gName].map(p => `
          <div class="participant-chip">
            <span class="dot"></span>
            ${escapeHtml(p.name)}
            <span class="role-tag">· ${escapeHtml(p.role_name)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function renderSceneControls() {
  const container = document.getElementById('sceneControls');
  const empty = document.getElementById('sceneControlsEmpty');
  const scenes = sessionData.scenes;
  const currentScene = sessionData.session ? sessionData.session.current_scene : 0;

  if (!scenes || scenes.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  container.innerHTML = scenes.map(s => {
    const isPushed = s.scene_number <= currentScene;
    const isCurrent = s.scene_number === currentScene;
    let statusText = '待推送';
    let statusClass = '';
    if (isCurrent) {
      statusText = '当前展示中';
      statusClass = 'current';
    } else if (isPushed) {
      statusText = '已推送';
      statusClass = 'pushed';
    }

    return `
      <button class="scene-btn ${statusClass}" onclick="pushScene(${s.scene_number})" ${isPushed ? 'disabled' : ''}>
        <div class="scene-btn-num">${s.scene_number}</div>
        <div class="scene-btn-info">
          <div class="scene-btn-title">${escapeHtml(s.title)}</div>
          <div class="scene-btn-status">${statusText}</div>
        </div>
        ${!isPushed ? '<span style="color:var(--accent);font-size:13px;font-weight:600">推送 →</span>' : (isCurrent ? '<span style="color:var(--gold);font-size:16px">✦</span>' : '<span style="color:var(--green);font-size:16px">✓</span>')}
      </button>
    `;
  }).join('');
}

// ==================== 工具 ====================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
