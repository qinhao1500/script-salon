const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ==================== 数据库 ====================
const db = new Database(path.join(__dirname, 'salon.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    current_scene INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'preparing',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS groups_t (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    FOREIGN KEY (group_id) REFERENCES groups_t(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    scene_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    round_type TEXT NOT NULL DEFAULT 'script',
    full_dialogue TEXT DEFAULT '',
    task_content TEXT DEFAULT '',
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scene_role_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS hidden_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    tier INTEGER NOT NULL CHECK(tier IN (1,2,3)),
    content TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS unlock_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL,
    scene_id INTEGER NOT NULL,
    tier INTEGER NOT NULL CHECK(tier IN (1,2,3)),
    unlocked INTEGER NOT NULL DEFAULT 0,
    unlocked_at DATETIME,
    FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
    FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups_t(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  );
`);

// 数据库迁移：为旧表添加新字段（兼容已有数据库）
try { db.exec("ALTER TABLE scenes ADD COLUMN round_type TEXT NOT NULL DEFAULT 'script'"); } catch(e) {}
try { db.exec("ALTER TABLE scenes ADD COLUMN full_dialogue TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE scenes ADD COLUMN task_content TEXT DEFAULT ''"); } catch(e) {}

// 预编译语句
const stmts = {
  createSession: db.prepare('INSERT INTO sessions (code, title) VALUES (?, ?)'),
  getSessionByCode: db.prepare('SELECT * FROM sessions WHERE code = ?'),
  getGroups: db.prepare('SELECT * FROM groups_t WHERE session_id = ? ORDER BY sort_order'),
  addGroup: db.prepare('INSERT INTO groups_t (session_id, name, sort_order) VALUES (?, ?, ?)'),
  deleteGroup: db.prepare('DELETE FROM groups_t WHERE id = ? AND session_id = ?'),
  addRole: db.prepare('INSERT INTO roles (group_id, session_id, name, description) VALUES (?, ?, ?, ?)'),
  getRolesByGroup: db.prepare('SELECT * FROM roles WHERE group_id = ? AND session_id = ?'),
  deleteRole: db.prepare('DELETE FROM roles WHERE id = ? AND session_id = ?'),
  addScene: db.prepare('INSERT INTO scenes (session_id, scene_number, title, content, round_type, full_dialogue, task_content) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  getScenes: db.prepare('SELECT * FROM scenes WHERE session_id = ? ORDER BY scene_number'),
  deleteScene: db.prepare('DELETE FROM scenes WHERE id = ? AND session_id = ?'),
  addSceneRoleContent: db.prepare('INSERT OR REPLACE INTO scene_role_content (scene_id, role_id, content) VALUES (?, ?, ?)'),
  getSceneRoleContent: db.prepare('SELECT * FROM scene_role_content WHERE scene_id = ?'),
  setCurrentScene: db.prepare('UPDATE sessions SET current_scene = ? WHERE code = ?'),
  addParticipant: db.prepare('INSERT OR REPLACE INTO participants (session_id, group_id, role_id, name) VALUES (?, ?, ?, ?)'),
  removeParticipant: db.prepare('DELETE FROM participants WHERE role_id = ? AND session_id = ?'),
  getParticipants: db.prepare('SELECT p.*, g.name as group_name, r.name as role_name FROM participants p JOIN groups_t g ON p.group_id = g.id JOIN roles r ON p.role_id = r.id WHERE p.session_id = ? ORDER BY g.sort_order, p.joined_at'),
  getParticipantByRole: db.prepare('SELECT * FROM participants WHERE role_id = ? AND session_id = ?'),
  isRoleOccupied: db.prepare('SELECT COUNT(*) as cnt FROM participants WHERE role_id = ? AND session_id = ?'),
  getMaxSortOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM groups_t WHERE session_id = ?'),
  getMaxSceneNumber: db.prepare('SELECT COALESCE(MAX(scene_number), 0) as max FROM scenes WHERE session_id = ?'),
  updateSessionStatus: db.prepare('UPDATE sessions SET status = ? WHERE code = ?'),
  addHiddenInfo: db.prepare('INSERT INTO hidden_info (scene_id, role_id, tier, content) VALUES (?, ?, ?, ?)'),
  getHiddenInfo: db.prepare('SELECT * FROM hidden_info WHERE scene_id = ? AND role_id = ? ORDER BY tier'),
  getHiddenInfoByScene: db.prepare('SELECT * FROM hidden_info WHERE scene_id = ? ORDER BY role_id, tier'),
  deleteHiddenInfo: db.prepare('DELETE FROM hidden_info WHERE scene_id = ?'),
  addUnlockRecord: db.prepare("INSERT OR REPLACE INTO unlock_records (participant_id, scene_id, tier, unlocked, unlocked_at) VALUES (?, ?, ?, 1, datetime('now'))"),
  getUnlockRecord: db.prepare('SELECT * FROM unlock_records WHERE participant_id = ? AND scene_id = ? AND tier = ?'),
  getParticipantUnlocks: db.prepare('SELECT * FROM unlock_records WHERE participant_id = ? AND scene_id = ?'),
  updateSceneType: db.prepare('UPDATE scenes SET round_type = ?, full_dialogue = ? WHERE id = ?'),
};

// 生成4位数字场次码
function generateCode() {
  while (true) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const exists = db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE code = ?').get(code);
    if (exists.cnt === 0) return code;
  }
}

// ==================== 中间件 ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== REST API ====================

// 获取所有场次列表
app.get('/api/sessions', (req, res) => {
  const sessions = db.prepare('SELECT id, code, title, status, current_scene, created_at FROM sessions ORDER BY created_at DESC LIMIT 50').all();
  res.json({ success: true, sessions });
});

// 删除场次
app.delete('/api/session/:code', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  db.prepare('DELETE FROM sessions WHERE code = ?').run(req.params.code);
  res.json({ success: true });
});

// 创建场次
app.post('/api/session', (req, res) => {
  const { title } = req.body;
  const code = generateCode();
  stmts.createSession.run(code, title || '未命名场次');
  const session = stmts.getSessionByCode.get(code);
  res.json({ success: true, session });
});

// 获取场次信息
app.get('/api/session/:code', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  res.json({ success: true, session });
});

// 辅助：给场景附加角色专属内容
function enrichSceneWithRoleContent(scene, sessionId) {
  const roleContents = stmts.getSceneRoleContent.all(scene.id);
  const roleContentMap = {};
  roleContents.forEach(rc => {
    roleContentMap[rc.role_id] = rc.content;
  });
  return { ...scene, role_content: roleContentMap };
}

// 获取场次完整数据（讲师端用）
app.get('/api/session/:code/full', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const groups = stmts.getGroups.all(session.id);
  const groupsWithRoles = groups.map(g => ({
    ...g,
    roles: stmts.getRolesByGroup.all(g.id, session.id)
  }));
  const scenes = stmts.getScenes.all(session.id).map(s => enrichSceneWithRoleContent(s, session.id));
  const participants = stmts.getParticipants.all(session.id);
  res.json({ success: true, session, groups: groupsWithRoles, scenes, participants });
});

// 获取场次公开信息（学员端用）
app.get('/api/session/:code/public', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const groups = stmts.getGroups.all(session.id);
  const groupsWithRoles = groups.map(g => {
    const roles = stmts.getRolesByGroup.all(g.id, session.id);
    return {
      ...g,
      roles: roles.map(r => ({
        ...r,
        occupied: stmts.isRoleOccupied.get(r.id, session.id).cnt > 0
      }))
    };
  });
  const scenes = stmts.getScenes.all(session.id).map(s => enrichSceneWithRoleContent(s, session.id));
  const currentScene = session.current_scene;
  const pushedScenes = scenes.filter(s => s.scene_number <= currentScene);
  res.json({ success: true, session: { ...session, pushedScenes }, groups: groupsWithRoles });
});

// 修改场次标题
app.put('/api/session/:code/title', (req, res) => {
  const { title } = req.body;
  db.prepare('UPDATE sessions SET title = ? WHERE code = ?').run(title, req.params.code);
  res.json({ success: true });
});

// 添加小组
app.post('/api/session/:code/group', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const { name } = req.body;
  const maxOrder = stmts.getMaxSortOrder.get(session.id).max;
  stmts.addGroup.run(session.id, name, maxOrder + 1);
  const groups = stmts.getGroups.all(session.id);
  io.to(`session:${req.params.code}`).emit('session_updated', { groups });
  res.json({ success: true, groups });
});

// 删除小组
app.delete('/api/session/:code/group/:groupId', (req, res) => {
  stmts.deleteGroup.run(req.params.groupId, req.params.code);
  const session = stmts.getSessionByCode.get(req.params.code);
  const groups = stmts.getGroups.all(session.id);
  io.to(`session:${req.params.code}`).emit('session_updated', { groups });
  res.json({ success: true, groups });
});

// 添加角色
app.post('/api/session/:code/role', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const { groupId, name, description } = req.body;
  stmts.addRole.run(groupId, session.id, name, description || '');
  const roles = stmts.getRolesByGroup.all(groupId, session.id);
  io.to(`session:${req.params.code}`).emit('session_updated', { roles: { groupId, roles } });
  res.json({ success: true, roles });
});

// 删除角色
app.delete('/api/session/:code/role/:roleId', (req, res) => {
  const role = db.prepare('SELECT group_id FROM roles WHERE id = ? AND session_id = (SELECT id FROM sessions WHERE code = ?)').get(req.params.roleId, req.params.code);
  stmts.deleteRole.run(req.params.roleId, req.params.code);
  if (role) {
    const roles = stmts.getRolesByGroup.all(role.group_id, req.params.code);
    io.to(`session:${req.params.code}`).emit('session_updated', { roles: { groupId: role.group_id, roles } });
  }
  res.json({ success: true });
});

// ==================== 隐藏信息 API ====================

// 获取角色的隐藏信息（含锁定状态）
app.get('/api/session/:code/hidden-info/:roleId', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const sceneNumber = parseInt(req.query.scene) || session.current_scene;
  const scene = db.prepare('SELECT * FROM scenes WHERE session_id = ? AND scene_number = ?').get(session.id, sceneNumber);
  if (!scene) return res.json({ success: true, hidden_info: [] });
  const hiddenInfo = stmts.getHiddenInfo.all(scene.id, parseInt(req.params.roleId));
  const participant = db.prepare('SELECT * FROM participants WHERE role_id = ? AND session_id = ?').get(parseInt(req.params.roleId), session.id);
  let unlockStatus = {};
  if (participant) {
    const records = stmts.getParticipantUnlocks.all(participant.id, scene.id);
    records.forEach(r => { unlockStatus[r.tier] = r.unlocked; });
  }
  const result = hiddenInfo.map(h => ({...h, unlocked: unlockStatus[h.tier] || false }));
  res.json({ success: true, hidden_info: result });
});

// 学员自检解锁
app.post('/api/session/:code/unlock', (req, res) => {
  const { roleId, sceneNumber, tier } = req.body;
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const scene = db.prepare('SELECT * FROM scenes WHERE session_id = ? AND scene_number = ?').get(session.id, sceneNumber);
  if (!scene) return res.status(404).json({ success: false, message: '场景不存在' });
  const participant = db.prepare('SELECT * FROM participants WHERE role_id = ? AND session_id = ?').get(roleId, session.id);
  if (!participant) return res.status(404).json({ success: false, message: '参与者不存在' });
  stmts.addUnlockRecord.run(participant.id, scene.id, tier);
  io.to('session:' + req.params.code).emit('unlock_updated', { roleId, sceneNumber, tier, unlocked: true });
  res.json({ success: true });
});

// 讲师全组信息解禁
app.post('/api/session/:code/unlock-all', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const participants = stmts.getParticipants.all(session.id);
  const scenes = stmts.getScenes.all(session.id);
  const unlockAll = db.transaction(() => {
    participants.forEach(p => {
      scenes.forEach(s => {
        for (let tier = 1; tier <= 3; tier++) {
          try { stmts.addUnlockRecord.run(p.id, s.id, tier); } catch(e) {}
        }
      });
    });
  });
  unlockAll();
  io.to('session:' + req.params.code).emit('all_unlocked');
  res.json({ success: true, message: '全部信息已解禁' });
});

// 讲师紧急解锁
app.post('/api/session/:code/emergency-unlock', (req, res) => {
  const { roleId } = req.body;
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const participant = db.prepare('SELECT * FROM participants WHERE role_id = ? AND session_id = ?').get(roleId, session.id);
  if (!participant) return res.status(404).json({ success: false, message: '参与者不存在' });
  const scenes = stmts.getScenes.all(session.id);
  scenes.forEach(s => {
    for (let tier = 1; tier <= 3; tier++) {
      try { stmts.addUnlockRecord.run(participant.id, s.id, tier); } catch(e) {}
    }
  });
  io.to('session:' + req.params.code).emit('unlock_updated', { roleId, emergency: true });
  res.json({ success: true, message: '已紧急解锁' });
});

// 更新场景类型和完整对白
app.put('/api/session/:code/scene/:sceneId', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const { round_type, full_dialogue } = req.body;
  stmts.updateSceneType.run(round_type || 'script', full_dialogue || '', parseInt(req.params.sceneId));
  if (req.body.hidden_info && Array.isArray(req.body.hidden_info)) {
    stmts.deleteHiddenInfo.run(parseInt(req.params.sceneId));
    const insertHidden = db.transaction((items) => {
      for (const h of items) {
        stmts.addHiddenInfo.run(parseInt(req.params.sceneId), h.role_id, h.tier, h.content);
      }
    });
    insertHidden(req.body.hidden_info);
  }
  res.json({ success: true });
});


// 添加剧本幕次（支持角色专属内容）
app.post('/api/session/:code/scene', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const { title, content, roleContent } = req.body;
  const maxScene = stmts.getMaxSceneNumber.get(session.id).max;
  const result = stmts.addScene.run(session.id, maxScene + 1, title, content);
  const sceneId = result.lastInsertRowid;
  // 保存角色专属内容
  if (roleContent && typeof roleContent === 'object') {
    const insertMany = db.transaction((entries) => {
      for (const [roleId, text] of Object.entries(entries)) {
        if (text && text.trim()) {
          stmts.addSceneRoleContent.run(sceneId, parseInt(roleId), text);
        }
      }
    });
    insertMany(Object.entries(roleContent));
  }
  const scenes = stmts.getScenes.all(session.id).map(s => enrichSceneWithRoleContent(s, session.id));
  io.to(`session:${req.params.code}`).emit('session_updated', { scenes });
  res.json({ success: true, scenes });
});

// 更新剧本幕次（支持编辑标题、内容、角色专属内容）
app.put('/api/session/:code/scene/:sceneId', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const { title, content } = req.body;
  db.prepare('UPDATE scenes SET title = ?, content = ? WHERE id = ? AND session_id = ?').run(title, content, req.params.sceneId, session.id);
  // 更新角色专属内容
  if (req.body.roleContent && typeof req.body.roleContent === 'object') {
    for (const [roleId, text] of Object.entries(req.body.roleContent)) {
      if (text && text.trim()) {
        stmts.addSceneRoleContent.run(parseInt(req.params.sceneId), parseInt(roleId), text);
      }
    }
  }
  const scenes = stmts.getScenes.all(session.id).map(s => enrichSceneWithRoleContent(s, session.id));
  io.to(`session:${req.params.code}`).emit('session_updated', { scenes });
  res.json({ success: true, scenes });
});

// 删除剧本幕次
app.delete('/api/session/:code/scene/:sceneId', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const deletedScene = db.prepare('SELECT scene_number FROM scenes WHERE id = ? AND session_id = ?').get(req.params.sceneId, session.id);
  if (!deletedScene) return res.status(404).json({ success: false, message: '场景不存在' });
  stmts.deleteScene.run(req.params.sceneId, req.params.code);
  // 重新编号
  const remaining = stmts.getScenes.all(session.id);
  db.transaction(() => {
    remaining.forEach((s, i) => {
      db.prepare('UPDATE scenes SET scene_number = ? WHERE id = ?').run(i + 1, s.id);
    });
  })();
  const scenes = stmts.getScenes.all(session.id).map(s => enrichSceneWithRoleContent(s, session.id));
  io.to(`session:${req.params.code}`).emit('session_updated', { scenes });
  res.json({ success: true, scenes });
});

// 场景上移/下移
app.put('/api/session/:code/scene/:sceneId/move', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const { direction } = req.body; // 'up' or 'down'
  const scenes = stmts.getScenes.all(session.id);
  const idx = scenes.findIndex(s => s.id === parseInt(req.params.sceneId));
  if (idx === -1) return res.status(404).json({ success: false, message: '场景不存在' });
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= scenes.length) return res.json({ success: true, scenes: scenes.map(s => enrichSceneWithRoleContent(s, session.id)) });
  db.transaction(() => {
    db.prepare('UPDATE scenes SET scene_number = ? WHERE id = ?').run(scenes[swapIdx].scene_number, scenes[idx].id);
    db.prepare('UPDATE scenes SET scene_number = ? WHERE id = ?').run(scenes[idx].scene_number, scenes[swapIdx].id);
  })();
  const updatedScenes = stmts.getScenes.all(session.id).map(s => enrichSceneWithRoleContent(s, session.id));
  io.to(`session:${req.params.code}`).emit('session_updated', { scenes: updatedScenes });
  res.json({ success: true, scenes: updatedScenes });
});

// 在指定场景后插入新场景
app.post('/api/session/:code/scene/insert-after', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const { afterSceneId, title, content } = req.body;
  if (!title || !content) return res.status(400).json({ success: false, message: '缺少标题或内容' });
  const scenes = stmts.getScenes.all(session.id);
  const afterIdx = scenes.findIndex(s => s.id === afterSceneId);
  const insertPosition = afterIdx === -1 ? scenes.length : afterIdx + 1;
  db.transaction(() => {
    // 将insertPosition及之后的场景编号后移
    for (let i = scenes.length - 1; i >= insertPosition; i--) {
      db.prepare('UPDATE scenes SET scene_number = ? WHERE id = ?').run(scenes[i].scene_number + 1, scenes[i].id);
    }
    stmts.addScene.run(session.id, insertPosition + 1, title, content);
  })();
  const updatedScenes = stmts.getScenes.all(session.id).map(s => enrichSceneWithRoleContent(s, session.id));
  io.to(`session:${req.params.code}`).emit('session_updated', { scenes: updatedScenes });
  res.json({ success: true, scenes: updatedScenes });
});

// ==================== 预设沙龙 API ====================

// 一键创建喙语621号店预设沙龙（完整剧本内容）
app.post('/api/preset/salon-621', (req, res) => {
  const code = generateCode();
  const title = '喙语621号店 · 沟通剧本杀沙龙';
  
  stmts.createSession.run(code, title);
  const session = stmts.getSessionByCode.get(code);
  const sessionId = session.id;

  stmts.addGroup.run(sessionId, '第一组', 1);
  const group = stmts.getGroups.all(sessionId)[0];
  const groupId = group.id;

  const roleDefs = [
    { name: '周岚', desc: '主理人 · 12年。不反对变化，但反对仓促决定。' },
    { name: '林澈', desc: '推动者 · 近两年。店必须动起来。' },
    { name: '阿宁', desc: '老员工 · 4年。很多事不是不能做，是最后都变成临时来。' },
    { name: '许言', desc: '本地撰稿人 · 5年前写过一篇报道。外部资源解决不了内部问题。' },
  ];
  roleDefs.forEach(r => { stmts.addRole.run(groupId, sessionId, r.name, r.desc); });
  const roles = stmts.getRolesByGroup.all(groupId, sessionId);
  const roleIds = {};
  roles.forEach(r => { roleIds[r.name] = r.id; });

  const insertScene = db.transaction((snum, title, content, roundType, fullDialogue, taskContent, roleContentMap) => {
    const r = stmts.addScene.run(sessionId, snum, title, content, roundType||'script', fullDialogue||'', taskContent||'');
    const sceneId = r.lastInsertRowid;
    if (roleContentMap) {
      for (const [roleName, text] of Object.entries(roleContentMap)) {
        if (roleName === '_hiddenInfo' || !text || !text.trim() || !roleIds[roleName]) continue;
        stmts.addSceneRoleContent.run(sceneId, roleIds[roleName], text);
      }
      if (roleContentMap._hiddenInfo) {
        for (const h of roleContentMap._hiddenInfo) {
          if (roleIds[h.role] && h.content && h.content.trim()) {
            stmts.addHiddenInfo.run(sceneId, roleIds[h.role], h.tier, h.content);
          }
        }
      }
    }
    return sceneId;
  });

  insertScene(1, '第1环节：开场 · 角色认领', '【讲师开场】\n\n各位晚上好，欢迎来到喙语621号店。\n\n在正式开始之前，我想先问一个小问题——在你的心里，有没有一家你舍不得它关门的店？不用回答，心里想一下就行。\n\n今天晚上我们要一起走进一家开了十二年的小店。明天房东就要来问最后决定了——是续租、转型、还是关门。今晚，所有和这家店命运相关的人都被叫了回来。\n\n你们就是这些人。\n\n请看手机——你收到了你的角色信息。先弄清楚三件事：你是谁、你怎么看待这家店、今晚你最想争取什么。', 'discussion', '', '', null);
  insertScene(2, '第2环节 · 第1幕：灯还亮着', '', 'script', '**周岚**（手指轻轻压着桌上的本子，语气尽量平稳，但能听出疲惫）：\n「人都到齐了吧。那我直说了——明天房东要来，要我们给一个最后答复。续租、转型、还是关门。今晚必须定下来。」\n（她停了停，目光扫过所有人）\n「我先表个态——我不是不让大家提想法，但这家店不是说改就改的。至少，我们得先想清楚，到底要守住什么。」\n\n**林澈**（身体微微前倾，语速偏快，像是已经等这句话很久了）：\n「那我先来。再拖下去店就真的没了。这两个月我们错过了至少两次机会——不是没人提方案，是一到关键处就卡住。」\n（他呼了一口气，压着火）\n「我不是来吵架的。但我觉得我们现在的问题不是缺想法，是已经拖不起了。」\n\n**阿宁**（原本靠在椅背上，这时慢慢坐直，语气带一点犹豫，但像忍了很久）：\n「……我插一句。你们说的改不改我不一定说得上话，但有一件事我想先说清楚——很多决定下来的时候，我是最后一个知道的。」\n（她语气不重，但话不绕）\n「上个月菜单要换，我当天下午四点半才收到通知。那天晚上我一个人在吧台加了三个小时班。这种事不是第一次了。」\n\n**许言**（双手交握放在桌上，先看一圈大家，语气尽量缓）：\n「我先不站队。我就说一个感觉——我刚才听下来，你们每个人说的都有道理，但你们好像不在说同一件事。」\n（他环视一圈）\n「林澈说的是机会，周岚说的是边界，阿宁说的是执行。你们自己有没有发现？」', '【你的第一轮任务】\n\n你心里对自己说：\n先别急着顶回去。先听他们说完。至少听出来两个人到底在担心什么——那种他们没直接说出来的担心。\n\n你可以这样开头：\n「你继续说，我听着。」\n\n注意——你要是说了这几句话，讨论会变糟：\n✕ 「你每次都是这种语气。」\n✕ 「那你觉得一定行吗？」', { '周岚': '（第1幕话头读完后进入自由讨论。你的任务是先听，不要急着反驳。）', '林澈': '（第1幕话头读完后进入自由讨论。拉一个人站到你这边。）', '阿宁': '（第1幕话头读完后进入自由讨论。让至少两个人对你的话有回应。）', '许言': '（第1幕话头读完后进入自由讨论。摸清至少两个人对这家店的预期。）', '_hiddenInfo': [{ role:'周岚', tier:1, content:'有件事一直在我心里没过去。\n\n两年前那次所谓的改动。饮品线、照明——我当时也是被推着答应的。前前后后折腾了快两个月，花了两万块。最后效果很一般。有几个老客人跟我说：「感觉店里不太一样了。」\n\n那之后我变得特别小心。因为我不想再来一次。但这件事我从没跟他们好好聊过。不是不想聊——是不知道怎么说。' },{ role:'林澈', tier:1, content:'有件事我一直没说。\n\n老街夜行是我托朋友拿到的。我跟他说「没问题，621肯定上」。如果今晚退掉——不只是一个机会没了。我朋友那边我没法交代。\n\n我没说出来，是因为说出来像是在逼大家。但不说的话——好像又没人知道我为什么这么急。' },{ role:'阿宁', tier:1, content:'有一本笔记本我一直没给人看过。\n\n过去一年，每一次临时变动、紧急通知——我都记在上面了。哪一天、什么事、谁通知的、我花了多久补。都是最直接的记录。\n\n我没拿出来，是因为拿出来像是在记账。但我心里清楚——如果我不拿出来，没人会真的知道执行端是什么情况。' },{ role:'许言', tier:1, content:'有件事我一直没跟他们说过。\n\n五年前我写过一篇关于这家店的深度报道。那篇发出去之后收到了很多留言——有人说就是在这里求婚的。\n\n从那以后我就一直在关注这个地方。今晚来——不只是来坐坐的。' },]});
  insertScene(3, '第3环节：第一次讨论分享', '【讲师引导】\n\n组内讨论：\n\n• 你们觉得刚才谁是最想推动事情往前走的那个人？\n• 谁是最难被说服的？\n• 哪一句话让气氛明显变紧了？\n• 你们表面上在争什么？实际上在争什么？', 'discussion', '', '', null);
  insertScene(4, '第4环节 · 第2幕：门快关了', '', 'script', '**周岚**（语气比刚才沉了一些，像是在边想边说）：\n「刚才说到那份上，我觉得有些话确实得说开一点。我不是反对所有变化，但你们得理解——有些事我经历过，你们没有。」\n（她停了一下）\n「我不是说我有多了不起。但有些东西，不是说换就能换好的。」\n\n**林澈**（声音低了一点，不是在认输，是在说实话）：\n「我承认我有时候是急。但你们知道吗——我每次停下来等，最后就什么都没发生。我等过很多次了。」\n（他看了一眼所有人）\n「我不是在怪谁。我只是不想今晚谈完，一切又回到原样。」\n\n**阿宁**（顿了一下才开口，像是想了很久才决定要说）：\n「其实……我刚才说换菜单的事，只是其中一个。类似的事每个月都有。我不是不愿意配合，但每次都是最后通知、临时补——」\n（她停下来，过了一会儿）\n「你们有没有想过，哪天我要是不补了呢？」\n\n**许言**（语气平缓，但目光认真）：\n「我听到现在有一个感觉越来越明显——你们每个人都有道理，但你们在用自己的道理压对方的道理。」\n「我不是要分谁对谁错。我就想问一句——你们有没有谁，主动去问过别人『你心里真正担心的是什么』？」', '【你的第二轮任务】\n\n你对自己说：\n今晚至少要说一件我从来没提过的事。用事实说，不要用判断。\n\n你可以这样开头：\n「有件事我没跟你们提过。」\n\n注意——这些话会让讨论变糟：\n✕ 「你们根本不懂这家店。」\n✕ 「反正我不同意。」', { '周岚': '（第2幕话头读完后进入自由讨论。说一件你从没提过的事。）', '林澈': '（第2幕话头读完后进入自由讨论。在反驳之前先重复对方的话。）', '阿宁': '（第2幕话头读完后进入自由讨论。拿出你的笔记本说具体数据。）', '许言': '（第2幕话头读完后进入自由讨论。让两个人直接回答对方的问题。）', '_hiddenInfo': [{ role:'周岚', tier:2, content:'有件事我一直没说。\n\n这半年，店一直在亏。每个月我都在拿自己的钱往里填。到现在垫了有六万多。我算过，大概还能撑三个月。\n\n不是不想告诉他们——是说出来就好像承认自己没经营好。' },{ role:'林澈', tier:2, content:'还有一个事我没跟任何人说过。\n\n上个月有人挖我。一家新品牌咖啡店，管理岗。薪资高不少，月底要答复。\n\n我不是犹豫去不去——我是怕我走了之后，这家店撑不住。' },{ role:'阿宁', tier:2, content:'还有一件事。\n\n上周有人来挖我了——另一家咖啡馆的店长岗，薪资高两成。我还没回复。\n\n如果今晚还是各说各的——那我可能真的不需要再等了。' },{ role:'许言', tier:2, content:'几个月前我认识了这栋楼的房东。他对这家店印象不错，但也提到了运营能力的担忧。\n\n他话里留了空间——如果团队有清晰的方向和稳定的共识，租金上他可以松动。\n\n但这话我没跟店里任何人提过。' },]});
  insertScene(5, '第5环节：第二次讨论分享', '【讲师引导】\n\n组内讨论：\n\n• 哪个角色最像早就憋了很久的样子？\n• 哪些问题其实不是今天晚上才有的？\n• 如果只是方案问题，为什么每次都谈不下来？\n• 你觉得真正卡住决定的到底是什么？', 'discussion', '', '', null);
  insertScene(6, '第6环节 · 第3幕（翻车版）：杯子还温着', '【场景说明】前一轮讨论结束后，其他人暂时离开。店里只剩周岚和林澈两个人。\n\n【讲师引导】需要一组周岚和林澈上台演绎。', 'script', '**林澈**（看着手机，快步走近，语速明显加快）：\n「刚收到消息。老街夜行活动那边还有一个位置。今晚就要回。」\n\n**周岚**（动作停住，慢慢抬头，皱眉）：\n「今晚就定？你不觉得太赶了吗？」\n\n**林澈**（把手机扣在桌上，压着急）：\n「机会不会等人。我们已经错过多少次了，你也知道。」\n\n**周岚**（站起一点又坐回去，像在压住情绪）：\n「我知道。但不是所有机会来了都得硬接。」\n\n**林澈**（往前一步，语气更重）：\n「问题不是接得完不完美——是我们再这样下去，连试都没得试。」\n\n**周岚**（冷笑一下，眼神里开始有防备）：\n「你每次都这样。一有事就说赶紧做，好像不答应就是在拖后腿。」\n\n**林澈**（一下被顶到，声音压低，但更冲）：\n「那你呢？每次都再看看、再想想——到头来不还是什么都没定下来？」', '', { '周岚': '【上台对戏版本】和林澈对戏。话头用完后自由发挥。任务：不说「不行」，说「什么情况下可以」。', '林澈': '【上台对戏版本】和周岚对戏。你先开口。任务：把为什么这么急的真实原因说出一件来。', '阿宁': '【观察任务】回答三个问题：1.他们有没有一次真的听懂了对方？2.哪一句换说法会不同？3.你会上台说什么？', '许言': '【观察任务】回答三个问题：1.他们争的是同一件事吗？2.谁的话里藏着真正怕的东西？3.你还有信心吗？', '_hiddenInfo': [{ role:'周岚', tier:3, content:'其实来之前我做了一个决定——如果今晚谈不拢，我就自己去找房东续约。哪怕只剩我一个人。\n\n但现在我有点不确定了。也许问题不是别人不努力——是我一直没把最真实的情况告诉他们。如果早点说，会不会不一样？' },{ role:'林澈', tier:3, content:'我也常常一急就不给人说话的机会。吵完之后我也会想：是不是又说过了。\n\n那句「再拖就没了」不光是说给他们听的，也是说给我自己的。' },{ role:'阿宁', tier:3, content:'说实话，我是真的在意这家店。要不是在意，我早走了。\n\n我今晚最想听到的，不是「改还是不改」。是有人认认真真问我一句：「你怎么想？」' },{ role:'许言', tier:3, content:'来之前我就有个预期——可能会看到和五年前差不多的场面。\n\n我给自己定了一条线：如果今晚到第三幕结束之前，没人主动去问别人「你真正担心的是什么」——那我手里的房东信息永远不会拿出来。' },]});
  insertScene(7, '第7环节：观察分享 + 反转', '【讲师引导】\n\n1. 阿宁和许言分享观察发现。\n2. 全员讨论：他们表面上在争什么？实际上在争什么？\n3. 反转：讲师揭示身份——「我是十二年前投资这家店的人，从没露过面。」\n\n请所有人打开手机上还没解锁的信息。', 'discussion', '', '', null);
  insertScene(8, '第8环节 · 第3幕（修正版）：杯子还温着', '【讲师引导】同样的事，同样的人。但如果他们把真正重要的东西说清楚——会走向完全不同的结局。需要另一组周岚和林澈上台演绎。', 'script', '**林澈**（深呼吸一下，语速仍快但明显在控制）：\n「我刚收到消息，老街夜行活动那边还有一个位置。我想先说清楚：我希望我们这次能参加，这是这段时间少有的一次机会。」\n\n**周岚**（没有立刻反驳，语气谨慎但平稳）：\n「你说的参加，具体是指今晚要定到什么程度？」\n\n**林澈**（点头）：\n「今晚先确认要不要争取这个机会。如果参加，我明天中午前出一个简版方案。」\n\n**周岚**（神情稍松）：\n「好。我先说我的顾虑——我担心在准备不清楚时先答应，最后赶时间把店做得很失真。」\n\n**林澈**（放慢语气）：\n「你说的失真，对你来说最重要的是哪一部分？」\n\n**周岚**（直接说）：\n「两点。第一，不能为了活动把店的感觉打散。第二，执行压力不能临时落到阿宁那里。」\n\n**林澈**（点头）：\n「好，我记住。我也说我的担心——我怕连这种机会都不试，店会在犹豫里慢慢失去更多可能。」\n\n**周岚**：\n「我理解你急。但如果要试，边界要先定出来。」\n\n**林澈**：\n「可以。今晚先确认是否参加；我明天出方案；你来帮我划清哪些能动、哪些不能动。」\n\n**周岚**：\n「我接受。但补两条：方案出来前不对外承诺细节；阿宁要一起看执行表。」\n\n**林澈**：\n「好。对外只回有意参加。执行表我和阿宁一起列。如果你看方案觉得触底线，保留不做的权利。」\n\n**周岚**：\n「好，这样我能接受。」\n\n**林澈**：\n「我也补一句：如果我后面又太急，你直接提醒我。」\n\n**周岚**：\n「那我也补：如果我只说不行没说清原因，你直接问我哪条过不去。」', '', { '周岚': '【修正版·上台】核心：把顾虑说清楚，而不是只说「不行」。注意动作标注。', '林澈': '【修正版·上台】核心：确认对方的底线，说出自己的担心。注意动作标注。', '阿宁': '【观察】对比翻车版和修正版，注意两个人分别做了哪些不同的事。', '许言': '【观察】修正版里哪些做法让对话从对抗变成了合作？', });
  insertScene(9, '第9环节：知识分享', '【讲师分享三件事】\n\n一、听——他到底在说什么\n第一幕大家都在说但没人真的在听。以后开口前先问三个问题：他到底在说什么？他到底在担心什么？他到底想要什么？\n\n二、说——从「我觉得」到「事实是」\n第二幕阿宁的笔记本：她说的是事实，不是情绪。三句话：发生了什么？带来了什么？我担心什么？\n\n三、定——从「不行」到「什么情况下可以」\n修正版里周岚说了两点底线而不是说不行。把要求和底线放到桌面上，找两边都能走的路。', 'knowledge', '', '', null);
  insertScene(10, '第10环节：最终决策', '回到最初的问题：621号店接下来怎么办？但这一次，你们手里有全部信息。\n\n请在组内完成四项：\n1. 你们共同真正想守住的是什么？\n2. 新的三条沟通约定是什么？\n3. 最终决定——继续 / 转型 / 暂停 / 告别\n4. 留给621号店的一句话', 'decision', '', '', null);
  insertScene(11, '第11环节：收尾', '有些关系不是败在不在乎。是败在——太久没有把在乎说清楚。\n\n如果重新开始一次——你会先怎么说？\n\n谢谢大家。喙语621号店，今晚打烊了。', 'discussion', '', '', null);
  res.json({
    success: true,
    session: { code, id: sessionId, title },
    message: '预设沙龙已创建！含11环节完整内容'
  });
});// ==================== Socket.IO ====================
const sessionClients = {}; // { sessionCode: { instructors: Set, participants: Map<socketId, data> } }

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // 讲师加入场次房间
  socket.on('instructor:join', (code) => {
    const session = stmts.getSessionByCode.get(code);
    if (!session) {
      socket.emit('error', '场次码无效');
      return;
    }
    socket.join(`session:${code}`);
    socket.data.sessionCode = code;
    socket.data.role = 'instructor';
    console.log(`[讲师加入] ${socket.id} 加入场次 ${code}`);
    // 通知讲师当前完整数据
    const groups = stmts.getGroups.all(session.id);
    const groupsWithRoles = groups.map(g => ({
      ...g,
      roles: stmts.getRolesByGroup.all(g.id, session.id)
    }));
    const scenes = stmts.getScenes.all(session.id).map(s => enrichSceneWithRoleContent(s, session.id));
    const participants = stmts.getParticipants.all(session.id);
    socket.emit('instructor:init', {
      session,
      groups: groupsWithRoles,
      scenes,
      participants
    });
  });

  // 学员加入场次
  socket.on('participant:join', (code) => {
    const session = stmts.getSessionByCode.get(code);
    if (!session) {
      socket.emit('error', '场次码无效');
      return;
    }
    socket.join(`session:${code}`);
    socket.data.sessionCode = code;
    socket.data.role = 'participant';
    console.log(`[学员加入] ${socket.id} 加入场次 ${code}`);
    // 发送公开信息
    const groups = stmts.getGroups.all(session.id);
    const groupsWithRoles = groups.map(g => {
      const roles = stmts.getRolesByGroup.all(g.id, session.id);
      return {
        ...g,
        roles: roles.map(r => ({
          ...r,
          occupied: stmts.isRoleOccupied.get(r.id, session.id).cnt > 0
        }))
      };
    });
    const scenes = stmts.getScenes.all(session.id);
    const pushedScenes = scenes.filter(s => s.scene_number <= session.current_scene);
    socket.emit('participant:init', {
      session: { ...session, pushedScenes },
      groups: groupsWithRoles
    });
  });

  // 学员选择角色
  socket.on('participant:select_role', ({ code, groupId, roleId, name }) => {
    const session = stmts.getSessionByCode.get(code);
    if (!session) {
      socket.emit('error', '场次无效');
      return;
    }
    // 检查角色是否已被占
    const occupied = stmts.isRoleOccupied.get(roleId, session.id);
    if (occupied.cnt > 0) {
      socket.emit('participant:error', '该角色已被选择');
      return;
    }
    // 检查该学员是否已选过角色（如果已选，先释放）
    const existing = db.prepare('SELECT * FROM participants WHERE session_id = ? AND name = ?').get(session.id, name);
    if (existing) {
      stmts.removeParticipant.run(existing.role_id, session.id);
    }
    // 登记学员
    stmts.addParticipant.run(session.id, groupId, roleId, name);

    // 更新学员的 socket data
    socket.data.participantName = name;
    socket.data.selectedRoleId = roleId;

    // 通知学员选择成功
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId);
    const group = db.prepare('SELECT * FROM groups_t WHERE id = ?').get(groupId);
    socket.emit('participant:role_selected', {
      name,
      group,
      role,
      currentScene: session.current_scene
    });

    // 通知讲师有新学员加入
    const participants = stmts.getParticipants.all(session.id);
    io.to(`session:${code}`).emit('participants_updated', { participants });

    // 如果已经有推送的剧本，立即发给该学员（含角色专属内容）
    if (session.current_scene > 0) {
      const pushedScenes = stmts.getScenes.all(session.id)
        .filter(s => s.scene_number <= session.current_scene)
        .map(s => enrichSceneWithRoleContent(s, session.id));
      socket.emit('scene:pushed', { scenes: pushedScenes, currentScene: session.current_scene });
    }
  });

  // 讲师推送剧本
  socket.on('instructor:push_scene', ({ code, sceneNumber }) => {
    const session = stmts.getSessionByCode.get(code);
    if (!session) return;
    stmts.setCurrentScene.run(sceneNumber, code);
    // 更新状态
    if (session.status === 'preparing') {
      stmts.updateSessionStatus.run('active', code);
    }
    const scenes = stmts.getScenes.all(session.id).map(s => enrichSceneWithRoleContent(s, session.id));
    const pushedScenes = scenes.filter(s => s.scene_number <= sceneNumber);
    // 广播给场次内所有人（包括讲师）
    io.to(`session:${code}`).emit('scene:pushed', {
      currentScene: sceneNumber,
      scenes: pushedScenes
    });
    console.log(`[推送] 场次 ${code} 推送第 ${sceneNumber} 幕`);
  });

  // 讲师结束场次
  socket.on('instructor:end', (code) => {
    stmts.updateSessionStatus.run('ended', code);
    io.to(`session:${code}`).emit('session:ended');
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log(`[断开] ${socket.id}`);
    const code = socket.data.sessionCode;
    const role = socket.data.role;
    if (code && role === 'participant' && socket.data.selectedRoleId) {
      // 学员断开，询问是否释放角色（这里先释放，生产环境可以加心跳检测）
      stmts.removeParticipant.run(socket.data.selectedRoleId, code);
      const participants = stmts.getParticipants.all(code);
      io.to(`session:${code}`).emit('participants_updated', { participants });
    }
  });
});

// ==================== 启动 ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎭 剧本杀沟通沙龙系统已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   公网: http://0.0.0.0:${PORT}`);
});
