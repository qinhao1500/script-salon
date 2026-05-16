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
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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
  addScene: db.prepare('INSERT INTO scenes (session_id, scene_number, title, content) VALUES (?, ?, ?, ?)'),
  getScenes: db.prepare('SELECT * FROM scenes WHERE session_id = ? ORDER BY scene_number'),
  deleteScene: db.prepare('DELETE FROM scenes WHERE id = ? AND session_id = ?'),
  setCurrentScene: db.prepare('UPDATE sessions SET current_scene = ? WHERE code = ?'),
  addParticipant: db.prepare('INSERT OR REPLACE INTO participants (session_id, group_id, role_id, name) VALUES (?, ?, ?, ?)'),
  removeParticipant: db.prepare('DELETE FROM participants WHERE role_id = ? AND session_id = ?'),
  getParticipants: db.prepare('SELECT p.*, g.name as group_name, r.name as role_name FROM participants p JOIN groups_t g ON p.group_id = g.id JOIN roles r ON p.role_id = r.id WHERE p.session_id = ? ORDER BY g.sort_order, p.joined_at'),
  getParticipantByRole: db.prepare('SELECT * FROM participants WHERE role_id = ? AND session_id = ?'),
  isRoleOccupied: db.prepare('SELECT COUNT(*) as cnt FROM participants WHERE role_id = ? AND session_id = ?'),
  getMaxSortOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max FROM groups_t WHERE session_id = ?'),
  getMaxSceneNumber: db.prepare('SELECT COALESCE(MAX(scene_number), 0) as max FROM scenes WHERE session_id = ?'),
  updateSessionStatus: db.prepare('UPDATE sessions SET status = ? WHERE code = ?'),
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

// 获取场次完整数据（讲师端用）
app.get('/api/session/:code/full', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const groups = stmts.getGroups.all(session.id);
  const groupsWithRoles = groups.map(g => ({
    ...g,
    roles: stmts.getRolesByGroup.all(g.id, session.id)
  }));
  const scenes = stmts.getScenes.all(session.id);
  const participants = stmts.getParticipants.all(session.id);
  res.json({ success: true, session, groups: groupsWithRoles, scenes, participants });
});

// 获取场次公开信息（学员端用，不包括敏感数据）
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
  const scenes = stmts.getScenes.all(session.id);
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

// 添加剧本幕次
app.post('/api/session/:code/scene', (req, res) => {
  const session = stmts.getSessionByCode.get(req.params.code);
  if (!session) return res.status(404).json({ success: false, message: '场次不存在' });
  const { title, content } = req.body;
  const maxScene = stmts.getMaxSceneNumber.get(session.id).max;
  stmts.addScene.run(session.id, maxScene + 1, title, content);
  const scenes = stmts.getScenes.all(session.id);
  io.to(`session:${req.params.code}`).emit('session_updated', { scenes });
  res.json({ success: true, scenes });
});

// 删除剧本幕次
app.delete('/api/session/:code/scene/:sceneId', (req, res) => {
  stmts.deleteScene.run(req.params.sceneId, req.params.code);
  const session = stmts.getSessionByCode.get(req.params.code);
  const scenes = stmts.getScenes.all(session.id);
  io.to(`session:${req.params.code}`).emit('session_updated', { scenes });
  res.json({ success: true, scenes });
});

// ==================== Socket.IO ====================
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
    const scenes = stmts.getScenes.all(session.id);
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

    // 如果已经有推送的剧本，立即发给该学员
    if (session.current_scene > 0) {
      const pushedScenes = stmts.getScenes.all(session.id).filter(s => s.scene_number <= session.current_scene);
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
    const scenes = stmts.getScenes.all(session.id);
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
