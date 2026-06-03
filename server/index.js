require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express      = require('express');
const session      = require('express-session');
const passport     = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const multer       = require('multer');
const cors         = require('cors');
const fs           = require('fs');
const path         = require('path');
const fetch        = require('node-fetch');

const app      = express();
const PORT     = process.env.PORT || 3002;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3002';
const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:7b';
const DATA_DIR = path.join(__dirname, '..', 'data');  // data/<userId>/uploads + notas.json
const QUOTA_BYTES = 100 * 1024 * 1024; // 100 MB por usuario

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Helpers ──
function userDir(userId)     { return path.join(DATA_DIR, userId); }
function uploadsDir(userId)  { return path.join(DATA_DIR, userId, 'uploads'); }
function notasFile(userId)   { return path.join(DATA_DIR, userId, 'notas.json'); }

function ensureUser(userId) {
  const ud = uploadsDir(userId);
  if (!fs.existsSync(ud)) fs.mkdirSync(ud, { recursive: true });
  const nf = notasFile(userId);
  if (!fs.existsSync(nf)) fs.writeFileSync(nf, '[]');
}

function readNotas(userId)        { try { return JSON.parse(fs.readFileSync(notasFile(userId), 'utf8')); } catch { return []; } }
function writeNotas(userId, data) { fs.writeFileSync(notasFile(userId), JSON.stringify(data, null, 2)); }

function getDirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce((acc, f) => {
    try { return acc + fs.statSync(path.join(dir, f)).size; } catch { return acc; }
  }, 0);
}

// ── Passport ──
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  `${BASE_URL}/auth/google/callback`
}, (accessToken, refreshToken, profile, done) => {
  const user = {
    id:     profile.id,
    name:   profile.displayName,
    email:  profile.emails?.[0]?.value || '',
    avatar: profile.photos?.[0]?.value || ''
  };
  ensureUser(user.id);
  done(null, user);
}));

passport.serializeUser((user, done)   => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'cloudy_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 días
}));
app.use(passport.initialize());
app.use(passport.session());

// Archivos estáticos — splash y login son públicos
app.use('/splash.html', express.static(path.join(__dirname, '..', 'public', 'splash.html')));
app.use('/login.html',  express.static(path.join(__dirname, '..', 'public', 'login.html')));
app.use('/favicon.ico', express.static(path.join(__dirname, '..', 'public', 'favicon.ico')));

// Auth guard para todo lo demás
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
  res.redirect('/login.html');
}

// Rutas públicas estáticas
app.get('/',           (req, res) => req.isAuthenticated() ? res.sendFile(path.join(__dirname, '..', 'public', 'index.html')) : res.redirect('/splash.html'));
app.get('/splash.html',(req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'splash.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));

// ── Auth routes ──
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  (req, res) => res.redirect('/')
);
app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/login.html'));
});
app.get('/api/me', requireAuth, (req, res) => {
  const used = getDirSize(uploadsDir(req.user.id));
  res.json({ ...req.user, usedBytes: used, quotaBytes: QUOTA_BYTES });
});

// ── App estática protegida ──
app.use(requireAuth, express.static(path.join(__dirname, '..', 'public')));

// ── Multer ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir(req.user.id)),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_');
    const dest = path.join(uploadsDir(req.user.id), safe);
    cb(null, fs.existsSync(dest) ? Date.now() + '_' + safe : safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx','.xls','.csv','.txt','.md','.pdf','.docx','.doc'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ── API Files ──
app.get('/api/files', requireAuth, (req, res) => {
  const dir = uploadsDir(req.user.id);
  if (!fs.existsSync(dir)) return res.json([]);
  const entries = fs.readdirSync(dir).map(name => {
    const stat = fs.statSync(path.join(dir, name));
    return { name, size: stat.size, modified: stat.mtime };
  });
  res.json(entries);
});

app.post('/api/upload', requireAuth, (req, res, next) => {
  const used = getDirSize(uploadsDir(req.user.id));
  if (used >= QUOTA_BYTES) return res.status(413).json({ error: 'Cuota de 100 MB alcanzada' });
  next();
}, upload.array('files', 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No se recibieron archivos' });
  res.json(req.files.map(f => ({ name: f.filename, size: f.size })));
});

app.delete('/api/files/:name', requireAuth, (req, res) => {
  const filePath = path.join(uploadsDir(req.user.id), path.basename(req.params.name));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

app.get('/api/files/:name/download', requireAuth, (req, res) => {
  const filePath = path.join(uploadsDir(req.user.id), path.basename(req.params.name));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.download(filePath);
});

// ── API Notas ──
app.get('/api/notas', requireAuth, (req, res) => res.json(readNotas(req.user.id)));

app.post('/api/notas', requireAuth, (req, res) => {
  const { id, text, color, x, y } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const notas = readNotas(req.user.id);
  const idx = notas.findIndex(n => n.id === id);
  if (idx > -1) notas[idx] = { ...notas[idx], text, color, x, y };
  else notas.push({ id, text: text||'', color: color||'#fef08a', x: x||220, y: y||120 });
  writeNotas(req.user.id, notas);
  res.json({ ok: true });
});

app.delete('/api/notas/:id', requireAuth, (req, res) => {
  const notas = readNotas(req.user.id).filter(n => n.id !== parseInt(req.params.id));
  writeNotas(req.user.id, notas);
  res.json({ ok: true });
});

// ── API Search (Ollama) ──
app.post('/api/search', requireAuth, async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  const notas = readNotas(req.user.id).filter(n => n.text?.trim());
  const notasSummary = notas.length
    ? '=== NOTAS DEL USUARIO ===\n' + notas.map((n,i) => `[Nota ${i+1}]: ${n.text.slice(0,800)}`).join('\n\n')
    : '(no hay notas)';

  const textExts = ['.txt','.md','.csv'];
  const files = fs.existsSync(uploadsDir(req.user.id)) ? fs.readdirSync(uploadsDir(req.user.id)) : [];
  const fileContents = files.filter(name => textExts.includes(path.extname(name).toLowerCase())).map(name => {
    let content = '';
    try { content = fs.readFileSync(path.join(uploadsDir(req.user.id), name), 'utf8').slice(0, 1500); } catch {}
    return `=== ARCHIVO: ${name} ===\n${content}`;
  });

  const prompt = `Sos un asistente personal. Buscá información EXACTA en el contenido de abajo y respondé con lo que encontrás.

${notasSummary}

${fileContents.join('\n\n')}

---
Pregunta: "${query}"

Instrucciones:
- Buscá ÚNICAMENTE en el contenido de arriba.
- Si encontrás la información, citá de qué nota o archivo viene.
- Si NO encontrás, respondé: "No encontré esa información en tus notas ni archivos."
- NO inventes información.
- Respondé en español, breve y directo.
- Última línea: "ARCHIVOS:" seguido de nombres relevantes separados por coma (o "ninguno").`;

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { num_predict: 512, temperature: 0.2 },
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!response.ok) return res.status(500).json({ error: `Ollama error: ${await response.text()}` });
    const data = await response.json();
    const text = (data.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const [answer, sourceLine] = text.split(/ARCHIVOS:/i);
    const sources = sourceLine ? sourceLine.split(',').map(s=>s.trim()).filter(s=>s&&s.toLowerCase()!=='ninguno') : [];
    res.json({ answer: answer.trim(), sources });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo conectar con Ollama.' });
  }
});

app.listen(PORT, () => console.log(`Cloudy server running on port ${PORT}`));
