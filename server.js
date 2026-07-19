var express = require('express');
var cors = require('cors');
var bcrypt = require('bcryptjs');
var jwt = require('jsonwebtoken');
var multer = require('multer');
var path = require('path');
var fs = require('fs');
var uuid = require('uuid').v4;
var initSqlJs = require('sql.js');

// ===== ПОДКЛЮЧАЕМ СИСТЕМУ БЭКАПОВ =====
var backup = require('./backup');

var app = express();
var PORT = process.env.PORT || 3000;
var JWT_SECRET = process.env.JWT_SECRET || 'secret123';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

var db;
var DB_PATH = 'database.sqlite';

// ===== УДАЛЯЕМ ПОВРЕЖДЕННУЮ БД ПРИ СТАРТЕ =====
if (fs.existsSync(DB_PATH)) {
  try {
    var stats = fs.statSync(DB_PATH);
    if (stats.size < 100) {
      console.log('🗑️ Удаляем поврежденную БД (слишком маленькая)...');
      fs.unlinkSync(DB_PATH);
      console.log('✅ БД удалена');
    }
  } catch (e) {
    console.log('⚠️ Не удалось проверить БД:', e.message);
  }
}

// ===== ФУНКЦИЯ ДЛЯ ВОССТАНОВЛЕНИЯ БЭКАПА =====
async function restoreDatabaseIfNeeded() {
  console.log('🔄 Проверка бэкапов...');
  try {
    var restored = await backup.restoreFromGitHub();
    if (restored) {
      console.log('✅ База данных восстановлена из GitHub');
      return true;
    } else {
      console.log('ℹ️ Используем локальную базу данных');
      return false;
    }
  } catch (error) {
    console.error('❌ Ошибка восстановления:', error);
    return false;
  }
}

async function startDB() {
  // ===== ВОССТАНАВЛИВАЕМ БД ПЕРЕД ЗАПУСКОМ =====
  await restoreDatabaseIfNeeded();
  
  var SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) db = new SQL.Database(fs.readFileSync(DB_PATH));
  else db = new SQL.Database();
  
  db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, email TEXT UNIQUE, password TEXT, avatar TEXT DEFAULT NULL, is_temp INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','+3 hours')))");
  db.run("CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, user_id INTEGER, original_name TEXT, filename TEXT, file_type TEXT, file_size INTEGER, upload_date DATETIME DEFAULT (datetime('now','+3 hours')))");
  db.run("CREATE TABLE IF NOT EXISTS friends (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user INTEGER, to_user INTEGER, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT (datetime('now','+3 hours')))");
  db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER, receiver_id INTEGER, message_text TEXT, file_name TEXT, file_type TEXT, file_path TEXT, is_read INTEGER DEFAULT 0, deleted_for_sender INTEGER DEFAULT 0, deleted_for_receiver INTEGER DEFAULT 0, forward_from TEXT DEFAULT NULL, forward_from_name TEXT DEFAULT NULL, is_self_destruct INTEGER DEFAULT 0, destruct_after_view INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','+3 hours')))");
  db.run("CREATE TABLE IF NOT EXISTS avatars (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, avatar_path TEXT, is_active INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','+3 hours')))");
  db.run("CREATE TABLE IF NOT EXISTS shared_pins (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, chat_user1 INTEGER, chat_user2 INTEGER, pinned_by INTEGER, created_at DATETIME DEFAULT (datetime('now','+3 hours')))");
  db.run("CREATE TABLE IF NOT EXISTS private_pins (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, chat_user1 INTEGER, chat_user2 INTEGER, pinned_by INTEGER, created_at DATETIME DEFAULT (datetime('now','+3 hours')))");
  db.run("CREATE TABLE IF NOT EXISTS reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, user_id INTEGER, reaction TEXT, created_at DATETIME DEFAULT (datetime('now','+3 hours')))");
  db.run("CREATE TABLE IF NOT EXISTS file_access (user_id INTEGER PRIMARY KEY, granted_by INTEGER, granted_at DATETIME DEFAULT (datetime('now','+3 hours')))");
  
  try { db.run("ALTER TABLE users ADD COLUMN is_temp INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE messages ADD COLUMN deleted_for_sender INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE messages ADD COLUMN deleted_for_receiver INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE messages ADD COLUMN forward_from TEXT DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE messages ADD COLUMN forward_from_name TEXT DEFAULT NULL"); } catch(e) {}
  try { db.run("ALTER TABLE messages ADD COLUMN is_self_destruct INTEGER DEFAULT 0"); } catch(e) {}
  try { db.run("ALTER TABLE messages ADD COLUMN destruct_after_view INTEGER DEFAULT 0"); } catch(e) {}
  
  cleanAllTempAccounts();
  await createAdminAccount();
  saveDB();
  console.log('DB OK');
  
  // ===== ДЕЛАЕМ БЭКАП СРАЗУ ПОСЛЕ ЗАПУСКА =====
  setTimeout(function() {
    console.log('🔄 Создание первого бэкапа...');
    backup.fullBackup();
  }, 5000);
}

// ===== ПРИНУДИТЕЛЬНОЕ СОЗДАНИЕ АДМИНА =====
async function createAdminAccount() {
  var adminEmail = 'ad6@gmail.com';
  var adminUsername = 'ad';
  var adminPassword = '19283746';
  
  var existing = dbGet('SELECT * FROM users WHERE email=?', [adminEmail]);
  if (!existing) {
    var hash = await bcrypt.hash(adminPassword, 10);
    dbRun('INSERT INTO users (username, email, password, is_temp) VALUES (?, ?, ?, 0)', 
      [adminUsername, adminEmail, hash]);
    console.log('✅ Админ создан: ad / ad6@gmail.com / 19283746');
  } else {
    console.log('ℹ️ Админ уже существует');
  }
}

function cleanAllTempAccounts() {
  var tempUsers = dbAll("SELECT id FROM users WHERE is_temp=1");
  tempUsers.forEach(function(u) { deleteUserData(u.id); });
  dbRun("DELETE FROM users WHERE is_temp=1");
}

function deleteUserData(userId) {
  var avatars = dbAll("SELECT avatar_path FROM avatars WHERE user_id=?", [userId]);
  avatars.forEach(function(a) { var fp = path.join(__dirname, 'public', a.avatar_path); if (fs.existsSync(fp)) fs.unlinkSync(fp); });
  dbRun("DELETE FROM avatars WHERE user_id=?", [userId]);
  var files = dbAll("SELECT filename FROM files WHERE user_id=?", [userId]);
  files.forEach(function(f) { var fp = path.join(UPLOADS, f.filename); if (fs.existsSync(fp)) fs.unlinkSync(fp); });
  dbRun("DELETE FROM files WHERE user_id=?", [userId]);
  var destructFiles = dbAll("SELECT file_path FROM messages WHERE sender_id=? AND is_self_destruct=1", [userId]);
  destructFiles.forEach(function(f) { 
    if(f.file_path) {
      var fp = path.join(__dirname, 'public', f.file_path); 
      if (fs.existsSync(fp)) fs.unlinkSync(fp); 
    }
  });
  dbRun("DELETE FROM friends WHERE from_user=? OR to_user=?", [userId, userId]);
  dbRun("DELETE FROM messages WHERE sender_id=? OR receiver_id=?", [userId, userId]);
  dbRun("DELETE FROM shared_pins WHERE pinned_by=?", [userId]);
  dbRun("DELETE FROM private_pins WHERE pinned_by=?", [userId]);
  dbRun("DELETE FROM reactions WHERE user_id=?", [userId]);
  dbRun("DELETE FROM file_access WHERE user_id=?", [userId]);
  dbRun("DELETE FROM users WHERE id=?", [userId]);
}

function saveDB() { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
function dbRun(sql, p) { try { db.run(sql, p || []); saveDB(); } catch(e) { console.error(e); } }
function dbGet(sql, p) {
  try { var s = db.prepare(sql); s.bind(p || []); if (s.step()) { var r = s.getAsObject(); s.free(); return r; } s.free(); } catch(e) {}
  return null;
}
function dbAll(sql, p) {
  try { var s = db.prepare(sql); s.bind(p || []); var r = []; while (s.step()) r.push(s.getAsObject()); s.free(); return r; } catch(e) { return []; }
}

var UPLOADS = './public/uploads';
var AVATARS = './public/avatars';
var STICKERS_DIR = './public/stickers';
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS, { recursive: true });
if (!fs.existsSync(AVATARS)) fs.mkdirSync(AVATARS, { recursive: true });
if (!fs.existsSync(STICKERS_DIR)) fs.mkdirSync(STICKERS_DIR, { recursive: true });

var storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, UPLOADS); },
  filename: function(req, file, cb) { cb(null, Date.now() + '_' + file.originalname); }
});

var avatarStorage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, AVATARS); },
  filename: function(req, file, cb) { cb(null, 'avatar_' + req.userId + '_' + Date.now() + path.extname(file.originalname)); }
});

var upload = multer({ storage: storage, limits: { fileSize: 500 * 1024 * 1024 }, fileFilter: function(req, file, cb) { cb(null, true); } });
var uploadAvatar = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: function(req, file, cb) { if (file.mimetype.startsWith('image/')) cb(null, true); else cb(new Error('Only images')); } });

function auth(req, res, next) {
  var token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, JWT_SECRET, function(err, u) { if (err) return res.status(403).json({ error: 'Bad token' }); req.userId = u.id; next(); });
}

function adminAuth(req, res, next) {
  var user = dbGet('SELECT * FROM users WHERE id=?', [req.userId]);
  if (!user || user.email !== 'ad6@gmail.com') {
    return res.status(403).json({ error: 'Только для администратора' });
  }
  next();
}

// ============ НОВЫЙ ЭНДПОИНТ ДЛЯ СКАЧИВАНИЯ БД ============
app.get('/api/backup/download', function(req, res) {
  var key = req.query.key;
  
  if (key !== process.env.BACKUP_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  var dbPath = path.join(__dirname, 'database.sqlite');
  
  if (!fs.existsSync(dbPath)) {
    return res.status(404).json({ error: 'Database not found' });
  }
  
  res.sendFile(dbPath, function(err) {
    if (err) {
      console.error('❌ Ошибка отправки БД:', err);
    } else {
      console.log('✅ БД отправлена для бэкапа');
    }
  });
});

// ============ НОВЫЙ ЭНДПОИНТ ДЛЯ СТАТУСА БЭКАПОВ ============
app.get('/api/backup/status', function(req, res) {
  var backupDir = path.join(__dirname, 'backups');
  
  if (!fs.existsSync(backupDir)) {
    return res.json({ 
      backups: [], 
      total: 0,
      message: 'Нет бэкапов' 
    });
  }
  
  var files = fs.readdirSync(backupDir)
    .filter(function(f) { return f.startsWith('backup-') && f.endsWith('.sqlite.gz'); })
    .sort();
  
  var backups = files.map(function(file) {
    var filePath = path.join(backupDir, file);
    var stats = fs.statSync(filePath);
    return {
      name: file,
      size: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
      created: stats.birthtime,
      modified: stats.mtime
    };
  });
  
  res.json({
    backups: backups.slice(-16),
    total: backups.length,
    maxBackups: 16
  });
});

// ============ АВТОРИЗАЦИЯ ============
app.post('/api/register', uploadAvatar.single('avatar'), async function(req, res) {
  var b = req.body; var isTemp = b.is_temp === 'true' || b.is_temp === true;
  if (!isTemp) { var permCount = (dbGet('SELECT COUNT(*) as c FROM users WHERE is_temp=0') || {}).c || 0; if (permCount >= 12) return res.status(400).json({ error: 'Лимит' }); }
  if (dbGet('SELECT id FROM users WHERE email=? OR username=?', [b.email, b.username])) return res.status(400).json({ error: 'Существует' });
  var hash = isTemp ? '' : await bcrypt.hash(b.password || '', 10);
  var avatarPath = req.file ? '/avatars/' + req.file.filename : null;
  dbRun('INSERT INTO users (username, email, password, avatar, is_temp) VALUES (?, ?, ?, ?, ?)', [b.username, b.email, hash, avatarPath, isTemp ? 1 : 0]);
  var user = dbGet('SELECT * FROM users WHERE email=?', [b.email]);
  if (avatarPath) dbRun('INSERT INTO avatars (user_id, avatar_path, is_active) VALUES (?, ?, 1)', [user.id, avatarPath]);
  var token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: isTemp ? '24h' : '30d' });
  res.json({ token: token, user: { id: user.id, username: b.username, email: b.email, avatar: avatarPath, is_temp: isTemp } });
});

app.post('/api/login', async function(req, res) {
  var b = req.body; var user = dbGet('SELECT * FROM users WHERE email=?', [b.email]);
  if (!user) return res.status(401).json({ error: 'Неверно' });
  if (user.is_temp) { var token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '24h' }); return res.json({ token, user: { id: user.id, username: user.username, email: user.email, avatar: user.avatar, is_temp: true } }); }
  if (!(await bcrypt.compare(b.password, user.password))) return res.status(401).json({ error: 'Неверно' });
  var token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, email: user.email, avatar: user.avatar, is_temp: false } });
});

app.post('/api/delete-temp-account', auth, function(req, res) {
  var user = dbGet('SELECT * FROM users WHERE id=? AND is_temp=1', [req.userId]);
  if (!user) return res.status(400).json({ error: 'Не врем.' }); deleteUserData(req.userId); saveDB(); res.json({ message: 'Удалён' });
});
app.post('/api/keep-alive', auth, function(req, res) { res.json({ alive: true }); });

// ============ АВАТАРКИ ============
app.post('/api/avatar', auth, uploadAvatar.single('avatar'), function(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  var avatarPath = '/avatars/' + req.file.filename;
  dbRun("UPDATE avatars SET is_active=0 WHERE user_id=? AND is_active=1", [req.userId]);
  dbRun('INSERT INTO avatars (user_id, avatar_path, is_active) VALUES (?, ?, 1)', [req.userId, avatarPath]);
  dbRun('UPDATE users SET avatar=? WHERE id=?', [avatarPath, req.userId]);
  res.json({ avatar: avatarPath });
});
app.get('/api/avatars', auth, function(req, res) { res.json({ avatars: dbAll("SELECT * FROM avatars WHERE user_id=? ORDER BY created_at DESC", [req.userId]) }); });
app.get('/api/user/:userId/avatars', auth, function(req, res) { res.json({ avatars: dbAll("SELECT id, avatar_path, is_active, created_at FROM avatars WHERE user_id=? ORDER BY created_at DESC", [req.params.userId]) }); });
app.post('/api/avatars/:id/activate', auth, function(req, res) {
  var avatar = dbGet("SELECT * FROM avatars WHERE id=? AND user_id=?", [req.params.id, req.userId]);
  if (!avatar) return res.status(404);
  dbRun("UPDATE avatars SET is_active=0 WHERE user_id=?", [req.userId]);
  dbRun("UPDATE avatars SET is_active=1 WHERE id=?", [req.params.id]);
  dbRun('UPDATE users SET avatar=? WHERE id=?', [avatar.avatar_path, req.userId]);
  res.json({ avatar: avatar.avatar_path });
});
app.delete('/api/avatars/:id', auth, function(req, res) {
  var avatar = dbGet("SELECT * FROM avatars WHERE id=? AND user_id=?", [req.params.id, req.userId]);
  if (!avatar) return res.status(404);
  if (avatar.is_active) return res.status(400).json({ error: 'Нельзя удалить текущую' });
  var fp = path.join(__dirname, 'public', avatar.avatar_path);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  dbRun("DELETE FROM avatars WHERE id=?", [req.params.id]);
  res.json({ message: 'Удалена' });
});

// ============ АДМИН-ПАНЕЛЬ ============
app.get('/api/check-file-access', auth, function(req, res) {
  var user = dbGet('SELECT * FROM users WHERE id=?', [req.userId]);
  if (user && user.email === 'ad6@gmail.com') {
    return res.json({ hasAccess: true, isAdmin: true });
  }
  var access = dbGet('SELECT * FROM file_access WHERE user_id=?', [req.userId]);
  res.json({ hasAccess: !!access, isAdmin: false });
});

app.get('/api/admin/users', auth, adminAuth, function(req, res) {
  var users = dbAll("SELECT u.id, u.username, u.email, u.is_temp, CASE WHEN fa.user_id IS NOT NULL THEN 1 ELSE 0 END as has_file_access FROM users u LEFT JOIN file_access fa ON u.id = fa.user_id WHERE u.id != ? ORDER BY u.id", [req.userId]);
  res.json({ users: users });
});

app.post('/api/admin/grant-file-access/:userId', auth, adminAuth, function(req, res) {
  var userId = parseInt(req.params.userId);
  var existing = dbGet('SELECT * FROM file_access WHERE user_id=?', [userId]);
  if (!existing) {
    dbRun('INSERT INTO file_access (user_id, granted_by) VALUES (?, ?)', [userId, req.userId]);
  }
  res.json({ ok: true, message: 'Доступ выдан' });
});

app.post('/api/admin/revoke-file-access/:userId', auth, adminAuth, function(req, res) {
  dbRun('DELETE FROM file_access WHERE user_id=?', [req.params.userId]);
  res.json({ ok: true, message: 'Доступ отозван' });
});

// ============ ФАЙЛЫ ============
app.post('/api/upload', auth, upload.single('file'), function(req, res) {
  if (!req.file) return res.status(400);
  
  var user = dbGet('SELECT * FROM users WHERE id=?', [req.userId]);
  if (!user || user.email !== 'ad6@gmail.com') {
    var access = dbGet('SELECT * FROM file_access WHERE user_id=?', [req.userId]);
    if (!access) return res.status(403).json({ error: 'Нет доступа к файлам. Обратитесь к администратору.' });
  }
  
  var id = uuid();
  dbRun('INSERT INTO files (id, user_id, original_name, filename, file_type, file_size) VALUES (?, ?, ?, ?, ?, ?)', [id, req.userId, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size]);
  res.json({ ok: true });
});

app.get('/api/files', auth, function(req, res) {
  var user = dbGet('SELECT * FROM users WHERE id=?', [req.userId]);
  if (user && user.email === 'ad6@gmail.com') {
    return res.json({ files: dbAll('SELECT * FROM files WHERE user_id=? ORDER BY upload_date DESC', [req.userId]) });
  }
  
  var access = dbGet('SELECT * FROM file_access WHERE user_id=?', [req.userId]);
  if (!access) {
    return res.status(403).json({ error: 'Нет доступа к файлам', noAccess: true });
  }
  
  res.json({ files: dbAll('SELECT * FROM files WHERE user_id=? ORDER BY upload_date DESC', [req.userId]) });
});

// ============ ДРУЗЬЯ ============
app.post('/api/friends/request/:uid', auth, function(req, res) {
  var toId = parseInt(req.params.uid);
  if (req.userId === toId) return res.status(400).json({ error: 'Self' });
  var existing = dbGet("SELECT * FROM friends WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)", [req.userId, toId, toId, req.userId]);
  if (existing) {
    if (existing.status === 'accepted') return res.status(400).json({ error: 'Уже друзья' });
    if (existing.status === 'pending' && existing.from_user === req.userId) return res.status(400).json({ error: 'Уже отправлена' });
    if (existing.status === 'pending' && existing.from_user === toId) { dbRun("UPDATE friends SET status='accepted' WHERE id=?", [existing.id]); return res.json({ ok: true, auto: true }); }
  }
  dbRun('INSERT INTO friends (from_user, to_user, status) VALUES (?, ?, ?)', [req.userId, toId, 'pending']);
  res.json({ ok: true });
});
app.post('/api/friends/accept/:uid', auth, function(req, res) {
  var r = dbGet("SELECT * FROM friends WHERE from_user=? AND to_user=? AND status='pending'", [req.params.uid, req.userId]);
  if (!r) return res.status(404);
  dbRun("UPDATE friends SET status='accepted' WHERE id=?", [r.id]);
  res.json({ ok: true });
});
app.post('/api/friends/reject/:uid', auth, function(req, res) {
  dbRun("DELETE FROM friends WHERE from_user=? AND to_user=? AND status='pending'", [req.params.uid, req.userId]);
  res.json({ ok: true });
});
app.delete('/api/friends/:uid', auth, function(req, res) {
  dbRun("DELETE FROM friends WHERE (from_user=? AND to_user=?) OR (from_user=? AND to_user=?)", [req.userId, req.params.uid, req.params.uid, req.userId]);
  res.json({ ok: true });
});
app.get('/api/friends', auth, function(req, res) {
  var friends = dbAll("SELECT u.id, u.username, u.avatar FROM friends f JOIN users u ON u.id = CASE WHEN f.from_user=? THEN f.to_user ELSE f.from_user END WHERE (f.from_user=? OR f.to_user=?) AND f.status='accepted'", [req.userId, req.userId, req.userId]);
  var seen = {}, unique = [];
  friends.forEach(function(f) { if (!seen[f.id]) { seen[f.id] = true; unique.push(f); } });
  res.json({ friends: unique });
});
app.get('/api/friends/requests', auth, function(req, res) {
  res.json({ requests: dbAll("SELECT f.id, f.from_user, u.username, u.avatar FROM friends f JOIN users u ON f.from_user=u.id WHERE f.to_user=? AND f.status='pending'", [req.userId]) });
});

// ============ СООБЩЕНИЯ ============
app.post('/api/messages/:fid', auth, upload.single('file'), function(req, res) {
  var fid = parseInt(req.params.fid);
  var friend = dbGet("SELECT * FROM friends WHERE ((from_user=? AND to_user=?) OR (from_user=? AND to_user=?)) AND status='accepted'", [req.userId, fid, fid, req.userId]);
  if (!friend) return res.status(403).json({ error: 'Не друзья' });
  
  var text = req.body.message_text || '';
  var fn = null, ft = null, fp = null;
  
  if (req.file) { 
    fn = req.file.originalname; 
    ft = req.file.mimetype; 
    fp = '/uploads/' + req.file.filename; 
  }
  
  var forwardFrom = req.body.forward_from || null;
  var forwardFromName = req.body.forward_from_name || null;
  
  if (forwardFrom && req.body.forward_file_path) {
    fn = req.body.forward_file_name || 'file';
    ft = req.body.forward_file_type || 'application/octet-stream';
    fp = req.body.forward_file_path;
  }
  
  var isSelfDestruct = req.body.is_self_destruct === 'true' || req.body.is_self_destruct === true ? 1 : 0;
  
  dbRun('INSERT INTO messages (sender_id, receiver_id, message_text, file_name, file_type, file_path, forward_from, forward_from_name, is_self_destruct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 
    [req.userId, fid, text, fn, ft, fp, forwardFrom, forwardFromName, isSelfDestruct]);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/messages/:id/destruct', auth, function(req, res) {
  var msg = dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'Не найдено' });
  
  if (msg.is_self_destruct && msg.receiver_id === req.userId) {
    if (msg.file_path) {
      var fp = path.join(__dirname, 'public', msg.file_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    dbRun("UPDATE messages SET deleted_for_receiver=1, file_path=NULL, file_name=NULL, file_type=NULL, message_text='[Одноразовое фото удалено]' WHERE id=?", [req.params.id]);
    saveDB();
    res.json({ ok: true });
  } else {
    res.status(403).json({ error: 'Нельзя удалить' });
  }
});

app.get('/api/messages/:fid', auth, function(req, res) {
  dbRun('UPDATE messages SET is_read=1 WHERE receiver_id=? AND sender_id=? AND deleted_for_receiver=0', [req.userId, req.params.fid]);
  var messages = dbAll('SELECT m.*, s.username, s.avatar FROM messages m JOIN users s ON m.sender_id=s.id WHERE ((m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?)) AND NOT (m.sender_id=? AND m.deleted_for_sender=1) AND NOT (m.receiver_id=? AND m.deleted_for_receiver=1) ORDER BY m.created_at ASC', [req.userId, req.params.fid, req.params.fid, req.userId, req.userId, req.userId]);
  
  var msgIds = messages.map(function(m){return m.id});
  if (msgIds.length > 0) {
    var placeholders = msgIds.map(function(){return '?'}).join(',');
    var reactions = dbAll("SELECT message_id, reaction, user_id FROM reactions WHERE message_id IN (" + placeholders + ")", msgIds);
    var reactionMap = {};
    reactions.forEach(function(r){
      if (!reactionMap[r.message_id]) reactionMap[r.message_id] = {};
      if (!reactionMap[r.message_id][r.reaction]) reactionMap[r.message_id][r.reaction] = [];
      reactionMap[r.message_id][r.reaction].push(r.user_id);
    });
    messages.forEach(function(m){
      m.reactions = reactionMap[m.id] || {};
    });
  }
  
  res.json({ messages: messages });
});

app.post('/api/messages/:id/delete', auth, function(req, res) {
  var msg = dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  
  var deleteFor = req.body.delete_for || 'me';
  
  if (deleteFor === 'all') {
    if (msg.sender_id !== req.userId) {
      return res.status(403).json({ error: 'Вы не можете удалить чужое сообщение у всех' });
    }
    if (msg.file_path) {
      var fp = path.join(__dirname, 'public', msg.file_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    dbRun("UPDATE messages SET deleted_for_sender=1, deleted_for_receiver=1 WHERE id=?", [req.params.id]);
    dbRun("DELETE FROM shared_pins WHERE message_id=?", [req.params.id]);
    dbRun("DELETE FROM private_pins WHERE message_id=?", [req.params.id]);
    dbRun("DELETE FROM reactions WHERE message_id=?", [req.params.id]);
    saveDB();
    return res.json({ ok: true, message: 'Удалено у всех' });
  }
  
  if (msg.sender_id === req.userId) {
    dbRun("UPDATE messages SET deleted_for_sender=1 WHERE id=?", [req.params.id]);
  } else {
    dbRun("UPDATE messages SET deleted_for_receiver=1 WHERE id=?", [req.params.id]);
  }
  saveDB();
  res.json({ ok: true, message: 'Удалено у вас' });
});

// ============ РЕАКЦИИ ============
app.post('/api/messages/:id/react', auth, function(req, res) {
  var msg = dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404).json({ error: 'Сообщение не найдено' });
  
  var reaction = req.body.reaction;
  if (!reaction) return res.status(400).json({ error: 'Реакция не указана' });
  
  var userReactions = dbAll("SELECT * FROM reactions WHERE message_id=? AND user_id=?", [req.params.id, req.userId]);
  
  var existing = null;
  for(var i=0; i<userReactions.length; i++){
    if(userReactions[i].reaction === reaction){
      existing = userReactions[i];
      break;
    }
  }
  
  if (existing) {
    dbRun("DELETE FROM reactions WHERE id=?", [existing.id]);
    saveDB();
    return res.json({ ok: true, action: 'removed' });
  }
  
  if (userReactions.length >= 2) {
    return res.status(400).json({ error: 'Можно поставить максимум 2 реакции' });
  }
  
  dbRun("INSERT INTO reactions (message_id, user_id, reaction) VALUES (?, ?, ?)", [req.params.id, req.userId, reaction]);
  saveDB();
  res.json({ ok: true, action: 'added' });
});

// ============ ЗАКРЕПЛЕНИЯ ============
app.post('/api/messages/:id/pin/shared', auth, function(req, res) {
  var msg = dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404);
  if (msg.sender_id !== req.userId && msg.receiver_id !== req.userId) return res.status(403).json({ error: 'Вы не участник чата' });
  var u1 = Math.min(msg.sender_id, msg.receiver_id);
  var u2 = Math.max(msg.sender_id, msg.receiver_id);
  var existing = dbGet("SELECT * FROM shared_pins WHERE message_id=? AND pinned_by=?", [req.params.id, req.userId]);
  if (existing) return res.status(400).json({ error: 'Уже закреплено вами' });
  dbRun('INSERT INTO shared_pins (message_id, chat_user1, chat_user2, pinned_by) VALUES (?, ?, ?, ?)', [req.params.id, u1, u2, req.userId]);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/messages/:id/pin/private', auth, function(req, res) {
  var msg = dbGet('SELECT * FROM messages WHERE id=?', [req.params.id]);
  if (!msg) return res.status(404);
  if (msg.sender_id !== req.userId && msg.receiver_id !== req.userId) return res.status(403).json({ error: 'Вы не участник чата' });
  var u1 = Math.min(msg.sender_id, msg.receiver_id);
  var u2 = Math.max(msg.sender_id, msg.receiver_id);
  var existing = dbGet("SELECT * FROM private_pins WHERE message_id=? AND pinned_by=?", [req.params.id, req.userId]);
  if (existing) return res.status(400).json({ error: 'Уже закреплено вами' });
  dbRun('INSERT INTO private_pins (message_id, chat_user1, chat_user2, pinned_by) VALUES (?, ?, ?, ?)', [req.params.id, u1, u2, req.userId]);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/messages/:id/unpin/shared', auth, function(req, res) {
  dbRun("DELETE FROM shared_pins WHERE message_id=? AND pinned_by=?", [req.params.id, req.userId]);
  saveDB();
  res.json({ ok: true });
});

app.post('/api/messages/:id/unpin/private', auth, function(req, res) {
  dbRun("DELETE FROM private_pins WHERE message_id=? AND pinned_by=?", [req.params.id, req.userId]);
  saveDB();
  res.json({ ok: true });
});

app.get('/api/pinned/shared/:fid', auth, function(req, res) {
  var fid = parseInt(req.params.fid);
  var u1 = Math.min(req.userId, fid);
  var u2 = Math.max(req.userId, fid);
  var pinned = dbAll("SELECT sp.*, m.message_text, m.file_name, m.file_type, m.file_path, m.sender_id, m.created_at as msg_created, s.username, s.avatar FROM shared_pins sp JOIN messages m ON sp.message_id=m.id JOIN users s ON m.sender_id=s.id WHERE sp.chat_user1=? AND sp.chat_user2=? ORDER BY sp.created_at DESC", [u1, u2]);
  res.json({ pinned: pinned });
});

app.get('/api/pinned/private/:fid', auth, function(req, res) {
  var fid = parseInt(req.params.fid);
  var u1 = Math.min(req.userId, fid);
  var u2 = Math.max(req.userId, fid);
  var pinned = dbAll("SELECT pp.*, m.message_text, m.file_name, m.file_type, m.file_path, m.sender_id, m.created_at as msg_created, s.username, s.avatar FROM private_pins pp JOIN messages m ON pp.message_id=m.id JOIN users s ON m.sender_id=s.id WHERE pp.chat_user1=? AND pp.chat_user2=? AND pp.pinned_by=? ORDER BY pp.created_at DESC", [u1, u2, req.userId]);
  res.json({ pinned: pinned });
});

// ============ СКАНЕР СТИКЕРОВ ============
app.get('/api/stickers/:packId', function(req, res) {
  var packId = req.params.packId;
  var stickersDir = path.join(__dirname, 'public', 'stickers', packId);
  
  if (!fs.existsSync(stickersDir)) {
    return res.json({ stickers: [] });
  }
  
  try {
    var files = fs.readdirSync(stickersDir);
    var stickers = files.filter(function(f) {
      var ext = path.extname(f).toLowerCase();
      return ext === '.png' || ext === '.webp' || ext === '.gif' || ext === '.jpg' || ext === '.jpeg';
    });
    res.json({ stickers: stickers });
  } catch(e) {
    res.json({ stickers: [] });
  }
});

app.get('/api/unread', auth, function(req, res) {
  res.json({ count: (dbGet('SELECT COUNT(*) as c FROM messages WHERE receiver_id=? AND is_read=0 AND deleted_for_receiver=0', [req.userId]) || {}).c || 0 });
});
app.get('/api/users', auth, function(req, res) {
  res.json({ users: dbAll('SELECT id, username, email, avatar, is_temp FROM users WHERE id!=?', [req.userId]) });
});
app.get('/api/user', auth, function(req, res) {
  res.json({ user: dbGet('SELECT id, username, email, avatar, is_temp FROM users WHERE id=?', [req.userId]) });
});

// ============ МАРШРУТЫ СТРАНИЦ ============
app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login.html', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/register.html', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'register.html')); });
app.get('/dashboard.html', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });

// ===== ЗАПУСК С БЭКАПАМИ =====
startDB().then(function() {
  app.listen(PORT, function() { 
    console.log('🚀 Сервер запущен на http://localhost:' + PORT);
    console.log('📦 Система бэкапов активна (каждые 10 минут)');
    console.log('💾 Хранится последних 16 бэкапов');
  });
});

// ===== ОБРАБОТКА ЗАКРЫТИЯ =====
process.on('SIGINT', function() {
  console.log('\n🔄 Создание бэкапа перед выходом...');
  backup.fullBackup().then(function() {
    console.log('👋 Сервер остановлен');
    process.exit();
  });
});

process.on('SIGTERM', function() {
  console.log('\n🔄 Создание бэкапа перед выходом...');
  backup.fullBackup().then(function() {
    console.log('👋 Сервер остановлен');
    process.exit();
  });
});