// ==================== 学员端 ====================
let sessionCode = null, myName = null, myGroup = null, myRole = null;
let sessionData = { session: null, groups: [] };
let currentViewingScene = 0; // 当前查看的场景索引

const ROLE_COLORS = { '周岚':'#B85C3A','林澈':'#E8923A','阿宁':'#3A9E7A','许岩':'#5A8AB5','许言':'#5A8AB5' };
function getRoleColor(n) { return ROLE_COLORS[n]||'#9A8A7A'; }

// ==================== 加入 ====================
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
  if(document.getElementById('stepRole').style.display!=='none') renderRoles();
});
socket.on('participant:role_selected', (d) => { myGroup=d.group; myRole=d.role; enterScriptView(); });
socket.on('participant:error', (m) => { toast(m,'error'); });
socket.on('scene:pushed', (d) => {
  sessionData.session.currentScene = d.currentScene;
  sessionData.session.pushedScenes = d.scenes;
  currentViewingScene = d.scenes.length - 1; // 跳到最新一幕
  renderScripts();
});
socket.on('session:ended', () => { toast('场次已结束','info'); document.getElementById('statusText').textContent='已结束'; });

// ==================== 页面切换 ====================
function showGroupSelection() {
  document.getElementById('stepCode').style.display='none';
  document.getElementById('stepGroup').style.display='block';
  document.getElementById('stepRole').style.display='none';
  document.getElementById('stepScript').style.display='none';
  document.getElementById('statusText').textContent='选择小组';
  const list = document.getElementById('groupSelectList');
  const gs = sessionData.groups;
  if(!gs||!gs.length){list.innerHTML='<div class="empty-state"><div class="icon">👥</div><div class="text">暂无小组</div></div>';return;}
  list.innerHTML=gs.map(g=>'<button class="group-select-item" onclick="selectGroup('+g.id+')"><span>'+escapeHtml(g.name)+'</span><span class="arrow">→</span></button>').join('');
}
function selectGroup(gid) {
  myGroup = sessionData.groups.find(g=>g.id===gid); if(!myGroup) return;
  document.getElementById('stepGroup').style.display='none'; document.getElementById('stepRole').style.display='block';
  document.getElementById('statusText').textContent='选择角色';
  document.getElementById('selectedGroupDisplay').textContent=myGroup.name;
  renderRoles();
}
function renderRoles() {
  const grid = document.getElementById('roleGrid');
  if(!myGroup||!myGroup.roles){grid.innerHTML='<div class="empty-state"><div class="icon">🎭</div><div class="text">暂无角色</div></div>';return;}
  grid.innerHTML=myGroup.roles.map(r=>'<div class="role-card '+(r.occupied?'occupied':'')+'" onclick="selectRole('+r.id+')"><div class="role-name">'+escapeHtml(r.name)+'</div><div class="role-status">'+(r.occupied?'已被选':'可选')+'</div></div>').join('');
}
function selectRole(rid){const r=myGroup.roles.find(x=>x.id===rid);if(!r||r.occupied)return;socket.emit('participant:select_role',{code:sessionCode,groupId:myGroup.id,roleId:rid,name:myName});}
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

// ==================== 横向场景导航 ====================
function prevScene() { if(currentViewingScene>0){currentViewingScene--;renderCurrentScene();} }
function nextScene() {
  const ss=sessionData.session&&sessionData.session.pushedScenes;
  if(ss&currentViewingScene<ss.length-1){currentViewingScene++;renderCurrentScene();}
}

// ==================== 渲染 ====================
function renderScripts() {
  const wr=document.getElementById('waitingRoom');const sc=document.getElementById('scriptContent');
  const badge=document.getElementById('sceneStatusBadge');const ss=sessionData.session&&sessionData.session.pushedScenes;
  const cs=sessionData.session?sessionData.session.currentScene:0;

  // 进度条
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

  // 角色颜色
  const roleClass=myRole?'role-'+({周岚:'zhou',林澈:'lin',阿宁:'a',许岩:'xu',许言:'xu'}[myRole.name]||'default'):'role-default';

  // 角色专属内容
  let roleHtml='';
  if(s.role_content&&myRole){
    const rt=s.role_content[myRole.id];
    if(rt&&rt.trim()){
      const rc=getRoleColor(myRole.name);
      roleHtml='<div class="role-script-block"><div class="role-script-label" style="color:'+rc+'">🎭 你的专属剧本</div><div class="scene-content" style="font-size:14px;color:var(--text-primary);white-space:pre-wrap">'+escapeHtml(rt)+'</div></div>';
    }
  }

  // 对话高亮（按角色染色）
  let displayContent = s.content;
  if(myRole) {
    const names = ['周岚','林澈','阿宁','许言','许岩'];
    names.forEach(name => {
      const color = getRoleColor(name);
      const regex = new RegExp('\\*\\*'+name+'\\*\\*', 'g');
      displayContent = displayContent.replace(regex, '**<span style="color:'+color+';font-weight:700">'+name+'</span>**');
    });
  }

  const card=document.getElementById('sceneCard');
  card.className='scene '+roleClass;
  card.style.animation='fadeInUp 0.3s ease forwards';
  card.innerHTML='<div class="scene-number">第 '+s.scene_number+' 幕'+(currentViewingScene===ss.length-1?' · 最新':'')+'</div><div class="scene-title">'+escapeHtml(s.title)+'</div><div class="scene-content" style="font-size:14px;white-space:pre-wrap">'+displayContent+'</div>'+roleHtml;
}

// ==================== 返回 ====================
function backToCode(){['stepCode','stepGroup','stepRole','stepScript'].forEach((id,i)=>document.getElementById(id).style.display=i===0?'block':'none');document.getElementById('statusText').textContent='输入场次码加入';}
function backToGroup(){document.getElementById('stepGroup').style.display='block';document.getElementById('stepRole').style.display='none';document.getElementById('statusText').textContent='选择小组';}

// ==================== 工具 ====================
function escapeHtml(str){const d=document.createElement('div');d.textContent=str;return d.innerHTML;}

// 恢复上次连接
(function(){try{const s=JSON.parse(localStorage.getItem('salon_session'));if(s&&s.code&&s.name){document.getElementById('codeInput').value=s.code;document.getElementById('nameInput').value=s.name;}}catch(e){}})();
