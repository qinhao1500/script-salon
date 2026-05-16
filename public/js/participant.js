// ==================== 学员端逻辑 ====================
let sessionCode = null;
let myName = null;
let myGroup = null;
let myRole = null;
let sessionData = {
  session: null,
  groups: []
};

// ==================== 加入场次 ====================
async function joinSession() {
  const code = document.getElementById('codeInput').value.trim();
  const name = document.getElementById('nameInput').value.trim();

  if (!code || code.length !== 4) {
    toast('请输入 4 位场次码', 'error');
    return;
  }
  if (!name) {
    toast('请输入你的名字', 'error');
    return;
  }

  // 先验证场次是否存在
  try {
    const res = await fetch(`/api/session/${code}/public`);
    const data = await res.json();
    if (!data.success) {
      toast(data.message || '场次不存在', 'error');
      return;
    }

    sessionCode = code;
    myName = name;
    sessionData = data;

    // 保存到本地存储，方便刷新后恢复
    localStorage.setItem('salon_session', JSON.stringify({ code, name }));

    // 加入 socket 房间
    socket.emit('participant:join', code);

    // 显示小组选择
    showGroupSelection();
  } catch (err) {
    toast('连接失败，请检查网络', 'error');
  }
}

// ==================== Socket 事件 ====================
socket.on('participant:init', (data) => {
  sessionData.session = data.session;
  sessionData.groups = data.groups;
  // 如果在角色选择阶段，刷新角色状态
  if (document.getElementById('stepRole').style.display !== 'none') {
    renderRoles();
  }
});

socket.on('participant:role_selected', (data) => {
  myGroup = data.group;
  myRole = data.role;
  enterScriptView();
});

socket.on('participant:error', (msg) => {
  toast(msg, 'error');
});

socket.on('scene:pushed', (data) => {
  sessionData.session.currentScene = data.currentScene;
  sessionData.session.pushedScenes = data.scenes;
  renderScripts();
});

// 当之前已选角色、后来收到新推送时，更新 sessionData 中的场景（含 role_content）
socket.on('participant:role_selected', (data) => {
  myGroup = data.group;
  myRole = data.role;
  enterScriptView();
  // 如果已经有推送场景，保存场景数据
  if (sessionData.session && sessionData.session.pushedScenes) {
    renderScripts();
  }
});

socket.on('session_updated', (data) => {
  // 刷新可用角色
  if (data.roles) {
    const group = sessionData.groups.find(g => g.id === data.roles.groupId);
    if (group) {
      group.roles = data.roles.roles.map(r => ({
        ...r,
        occupied: false // 这里不够准确，后面会刷新
      }));
    }
  }
  if (data.groups) {
    // 需要重新获取公开数据
    refreshPublicData();
  }
});

socket.on('session:ended', () => {
  toast('场次已结束，感谢参与！', 'info');
  document.getElementById('statusText').textContent = '场次已结束';
});

// ==================== 刷新公开数据 ====================
async function refreshPublicData() {
  if (!sessionCode) return;
  try {
    const res = await fetch(`/api/session/${sessionCode}/public`);
    const data = await res.json();
    if (data.success) {
      sessionData = data;
      // 如果正在角色选择，刷新
      if (document.getElementById('stepRole').style.display !== 'none') {
        renderRoles();
      }
    }
  } catch (err) {
    console.error('刷新数据失败:', err);
  }
}

// ==================== 页面切换 ====================
function showGroupSelection() {
  document.getElementById('stepCode').style.display = 'none';
  document.getElementById('stepGroup').style.display = 'block';
  document.getElementById('stepRole').style.display = 'none';
  document.getElementById('stepScript').style.display = 'none';
  document.getElementById('statusText').textContent = '选择小组';

  const list = document.getElementById('groupSelectList');
  const groups = sessionData.groups;

  if (!groups || groups.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="icon">👥</div><div class="text">该场次暂未设置小组</div></div>`;
    return;
  }

  list.innerHTML = groups.map(g => `
    <button class="group-select-item" onclick="selectGroup(${g.id})">
      <span>${escapeHtml(g.name)}</span>
      <span class="arrow">→</span>
    </button>
  `).join('');
}

function selectGroup(groupId) {
  const group = sessionData.groups.find(g => g.id === groupId);
  if (!group) return;

  myGroup = group;

  document.getElementById('stepGroup').style.display = 'none';
  document.getElementById('stepRole').style.display = 'block';
  document.getElementById('statusText').textContent = '选择角色';
  document.getElementById('selectedGroupDisplay').textContent = group.name;

  renderRoles();
}

function renderRoles() {
  const grid = document.getElementById('roleGrid');
  if (!myGroup || !myGroup.roles) {
    grid.innerHTML = `<div class="empty-state"><div class="icon">🎭</div><div class="text">该小组暂未设置角色</div></div>`;
    return;
  }

  grid.innerHTML = myGroup.roles.map(r => `
    <div class="role-card ${r.occupied ? 'occupied' : ''}" onclick="selectRole(${r.id})">
      <div class="role-name">${escapeHtml(r.name)}</div>
      <div class="role-status">${r.occupied ? '已被选择' : '可选'}</div>
    </div>
  `).join('');
}

function selectRole(roleId) {
  const role = myGroup.roles.find(r => r.id === roleId);
  if (!role || role.occupied) return;

  socket.emit('participant:select_role', {
    code: sessionCode,
    groupId: myGroup.id,
    roleId,
    name: myName
  });
}

function enterScriptView() {
  document.getElementById('stepCode').style.display = 'none';
  document.getElementById('stepGroup').style.display = 'none';
  document.getElementById('stepRole').style.display = 'none';
  document.getElementById('stepScript').style.display = 'block';
  document.getElementById('statusText').textContent = '剧本进行中';

  document.getElementById('myRoleDisplay').textContent = myRole.name;
  document.getElementById('myGroupDisplay').textContent = myGroup.name;

  renderScripts();
}

function renderScripts() {
  const waitingRoom = document.getElementById('waitingRoom');
  const scriptContent = document.getElementById('scriptContent');
  const badge = document.getElementById('sceneStatusBadge');
  const scenes = sessionData.session && sessionData.session.pushedScenes;
  const currentScene = sessionData.session ? sessionData.session.currentScene : 0;

  if (!scenes || scenes.length === 0 || currentScene === 0) {
    waitingRoom.style.display = 'block';
    scriptContent.style.display = 'none';
    badge.textContent = '等待推送';
    badge.className = 'badge badge-gold';
    return;
  }

  waitingRoom.style.display = 'none';
  scriptContent.style.display = 'block';
  badge.textContent = `第 ${currentScene} 幕`;
  badge.className = 'badge badge-green';

  scriptContent.innerHTML = scenes.map(s => {
    // 检查是否有当前角色的专属内容
    let roleSpecificHtml = '';
    if (s.role_content && myRole) {
      const roleText = s.role_content[myRole.id];
      if (roleText && roleText.trim()) {
        roleSpecificHtml = `
          <div class="role-script" style="margin-top:16px;padding-top:16px;border-top:1px solid rgba(255,107,107,0.2)">
            <div style="font-size:12px;font-weight:700;color:var(--accent);margin-bottom:8px;letter-spacing:1px">🎭 你的角色剧本</div>
            <div style="font-size:14px;line-height:1.8;color:var(--text-primary);white-space:pre-wrap">${escapeHtml(roleText)}</div>
          </div>`;
      }
    }
    return `
      <div class="scene" style="${s.scene_number === currentScene ? 'animation-delay:0s' : 'animation-delay:0.1s'}">
        <div class="scene-number">第 ${s.scene_number} 幕 ${s.scene_number === currentScene ? '· 最新' : ''}</div>
        <div class="scene-title">${escapeHtml(s.title)}</div>
        <div class="scene-content">${escapeHtml(s.content)}</div>
        ${roleSpecificHtml}
      </div>
    `;
  }).join('');
}

// ==================== 返回 ====================
function backToCode() {
  document.getElementById('stepCode').style.display = 'block';
  document.getElementById('stepGroup').style.display = 'none';
  document.getElementById('stepRole').style.display = 'none';
  document.getElementById('stepScript').style.display = 'none';
  document.getElementById('statusText').textContent = '输入场次码加入';
}

function backToGroup() {
  document.getElementById('stepGroup').style.display = 'block';
  document.getElementById('stepRole').style.display = 'none';
  document.getElementById('statusText').textContent = '选择小组';
}

// ==================== 工具 ====================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== 尝试恢复上次连接 ====================
(function tryRestore() {
  try {
    const saved = JSON.parse(localStorage.getItem('salon_session'));
    if (saved && saved.code && saved.name) {
      document.getElementById('codeInput').value = saved.code;
      document.getElementById('nameInput').value = saved.name;
    }
  } catch (e) {}
})();
