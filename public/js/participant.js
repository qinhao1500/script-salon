// ==================== 学员端 ====================
let sessionCode = null, myName = null, myGroup = null, myRole = null;
let sessionData = { session: null, groups: [] };
let currentViewingScene = 0;
let fontSize = parseInt(localStorage.getItem('reader_font_size')) || 16;

const ROLE_COLORS = { '周岚':'#B85C3A','林澈':'#E8923A','阿宁':'#3A9E7A','许岩':'#5A8AB5','许言':'#5A8AB5' };
function getRoleColor(n) { return ROLE_COLORS[n]||'#9A8A7A'; }
function getRoleClass(n) { return { '周岚':'zhou','林澈':'lin','阿宁':'a','许岩':'xu','许言':'xu' }[n]||'default'; }

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

// ==================== 所有小组+角色一览 ====================
function renderAllGroups() {
  const grid = document.getElementById('roleGrid');
  const gs = sessionData.groups;
  if(!gs||!gs.length){grid.innerHTML='<div class="empty-state"><div class="icon">👥</div><div class="text">该场次暂未设置小组</div></div>';return;}
  
  let html = '';
  gs.forEach(g => {
    const roles = g.roles || [];
    html += `<div style="margin-bottom:14px">
      <div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;padding-left:4px">${escapeHtml(g.name)}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">`;
    roles.forEach(r => {
      const color = getRoleColor(r.name);
      html += `<div class="role-card ${r.occupied?'occupied':''}" onclick="selectRole(${g.id},${r.id})" style="animation:card-enter 0.3s ease-out both;animation-delay:${Math.random()*0.2}s">
        <div style="width:6px;height:6px;border-radius:50%;background:${color};margin:0 auto 6px"></div>
        <div class="role-name" style="color:${color}">${escapeHtml(r.name)}</div>
        <div class="role-status">${r.occupied?'已被选':'可选'}</div>
      </div>`;
    });
    html += `</div></div>`;
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

// ==================== 字体大小控制 ====================
function changeFontSize(delta) {
  fontSize = Math.min(24, Math.max(12, fontSize + delta));
  localStorage.setItem('reader_font_size', fontSize);
  document.getElementById('sceneCard').style.fontSize = fontSize + 'px';
  document.getElementById('fontSizeDisplay').textContent = fontSize;
}

// ==================== 横向场景导航 ====================
function prevScene() { if(currentViewingScene>0){currentViewingScene--;renderCurrentScene();} }
function nextScene() {
  const ss=sessionData.session&&sessionData.session.pushedScenes;
  if(ss&&currentViewingScene<ss.length-1){currentViewingScene++;renderCurrentScene();}
}

// ==================== 渲染 ====================
function renderScripts() {
  const wr=document.getElementById('waitingRoom');const sc=document.getElementById('scriptContent');
  const badge=document.getElementById('sceneStatusBadge');const ss=sessionData.session&&sessionData.session.pushedScenes;
  const cs=sessionData.session?sessionData.session.currentScene:0;

  if(ss&&ss.length>0){
    const bar=document.getElementById('progressBarContainer');bar.style.display='block';
    document.getElementById('progressBar').innerHTML=ss.map((s,i)=>{const n=i+1;const active=n===cs;const done=n<=cs;let cls='progress-dot';if(active)cls+=' active';else if(done)cls+=' done';const lc=i<ss.length-1?(n<=cs?'progress-line done':'progress-line'):'';return '<div class="'+cls+'"></div>'+(i<ss.length-1?'<div class="'+lc+'"></div>':'');}).join('');
  }

  if(!ss||!ss.length||cs===0){
    wr.style.display='block';sc.style.display='none';badge.textContent='等待推送';badge.className='badge badge-gold';return;
  }
  wr.style.display='none';sc.style.display='block';
  badge.textContent='第'+cs+'幕';badge.className='badge badge-green';
  renderCurrentScene();
}

function renderCurrentScene() {
  const ss=sessionData.session&&sessionData.session.pushedScenes;
  if(!ss||!ss.length) return;
  const s=ss[currentViewingScene]; if(!s) return;
  const total=ss.length;
  document.getElementById('sceneCounter').textContent='第 '+(currentViewingScene+1)+' 幕 / 共 '+total+' 幕';
  document.getElementById('prevSceneBtn').style.visibility=currentViewingScene>0?'visible':'hidden';
  document.getElementById('nextSceneBtn').style.visibility=currentViewingScene<total-1?'visible':'hidden';

  const roleClass=myRole?'role-'+getRoleClass(myRole.name):'role-default';
  const roleColor=getRoleColor(myRole?myRole.name:'');

  // 角色专属内容
  let roleHtml='';
  if(s.role_content&&myRole){
    const rt=s.role_content[myRole.id];
    if(rt&&rt.trim()){
      roleHtml='<div class="role-script-block"><div class="role-script-label" style="color:'+roleColor+'">🎭 你的专属剧本</div><div class="scene-content" style="font-size:'+fontSize+'px;color:var(--text-primary);white-space:pre-wrap">'+escapeHtml(rt)+'</div></div>';
    }
  }

  // 处理内容：高亮自己的台词并加粗
  let displayContent = s.content;
  if(myRole) {
    const allRoles = ['周岚','林澈','阿宁','许言','许岩'];
    // 先处理自己的角色——加粗
    const myName = myRole.name;
    const myRegex = new RegExp('(\\*\\*'+myName+'\\*\\*)', 'g');
    displayContent = displayContent.replace(myRegex, '<strong style="color:'+roleColor+';font-weight:800">**'+myName+'**</strong>');
    // 再处理其他角色——仅染色
    allRoles.forEach(name => {
      if(name === myName) return;
      const color = getRoleColor(name);
      const regex = new RegExp('\\*\\*'+name+'\\*\\*', 'g');
      displayContent = displayContent.replace(regex, '<span style="color:'+color+';font-weight:600">**'+name+'**</span>');
    });
    // 将 ** ** 标记替换为视觉加粗
    displayContent = displayContent.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  }

  const card=document.getElementById('sceneCard');
  card.className='scene '+roleClass;
  card.style.animation='fadeInUp 0.3s ease forwards';
  card.style.fontSize=fontSize+'px';
  
  // 字体控制按钮
  const fontControls = '<div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-bottom:8px">'+
    '<span style="font-size:11px;color:var(--text-muted)">字号</span>'+
    '<button class="btn btn-ghost btn-sm" onclick="changeFontSize(-1)" style="font-size:14px;padding:2px 8px;border:1px solid var(--divider);border-radius:4px">A−</button>'+
    '<span id="fontSizeDisplay" style="font-size:12px;color:var(--text-secondary);min-width:20px;text-align:center">'+fontSize+'</span>'+
    '<button class="btn btn-ghost btn-sm" onclick="changeFontSize(1)" style="font-size:14px;padding:2px 8px;border:1px solid var(--divider);border-radius:4px">A+</button>'+
    '</div>';

  card.innerHTML = fontControls +
    '<div class="scene-number">第 '+s.scene_number+' 幕'+(currentViewingScene===ss.length-1?' · 最新':'')+'</div>'+
    '<div class="scene-title">'+escapeHtml(s.title)+'</div>'+
    '<div class="scene-content" style="font-size:'+fontSize+'px;white-space:pre-wrap;line-height:2">'+displayContent+'</div>'+
    roleHtml;
}

// ==================== 返回 ====================
function backToCode(){['stepCode','stepGroup','stepRole','stepScript'].forEach((id,i)=>document.getElementById(id).style.display=i===0?'block':'none');document.getElementById('statusText').textContent='输入场次码加入';}
function backToGroup(){document.getElementById('stepGroup').style.display='block';document.getElementById('stepRole').style.display='none';document.getElementById('statusText').textContent='选择小组';}

// ==================== 工具 ====================
function escapeHtml(str){const d=document.createElement('div');d.textContent=str;return d.innerHTML;}

// 恢复上次连接
(function(){try{const s=JSON.parse(localStorage.getItem('salon_session'));if(s&&s.code&&s.name){document.getElementById('codeInput').value=s.code;document.getElementById('nameInput').value=s.name;}}catch(e){}})();
