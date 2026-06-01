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
    if(!d.success){toast(d.message||'场次不存在','error');return;}
    sessionCode = code; myName = name; sessionData = d;
    localStorage.setItem('salon_session',JSON.stringify({code,name}));
    socket.emit('participant:join', code);
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
  sessionData.session.currentScene = d.currentScene;
  sessionData.session.pushedScenes = d.scenes;
  currentViewingScene = d.scenes.length - 1;
  renderScripts();
});
socket.on('all_unlocked', () => {
  unlockedTiers = {}; // 重置，重新加载时会全部显示已解锁
  renderCurrentScene();
  toast('🔓 全部信息已解禁！','success');
});
socket.on('session:ended', () => { toast('场次已结束','info'); document.getElementById('statusText').textContent='已结束'; });

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
  gs.forEach(g => {
    const roles = g.roles || [];
    html += '<div style="margin-bottom:14px"><div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;padding-left:4px">'+escapeHtml(g.name)+'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">';
    roles.forEach(r => {
      const color = getRoleColor(r.name);
      html += '<div class="role-card '+(r.occupied?'occupied':'')+'" onclick="selectRole('+g.id+','+r.id+')" style="animation:card-enter 0.3s ease-out both;animation-delay:'+(Math.random()*0.2)+'s"><div style="width:6px;height:6px;border-radius:50%;background:'+color+';margin:0 auto 6px"></div><div class="role-name" style="color:'+color+'">'+escapeHtml(r.name)+'</div><div class="role-status">'+(r.occupied?'已被选':'可选')+'</div></div>';
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
  socket.emit('participant:select_role',{code:sessionCode,groupId:gid,roleId:rid,name:myName});
}

function enterScriptView() {
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
function prevScene() { if(currentViewingScene>0){currentViewingScene--;renderCurrentScene();} }
function nextScene() {
  const ss=sessionData.session&&sessionData.session.pushedScenes;
  if(ss&&currentViewingScene<ss.length-1){currentViewingScene++;renderCurrentScene();}
}

// ==================== 自检解锁 ====================
async function selfCheckUnlock(tier) {
  if(!myRole||!sessionCode) return;
  const scene = sessionData.session.pushedScenes[currentViewingScene];
  if(!scene) return;
  try {
    const r = await fetch('/api/session/'+sessionCode+'/unlock', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({roleId:myRole.id,sceneNumber:scene.scene_number,tier:tier})
    });
    const d = await r.json();
    if(d.success) {
      unlockedTiers[scene.scene_number+'_'+tier] = true;
      renderCurrentScene();
      toast('🔓 第'+tier+'层信息已解锁！','success');
    }
  } catch(e) { toast('解锁失败','error'); }
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
  const cs=sessionData.session?sessionData.session.currentScene:0;

  if(ss&&ss.length>0){renderProgressBarClickable(ss, cs);}

  if(!ss||!ss.length||cs===0){
    wr.style.display='block';sc.style.display='none';badge.textContent='等待推送';badge.className='badge badge-gold';return;
  }
  wr.style.display='none';sc.style.display='block';
  badge.textContent='第'+cs+'幕';badge.className='badge badge-green';
  renderCurrentScene();
}

async function renderCurrentScene() {
  const ss=sessionData.session&&sessionData.session.pushedScenes;
  if(!ss||!ss.length) return;
  const s=ss[currentViewingScene]; if(!s) return;
  const total=ss.length;
  document.getElementById('sceneCounter').textContent='第 '+(currentViewingScene+1)+' 幕 / 共 '+total+' 幕';
  document.getElementById('prevSceneBtn').style.visibility=currentViewingScene>0?'visible':'hidden';
  document.getElementById('nextSceneBtn').style.visibility=currentViewingScene<total-1?'visible':'hidden';

  const roleClass=myRole?'role-'+getRoleClass(myRole.name):'role-default';

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
    }
    fullDialogueHtml = '<div class="section-block"><div class="scene-content" style="font-size:'+fontSize+'px;white-space:pre-wrap;line-height:2">'+displayContent+'</div></div>';
  }

  // 角色专属内容
  let roleHtml = '';
  if(s.role_content&&myRole){
    const rt=s.role_content[myRole.id];
    if(rt&&rt.trim()){
      const roleColor=getRoleColor(myRole.name);
      roleHtml='<div class="section-block role-script-block"><div class="section-label" style="color:'+roleColor+'">🎭 你的专属内容</div><div class="role-script-content" style="font-size:'+fontSize+'px;white-space:pre-wrap;line-height:1.9">'+escapeHtml(rt)+'</div></div>';
    }
  }

  // 任务卡
  let taskHtml = '';
  const taskContent = s.task_content || '';
  if(taskContent && taskContent.trim()) {
    taskHtml = '<div class="section-block task-card" onclick="toggleTaskCard()"><div class="section-label" style="color:#D97736">📋 你的任务 <span style="font-size:12px;font-weight:normal;color:var(--text-muted)">（点击展开）</span></div><div id="taskCard" class="task-card-content" style="font-size:'+fontSize+'px;white-space:pre-wrap;line-height:1.9;display:none">'+escapeHtml(taskContent)+'</div></div>';
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
}

async function renderHiddenInfo() {
  if(!myRole) return '';
  const hiddenInfo = await loadHiddenInfo();
  if(!hiddenInfo.length) return '';

  const tierLabels = { 1:'第一层', 2:'第二层', 3:'第三层' };
  const tierIcons = { 1:'🔒', 2:'🔒', 3:'🔓' };
  let html = '<div class="section-block hidden-info-section"><div class="section-label" style="color:#5A8AB5">🔐 隐藏信息</div>';

  for(const h of hiddenInfo) {
    const isUnlocked = h.unlocked === 1 || unlockedTiers[sessionData.session.pushedScenes[currentViewingScene].scene_number+'_'+h.tier];
    const tierLabel = tierLabels[h.tier] || '第'+h.tier+'层';
    const isFinalTier = h.tier === 3;

    html += '<div class="hidden-info-item '+(isUnlocked?'unlocked':'locked')+'">';
    html += '<div class="hidden-info-header">';
    html += '<span class="hidden-info-tier">'+(isUnlocked?'🔓':'🔒')+' '+tierLabel+'</span>';
    if(!isUnlocked) {
      html += '<button class="btn btn-sm btn-primary" onclick="selfCheckUnlock('+h.tier+')" '+(isFinalTier?'disabled title="终局由讲师统一解禁"':'')+'>我达成了</button>';
    }
    html += '</div>';
    if(isUnlocked) {
      html += '<div class="hidden-info-content animate-unlock" style="font-size:'+fontSize+'px;white-space:pre-wrap;line-height:1.9">'+escapeHtml(h.content)+'</div>';
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

// 恢复上次连接
(function(){try{const s=JSON.parse(localStorage.getItem('salon_session'));if(s&&s.code&&s.name){document.getElementById('codeInput').value=s.code;document.getElementById('nameInput').value=s.name;}}catch(e){}})();
