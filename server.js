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
  const title = '喙语621号店 · 沉浸式沟通沙龙';
  
  stmts.createSession.run(code, title);
  const session = stmts.getSessionByCode.get(code);
  const sessionId = session.id;

  stmts.addGroup.run(sessionId, '621号店 · 第一组', 1);
  const group = stmts.getGroups.all(sessionId)[0];
  const groupId = group.id;

  // 创建角色（含完整背景故事）
  const roleDefs = [
    { name: '阿宁', desc: '老员工 · 你见过这家店热闹的时候，也陪它走过现在最吃力的时候。你不是最会做决定的人，但很多决定最后都要落到你这里执行。如果继续，执行必须更清楚；不能再默认总有人会把最后的问题接住。开场白：「很多事不是不能做，是最后都变成临时来。」' },
    { name: '周岚', desc: '主理人 · 12年的坚守。621号店承载了你很多时间、心力和判断。这些年外面变了很多，但你始终觉得，这家店不能为了「看起来更有效」就轻易变成另一个样子。不反对所有变化，但反对仓促决定。开场白：「我不是不让大家提方案，但这家店不是说改就改的。」' },
    { name: '林澈', desc: '推动者 · 你不是最早留下来的人，但正因为如此，你更清楚外面的环境已经变了。店不是没有机会，而是错过了太多次该动的时候。店必须动起来；有些尝试不一定完美，但不能一直等。开场白：「现在最大的问题不是有没有想法，而是我们已经拖不起了。」' },
    { name: '许言', desc: '多年熟客 · 你不天天在店里，但你是少数一直看着它从热闹走到今天的人。你愿意帮，但你也越来越觉得，问题不只是「缺一个活动」或「缺一点资源」。在没有形成一致方向前，盲目推进只会更乱。开场白：「我感觉你们现在不是没意见，是每个人都在说自己的。」' },
  ];
  const roleIds = {};
  roleDefs.forEach(r => { stmts.addRole.run(groupId, sessionId, r.name, r.desc); });
  const roles = stmts.getRolesByGroup.all(groupId, sessionId);
  roles.forEach(r => { roleIds[r.name] = r.id; });

  // 创建4幕完整剧本（含角色专属内容）
  const insertSceneWithRoles = db.transaction((sessionId, sceneNum, title, content, roleContentMap) => {
    const r = stmts.addScene.run(sessionId, sceneNum, title, content);
    const sceneId = r.lastInsertRowid;
    if (roleContentMap) {
      for (const [roleName, text] of Object.entries(roleContentMap)) {
        if (text && text.trim() && roleIds[roleName]) {
          stmts.addSceneRoleContent.run(sceneId, roleIds[roleName], text);
        }
      }
    }
    return sceneId;
  });

  // 第一幕 · 灯还亮着
  insertSceneWithRoles(sessionId, 1,
    '第一幕 · 灯还亮着',
    '时间：晚上打烊后　地点：621号店内\n\n夜里九点多，621号店刚结束营业。最后一桌客人已经离开，门口「营业中」的木牌被翻到了背面。咖啡机停了，吧台后还留着一点热气，空气里有咖啡、木头和一点洗杯水的味道。几个人坐下来讨论店的去留。每个人都憋了很久，一开口就有点不对劲。\n\n[讲师引导] 请大家朗读剧本，留意这场讨论为什么一开始就不顺利。\n\n━━━ 对白 ━━━\n\n**周岚**（坐在桌边，手指轻轻压着桌上的本子）: 今天把大家叫回来，不是为了吵架。明天房东就要来问最后决定了，这家店到底怎么办，今晚总要有个说法。\n\n**林澈**（身体微微前倾）: 那我先说吧。现在最大的问题不是「要不要讨论」，而是我们已经讨论太久了。再拖下去，店就真的没了。\n\n**周岚**（眉头微皱）: 你每次一开口就是这种语气，好像别人都没做事一样。\n\n**林澈**（愣半拍）: 我不是这个意思。客流掉成这样，线上也没做起来，再不改就来不及了。\n\n**阿宁**（慢慢坐直一点）: 其实……我觉得问题也不只是改不改。很多事情平时根本没讲清楚。今天说改菜单，明天说先别动，到最后都是吧台那边临时接。\n\n**周岚**（语气里有一点被顶到的不舒服）: 阿宁，你有意见可以早点说，不用每次都等到现在。\n\n**阿宁**（苦笑）: 我早点说有用吗？很多次我说了，最后不还是「再看看」？\n\n**许言**（双手交握）: 你们先别急。我在旁边听着，感觉你们每个人都在说自己的，但没人真的接住别人说的。\n\n**林澈**: 因为现在根本不是慢慢聊的时候。再慢一点，这店可能连聊的机会都没有了。\n\n**周岚**: 那按你的意思，是不是只要改得够快，这店就一定能活？\n\n**林澈**: 至少比现在这样强吧。总比一直守着以前那一套强。\n\n**周岚**: 「以前那一套」？你说得倒轻巧。你知道这家店为什么会有人来吗？\n\n**阿宁**（轻轻摇头）: 你们看，又变成这样了。每次一谈就开始顶。\n\n**许言**: 我能不能插一句？我现在其实没太听明白，你们到底在争「要不要改」，还是在争「谁说了算」？\n\n**周岚**: 我不是要争谁说了算。我只是觉得，有些东西不能说改就改。\n\n**林澈**（苦笑）: 可问题是，你从来没说清楚什么能改，什么不能改。\n\n**阿宁**（轻轻点头）: 对，这个我也想说。很多时候我们根本不知道你真正怎么想。\n\n**周岚**（脸色明显冷下来）: 所以现在变成我一个人的问题了，是吗？\n\n**许言**（声音放慢）: 我觉得不是谁一个人的问题。是你们都很急，但谁都没先听完别人到底在急什么。', null);

  // 第二幕 · 门快关了（含角色专属任务）
  insertSceneWithRoles(sessionId, 2,
    '第二幕 · 门快关了',
    '第一轮讨论不欢而散。咖啡凉了，气氛却更紧了。\n\n每个人都说了话，但没人觉得被听进去。周岚收回了手，林澈语速越来越快，阿宁那句「我早点说有用吗」还悬在头顶，许言的问题没人回答。\n\n沉默之后，有人先开了口。这一次，他们不再争「要不要改」，而是开始说出那些一直卡在嗓子眼的、具体的事。\n\n门外的老街还在。但店里的灯，比刚才又暗了一档。\n\n[讲师引导] 这一轮要说出一件最让你疲惫的具体的事，以及它为什么让你越来越不想再默默接住一切。',
    {
      '阿宁': '【你的任务】\n\n最近最让你累的事：菜单调整、活动安排、排班变化，很多事情你常常都是最后才知道。等你知道的时候，已经来不及提意见，只能现场补。\n\n你需要说出的三件事：\n1. 一件总是让你疲惫的具体事情\n2. 这件事怎样影响你的工作状态\n3. 你最希望以后改掉的是什么\n\n你可以这样开口：\n「对我来说最累的，不是忙，而是很多安排都变得太临时。」\n「比如菜单、活动、排班一改，我经常是最后才知道，然后只能现场补。」\n「我不是不愿意配合，我只是希望以后不要再默认一定有人会把所有问题接住。」\n\n⚠ 容易说砸的话：「随便吧」「反正最后都得我来收拾」「我说了也没用」',
      '周岚': '【你的任务】\n\n最近最让你不舒服的事：最近几次讨论方案，你常常还没把自己的顾虑讲完，大家就已经往「那到底改不改」推进了。你感觉自己不是在讨论，而是在被催着表态。\n\n你需要说出的三件事：\n1. 一件让你越来越抗拒讨论的具体事情\n2. 这件事让你产生了什么感觉或反应\n3. 你真正担心失去的是什么\n\n你可以这样开口：\n「最近几次聊方案，我常常还没说完，就已经被推进到要不要改这个结论上了。」\n「我真正担心的，不是改动本身，而是改到最后，这里只剩一个名字，已经不是原来的621了。」\n「如果一定要动，我希望先讲清楚，哪些东西我们无论如何都要保住。」\n\n⚠ 容易说砸的话：「你们根本不懂这家店」「反正我不同意」「你们就是想把这里变成别的地方」',
      '林澈': '【你的任务】\n\n最近最让你着急的事：这两个月明明有几次活动或联动机会，但每次一到要拍板的时候，讨论都会停住，最后什么都没做成。\n\n你需要说出的三件事：\n1. 一件你认为已经不能再拖的具体事情\n2. 这件事为什么让你越来越着急\n3. 你真正怕的是什么\n\n你可以这样开口：\n「这两个月我们已经错过了好几次可以试的机会。」\n「每次都不是没有人提方案，而是一到关键处就停住，最后什么都没落下去。」\n「我不是想把以前的东西全推翻，我只是觉得我们得先活下来，才有资格谈留下什么。」\n\n⚠ 容易说砸的话：「你们太慢了」「再这样下去就等死」「讲这些有用吗？」',
      '许言': '【你的任务】\n\n最近你最明显感受到的问题：你发现这家店里的人并不是没有想法，而是很多时候，想法、情绪和判断混在一起。结果每次都像谈了很多，但最后谁也不知道真正定下了什么。\n\n你需要说出的三件事：\n1. 你从旁观位置最明显看到的一个问题\n2. 这个问题为什么影响你是否愿意继续帮\n3. 你最希望他们先做好的是什么\n\n你可以这样开口：\n「我从外面看，最大的问题不是没人想办法，而是很多东西一直混在一起。」\n「有时候你们像是在谈方案，但很快又会变成立场、情绪和旧问题。」\n「我真正希望你们先做好的，不是活动，而是先把各自到底在坚持什么、担心什么讲明白。」\n\n⚠ 容易说砸的话：「你们先统一好了再找我」「这是你们内部问题」「算了，我大概知道了」'
    });

  // 第三幕 · 杯子还温着（含双版本）
  insertSceneWithRoles(sessionId, 3,
    '第三幕 · 杯子还温着',
    '时间已经更晚了。前一轮讨论结束后，其他人暂时离开，只剩周岚和林澈留在店里。\n\n灯没有全开，只剩吧台和靠窗一侧还亮着。外面老街的声音比刚才更少，整家店像一下空下来。桌上的杯子还没收，空气里还悬着刚才那些没接住的话。\n\n就在这时，林澈收到消息：老街夜行活动那边还有一个位置，如果621号店要参加，今晚就必须回。\n\n这像是一个机会，也像是一根点着火药的引线。因为这不再是「以后再说」，而是一个当下就要表态的时刻。\n\n[讲师引导] 请两位学员上台，分别演绎「翻车版」与「修正版」对话。其他人观察：真正卡住决定的是什么？',
    {
      '周岚': '【翻车版】\n\n林澈（快步走近）: 刚收到消息，老街夜行活动那边还有一个位置。如果我们要上，今晚就得回。\n\n周岚（皱眉）: 今晚就定？你不觉得这也太赶了吗？\n\n[翻车版的核心问题：双方都进入了态度对抗，没有人解释自己的真实诉求，情绪越顶越高，最终不欢而散。]\n\n━━━\n\n【修正版】\n\n林澈（深呼吸，控制语速）: 我刚收到消息，老街夜行活动那边还有一个位置。如果我们想参加，今晚要先给答复。我想先把我的想法说清楚：我希望我们这次能参加，因为这是这段时间少有的一次机会。\n\n周岚（没有立刻反驳）: 你先继续说。你说的「参加」，具体是指今晚要定到什么程度？\n\n林澈（点头）: 今晚先确认要不要争取这个机会。如果确认参加，我明天中午前出一个简版方案，再一起看。\n\n周岚（神情稍松）: 好，这样我比较能听明白。我先说我的顾虑：我不是反对参加活动，我担心的是在准备还不清楚的时候先答应，到最后为了赶时间，把店做得很失真。\n\n林澈: 你说的「失真」，对你来说最重要的是哪一部分？\n\n周岚: 两个点。第一，不要为了活动把店原来的感觉全部打散。第二，不能再让执行压力最后都临时落到阿宁那里。\n\n林澈: 好，这两个点我记住。那我也说清楚我的担心：我最怕的不是这次做得不够完美，而是如果我们连这种机会都一直不试，店会在犹豫里慢慢失去更多可能。\n\n周岚: 我能理解你为什么急。这次如果要试，我希望边界先定出来。\n\n林澈: 可以。今晚先确认愿不愿意参加；如果愿意，我明天出方案；你来帮我一起划清哪些能动、哪些不能动。\n\n周岚: 我可以接受。但要补两条：方案出来之前不先对外承诺细节；阿宁要一起看执行表，不是最后通知她。\n\n林澈: 对外我只回复「有意参加，明天补具体方案」。执行表我和阿宁一起先列。如果明天你看完方案觉得触到底线，我们保留不上活动的决定权。\n\n周岚: 好，这样我能接受。\n\n林澈: 我也补一句：如果我后面又说得太像只想快点推，你直接提醒我。\n\n周岚: 那我也补一句：如果我只是说「不行」，没把担心说清楚，你也可以直接问我到底哪一条过不去。',
      '林澈': '【翻车版】\n\n林澈（看着手机，快步走近桌边）: 刚收到消息，老街夜行活动那边还有一个位置。如果我们要上，今晚就得回。\n\n周岚（皱眉）: 今晚就定？你不觉得这也太赶了吗？\n\n林澈（把手机扣在桌上）: 问题是机会本来就不会等人。我们已经错过多少次了。\n\n[翻车版的核心问题：双方都进入了态度对抗，没有人解释自己的真实诉求，情绪越顶越高，最终不欢而散。]\n\n━━━\n\n【修正版】\n\n林澈（深呼吸，控制语速）: 我刚收到消息，老街夜行活动那边还有一个位置。如果我们想参加，今晚要先给答复。我想先把我的想法说清楚：我希望我们这次能参加，因为这是这段时间少有的一次机会。\n\n周岚: 你先继续说。你说的「参加」，具体是指今晚要定到什么程度？\n\n林澈（点头）: 不是今晚把所有细节都定完。今晚先确认要不要争取这个机会。如果确认参加，我明天中午前出一个简版方案。\n\n周岚: 好，这样我比较能听明白。我先说我的顾虑……\n\n（双方进入有效沟通，最终达成共识）\n\n林澈: 可以。那我现在请求：今晚先确认愿不愿意参加；如果愿意，我明天出方案；你来帮我一起划清哪些能动、哪些不能动。\n\n周岚: 我可以接受这样往下走。\n\n林澈: 我也补一句：如果我后面又说得太像只想快点推，你直接提醒我。我不想每次一着急，就把你推到对立面。',
      '阿宁': '【作为观察者】\n\n你需要在周岚和林澈谈话结束后回到店里说说自己的想法。\n\n你不是站队，而是帮助把冲突拉回「可做决定」的层面。\n\n你可以提醒的点：\n• 你们到底在争「去不去」，还是在争「谁有资格决定」？\n• 如果都说自己是为了店好，那各自「好」的定义是什么？\n• 现在最缺的不是情绪，而是一个能落地的判断方式\n\n你可以这样开口：\n• 「我想先确认一下，你们现在争的是这次活动本身，还是在争以后谁说了算？」\n• 「如果周岚担心的是边界，林澈担心的是机会，那能不能先把这两个点拆开谈？」',
      '许言': '【作为观察者】\n\n你需要在周岚和林澈谈话结束后回到店里说说自己的想法。\n\n你不是站队，而是帮助把冲突拉回「可做决定」的层面。\n\n你可以提醒的点：\n• 你们到底在争「去不去」，还是在争「谁有资格决定」？\n• 如果都说自己是为了店好，那各自「好」的定义是什么？\n• 现在最缺的不是情绪，而是一个能落地的判断方式\n\n你可以这样开口：\n• 「我想先确认一下，你们现在争的是这次活动本身，还是在争以后谁说了算？」\n• 「如果周岚担心的是边界，林澈担心的是机会，那能不能先把这两个点拆开谈？」'
    });

  // 第四幕 · 天快亮了
  insertSceneWithRoles(sessionId, 4,
    '第四幕 · 天快亮了',
    '在最后的讨论里，大家逐渐意识到：621号店真正的问题，不只是经营，而是这些人已经很久没有把彼此真正想说的话说清楚了。\n\n━━━ 请完成以下四项 ━━━\n\n📌 1. 我们共同真正想守住的是什么？\n（可参考：店的温度 / 彼此的信任 / 一个可以继续尝试的机会 / 不再靠猜的合作方式 / 体面的告别方式）\n\n📌 2. 如果继续，我们新的三条沟通约定是什么？\n（例如：重要安排必须提前说清楚 / 每次讨论先复述再表达 / 有不同意见时先讲事实和影响 / 每周固定一次短复盘）\n\n📌 3. 最终决定是什么？\n• 继续经营\n• 小幅转型\n• 暂停整理\n• 体面告别\n\n📌 4. 留给621号店的一句话\n（例如：「留下来的不只是店，是我们终于开始好好说话。」「如果重新开始，我们先把话讲清，再把路走稳。」）\n\n━━━\n\n讲师备注：决策录入开放后，各组代表在手机端填写。讲师可在汇总页查看提交状态。全部提交后投屏，各组代表口头汇报。此幕建议时长：15分钟。',
    {
      '阿宁': '【你的任务】\n\n请认真参与小组讨论，完成以上四项内容。\n\n你可以说的：\n• 「我最想守住的是，以后大家能提前把事情说清楚，而不是每次到最后才让我知道。」\n• 「如果继续，我希望我们的约定里有一条：重要的事情要提前同步，不要再默认总有人兜底。」',
      '周岚': '【你的任务】\n\n请认真参与小组讨论，完成以上四项内容。\n\n你可以说的：\n• 「我最想守住的是这家店原来的温度，但我也知道光守住不够，我们得找到一种不丢温度的方式往前走。」\n• 「如果继续，我希望能有一条约定：做任何调整之前，先说清楚哪些不能动。」',
      '林澈': '【你的任务】\n\n请认真参与小组讨论，完成以上四项内容。\n\n你可以说的：\n• 「我最想守住的是我们还愿意为这家店去努力的那种状态。」\n• 「如果继续，我希望我们的约定包括：有想法就带着方案来，不要停在嘴上。」',
      '许言': '【你的任务】\n\n请认真参与小组讨论，完成以上四项内容。\n\n你可以说的：\n• 「我最想守住的是这家店让人愿意坐下来好好说话的那种氛围。」\n• 「如果继续，我希望你们能有一条约定：每次讨论完，至少确定一件事可以落地。」'
    });

  res.json({
    success: true,
    session: { code, id: sessionId, title },
    message: '☕ 预设沙龙「喙语621号店」已创建！含完整剧本内容'
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
