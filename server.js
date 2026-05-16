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

  CREATE TABLE IF NOT EXISTS scene_role_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
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
  stmts.deleteScene.run(req.params.sceneId, req.params.code);
  const session = stmts.getSessionByCode.get(req.params.code);
  const scenes = stmts.getScenes.all(session.id);
  io.to(`session:${req.params.code}`).emit('session_updated', { scenes });
  res.json({ success: true, scenes });
});

// ==================== 预设沙龙 API ====================

// 一键创建喙语621号店预设沙龙
app.post('/api/preset/salon-621', (req, res) => {
  const code = generateCode();
  const title = '喙语621号店 · 沉浸式沟通沙龙';
  
  // 创建场次
  stmts.createSession.run(code, title);
  const session = stmts.getSessionByCode.get(code);
  const sessionId = session.id;

  // 创建小组
  stmts.addGroup.run(sessionId, '621号店 · 第一组', 1);
  const group = stmts.getGroups.all(sessionId)[0];
  const groupId = group.id;

  // 创建角色
  const roleDefs = [
    { name: '周岚', desc: '主理人 · 12年的坚守。不反对变化，但反对仓促决定。最怕店改得面目全非，丢失了这家老店最初的灵魂与温度。' },
    { name: '林澈', desc: '推动者 · 深度参与。持续推动主动求变，拒绝内耗拥抱生机。最怕在无休止的犹豫和讨论中消耗生命力。' },
    { name: '阿宁', desc: '老员工 · 落地人。运转中枢深谙门道，最终执行者。最怕所有的突发状况都被默认由她来收尾。' },
    { name: '许岩', desc: '熟客 · 旁观者。多年熟客一直在外面看着这家店。只帮有共识、有方向的团队。' },
  ];
  const roleIds = {};
  roleDefs.forEach(r => {
    stmts.addRole.run(groupId, sessionId, r.name, r.desc);
  });
  const roles = stmts.getRolesByGroup.all(groupId, sessionId);
  roles.forEach(r => { roleIds[r.name] = r.id; });

  // 创建4幕剧本（含角色专属内容）
  const sceneDefs = [
    {
      title: '第一幕 · 灯还亮着',
      content: '第一次讨论，每个人都憋了很久。空气里弥漫着未说出口的情绪，仿佛咖啡的蒸汽，既温暖又压抑。\n\n明天，房东就会来问最后决定。621号店在梧桐树下静静开了12年。租期将尽，房东的最后通牒就在明天。今晚，所有与这家店命运相连的人再次聚首，围坐在熟悉的旧木桌旁，试图在热气氤氲中，共同做出一个关于「去与留」的最终抉择。\n\n💡 值得留意：这场讨论为什么从一开始就进展不顺？是长久积压的情绪爆发，还是沟通方式的本质错位？'
    },
    {
      title: '第二幕 · 门快关了',
      content: '第一轮讨论不欢而散。咖啡凉了，气氛却更紧了。\n\n每个人都说了话，但没人觉得被听进去。沉默之后，有人先开了口。这一次，他们不再争「要不要改」，而是开始说出那些一直卡在嗓子眼的、具体的事。\n\n这一轮你要开始说得更具体。你不能只当观察者。要说出你作为角色最明显看到的问题。'
    },
    {
      title: '第三幕 · 杯子还温着',
      content: '时间已经更晚了。前一轮讨论结束后，其他人暂时离开，只剩周岚和林澈留在店里。\n\n林澈收到消息：老街夜行活动那边还有一个位置，如果621号店要参加，今晚就必须回。\n\n这像是一个机会，也像是一根点着火药的引线。因为这不再是「以后再说」，而是一个当下就要表态的时刻。'
    },
    {
      title: '第四幕 · 天快亮了',
      content: '在最后的讨论里，大家逐渐意识到：621号店真正的问题，不只是经营，而是这些人已经很久没有把彼此真正想说的话说清楚了。\n\n请完成以下四项：\n1. 我们共同真正想守住的是什么？\n2. 如果继续，我们新的三条沟通约定是什么？\n3. 最终决定是什么？（继续经营 / 小幅转型 / 暂停整理 / 体面告别）\n4. 留给621号店的一句话'
    }
  ];

  sceneDefs.forEach((s, idx) => {
    const sceneNum = idx + 1;
    const sceneResult = stmts.addScene.run(sessionId, sceneNum, s.title, s.content);
  });

  res.json({
    success: true,
    session: { code, id: sessionId, title },
    message: '预设沙龙「喙语621号店」已创建！'
  });
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
