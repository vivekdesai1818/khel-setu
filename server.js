const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-khelsetu-local-development-secret';
const DB_FILE = path.join(__dirname, 'khelsetu.sqlite');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ADMIN_EMAIL = process.env.SPORTS_ADMIN_EMAIL || 'sports.admin@khelsetu.demo';
const ADMIN_PASSWORD = process.env.SPORTS_ADMIN_PASSWORD || 'KhelSetu@2026';
const SCHOOL_EMAIL = process.env.SCHOOL_AUTHORITY_EMAIL || 'school.authority@khelsetu.demo';
const SCHOOL_PASSWORD = process.env.SCHOOL_AUTHORITY_PASSWORD || 'School@2026';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

// Serve the new frontend and preserve the old portal URLs as friendly aliases.
const FRONTEND_FILES = new Set(['index.html', 'app.js', 'style.css']);
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get(['/athlete-login.html', '/scout-login.html', '/coach-login.html', '/donor-login.html', '/dashboard.html', '/scout.html', '/coach.html', '/donor.html', '/feed.html'], (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/:file', (req, res, next) => {
  const file = req.params.file;
  if (!FRONTEND_FILES.has(file)) return next();
  const target = path.join(__dirname, 'public', file);
  if (!fs.existsSync(target)) return res.status(404).send(`${file} was not found in the public folder.`);
  return res.sendFile(target);
});

let db;
let saveQueue = Promise.resolve();

function saveDatabase() {
  // Serialize writes so two requests cannot overwrite one another's latest DB snapshot.
  saveQueue = saveQueue.then(() => {
    const bytes = db.export();
    fs.writeFileSync(DB_FILE, Buffer.from(bytes));
  });
  return saveQueue;
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
}

function one(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    return stmt.step() ? stmt.getAsObject() : null;
  } finally {
    stmt.free();
  }
}

function many(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function safeUser(row) {
  if (!row) return null;
  let profile = {};
  try { profile = JSON.parse(row.profile_json || '{}'); } catch (_) {}
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    sport: row.sport || '',
    district: row.district || '',
    created_at: row.created_at,
    approval_status: row.approval_status || 'approved',
    school_name: row.school_name || '',
    profile
  };
}

function createToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Please log in first.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (String(payload.sub) === '-1' && payload.role === 'administrator') { req.user = { id: -1, name: 'Sports Administrator', email: ADMIN_EMAIL, role: 'administrator', sport: '', district: '', profile: {} }; return next(); }
    if (String(payload.sub) === '-2' && payload.role === 'school_authority') { req.user = { id: -2, name: 'School Authority', email: SCHOOL_EMAIL, role: 'school_authority', sport: '', district: '', profile: { school_name: 'Demo Government School' } }; return next(); }
    const row = one('SELECT * FROM users WHERE id = ?', [payload.sub]);
    if (!row) return res.status(401).json({ error: 'Account not found. Please log in again.' });
    if (row.approval_status === 'pending' || row.approval_status === 'rejected') return res.status(403).json({ error: 'This account is not approved.' });
    req.user = safeUser(row);
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'This action is not available for your account role.' });
}

function cleanText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function requireFields(obj, fields) {
  return fields.filter((key) => !cleanText(obj[key], key === 'password' ? 200 : 500));
}

function createTables() {
  db.run(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('athlete','scout','coach','donor','judge','school_authority')),
      sport TEXT DEFAULT '',
      district TEXT DEFAULT '',
      approval_status TEXT NOT NULL DEFAULT 'approved',
      school_name TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      profile_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS approval_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), request_role TEXT NOT NULL, school_name TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', reviewed_by TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS tournament_results (id INTEGER PRIMARY KEY AUTOINCREMENT, athlete_id INTEGER NOT NULL REFERENCES users(id), judge_id INTEGER NOT NULL REFERENCES users(id), tournament_name TEXT NOT NULL, tournament_level TEXT NOT NULL, sport TEXT NOT NULL, event_name TEXT DEFAULT '', position INTEGER NOT NULL, performance TEXT DEFAULT '', base_points INTEGER NOT NULL, bonus_points INTEGER NOT NULL DEFAULT 0, total_points INTEGER NOT NULL, review TEXT DEFAULT '', certificate_url TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(athlete_id,tournament_name,event_name));
    CREATE TABLE IF NOT EXISTS support_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      athlete_id INTEGER NOT NULL REFERENCES users(id),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      video_url TEXT NOT NULL,
      video_type TEXT NOT NULL CHECK(video_type IN ('training','masterclass')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coach_id INTEGER NOT NULL REFERENCES users(id),
      athlete_id INTEGER NOT NULL REFERENCES users(id),
      video_id INTEGER REFERENCES videos(id),
      rating INTEGER,
      comment TEXT NOT NULL,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      receiver_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scout_id INTEGER NOT NULL REFERENCES users(id),
      athlete_id INTEGER NOT NULL REFERENCES users(id),
      message TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'sent',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS passbook_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      athlete_id INTEGER NOT NULL REFERENCES users(id),
      record_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      points INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS pledges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donor_id INTEGER NOT NULL REFERENCES users(id),
      support_request_id INTEGER NOT NULL REFERENCES support_requests(id),
      amount REAL NOT NULL,
      note TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pledged',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS community_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS community_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES community_posts(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
  const userCols = many('PRAGMA table_info(users)').map(c => c.name);
  if (!userCols.includes('approval_status')) db.run("ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'");
  if (!userCols.includes('school_name')) db.run("ALTER TABLE users ADD COLUMN school_name TEXT DEFAULT ''");
  const userSchema = one("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")?.sql || '';
  if (!userSchema.includes("'judge'")) {
    db.run('PRAGMA foreign_keys = OFF');
    db.run(`CREATE TABLE users_new (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('athlete','scout','coach','donor','judge','school_authority')),sport TEXT DEFAULT '',district TEXT DEFAULT '',approval_status TEXT NOT NULL DEFAULT 'approved',school_name TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,profile_json TEXT NOT NULL DEFAULT '{}')`);
    db.run('INSERT INTO users_new (id,name,email,password_hash,role,sport,district,approval_status,school_name,created_at,profile_json) SELECT id,name,email,password_hash,role,sport,district,approval_status,school_name,created_at,profile_json FROM users');
    db.run('DROP TABLE users'); db.run('ALTER TABLE users_new RENAME TO users'); db.run('PRAGMA foreign_keys = ON');
  }
}

// Authority review and judge-entered tournament records (prototype workflow).
app.get('/api/authority/requests', auth, allowRoles('administrator','school_authority'), (req,res) => {
  let rows = many(`SELECT ar.*,u.name,u.email,u.sport,u.district,u.approval_status FROM approval_requests ar JOIN users u ON u.id=ar.user_id WHERE ar.status='pending' ORDER BY ar.created_at ASC`);
  if (req.user.role === 'school_authority') rows = rows.filter(r => r.request_role === 'athlete' && String(r.school_name||'').trim().toLowerCase() === 'demo government school');
  else rows = rows.filter(r => r.request_role !== 'athlete');
  res.json({ requests: rows });
});
app.post('/api/authority/requests/:id/decision', auth, allowRoles('administrator','school_authority'), async (req,res) => {
  const id = Number(req.params.id), decision = cleanText(req.body.decision,20).toLowerCase();
  if (!['approve','reject'].includes(decision)) return res.status(400).json({error:'Choose approve or reject.'});
  const request = one("SELECT ar.*,u.role AS user_role FROM approval_requests ar JOIN users u ON u.id=ar.user_id WHERE ar.id=? AND ar.status='pending'",[id]);
  if (!request) return res.status(404).json({error:'Pending request not found.'});
  if (req.user.role === 'school_authority' && request.request_role !== 'athlete') return res.status(403).json({error:'School authorities can only review athlete requests.'});
  const status = decision === 'approve' ? 'approved' : 'rejected';
  run('UPDATE users SET approval_status=? WHERE id=?',[status,request.user_id]);
  run('UPDATE approval_requests SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?',[status,req.user.email,id]);
  await saveDatabase(); res.json({message:`Request ${status}.`});
});
app.get('/api/authority/athletes', auth, allowRoles('administrator','school_authority'), (req,res) => {
  const rows = many("SELECT * FROM users WHERE role='athlete' AND approval_status='approved' ORDER BY name COLLATE NOCASE").filter(r => req.user.role !== 'school_authority' || String(r.school_name||'').trim().toLowerCase() === 'demo government school').map(r=>{const u=safeUser(r);u.points=Number(one('SELECT COALESCE(SUM(total_points),0) AS n FROM tournament_results WHERE athlete_id=?',[u.id]).n||0)+Number(one('SELECT COALESCE(SUM(points),0) AS n FROM passbook_records WHERE athlete_id=?',[u.id]).n||0);return u;});
  res.json({athletes:rows});
});
app.get('/api/judge/athletes', auth, allowRoles('judge'), (req,res)=>res.json({athletes:many("SELECT id,name,sport,district,school_name FROM users WHERE role='athlete' AND approval_status='approved' ORDER BY name COLLATE NOCASE")}));
app.post('/api/judge/results', auth, allowRoles('judge'), async (req,res)=>{
  const b=req.body, athleteId=Number(b.athlete_id), tournament=cleanText(b.tournament_name,200), level=cleanText(b.tournament_level,30), sport=cleanText(b.sport,100), event=cleanText(b.event_name,120), position=Number(b.position), performance=cleanText(b.performance,100), review=cleanText(b.review,1500), bonus=Number(b.bonus_points||0), cert=cleanText(b.certificate_url,500);
  const levels={Taluka:1,District:1.5,State:2,National:2.5,International:3}; const multiplier=levels[level];
  if(!one("SELECT id FROM users WHERE id=? AND role='athlete' AND approval_status='approved'",[athleteId]))return res.status(404).json({error:'Approved athlete not found.'});
  if(!tournament||!level||!multiplier||!sport||!Number.isInteger(position)||position<1||position>100||!review)return res.status(400).json({error:'Complete tournament, level, sport, position and observer review.'});
  if(!Number.isInteger(bonus)||bonus<0||bonus>5)return res.status(400).json({error:'Additional performance points must be between 0 and 5.'});
  const base={Taluka:{1:10,2:8,3:6,other:2},District:{1:18,2:15,3:12,other:5},State:{1:25,2:21,3:18,other:7},National:{1:35,2:30,3:25,other:10},International:{1:45,2:38,3:32,other:12}}[level]; const basePoints=base[position]||base.other,total=basePoints+bonus;
  try{run('INSERT INTO tournament_results (athlete_id,judge_id,tournament_name,tournament_level,sport,event_name,position,performance,base_points,bonus_points,total_points,review,certificate_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',[athleteId,req.user.id,tournament,level,sport,event,position,performance,basePoints,bonus,total,review,cert]);await saveDatabase();res.status(201).json({message:'Tournament result recorded.',points:{base:basePoints,bonus,total}});}catch(e){res.status(409).json({error:'This athlete already has a result for this tournament and event. Use a unique tournament/event name.'});}
});
app.get('/api/athletes/:id/tournament-results', auth, allowRoles('athlete','scout','coach','administrator','school_authority','judge'), (req,res)=>{const id=Number(req.params.id);if(req.user.role==='athlete'&&req.user.id!==id)return res.status(403).json({error:'You can only view your own records.'});const results=many('SELECT t.*,u.name AS judge_name FROM tournament_results t JOIN users u ON u.id=t.judge_id WHERE t.athlete_id=? ORDER BY t.created_at DESC',[id]);res.json({results});});

app.get('/api/contacts', auth, (req, res) => {
  const contacts = many('SELECT id,name,role,sport,district FROM users WHERE id<>? ORDER BY name COLLATE NOCASE', [req.user.id]);
  res.json({ contacts });
});

app.get('/api/leaderboard', auth, (req, res) => {
  const sport = cleanText(req.query.sport,100).toLowerCase(), district = cleanText(req.query.district,100).toLowerCase();
  const athletes = many("SELECT * FROM users WHERE role='athlete' AND approval_status='approved'").map((row) => {
    const user = safeUser(row);
    user.points = Number(one('SELECT COALESCE(SUM(points),0) AS total FROM passbook_records WHERE athlete_id=?', [user.id]).total || 0) + Number(one('SELECT COALESCE(SUM(total_points),0) AS total FROM tournament_results WHERE athlete_id=?', [user.id]).total || 0);
    user.achievementCount = one('SELECT COUNT(*) AS total FROM passbook_records WHERE athlete_id=?', [user.id]).total;
    return user;
  }).filter(a => (!sport || (a.sport||'').toLowerCase().includes(sport)) && (!district || (a.district||'').toLowerCase().includes(district))).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  res.json({ athletes });
});

app.get('/api/posts', auth, (req, res) => {
  const posts = many(`SELECT p.*,u.name AS author_name,u.role AS author_role,u.sport AS author_sport,u.district AS author_district
    FROM community_posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.id DESC LIMIT 100`);
  for (const post of posts) post.comments = many(`SELECT c.*,u.name AS author_name,u.role AS author_role FROM community_comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.created_at ASC`, [post.id]);
  res.json({ posts });
});

app.post('/api/posts', auth, async (req, res) => {
  const body = cleanText(req.body.body || req.body.content, 2000);
  if (!body) return res.status(400).json({ error: 'Write something before publishing your post.' });
  run('INSERT INTO community_posts (user_id,body) VALUES (?,?)', [req.user.id, body]);
  await saveDatabase();
  res.status(201).json({ message: 'Your community post is live.', post: one('SELECT * FROM community_posts WHERE id=last_insert_rowid()') });
});

app.post('/api/posts/:id/comments', auth, async (req, res) => {
  const postId = Number(req.params.id);
  const body = cleanText(req.body.body, 1000);
  if (!one('SELECT id FROM community_posts WHERE id=?', [postId])) return res.status(404).json({ error: 'Post not found.' });
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  run('INSERT INTO community_comments (post_id,user_id,body) VALUES (?,?,?)', [postId, req.user.id, body]);
  await saveDatabase();
  res.status(201).json({ message: 'Comment added.' });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'KhelSetu API', port: PORT, database: 'SQLite', time: new Date().toISOString() });
});

app.post('/api/register', async (req, res) => {
  try {
    const name = cleanText(req.body.name, 100);
    const email = cleanText(req.body.email, 254).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const role = cleanText(req.body.role, 20).toLowerCase();
    const sport = cleanText(req.body.sport, 100);
    const district = cleanText(req.body.district, 100);

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Please fill in your name, email, password and account role.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    if (!['athlete', 'scout', 'coach', 'donor', 'judge'].includes(role)) return res.status(400).json({ error: 'Invalid account role.' });
    if (one('SELECT id FROM users WHERE email = ?', [email])) return res.status(409).json({ error: 'An account with this email already exists. Please log in instead.' });

    const passwordHash = await bcrypt.hash(password, 12);
    const schoolName = cleanText(req.body.school_name, 200);
    const needsApproval = ['athlete','coach','scout','judge'].includes(role);
    if (role === 'athlete' && !schoolName) return res.status(400).json({ error: 'Enter your school name so its authority can review your request.' });
    run('INSERT INTO users (name,email,password_hash,role,sport,district,profile_json,approval_status,school_name) VALUES (?,?,?,?,?,?,?,?,?)',
      [name, email, passwordHash, role, sport, district, '{}', needsApproval ? 'pending' : 'approved', schoolName]);
    const row = one('SELECT * FROM users WHERE email = ?', [email]);
    if (needsApproval) run('INSERT INTO approval_requests (user_id,request_role,school_name) VALUES (?,?,?)', [row.id, role, schoolName]);
    await saveDatabase();
    return res.status(201).json({ message: needsApproval ? 'Registration submitted. Your account will activate after approval.' : 'Registration successful.', pending: needsApproval, user: safeUser(row) });
  } catch (err) {
    console.error('Register error:', err.message);
    return res.status(500).json({ error: 'Could not create the account. Please try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const email = cleanText(req.body.email, 254).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const role = cleanText(req.body.role, 20).toLowerCase();
    if (!email || !password || !role) return res.status(400).json({ error: 'Please enter email, password and role.' });
    if (role === 'administrator' && email === ADMIN_EMAIL && password === ADMIN_PASSWORD) { const user = { id: -1, name: 'Sports Administrator', email, role: 'administrator', sport: '', district: '', profile: {} }; return res.json({ message: 'Administrator login successful.', token: createToken(user), user }); }
    if (role === 'school_authority' && email === SCHOOL_EMAIL && password === SCHOOL_PASSWORD) { const user = { id: -2, name: 'School Authority', email, role: 'school_authority', sport: '', district: '', profile: { school_name: 'Demo Government School' } }; return res.json({ message: 'School authority login successful.', token: createToken(user), user }); }
    const row = one('SELECT * FROM users WHERE email = ?', [email]);
    if (!row) return res.status(401).json({ error: 'No account found with this email. Please register first.' });
    if (row.role !== role) return res.status(403).json({ error: `This account is registered as ${row.role}. Please use the correct portal.` });
    if (row.approval_status === 'pending') return res.status(403).json({ error: 'Your registration is pending approval. You can log in after the authority approves it.' });
    if (row.approval_status === 'rejected') return res.status(403).json({ error: 'Your registration request was rejected. Please contact the relevant authority.' });
    const matches = await bcrypt.compare(password, row.password_hash);
    if (!matches) return res.status(401).json({ error: 'Incorrect email or password.' });
    const user = safeUser(row);
    return res.json({ message: 'Login successful.', token: createToken(user), user });
  } catch (err) {
    console.error('Login error:', err.message);
    return res.status(500).json({ error: 'Could not log in. Please try again.' });
  }
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.patch('/api/profile', auth, async (req, res) => {
  try {
    const row = one('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const oldProfile = JSON.parse(row.profile_json || '{}');
    const allowed = ['age', 'height', 'weight', 'bio', 'phone', 'organization', 'specialization', 'achievements'];
    const profile = { ...oldProfile };
    for (const key of allowed) if (req.body[key] !== undefined) profile[key] = typeof req.body[key] === 'string' ? cleanText(req.body[key], 1000) : req.body[key];
    const name = req.body.name === undefined ? row.name : cleanText(req.body.name, 100);
    const sport = req.body.sport === undefined ? row.sport : cleanText(req.body.sport, 100);
    const district = req.body.district === undefined ? row.district : cleanText(req.body.district, 100);
    if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
    run('UPDATE users SET name=?, sport=?, district=?, profile_json=? WHERE id=?', [name, sport, district, JSON.stringify(profile), req.user.id]);
    await saveDatabase();
    return res.json({ message: 'Profile updated.', user: safeUser(one('SELECT * FROM users WHERE id=?', [req.user.id])) });
  } catch (err) {
    console.error('Profile update error:', err.message);
    res.status(500).json({ error: 'Could not update profile.' });
  }
});

app.get('/api/dashboard', auth, (req, res) => {
  const user = req.user;
  const base = { user };
  if (user.role === 'athlete') {
    base.points = one('SELECT COALESCE(SUM(points),0) AS total FROM passbook_records WHERE athlete_id=?', [user.id]).total;
    base.passbook = many('SELECT * FROM passbook_records WHERE athlete_id=? ORDER BY created_at DESC, id DESC', [user.id]);
    const tournamentRows = many("SELECT id,'tournament' AS record_type,tournament_name AS title,review AS description,total_points AS points,created_at FROM tournament_results WHERE athlete_id=? ORDER BY created_at DESC",[user.id]);
    base.passbook = base.passbook.concat(tournamentRows).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
    base.points = Number(base.points||0) + Number(one('SELECT COALESCE(SUM(total_points),0) AS total FROM tournament_results WHERE athlete_id=?',[user.id]).total||0);
    base.reviews = many('SELECT r.*, u.name AS coach_name FROM reviews r JOIN users u ON u.id=r.coach_id WHERE r.athlete_id=? ORDER BY r.created_at DESC', [user.id]);
    base.supportRequests = many('SELECT * FROM support_requests WHERE athlete_id=? ORDER BY created_at DESC', [user.id]);
    base.invitations = many('SELECT i.*,u.name AS scout_name FROM invitations i JOIN users u ON u.id=i.scout_id WHERE i.athlete_id=? ORDER BY i.created_at DESC', [user.id]);
  } else if (user.role === 'scout') {
    base.invitations = many('SELECT i.*,u.name AS athlete_name FROM invitations i JOIN users u ON u.id=i.athlete_id WHERE i.scout_id=? ORDER BY i.created_at DESC', [user.id]);
    base.athleteCount = one("SELECT COUNT(*) AS n FROM users WHERE role='athlete'").n;
  } else if (user.role === 'coach') {
    base.pendingVideos = many("SELECT v.*,u.name AS athlete_name FROM videos v JOIN users u ON u.id=v.user_id WHERE v.video_type='training' ORDER BY v.created_at DESC");
    base.masterclasses = many("SELECT * FROM videos WHERE user_id=? AND video_type='masterclass' ORDER BY created_at DESC", [user.id]);
    base.unreadMessages = many('SELECT m.*,u.name AS sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.receiver_id=? ORDER BY m.created_at DESC', [user.id]);
  } else if (user.role === 'donor') {
    base.supportRequests = many("SELECT s.*,u.name AS athlete_name,u.sport,u.district,u.profile_json FROM support_requests s JOIN users u ON u.id=s.athlete_id WHERE s.status='open' ORDER BY s.created_at DESC");
    base.pledges = many('SELECT p.*,s.category,u.name AS athlete_name FROM pledges p JOIN support_requests s ON s.id=p.support_request_id JOIN users u ON u.id=s.athlete_id WHERE p.donor_id=? ORDER BY p.created_at DESC', [user.id]);
  }
  res.json(base);
});

app.get('/api/athletes', auth, allowRoles('scout', 'coach', 'donor'), (req, res) => {
  const sport = cleanText(req.query.sport, 100).toLowerCase();
  const district = cleanText(req.query.district, 100).toLowerCase();
  const athletes = many("SELECT * FROM users WHERE role='athlete' AND approval_status='approved' ORDER BY created_at DESC").map((row) => {
    const user = safeUser(row);
    user.points = Number(one('SELECT COALESCE(SUM(points),0) AS total FROM passbook_records WHERE athlete_id=?', [user.id]).total||0) + Number(one('SELECT COALESCE(SUM(total_points),0) AS total FROM tournament_results WHERE athlete_id=?', [user.id]).total||0);
    user.passbookCount = one('SELECT COUNT(*) AS total FROM passbook_records WHERE athlete_id=?', [user.id]).total;
    return user;
  }).filter((a) => (!sport || (a.sport || '').toLowerCase().includes(sport)) && (!district || (a.district || '').toLowerCase().includes(district)));
  res.json({ athletes });
});

app.get('/api/athletes/:id', auth, allowRoles('scout', 'coach', 'donor','administrator','school_authority','judge'), (req, res) => {
  const row = one("SELECT * FROM users WHERE id=? AND role='athlete'", [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'Athlete not found.' });
  const athlete = safeUser(row);
  athlete.points = Number(one('SELECT COALESCE(SUM(points),0) AS total FROM passbook_records WHERE athlete_id=?', [athlete.id]).total||0) + Number(one('SELECT COALESCE(SUM(total_points),0) AS total FROM tournament_results WHERE athlete_id=?', [athlete.id]).total||0);
  athlete.passbook = many('SELECT * FROM passbook_records WHERE athlete_id=? ORDER BY created_at DESC', [athlete.id]);
  athlete.reviews = many('SELECT r.*,u.name AS coach_name FROM reviews r JOIN users u ON u.id=r.coach_id WHERE r.athlete_id=? ORDER BY r.created_at DESC', [athlete.id]);
  res.json({ athlete });
});

app.get('/api/athletes/:id/passbook', auth, (req, res) => {
  const athleteId = Number(req.params.id);
  if (req.user.role === 'athlete' && req.user.id !== athleteId) return res.status(403).json({ error: 'You can only view your own passbook.' });
  if (!['athlete', 'scout', 'coach', 'donor'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed.' });
  const athlete = one("SELECT id FROM users WHERE id=? AND role='athlete'", [athleteId]);
  if (!athlete) return res.status(404).json({ error: 'Athlete not found.' });
  res.json({ records: many('SELECT p.*,u.name AS reviewer_name FROM passbook_records p LEFT JOIN users u ON u.id=p.created_by WHERE p.athlete_id=? ORDER BY p.created_at DESC', [athleteId]), reviews: many('SELECT r.*,u.name AS coach_name FROM reviews r JOIN users u ON u.id=r.coach_id WHERE r.athlete_id=? ORDER BY r.created_at DESC', [athleteId]) });
});

app.post('/api/support-requests', auth, allowRoles('athlete'), async (req, res) => {
  const category = cleanText(req.body.category, 100);
  const description = cleanText(req.body.description, 2000);
  const amount = Number(req.body.amount || 0);
  if (!category || !description) return res.status(400).json({ error: 'Please provide a support category and description.' });
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Amount must be zero or a positive number.' });
  run('INSERT INTO support_requests (athlete_id,category,description,amount) VALUES (?,?,?,?)', [req.user.id, category, description, amount]);
  await saveDatabase();
  res.status(201).json({ message: 'Support request saved and shared with donors.', request: one('SELECT * FROM support_requests WHERE id=last_insert_rowid()') });
});

app.get('/api/support-requests', auth, (req, res) => {
  let rows;
  if (req.user.role === 'athlete') rows = many('SELECT * FROM support_requests WHERE athlete_id=? ORDER BY created_at DESC', [req.user.id]);
  else if (req.user.role === 'donor') rows = many("SELECT s.*,u.name AS athlete_name,u.sport,u.district,u.profile_json FROM support_requests s JOIN users u ON u.id=s.athlete_id WHERE s.status='open' ORDER BY s.created_at DESC");
  else return res.status(403).json({ error: 'Only athletes and donors can view support requests.' });
  res.json({ requests: rows });
});

app.post('/api/support-requests/:id/pledge', auth, allowRoles('donor'), async (req, res) => {
  const requestId = Number(req.params.id);
  const amount = Number(req.body.amount);
  const request = one("SELECT * FROM support_requests WHERE id=? AND status='open'", [requestId]);
  if (!request) return res.status(404).json({ error: 'Open support request not found.' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid pledge amount.' });
  run('INSERT INTO pledges (donor_id,support_request_id,amount,note) VALUES (?,?,?,?)', [req.user.id, requestId, amount, cleanText(req.body.note, 1000)]);
  await saveDatabase();
  res.status(201).json({ message: 'Pledge recorded. This is not a payment or money transfer.', pledge: one('SELECT * FROM pledges WHERE id=last_insert_rowid()') });
});

app.get('/api/videos', auth, (req, res) => {
  const type = cleanText(req.query.type, 30);
  let sql = 'SELECT v.*,u.name AS author_name,u.role AS author_role FROM videos v JOIN users u ON u.id=v.user_id';
  const params = [];
  if (type === 'training' || type === 'masterclass') { sql += ' WHERE v.video_type=?'; params.push(type); }
  sql += ' ORDER BY v.created_at DESC';
  res.json({ videos: many(sql, params) });
});

app.post('/api/videos', auth, allowRoles('athlete', 'coach'), async (req, res) => {
  const title = cleanText(req.body.title, 150);
  const description = cleanText(req.body.description, 2000);
  const videoUrl = cleanText(req.body.video_url || req.body.url, 1000);
  const type = req.user.role === 'coach' ? 'masterclass' : 'training';
  if (!title || !videoUrl) return res.status(400).json({ error: 'Please provide a video title and video URL.' });
  if (!/^https?:\/\//i.test(videoUrl) && !videoUrl.startsWith('/uploads/')) return res.status(400).json({ error: 'Video URL must start with http://, https:// or /uploads/.' });
  run('INSERT INTO videos (user_id,title,description,video_url,video_type) VALUES (?,?,?,?,?)', [req.user.id, title, description, videoUrl, type]);
  await saveDatabase();
  res.status(201).json({ message: 'Video published to the community feed.', video: one('SELECT * FROM videos WHERE id=last_insert_rowid()') });
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 }, fileFilter: (_req, file, cb) => {
  if (file.mimetype.startsWith('video/')) cb(null, true);
  else cb(new Error('Only video files are allowed.'));
} });
app.post('/api/videos/upload', auth, allowRoles('athlete', 'coach'), upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a video file first.' });
    const title = cleanText(req.body.title, 150) || req.file.originalname;
    const description = cleanText(req.body.description, 2000);
    const type = req.user.role === 'coach' ? 'masterclass' : 'training';
    const url = `/uploads/${req.file.filename}`;
    run('INSERT INTO videos (user_id,title,description,video_url,video_type) VALUES (?,?,?,?,?)', [req.user.id, title, description, url, type]);
    await saveDatabase();
    res.status(201).json({ message: 'Video uploaded and published.', video: one('SELECT * FROM videos WHERE id=last_insert_rowid()') });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Video upload failed.' });
  }
});

const certificateUpload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (_req,file,cb) => { if (/^(application\/pdf|image\/(png|jpeg|webp))$/.test(file.mimetype)) cb(null,true); else cb(new Error('Certificate must be a PDF, PNG, JPG or WEBP file.')); } });
app.post('/api/certificates/upload', auth, allowRoles('judge'), certificateUpload.single('certificate'), async (req,res)=>{ if(!req.file)return res.status(400).json({error:'Choose a certificate file.'}); await saveDatabase(); res.status(201).json({url:`/uploads/${req.file.filename}`,filename:req.file.originalname}); });

app.post('/api/reviews', auth, allowRoles('coach'), async (req, res) => {
  const athleteId = Number(req.body.athlete_id);
  const comment = cleanText(req.body.comment || req.body.feedback, 3000);
  const rating = req.body.rating === undefined || req.body.rating === '' ? null : Number(req.body.rating);
  const points = 0; // Coaches can leave practice feedback, but never award tournament points.
  const videoId = req.body.video_id ? Number(req.body.video_id) : null;
  if (!one("SELECT id FROM users WHERE id=? AND role='athlete'", [athleteId])) return res.status(404).json({ error: 'Athlete not found.' });
  if (!comment) return res.status(400).json({ error: 'Please enter feedback before submitting.' });
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
  if (!Number.isInteger(points) || points < 0 || points > 1000) return res.status(400).json({ error: 'Points must be between 0 and 1000.' });
  run('INSERT INTO reviews (coach_id,athlete_id,video_id,rating,comment,points_awarded) VALUES (?,?,?,?,?,?)', [req.user.id, athleteId, videoId, rating, comment, points]);
  run('INSERT INTO passbook_records (athlete_id,record_type,title,description,points,created_by) VALUES (?,?,?,?,?,?)', [athleteId, 'coach_review', 'Coach feedback', comment, points, req.user.id]);
  await saveDatabase();
  res.status(201).json({ message: 'Feedback saved to the athlete review history and Digital Passbook.', review: one('SELECT * FROM reviews WHERE id=last_insert_rowid()') });
});

app.get('/api/messages', auth, (req, res) => {
  const otherId = req.query.with ? Number(req.query.with) : null;
  let sql = 'SELECT m.*,s.name AS sender_name,r.name AS receiver_name FROM messages m JOIN users s ON s.id=m.sender_id JOIN users r ON r.id=m.receiver_id WHERE (m.sender_id=? OR m.receiver_id=?)';
  const params = [req.user.id, req.user.id];
  if (otherId) { sql += ' AND (m.sender_id=? OR m.receiver_id=?)'; params.push(otherId, otherId); }
  sql += ' ORDER BY m.created_at ASC';
  res.json({ messages: many(sql, params) });
});

app.post('/api/messages', auth, async (req, res) => {
  const receiverId = Number(req.body.receiver_id);
  const body = cleanText(req.body.body || req.body.message, 3000);
  const receiver = one('SELECT id,role FROM users WHERE id=?', [receiverId]);
  if (!receiver) return res.status(404).json({ error: 'Recipient account not found.' });
  if (receiverId === req.user.id) return res.status(400).json({ error: 'You cannot message yourself.' });
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  run('INSERT INTO messages (sender_id,receiver_id,body) VALUES (?,?,?)', [req.user.id, receiverId, body]);
  await saveDatabase();
  res.status(201).json({ message: 'Message sent.', item: one('SELECT * FROM messages WHERE id=last_insert_rowid()') });
});

app.post('/api/invitations', auth, allowRoles('scout'), async (req, res) => {
  const athleteId = Number(req.body.athlete_id);
  const message = cleanText(req.body.message, 2000);
  if (!one("SELECT id FROM users WHERE id=? AND role='athlete'", [athleteId])) return res.status(404).json({ error: 'Athlete not found.' });
  run('INSERT INTO invitations (scout_id,athlete_id,message) VALUES (?,?,?)', [req.user.id, athleteId, message]);
  await saveDatabase();
  res.status(201).json({ message: 'Trial invitation saved and sent to the athlete account.', invitation: one('SELECT * FROM invitations WHERE id=last_insert_rowid()') });
});

app.post('/api/passbook', auth, allowRoles('coach'), async (req, res) => {
  return res.status(403).json({ error: 'Tournament points can only be entered by an authorized judge.' });
  /*
  const athleteId = Number(req.body.athlete_id);
  const title = cleanText(req.body.title, 150);
  const description = cleanText(req.body.description, 2000);
  const points = Number(req.body.points || 0);
  const type = cleanText(req.body.record_type, 50) || 'achievement';
  if (!one("SELECT id FROM users WHERE id=? AND role='athlete'", [athleteId])) return res.status(404).json({ error: 'Athlete not found.' });
  if (!title) return res.status(400).json({ error: 'Record title is required.' });
  if (!Number.isInteger(points) || points < 0 || points > 1000) return res.status(400).json({ error: 'Points must be between 0 and 1000.' });
  run('INSERT INTO passbook_records (athlete_id,record_type,title,description,points,created_by) VALUES (?,?,?,?,?,?)', [athleteId, type, title, description, points, req.user.id]);
  await saveDatabase();
  res.status(201).json({ message: 'Passbook record saved.', record: one('SELECT * FROM passbook_records WHERE id=last_insert_rowid()') });
  */
});

app.use((err, req, res, next) => {
  console.error('Request error:', err.message);
  if (res.headersSent) return next(err);
  res.status(400).json({ error: err.message || 'Request could not be processed.' });
});

async function start() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const bytes = fs.readFileSync(DB_FILE);
    db = new SQL.Database(bytes);
  } else {
    db = new SQL.Database();
  }
  createTables();
  await saveDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('==========================================');
    console.log(` KhelSetu backend is running on port ${PORT}`);
    console.log(` Health check: http://localhost:${PORT}/api/health`);
    console.log(` Database: ${DB_FILE}`);
    console.log(' Press Ctrl + C to stop the server.');
    console.log('==========================================');
    if (!process.env.JWT_SECRET) console.warn('For local testing, a default JWT secret is being used. Set JWT_SECRET before deploying publicly.');
  });
}

start().catch((err) => {
  console.error('Could not start KhelSetu backend:', err);
  process.exit(1);
});
