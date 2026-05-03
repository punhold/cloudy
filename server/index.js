const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const NOTAS_FILE = path.join(__dirname, '..', 'notas.json');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:7b';

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(NOTAS_FILE)) fs.writeFileSync(NOTAS_FILE, '[]');

function readNotas() { try { return JSON.parse(fs.readFileSync(NOTAS_FILE, 'utf8')); } catch { return []; } }
function writeNotas(notas) { fs.writeFileSync(NOTAS_FILE, JSON.stringify(notas, null, 2)); }

app.use(cors());
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Multer config — save to uploads/ with original name
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-\s]/g, '_');
    // Avoid overwriting: prefix with timestamp if exists
    const dest = path.join(UPLOADS_DIR, safe);
    if (fs.existsSync(dest)) {
      cb(null, Date.now() + '_' + safe);
    } else {
      cb(null, safe);
    }
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv', '.txt', '.md', '.pdf', '.docx', '.doc'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// GET /api/files — list all uploaded files
app.get('/api/files', (req, res) => {
  const entries = fs.readdirSync(UPLOADS_DIR).map(name => {
    const stat = fs.statSync(path.join(UPLOADS_DIR, name));
    return { name, size: stat.size, modified: stat.mtime };
  });
  res.json(entries);
});

// POST /api/upload — upload one or more files
app.post('/api/upload', upload.array('files', 20), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files received' });
  res.json(req.files.map(f => ({ name: f.filename, size: f.size })));
});

// DELETE /api/files/:name — delete a file
app.delete('/api/files/:name', (req, res) => {
  const name = path.basename(req.params.name); // sanitize
  const filePath = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// GET /api/files/:name/download
app.get('/api/files/:name/download', (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(UPLOADS_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

// GET /api/notas
app.get('/api/notas', (req, res) => res.json(readNotas()));

// POST /api/notas — create or update a nota
app.post('/api/notas', (req, res) => {
  const { id, text, color, x, y } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const notas = readNotas();
  const idx = notas.findIndex(n => n.id === id);
  if (idx > -1) notas[idx] = { ...notas[idx], text, color, x, y };
  else notas.push({ id, text: text||'', color: color||'#fef08a', x: x||220, y: y||120 });
  writeNotas(notas);
  res.json({ ok: true });
});

// DELETE /api/notas/:id
app.delete('/api/notas/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const notas = readNotas().filter(n => n.id !== id);
  writeNotas(notas);
  res.json({ ok: true });
});

// GET /api/status — check Ollama connection and loaded model
app.get('/api/status', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await r.json();
    const models = data.models?.map(m => m.name) || [];
    const ready = models.some(m => m.startsWith(OLLAMA_MODEL.split(':')[0]));
    res.json({ ollama: true, model: OLLAMA_MODEL, ready, availableModels: models });
  } catch {
    res.json({ ollama: false, model: OLLAMA_MODEL, ready: false });
  }
});

// POST /api/search — AI search over file contents using Ollama
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  // Include notes — goes FIRST so the model prioritizes them
  const notas = readNotas().filter(n => n.text && n.text.trim());
  const notasSummary = notas.length
    ? '=== NOTAS DEL USUARIO ===\n' + notas.map((n,i) => `[Nota ${i+1}]: ${n.text.slice(0,800)}`).join('\n\n')
    : '(no hay notas)';

  // Read text content of readable files
  const textExts = ['.txt', '.md', '.csv'];
  const files = fs.readdirSync(UPLOADS_DIR);
  const fileContents = files.filter(name => {
    const ext = path.extname(name).toLowerCase();
    return textExts.includes(ext);
  }).map(name => {
    let content = '';
    try { content = fs.readFileSync(path.join(UPLOADS_DIR, name), 'utf8').slice(0, 1500); } catch {}
    return `=== ARCHIVO: ${name} ===\n${content}`;
  });

  const prompt = `Sos un asistente personal. Tenés acceso a las notas y archivos del usuario. Tu trabajo es buscar información EXACTA dentro de ese contenido y responder con lo que encontrás.

${notasSummary}

${fileContents.join('\n\n')}

---
Pregunta del usuario: "${query}"

Instrucciones:
- Buscá la respuesta ÚNICAMENTE en el contenido de las notas y archivos de arriba.
- Si encontrás la información, citá exactamente de qué nota o archivo viene.
- Si NO encontrás la información, respondé: "No encontré esa información en tus notas ni archivos."
- NO inventes ni supongas información que no esté en el texto.
- Respondé en español, breve y directo.
- Última línea debe ser "ARCHIVOS:" seguido de los nombres de archivos relevantes separados por coma (o "ninguno").`;

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { num_predict: 512, temperature: 0.3 },
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `Ollama error: ${err}` });
    }

    const data = await response.json();
    const text = data.message?.content || '';

    // Strip <think>...</think> tags that deepseek-r1 adds
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    const [answer, sourceLine] = cleaned.split(/ARCHIVOS:/i);
    const sources = sourceLine
      ? sourceLine.split(',').map(s => s.trim()).filter(s => s && s.toLowerCase() !== 'ninguno')
      : [];
    res.json({ answer: answer.trim(), sources });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo conectar con Ollama. ¿Está corriendo en Orion?' });
  }
});

app.listen(PORT, () => console.log(`Cloudy server running on port ${PORT}`));
