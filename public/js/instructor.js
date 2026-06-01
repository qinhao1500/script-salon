// ==================== 讲师端 ====================
let sessionCode = null;
let sessionData = { session: null, groups: [], scenes: [], participants: [] };

const ROLE_COLORS = { '周岚':'#B85C3A','林澈':'#E8923A','阿宁':'#3A9E7A','许岩':'#5A8AB5','许言':'#5A8AB5' };
const ROLE_CLASS = { '周岚':'zhou','林澈':'lin','阿宁':'a','许岩':'xu','许言':'xu' };
function getRoleColor(n) { return ROLE_COLORS[n]||'#9A8A7A'; }

// ==================== 密码验证 ====================
(function checkPassword() {
  const pwd = localStorage.getItem('lecturer_pwd') || '123456';
  if (sessionStorage.getItem('lecturer_verified') === 'true') return;
  const div = document.createElement('div');
  div.className = 'modal-overlay';
  div.id = 'pwdModal';
  div.innerHTML = `<div class="modal-box">
    <div class="modal-title">🔒 讲师验证</div>
    <div class="modal-desc">请输入密码进入控制台</div>
    <div class="input-group"><input class="input" id="pwdInput" type="password" inputmode="numeric" placeholder="密码" maxlength="20" autofocus></div>
    <button class="btn btn-primary" id="pwdBtn" style="width:100%;margin:0">验证</button>
    <div style="text-align:center;margin-top:12px"><a href="/participant.html" style="color:var(--text-muted);font-size:13px">我是学员，点此进入</a></div>
  </div>`;
  document.body.appendChild(div);
  document.getElementById('pwdBtn').onclick = function() {
    const input = document.getElementById('pwdInput').value;
    if (input === pwd) {
      sessionStorage.setItem('lecturer_verified', 'true');
      div.remove();
    } else {
      toast('密码错误', 'error');
    }
  };
  setTimeout(() => { const i = document.getElementById('pwdInput'); if(i) i.focus(); }, 300);
})();

// ==================== 断线重连（刷新后恢复场次）====================
(function tryRestoreSession() {
  const saved = localStorage.getItem('instructor_session');
  if (!saved) return;
  try {
    const data = JSON.parse(saved);
    if (!data.code || !data.title) return;
    // 等密码验证完成后恢复
    var waitCount = 0;
    var waitAndRestore = setInterval(function() {
      waitCount++;
      if (sessionStorage.getItem('lecturer_verified') === 'true') {
        clearInterval(waitAndRestore);
        restoreSession(data);
      } else if (waitCount > 150) { // 30秒超时
        clearInterval(waitAndRestore);
      }
    }, 200);
  } catch(e) {}
})();

async function restoreSession(data) {
  // 先检查场次是否还存在
  try {
    const r = await fetch('/api/session/' + data.code + '/full');
    const d = await r.json();
    if (!d.success) {
      localStorage.removeItem('instructor_session');
      return;
    }
    sessionCode = data.code;
    sessionData = { session: d.session, groups: d.groups, scenes: d.scenes, participants: d.participants };
    socket.emit('instructor:join', sessionCode);
    // 恢复 UI
    document.getElementById('codeBanner').style.display = 'block';
    document.getElementById('sessionCode').textContent = sessionCode;
    document.getElementById('pageTitle').textContent = '☕ ' + d.session.title;
    document.getElementById('pageSubtitle').textContent = '场次码: ' + sessionCode;
    document.getElementById('headerActions').style.display = 'block';
    document.getElementById('tabBar').style.display = 'flex';
    document.getElementById('sessionInfo').style.display = 'block';
    document.getElementById('noSessionHint').style.display = 'none';
    document.getElementById('settingsCode').textContent = sessionCode;
    // 在页面顶部显示恢复提示
    const banner = document.createElement('div');
    banner.id = 'restoreBanner';
    banner.className = 'card';
    banner.style.cssText = 'background:rgba(245,166,35,0.1);border-color:var(--accent);text-align:center;padding:12px;margin-bottom:12px';
    banner.innerHTML = '☕ 已恢复上次场次 <strong>' + escapeHtml(d.session.title) + '</strong>（' + sessionCode + '）<br><span style="font-size:12px;color:var(--text-muted)">数据已自动恢复</span>';
    document.getElementById('tabSession').insertBefore(banner, document.getElementById('tabSession').firstChild);
    setTimeout(() => { const b = document.getElementById('restoreBanner'); if(b) b.remove(); }, 5000);
    renderAll();
    toast('已恢复上次场次', 'success');
  } catch(e) {
    console.log('恢复失败:', e);
  }
}

// ==================== 底部导航 ====================
document.querySelectorAll('#tabBar .tab').forEach(tab => {
  tab.addEventListener('click', function() {
    document.querySelectorAll('#tabBar .tab').forEach(t => t.classList.remove('active'));
    this.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(tc => tc.style.display = 'none');
    document.getElementById(this.dataset.tab).style.display = 'block';
  });
});
function switchTab(name) {
  document.querySelectorAll('#tabBar .tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`#tabBar .tab[data-tab="${name}"]`).classList.add('active');
  document.querySelectorAll('.tab-content').forEach(tc => tc.style.display = 'none');
  document.getElementById(name).style.display = 'block';
}

// ==================== 创建场次 ====================
async function createSession() {
  const title = document.getElementById('sessionTitle').value.trim() || '沟通沙龙';
  const btn = document.querySelector('#tabSession .btn-primary');
  btn.textContent='创建中...'; btn.disabled=true;
  try {
    const r = await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})});
    const d = await r.json();
    if(!d.success) throw new Error(d.message);
    afterCreate(d.session);
  }catch(e){toast(e.message,'error')}
  finally{btn.textContent='创建场次';btn.disabled=false}
}

async function createPresetSession() {
  const btn = document.querySelector('#tabSession .btn-secondary');
  btn.textContent='创建中...'; btn.disabled=true;
  try {
    const r = await fetch('/api/preset/salon-621',{method:'POST'});
    const d = await r.json();
    if(!d.success) throw new Error(d.message);
    afterCreate(d.session);
  }catch(e){toast(e.message,'error')}
  finally{btn.textContent='☕ 一键创建「621号店」';btn.disabled=false}
}

function saveSession() {
  if (!sessionCode) return;
  localStorage.setItem('instructor_session', JSON.stringify({
    code: sessionCode,
    title: sessionData.session ? sessionData.session.title : ''
  }));
}

async function loadSessionList() {
  try {
    const r = await fetch('/api/sessions');
    const d = await r.json();
    if (!d.success) return;
    const container = document.getElementById('sessionList');
    const ss = d.sessions || [];
    if (ss.length === 0) { container.innerHTML = '<div class="empty-state" style="padding:8px"><div class="text">暂无场次记录</div></div>'; return; }
    container.innerHTML = ss.map(s => {
      const isCurrent = s.code === sessionCode;
      const statusMap = { 'preparing':'准备中','active':'进行中','ended':'已结束' };
      return '<div class="list-item" style="'+(isCurrent?'border-color:var(--accent);background:rgba(245,166,35,0.04)':'')+'">'+
        '<div class="list-item-label" style="flex-direction:column;align-items:flex-start;gap:2px">'+
          '<span style="font-weight:600;font-size:14px">'+escapeHtml(s.title||'未命名')+'</span>'+
          '<span style="font-size:11px;color:var(--text-muted)">码:'+s.code+' · '+(statusMap[s.status]||s.status)+' · 第'+s.current_scene+'幕</span>'+
        '</div>'+
        '<div style="display:flex;gap:4px">'+
          (isCurrent?'<span class="badge badge-gold" style="font-size:11px">当前</span>':'<button class="btn btn-ghost btn-sm" onclick="switchToSession(\''+s.code+'\')" style="font-size:11px;color:var(--accent-dark)">切换</button>')+
          '<button class="btn btn-ghost btn-sm" onclick="deleteSession(\''+s.code+'\')" style="font-size:11px;color:var(--error)">删除</button>'+
        '</div></div>';
    }).join('');
  } catch(e) {}
}

async function switchToSession(code) {
  if (!confirm('切换到场次 '+code+'？当前未保存的进度将丢失。')) return;
  localStorage.setItem('instructor_session', JSON.stringify({ code, title: '' }));
  location.reload();
}

async function deleteSession(code) {
  if (!confirm('确定删除场次 '+code+'？')) return;
  try {
    await fetch('/api/session/'+code, { method: 'DELETE' });
    if (sessionCode === code) {
      localStorage.removeItem('instructor_session');
      resetView();
    }
    loadSessionList();
    toast('已删除','info');
  } catch(e) { toast('删除失败','error'); }
}

function afterCreate(session) {
  sessionCode = session.code;
  sessionData.session = { code:sessionCode, id:session.id, title:session.title, current_scene:0 };
  saveSession();
  loadSessionList();
  socket.emit('instructor:join', sessionCode);
  document.getElementById('codeBanner').style.display='block';
  document.getElementById('sessionCode').textContent=sessionCode;
  document.getElementById('pageTitle').textContent=session.title;
  document.getElementById('pageSubtitle').textContent='场次码: '+sessionCode;
  document.getElementById('headerActions').style.display='block';
  document.getElementById('tabBar').style.display='flex';
  document.getElementById('sessionInfo').style.display='block';
  document.getElementById('noSessionHint').style.display='none';
  document.getElementById('settingsCode').textContent=sessionCode;
  document.getElementById('pageTitle').textContent='☕ '+session.title;
  switchTab('tabSession');
  toast('场次创建成功！','success');
}

// ==================== Socket 事件 ====================
socket.on('instructor:init', (data) => {
  sessionData.groups=data.groups||[]; sessionData.scenes=data.scenes||[]; sessionData.participants=data.participants||[];
  renderAll();
});
socket.on('session_updated', (data) => {
  if(data.groups) fetchFullData();
  if(data.roles){const g=sessionData.groups.find(g=>g.id===data.roles.groupId);if(g)g.roles=data.roles.roles;renderRoles();}
  if(data.scenes){sessionData.scenes=data.scenes;renderScenes();renderSceneControls();}
  saveSession();
});
socket.on('participants_updated',(d)=>{sessionData.participants=d.participants;renderParticipants();renderSceneControls();saveSession();});
socket.on('scene:pushed',(d)=>{sessionData.session.current_scene=d.currentScene;renderSceneControls();saveSession();});
socket.on('session:ended',()=>{toast('场次已结束','info');resetView();loadSessionList();});

async function fetchFullData() {
  if(!sessionCode)return;
  try{const r=await fetch('/api/session/'+sessionCode+'/full');const d=await r.json();if(d.success){sessionData.groups=d.groups||[];sessionData.scenes=d.scenes||[];sessionData.participants=d.participants||[];renderAll();}}catch(e){}
}

// ==================== 小组/角色管理 ====================
async function addGroup() {
  const n=document.getElementById('groupInput').value.trim(); if(!n){toast('请输入名称','error');return;}
  try{const r=await fetch('/api/session/'+sessionCode+'/group',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})});const d=await r.json();if(d.success){document.getElementById('groupInput').value='';toast('已添加','success');}}catch(e){toast('添加失败','error')}
}
async function deleteGroup(id){if(!confirm('确定删除？'))return;try{await fetch('/api/session/'+sessionCode+'/group/'+id,{method:'DELETE'});toast('已删除','info');}catch(e){}}
async function addRole(gid){const n=document.getElementById('roleInput_'+gid).value.trim();if(!n){toast('请输入角色名称','error');return;}
  try{const r=await fetch('/api/session/'+sessionCode+'/role',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId:gid,name:n})});const d=await r.json();if(d.success){document.getElementById('roleInput_'+gid).value='';toast('已添加','success');}}catch(e){toast('添加失败','error')}
}
async function deleteRole(rid){if(!confirm('确定删除？'))return;try{await fetch('/api/session/'+sessionCode+'/role/'+rid,{method:'DELETE'});toast('已删除','info');}catch(e){}}

// ==================== 剧本管理 ====================
async function addScene() {
  const t=document.getElementById('sceneTitle').value.trim();const c=document.getElementById('sceneContent').value.trim();
  if(!t||!c){toast('请填写标题和内容','error');return;}
  try{const r=await fetch('/api/session/'+sessionCode+'/scene',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:t,content:c})});const d=await r.json();if(d.success){document.getElementById('sceneTitle').value='';document.getElementById('sceneContent').value='';toast('已添加','success');}}catch(e){toast('添加失败','error')}
}
async function deleteScene(sid){if(!confirm('确定删除？'))return;try{await fetch('/api/session/'+sessionCode+'/scene/'+sid,{method:'DELETE'});toast('已删除','info');}catch(e){}}
async function moveScene(sid,dir){
  try{await fetch('/api/session/'+sessionCode+'/scene/'+sid+'/move',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({direction:dir})});}catch(e){toast('移动失败','error')}
}
async function insertAfter(sid){
  const t=prompt('输入新幕次的标题：'); if(!t)return;
  const c=prompt('输入新幕次的内容：'); if(!c)return;
  try{const r=await fetch('/api/session/'+sessionCode+'/scene/insert-after',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({afterSceneId:sid,title:t,content:c})});const d=await r.json();if(d.success)toast('已插入','success');}catch(e){toast('插入失败','error')}
}

// ==================== 推送控制 ====================
function pushScene(n){if(!confirm('确定推送第'+n+'幕？'))return;socket.emit('instructor:push_scene',{code:sessionCode,sceneNumber:n});toast('第'+n+'幕已推送','success');}
function endSession(){
  if(!confirm('确定结束场次？'))return;
  localStorage.removeItem('instructor_session');
  socket.emit('instructor:end',sessionCode);
}
function copyCode(){
  if(navigator.clipboard)navigator.clipboard.writeText(sessionCode).then(()=>toast('已复制','success'));
  else{const ta=document.createElement('textarea');ta.value=sessionCode;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();toast('已复制','success');}
}

// ==================== 编辑弹窗 ====================
let editingSceneId=null;
function editScene(sid){
  const s=sessionData.scenes.find(x=>x.id===sid); if(!s)return;
  editingSceneId=sid;
  document.getElementById('editSceneTitle').value=s.title||'';
  document.getElementById('editSceneContent').value=s.content||'';
  let html='';
  (sessionData.groups||[]).forEach(g=>(g.roles||[]).forEach(r=>{
    const t=(s.role_content&&s.role_content[r.id])||'';
    html+=`<div style="margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid var(--divider)">
      <label style="font-size:12px;font-weight:600;color:${getRoleColor(r.name)};display:block;margin-bottom:4px">🎭 ${g.name} · ${r.name}</label>
      <textarea class="input" id="editRoleContent_${r.id}" rows="3" style="font-size:13px">${escapeHtml(t)}</textarea></div>`;
  }));
  document.getElementById('editRoleContentList').innerHTML=html;
  document.getElementById('editSceneModal').style.display='flex';
}
function closeEditScene(){document.getElementById('editSceneModal').style.display='none';editingSceneId=null;}
async function saveEditScene(){
  if(!editingSceneId)return;
  const t=document.getElementById('editSceneTitle').value.trim();const c=document.getElementById('editSceneContent').value.trim();
  if(!t||!c){toast('请填写完整','error');return;}
  const rc={};(sessionData.groups||[]).forEach(g=>(g.roles||[]).forEach(r=>{
    const ta=document.getElementById('editRoleContent_'+r.id);if(ta&&ta.value.trim())rc[r.id]=ta.value.trim();
  }));
  try{const r=await fetch('/api/session/'+sessionCode+'/scene/'+editingSceneId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:t,content:c,roleContent:rc})});const d=await r.json();if(d.success){toast('已保存','success');closeEditScene();}}catch(e){toast('保存失败','error')}
}

// ==================== 设置 ====================
function changePassword(){
  const p=document.getElementById('newPwdInput').value.trim();
  if(!p||p.length<4){toast('密码至少4位','error');return;}
  localStorage.setItem('lecturer_pwd',p);
  toast('密码已修改','success');
  document.getElementById('newPwdInput').value='';
}

function resetView(){
  sessionCode=null;sessionData={session:null,groups:[],scenes:[],participants:[]};
  document.getElementById('codeBanner').style.display='none';
  document.getElementById('sessionInfo').style.display='none';
  document.getElementById('noSessionHint').style.display='block';
  document.getElementById('tabBar').style.display='none';
  document.getElementById('headerActions').style.display='none';
  document.getElementById('pageTitle').textContent='☕ 讲师控制台';
  document.getElementById('pageSubtitle').textContent='管理你的场次';
}

// ==================== 渲染 ====================
function renderAll(){renderGroups();renderRoles();renderScenes();renderParticipants();renderSceneControls();}

function renderGroups(){
  const gs=sessionData.groups||[];
  document.getElementById('groupEmpty').style.display=gs.length?'none':'block';
  document.getElementById('groupList').innerHTML=gs.map(g=>`<div class="list-item"><div class="list-item-label"><span>👥</span><span>${escapeHtml(g.name)}</span><span class="badge">${(g.roles||[]).length}角色</span></div><button class="btn btn-ghost btn-sm" onclick="deleteGroup(${g.id})" style="color:var(--error)">删除</button></div>`).join('');
}

function renderRoles(){
  const gs=sessionData.groups||[];
  if(!gs.length){document.getElementById('rolesContent').innerHTML='<div class="empty-state" style="padding:12px"><div class="text">请先添加小组</div></div>';return;}
  document.getElementById('rolesContent').innerHTML=gs.map(g=>{
    const rs=g.roles||[];
    return `<div style="margin-bottom:10px;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid var(--divider)">
      <div style="font-size:13px;font-weight:600;margin-bottom:6px">${escapeHtml(g.name)} <span class="badge">${rs.length}</span></div>
      <div class="inline-form"><input class="input" id="roleInput_${g.id}" placeholder="角色名称" maxlength="20" style="font-size:13px"><button class="btn btn-primary btn-sm" onclick="addRole(${g.id})">添加</button></div>
      ${rs.length?`<div class="list">${rs.map(r=>`<div class="list-item"><div class="list-item-label"><span style="color:${getRoleColor(r.name)}">◆</span><span>${escapeHtml(r.name)}</span></div><button class="btn btn-ghost btn-sm" onclick="deleteRole(${r.id})" style="color:var(--text-muted)">✕</button></div>`).join('')}</div>`:'<div style="font-size:12px;color:var(--text-muted);padding:4px 0">暂无角色</div>'}
    </div>`;
  }).join('');
}

function renderScenes(){
  const ss=sessionData.scenes||[];
  document.getElementById('sceneEmpty').style.display=ss.length?'none':'block';
  if(ss.length) document.getElementById('tabScript').querySelector('.card').style.display='block';
  document.getElementById('sceneList').innerHTML=ss.map((s,i)=>{
    const hasRole=s.role_content&&Object.keys(s.role_content).length>0;
    return `<div class="scene" style="animation:none;opacity:1">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div><div class="scene-number">第${s.scene_number}幕</div><div class="scene-title" style="font-size:16px">${escapeHtml(s.title)}</div></div>
        <div class="scene-order-controls">
          <button class="scene-order-btn" onclick="moveScene(${s.id},'up')" ${i===0?'disabled style="opacity:0.3"':''}>↑</button>
          <button class="scene-order-btn" onclick="moveScene(${s.id},'down')" ${i===ss.length-1?'disabled style="opacity:0.3"':''}>↓</button>
          <button class="scene-order-btn insert" onclick="insertAfter(${s.id})" title="在此后插入">+</button>
        </div>
      </div>
      <div class="scene-content" style="font-size:13px;max-height:80px;overflow:hidden">${escapeHtml(s.content)}</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn btn-ghost btn-sm" onclick="editScene(${s.id})" style="color:var(--accent-dark)">✏️ 编辑</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteScene(${s.id})" style="color:var(--error)">🗑 删除</button>
        ${hasRole?`<span style="font-size:11px;color:var(--success);align-self:center">🎭 含角色内容</span>`:''}
      </div>
    </div>`;
  }).join('');
}

function renderProgressBar(scenes, currentScene) {
  var c=document.getElementById('progressBarContainer');var b=document.getElementById('progressBar');
  if(!c||!b)return;
  if(!scenes||!scenes.length){c.style.display='none';return;}
  c.style.display='block';
  var colors = ['#B85C3A','#E8923A','#3A9E7A','#5A8AB5','#9A6A7A'];
  var html = '';
  for(var i = 0; i < scenes.length; i++) {
    var n = i+1; var isActive = n===currentScene; var isDone = n<=currentScene;
    var color = colors[i % colors.length];
    var cls = 'progress-dot'; if(isActive) cls+=' active'; else if(isDone) cls+=' done';
    var dotStyle = isDone ? 'background:'+color+';border-color:'+color : isActive ? 'background:'+color+';border-color:'+color : '';
    html += '<div class="'+cls+'" style="cursor:pointer;'+dotStyle+'" title="第'+n+'幕"></div>';
    if(i < scenes.length-1) {
      var lineCls = n<=currentScene ? 'progress-line done' : 'progress-line';
      if(n<=currentScene) html += '<div class="'+lineCls+'" style="background:'+color+'"></div>';
      else html += '<div class="'+lineCls+'"></div>';
    }
  }
  b.innerHTML = html;
}

function renderSceneControls(){
  const c=document.getElementById('sceneControls');const e=document.getElementById('sceneControlsEmpty');
  const ss=sessionData.scenes;const cs=sessionData.session?sessionData.session.current_scene:0;
  renderProgressBar(ss,cs);
  if(!ss||!ss.length){c.innerHTML='';e.style.display='block';return;}
  e.style.display='none';
  c.innerHTML=ss.map(s=>{
    const pushed=s.scene_number<=cs;const isCurrent=s.scene_number===cs;
    let st='待推送',sc='';if(isCurrent){st='展示中';sc='current';}else if(pushed){st='已推送';sc='pushed';}
    return `<button class="scene-btn ${sc}" onclick="pushScene(${s.scene_number})" ${pushed?'disabled':''}>
      <div class="scene-btn-num">${s.scene_number}</div>
      <div class="scene-btn-info"><div class="scene-btn-title">${escapeHtml(s.title)}</div><div class="scene-btn-status">${st}</div></div>
      ${!pushed?'<span style="color:var(--accent);font-size:13px;font-weight:600">推送 →</span>':(isCurrent?'<span style="color:var(--accent-dark);font-size:16px">✦</span>':'<span style="color:var(--success);font-size:16px">✓</span>')}
    </button>`;
  }).join('');
}

function renderParticipants(){
  const c=document.getElementById('participantList');const ct=document.getElementById('participantCount');
  const ps=sessionData.participants;ct.textContent=ps?ps.length:0;
  if(!ps||!ps.length){c.innerHTML='<div class="empty-state" style="padding:12px"><div class="icon" style="font-size:20px">👤</div><div class="text">暂无学员加入</div></div>';return;}
  const bg={};ps.forEach(p=>{if(!bg[p.group_name])bg[p.group_name]=[];bg[p.group_name].push(p);});
  c.innerHTML=Object.keys(bg).map(gn=>`<div class="participant-group"><div class="participant-group-title">${escapeHtml(gn)}</div><div class="participant-list">${bg[gn].map(p=>`<div class="participant-chip"><span class="dot" style="background:${getRoleColor(p.role_name)}"></span>${escapeHtml(p.name)}<span class="role-tag" style="color:${getRoleColor(p.role_name)}">· ${escapeHtml(p.role_name)}</span></div>`).join('')}</div></div>`).join('');
}

// ==================== 工具 ====================
function escapeHtml(str){const d=document.createElement('div');d.textContent=str;return d.innerHTML;}
