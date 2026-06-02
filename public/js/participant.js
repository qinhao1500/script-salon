// ==================== 学员端 ====================
let sessionCode = null, myName = null, myGroup = null, myRole = null;
let sessionData = { session: null, groups: [] };
let currentViewingScene = 0;
let fontSize = parseInt(localStorage.getItem('reader_font_size')) || 16;
let unlockedTiers = {}; // { sceneNumber_tier: true }

const ROLE_COLORS = { '周岚':'#B85C3A','林澈':'#E8923A','阿宁':'#3A9E7A','许言':'#5A8AB5' };
function getRoleColor(n) { return ROLE_COLORS[n]||'#9A8A7A'; }
function getRoleClass(n) { return { '周岚':'zhou','林澈':'lin','阿宁':'a','许言':'xu' }[n]||'default'; }

function getRoundTypeLabel(type) {
  const map = { 'script':'🎭 剧本','discussion':'💬 讨论','knowledge':'📖 知识','decision':'📋 决策' };
  return map[type] || '📄 环节';
}

// ==================== 加入场次 ====================
async function joinSession() {
  const code = document.getElementById('codeInput').value.trim();
  const name = document.getElementById('nameInput').value.trim();
  if(!code||code.length!==4){toast('请输入4位场次码','error');return;}
  if(!name){toast('请输入名字','error');return;}
  try {
    const r = await fetch('/api/session/'+code+'/public');
    const d = await r.json();
    if(!d.success){
      toast(d.message||'场次不存在','error');
      // 场次已结束，清除本地记录
      if (d.message && d.message.indexOf('已结束') > -1) {
        localStorage.removeItem('salon_session');
        localStorage.removeItem('salon_participant');
      }
      return;
    }
    sessionCode = code; myName = name; sessionData = d;
    localStorage.setItem('salon_session',JSON.stringify({code,name}));
    socket.emit('participant:join', code);
    // 检查是否有已保存的角色身份，有则自动恢复
    var saved = JSON.parse(localStorage.getItem('salon_participant'));
    if (saved && saved.code === code && saved.roleId) {
      myGroup = { id: saved.groupId, name: saved.groupName };
      myRole = { id: saved.roleId, name: saved.roleName };
      enterScriptView();
      return;
    }
    showGroupSelection();
  } catch(e) { toast('连接失败','error'); }
}

// ==================== Socket ====================
socket.on('participant:init', (d) => {
  sessionData.session=d.session; sessionData.groups=d.groups;
  if(document.getElementById('stepRole').style.display!=='none') renderAllGroups();
});
socket.on('participant:role_selected', (d) => { myGroup=d.group; myRole=d.role; enterScriptView(); });
socket.on('participant:error', (m) => { toast(m,'error'); });
socket.on('scene:pushed', (d) => {
  console.log('[socket] 收到scene:pushed', 'currentScene=' + d.currentScene, 'scenes=' + (d.scenes ? d.scenes.length : 0));
  try {
    sessionData.session.currentScene = d.currentScene;
    sessionData.session.current_scene = d.currentScene;
    sessionData.session.pushedScenes = d.scenes;
    currentViewingScene = d.scenes.length - 1;
    renderScripts();
    console.log('[socket] 渲染完成');
  } catch(e) { console.error('[socket] scene:pushed error:', e); }
});
socket.on('all_unlocked', () => {
  unlockedTiers = {}; // 重置，重新加载时会全部显示已解锁
  renderCurrentScene();
  toast('🔓 全部信息已解禁！','success');
});
socket.on('session:ended', () => { toast('场次已结束','info'); document.getElementById('statusText').textContent='已结束'; });

// 编辑场景后刷新
socket.on('scene_updated', function() {
  if (!sessionCode || !myRole) return;
  manualRefresh();
});

// ==================== 页面切换 ====================
function showGroupSelection() {
  ['stepCode','stepGroup','stepRole'].forEach(id=>document.getElementById(id).style.display='none');
  document.getElementById('stepRole').style.display='block';
  document.getElementById('stepScript').style.display='none';
  document.getElementById('statusText').textContent='选择角色';
  document.getElementById('selectedGroupDisplay').textContent='所有小组';
  renderAllGroups();
}

function renderAllGroups() {
  const grid = document.getElementById('roleGrid');
  const gs = sessionData.groups;
  if(!gs||!gs.length){grid.innerHTML='<div class="empty-state"><div class="icon">👥</div><div class="text">该场次暂未设置小组</div></div>';return;}
  let html = '';
  gs.forEach((g, gi) => {
    const roles = g.roles || [];
    html += '<div class="role-group-block" style="animation: cardRise 0.4s ease-out both; animation-delay:'+(gi*0.08)+'s">';
    html += '<div class="role-group-title">'+escapeHtml(g.name)+'</div>';
    html += '<div class="role-grid-2">';
    roles.forEach((r, ri) => {
      const color = getRoleColor(r.name);
      const occ = r.occupied;
      const desc = (r.description || '').substring(0, 28);
      html += '<div class="role-card-enhanced '+(occ?'occupied':'')+'" onclick="selectRole('+g.id+','+r.id+')" style="--role-color:'+color+'; animation: cardRise 0.35s ease-out both; animation-delay:'+(gi*0.08+ri*0.06)+'s">';
      html += '<div class="rce-avatar" style="background: linear-gradient(135deg, '+color+', '+color+'88)"><span>'+r.name[0]+'</span></div>';
      html += '<div class="rce-name" style="color:'+color+'">'+escapeHtml(r.name)+'</div>';
      html += '<div class="rce-desc">'+(desc||(occ?'已被选择':'点击选择'))+'</div>';
      html += '<div class="rce-status">'+(occ?'已被选':'可选')+'</div>';
      html += '</div>';
    });
    html += '</div></div>';
  });
  grid.innerHTML = html;
}

function selectRole(gid, rid) {
  const group = sessionData.groups.find(g=>g.id===gid);
  if(!group) return;
  const role = group.roles.find(r=>r.id===rid);
  if(!role||role.occupied) return;
  myGroup = group;
  myRole = role;
  // 保存身份到本地，刷新后可恢复
  localStorage.setItem('salon_participant', JSON.stringify({
    code: sessionCode,
    name: myName,
    roleId: role.id,
    roleName: role.name,
    groupId: group.id,
    groupName: group.name
  }));
  socket.emit('participant:select_role',{code:sessionCode,groupId:gid,roleId:rid,name:myName});
}

function enterScriptView() {
  // 保存场次和角色身份到本地，支持断线重连
  localStorage.setItem('salon_session', JSON.stringify({ code: sessionCode, name: myName }));
  localStorage.setItem('salon_participant', JSON.stringify({
    code: sessionCode, name: myName,
    roleId: myRole.id, roleName: myRole.name,
    groupId: myGroup.id, groupName: myGroup.name
  }));
  ['stepCode','stepGroup','stepRole'].forEach(id=>document.getElementById(id).style.display='none');
  document.getElementById('stepScript').style.display='block';
  document.getElementById('statusText').textContent='剧本进行中';
  document.getElementById('myRoleDisplay').textContent=myRole.name;
  document.getElementById('myGroupDisplay').textContent=myGroup.name;
  const rc=getRoleColor(myRole.name);
  document.getElementById('roleIndicator').style.background=rc;
  document.getElementById('myRoleDisplay').style.color=rc;
  currentViewingScene = 0;
  renderScripts();
  // 启动定时轮询（双重保障，防止socket遗漏）
  startScenePolling();
}

// ==================== 字体控制 ====================
function changeFontSize(delta) {
  fontSize = Math.min(24, Math.max(12, fontSize + delta));
  localStorage.setItem('reader_font_size', fontSize);
  document.getElementById('fontSizeDisplay').textContent = fontSize;
  const card = document.getElementById('sceneCard');
  if(card) {
    card.querySelectorAll('.scene-content, .role-script-content, .hidden-info-content, .task-card-content').forEach(function(el) {
      el.style.fontSize = fontSize + 'px';
    });
  }
}

function toggleTaskCard() {
  const tc = document.getElementById('taskCard');
  if(tc) tc.style.display = tc.style.display==='none'?'block':'none';
}

// ==================== 场景导航 ====================
function prevScene() { if(currentViewingScene>0){currentViewingScene--;renderCurrentScene();renderProgressDots();} }
function nextScene() {
  const ss=sessionData.session&&sessionData.session.pushedScenes;
  if(ss&&currentViewingScene<ss.length-1){currentViewingScene++;renderCurrentScene();renderProgressDots();}
}

// ==================== 自检解锁 ====================
async function selfCheckUnlock(tier) {
  if (!sessionCode || !myRole) { toast('请先选择角色', 'info'); return; }
  var ss = sessionData.session && sessionData.session.pushedScenes;
  if (!ss || !ss.length) { toast('暂无剧本内容', 'info'); return; }
  var scene = ss[currentViewingScene];
  if (!scene) return;
  var sceneNumber = scene.scene_number;
  try {
    var r = await fetch('/api/session/' + sessionCode + '/unlock', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ roleId: myRole.id, sceneNumber: sceneNumber, tier: tier })
    });
    var d = await r.json();
    if (d.success) {
      unlockedTiers[sceneNumber + '_' + tier] = true;
      toast('🔓 第'+tier+'层隐藏信息已解锁！', 'success');
      renderCurrentScene();
    } else { toast(d.message || '解锁失败', 'error'); }
  } catch(e) { toast('解锁失败', 'error'); }
}

function xuYanChoice(choice) {
  if (!sessionCode || !myRole || myRole.name !== '许言') return;
  document.getElementById('xuYanChoiceArea').style.display = 'none';
  fetch('/api/session/' + sessionCode + '/xu-yan', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ groupId: myGroup.id, choice: choice })
  }).catch(function(){});
  toast('已选择：' + (choice === 'public' ? '📢 公开' : '🔒 保留'), 'success');
}

// ==================== 进度条 ====================
function renderProgressDots() {
  var el = document.getElementById('progressDots');
  if (!el) return;
  var ss = sessionData.session && sessionData.session.pushedScenes;
  var total = ss ? ss.length : 0;
  if (total < 2) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  var html = '';
  for (var i = 0; i < total; i++) {
    var s = ss[i];
    var cls = 'progress-dot';
    if (i === currentViewingScene) cls += ' current';
    else if (i < currentViewingScene) cls += ' visited';
    else cls += ' future';
    html += '<div class="' + cls + '" onclick="goToScene(' + i + ')">' + s.scene_number + '</div>';
  }
  el.innerHTML = html;
}

function goToScene(idx) {
  var ss = sessionData.session && sessionData.session.pushedScenes;
  if (!ss || idx >= ss.length) return;
  currentViewingScene = idx;
  // 确保脚本区域可见，决策/结束区域隐藏
  var sc = document.getElementById('scriptContent');
  if (sc) sc.style.display = 'block';
  document.getElementById('decisionFormArea').style.display = 'none';
  document.getElementById('endingArea').style.display = 'none';
  var card = document.getElementById('sceneCard');
  if (card) card.style.display = 'block';
  document.getElementById('sceneCounter').style.display = 'block';
  document.getElementById('progressDots').style.display = 'flex';
  renderCurrentScene();
  renderProgressDots();
}

// ==================== 加载隐藏信息 ====================
async function loadHiddenInfo() {
  if(!myRole||!sessionCode) return [];
  const scene = sessionData.session.pushedScenes[currentViewingScene];
  if(!scene) return [];
  try {
    const r = await fetch('/api/session/'+sessionCode+'/hidden-info/'+myRole.id+'?scene='+scene.scene_number);
    const d = await r.json();
    if(d.success) return d.hidden_info || [];
  } catch(e) {}
  return [];
}

// ==================== 渲染 ====================
function renderScripts() {
  const wr=document.getElementById('waitingRoom');const sc=document.getElementById('scriptContent');
  const badge=document.getElementById('sceneStatusBadge');
  const ss=sessionData.session&&sessionData.session.pushedScenes;
  const cs=(sessionData.session?sessionData.session.currentScene:undefined)||(sessionData.session?sessionData.session.current_scene:undefined)||0;

  if(ss&&ss.length>0){
    // 进度条（后续可启用）
  }

  if(!ss||!ss.length||cs===0){
    wr.style.display='block';sc.style.display='none';badge.textContent='等待推送';badge.className='badge badge-gold';
    document.getElementById('decisionFormArea').style.display='none';
    document.getElementById('endingArea').style.display='none';
    return;
  }
  wr.style.display='none';sc.style.display='block';
  
  // Check if last scene is decision or ending
  var last = ss[ss.length-1];
  if (last && last.round_type === 'decision') {
    sc.style.display = 'none';
    document.getElementById('decisionFormArea').style.display = 'block';
    document.getElementById('endingArea').style.display = 'none';
    badge.textContent='最终决策';badge.className='badge badge-green';
    return;
  }
  badge.textContent='第'+cs+'幕';badge.className='badge badge-green';
  renderCurrentScene();
  renderProgressDots();
}

async function renderCurrentScene() {
  try {
  const ss=sessionData.session&&sessionData.session.pushedScenes;
  if(!ss||!ss.length) return;
  const s=ss[currentViewingScene]; if(!s) return;
  
  // 确保基础元素可见
  var card = document.getElementById('sceneCard');
  if (!card) return;
  card.style.display = 'block';
  var counter = document.getElementById('sceneCounter');
  if (counter) counter.style.display = 'block';
  
  // Handle decision scene
  if (s.round_type === 'decision') {
    card.style.display = 'none';
    if (counter) counter.style.display = 'none';
    var df = document.getElementById('decisionFormArea');
    var ea = document.getElementById('endingArea');
    var xy = document.getElementById('xuYanChoiceArea');
    if (df) df.style.display = 'block';
    if (ea) ea.style.display = 'none';
    if (xy) xy.style.display = 'none';
    return;
  }
  
  // Handle ending (scene 11)
  if (s.scene_number >= 11) {
    card.style.display = 'none';
    if (counter) counter.style.display = 'none';
    var df2 = document.getElementById('decisionFormArea');
    var ea2 = document.getElementById('endingArea');
    var xy2 = document.getElementById('xuYanChoiceArea');
    if (df2) df2.style.display = 'none';
    if (ea2) ea2.style.display = 'block';
    if (xy2) xy2.style.display = 'none';
    return;
  }
  
  var df3 = document.getElementById('decisionFormArea');
  var ea3 = document.getElementById('endingArea');
  if (df3) df3.style.display = 'none';
  if (ea3) ea3.style.display = 'none';
  const total=ss.length;
  document.getElementById('sceneCounter').textContent='第 '+(currentViewingScene+1)+' 幕 / 共 '+total+' 幕';
  document.getElementById('prevSceneBtn').style.visibility=currentViewingScene>0?'visible':'hidden';
  document.getElementById('nextSceneBtn').style.visibility=currentViewingScene<total-1?'visible':'hidden';

  const roleClass=myRole?'role-'+getRoleClass(myRole.name):'role-default';
  var myRoleColor = myRole ? getRoleColor(myRole.name) : '#F5A623';

  // 环节类型标识
  const roundType = s.round_type || 'script';
  const typeLabel = getRoundTypeLabel(roundType);

  // 完整话头渲染
  let fullDialogueHtml = '';
  if(s.full_dialogue && s.full_dialogue.trim()) {
    let dialogueContent = s.full_dialogue;
    if(myRole) {
      var allRoles = ['周岚','林澈','阿宁','许言'];
      var myName = myRole.name;
      for(var ri = 0; ri < allRoles.length; ri++) {
        var name = allRoles[ri];
        var color = getRoleColor(name);
        var isMe = name === myName;
        var re = new RegExp('\\*\\*' + name + '\\*\\*', 'g');
        if(isMe) {
          dialogueContent = dialogueContent.replace(re, '<strong style="color:' + color + ';font-size:1.05em;background:rgba('+hexToRgb(color)+',0.12);padding:0 4px;border-radius:3px">' + name + '</strong>');
        } else {
          dialogueContent = dialogueContent.replace(re, '<span style="color:' + color + ';font-weight:600">' + name + '</span>');
        }
      }
      dialogueContent = dialogueContent.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // 动作标注用灰色斜体区分
      dialogueContent = dialogueContent.replace(/（[^）]+）/g, function(m) { return '<span class="inline-note">' + m + '</span>'; });
      dialogueContent = dialogueContent.replace(/（([^）]*)）/g, function(m) { return '<span class="inline-note">' + m + '</span>'; });
    }
    fullDialogueHtml = '<div class="section-block"><div class="section-label">📜 完整对白</div><div class="scene-content" style="font-size:'+fontSize+'px;white-space:pre-wrap;line-height:2">'+dialogueContent+'</div></div>';
  } else {
    // 无完整话头时使用公共内容
    let displayContent = s.content;
    if(myRole) {
      var allRoles = ['周岚','林澈','阿宁','许言'];
      var myName = myRole.name;
      for(var ri = 0; ri < allRoles.length; ri++) {
        var name = allRoles[ri];
        var color = getRoleColor(name);
        var isMe = name === myName;
        var re = new RegExp('\\*\\*' + name + '\\*\\*', 'g');
        if(isMe) {
          displayContent = displayContent.replace(re, '<strong style="color:' + color + ';font-size:1.05em;background:rgba('+hexToRgb(color)+',0.1);padding:0 4px;border-radius:3px">' + name + '</strong>');
        } else {
          displayContent = displayContent.replace(re, '<span style="color:' + color + ';font-weight:600">' + name + '</span>');
        }
      }
      displayContent = displayContent.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // 动作标注用灰色斜体区分
      displayContent = displayContent.replace(/（[^）]+）/g, function(m) { return '<span class="inline-note">' + m + '</span>'; });
    }
    fullDialogueHtml = '<div class="section-block"><div class="scene-content" style="font-size:'+fontSize+'px;white-space:pre-wrap;line-height:2">'+displayContent+'</div></div>';
  }

  // 角色专属内容（仅场景1显示为角色介绍）
  var rt = '';
  if(s.role_content&&myRole){
    rt = s.role_content[myRole.id] || '';
  }
  var roleHtml = '';
  if (rt && rt.trim() && s.scene_number === 1) {
    roleHtml = '<div class="section-block" style="border-color:'+myRoleColor+'40;background:'+myRoleColor+'04"><div class="section-label" style="color:'+myRoleColor+'">🎭 你的角色</div><div class="role-script-content" style="font-size:'+fontSize+'px;white-space:pre-wrap;line-height:1.9">'+escapeHtml(rt)+'</div></div>';
  }

  // 任务卡 —— 场景1不显示，其他场景优先用角色专属内容
  let taskHtml = '';
  if (s.scene_number !== 1) {
    var roleTask = rt && rt.trim();
    var globalTask = s.task_content || '';
    var taskText = roleTask || globalTask;
    if(taskText && taskText.trim()) {
      taskHtml = '<div class="section-block task-card" style="border-color:'+myRoleColor+'40;background:'+myRoleColor+'06" onclick="toggleTaskCard()"><div class="section-label" style="color:'+myRoleColor+'">📋 你的任务 <span style="font-size:12px;font-weight:normal;color:var(--text-muted)">（点击展开）</span></div><div id="taskCard" class="task-card-content" style="font-size:'+fontSize+'px;white-space:pre-wrap;line-height:1.9;display:none">'+escapeHtml(taskText)+'</div></div>';
    }
  }

  // 字体控制
  var fontControls = '<div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-bottom:8px">'+
    '<span style="font-size:11px;color:var(--text-muted)">字号</span>'+
    '<button class="btn btn-ghost btn-sm" onclick="changeFontSize(-1)" style="font-size:14px;padding:2px 8px;border:1px solid var(--divider);border-radius:4px">A−</button>'+
    '<span id="fontSizeDisplay" style="font-size:12px;color:var(--text-secondary);min-width:20px;text-align:center">'+fontSize+'</span>'+
    '<button class="btn btn-ghost btn-sm" onclick="changeFontSize(1)" style="font-size:14px;padding:2px 8px;border:1px solid var(--divider);border-radius:4px">A+</button>'+
    '</div>';

  // 隐藏信息
  const hiddenInfoHtml = await renderHiddenInfo();

  var card = document.getElementById('sceneCard');
  card.className = 'scene ' + roleClass;
  card.style.animation = 'fadeInUp 0.3s ease forwards';

  card.innerHTML = fontControls +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'+
    '<span class="badge '+(roundType==='script'?'badge-green':'badge-gold')+'">'+typeLabel+'</span>'+
    (currentViewingScene===total-1?'<span class="badge badge-green" style="font-size:11px">最新</span>':'')+
    '</div>'+
    '<div class="scene-title">'+escapeHtml(s.title)+'</div>'+
    fullDialogueHtml +
    roleHtml +
    taskHtml +
    hiddenInfoHtml;

  card.querySelectorAll('.scene-content, .role-script-content, .hidden-info-content, .task-card-content').forEach(function(el){el.style.fontSize=fontSize+'px';});
  } catch(e) { console.error('renderCurrentScene error:', e); }
}

async function renderHiddenInfo() {
  if(!myRole) return '';
  const hiddenInfo = await loadHiddenInfo();
  if(!hiddenInfo.length) return '';
  const tierLabels = { 1:'第一层', 2:'第二层', 3:'第三层' };
  const roleColor=getRoleColor(myRole.name);
  console.log('[颜色调试] renderHiddenInfo myRole:', myRole.name, 'roleColor:', roleColor);
  let html = '<div class="section-block hidden-info-section" style="border-color:'+roleColor+'40;background:'+roleColor+'04"><div class="section-label" style="color:'+roleColor+'">🔐 隐藏信息</div>';

  for(const h of hiddenInfo) {
    const isUnlocked = h.unlocked === 1 || unlockedTiers[sessionData.session.pushedScenes[currentViewingScene].scene_number+'_'+h.tier];
    const tierLabel = tierLabels[h.tier] || '第'+h.tier+'层';
    const isFinalTier = h.tier === 3;

    html += '<div class="hidden-info-item '+(isUnlocked?'unlocked':'locked')+'" style="'+(isUnlocked?'border-color:'+roleColor+'60;background:'+roleColor+'0A':'')+'">';
    html += '<div class="hidden-info-header">';
    html += '<span class="hidden-info-tier">'+(isUnlocked?'🔓':'🔒')+' '+tierLabel+'</span>';
    if(!isUnlocked) {
      html += '<button class="btn btn-sm btn-primary" onclick="selfCheckUnlock('+h.tier+')" '+(isFinalTier?'disabled title="终局由讲师统一解禁"':'')+'>我达成了</button>';
    }
    html += '</div>';
    if(isUnlocked) {
      html += '<div class="hidden-info-content" style="font-size:'+fontSize+'px;white-space:pre-wrap;line-height:1.9;border-left-color:'+roleColor+'">'+escapeHtml(h.content)+'</div>';
    } else if(isFinalTier) {
      html += '<div class="hidden-info-placeholder">⏳ 讲师宣布解禁后方可查看</div>';
    } else {
      html += '<div class="hidden-info-placeholder">✅ 完成本轮任务后点击上方按钮解锁</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

// ==================== 工具 ====================
function escapeHtml(str){const d=document.createElement('div');d.textContent=str;return d.innerHTML;}
function hexToRgb(hex) {
  const c = hex.replace('#','');
  return parseInt(c.substring(0,2),16)+','+parseInt(c.substring(2,4),16)+','+parseInt(c.substring(4,6),16);
}

// ==================== 定时轮询：双重保障推送不丢失 ====================
let scenePollTimer = null;

function startScenePolling() {
  if (scenePollTimer) clearInterval(scenePollTimer);
  scenePollTimer = setInterval(async function() {
    if (!sessionCode || !myRole) return;
    try {
      console.log('[轮询] 开始拉取...');
      var r = await fetch('/api/session/' + sessionCode + '/diag');
      var d = await r.json();
      if (!d.success || !d.session) { console.log('[轮询] 拉取失败'); return; }
      var cs = d.session.current_scene || 0;
      console.log('[轮询] current_scene=' + cs + ' 参与者=' + d.participantCount);
      if (cs === 0) return;
      var oldCs = sessionData._lastScene || 0;
      if (cs === oldCs) return;
      console.log('[轮询] 检测到变化: ' + oldCs + ' -> ' + cs + '，拉取完整数据');
      sessionData._lastScene = cs;
      var r2 = await fetch('/api/session/' + sessionCode + '/full');
      var d2 = await r2.json();
      if (d2.success) {
        sessionData.session = d2.session;
        sessionData.session.currentScene = d2.session.current_scene;
        sessionData.session.pushedScenes = d2.scenes.filter(function(s) { return s.scene_number <= cs; });
        currentViewingScene = sessionData.session.pushedScenes.length - 1;
        console.log('[轮询] 渲染, pushedScenes=' + sessionData.session.pushedScenes.length);
        renderScripts();
      }
    } catch(e) { console.log('[轮询] 异常:', e.message); }
  }, 2000);
}

function stopScenePolling() {
  if (scenePollTimer) { clearInterval(scenePollTimer); scenePollTimer = null; }
}

// ==================== 手动刷新 ====================
async function manualRefresh() {
  if (!sessionCode || !myRole) { toast('请先选择角色','error'); return; }
  try {
    var r = await fetch('/api/session/' + sessionCode + '/full');
    var d = await r.json();
    if (!d.success) { toast('刷新失败','error'); return; }
    var cs = d.session.current_scene || 0;
    if (cs === 0) { toast('暂无新内容','info'); return; }
    sessionData.session = d.session;
    sessionData.session.currentScene = d.session.current_scene;
    sessionData.session.pushedScenes = d.scenes.filter(function(s) { return s.scene_number <= cs; });
    currentViewingScene = sessionData.session.pushedScenes.length - 1;
    renderScripts();
    toast('已刷新','success');
  } catch(e) { toast('刷新失败','error'); }
}

// ==================== 页面加载：检查是否有之前的场次 ====================
(function checkPreviousSession() {
  try {
    var sess = JSON.parse(localStorage.getItem('salon_session'));
    var part = JSON.parse(localStorage.getItem('salon_participant'));
    if (!sess || !sess.code || !sess.name) return;
    if (!part || !part.code || !part.roleName) return;
    if (!window.confirm('检测到你之前加入了场次 ' + sess.code + '（角色：' + part.roleName + '）\n\n是否回到之前的进度？')) {
      localStorage.removeItem('salon_session');
      localStorage.removeItem('salon_participant');
      return;
    }
    document.getElementById('codeInput').value = sess.code;
    document.getElementById('nameInput').value = sess.name;
    joinSession();
  } catch(e) {}
})();

// ==================== 决策提交 ====================
async function submitDecision() {
  var keep = document.getElementById('dfKeep').value.trim();
  var r1 = document.getElementById('dfRule1').value.trim();
  var r2 = document.getElementById('dfRule2').value.trim();
  var r3 = document.getElementById('dfRule3').value.trim();
  var choice = document.getElementById('dfChoice').value;
  var words = document.getElementById('dfWords').value.trim();
  if (!keep || !r1 || !words) { toast('请至少填写守住什么、第一条约定和一句话', 'info'); return; }
  try {
    var r = await fetch('/api/session/' + sessionCode + '/decision', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ groupId: myGroup.id, roleName: myRole.name, keep: keep, rules: [r1,r2,r3], choice: choice, words: words })
    });
    var d = await r.json();
    if (d.success) {
      document.getElementById('decisionFormArea').innerHTML = '<div class="card" style="text-align:center;padding:30px"><div style="font-size:40px;margin-bottom:12px">✅</div><div style="font-size:16px;color:var(--success);font-weight:600">决策已提交</div><div style="font-size:14px;color:var(--text-muted);margin-top:8px">等待其他组完成</div></div>';
      toast('决策已提交！', 'success');
    }
  } catch(e) { toast('提交失败', 'error'); }
}

// Socket: 场次结束，显示收尾
socket.on('session:ended', () => {
  document.getElementById('scriptContent').style.display = 'none';
  document.getElementById('decisionFormArea').style.display = 'none';
  document.getElementById('endingArea').style.display = 'block';
  document.getElementById('endingDecision').textContent = '你们的决定，你们自己认同。';
});
