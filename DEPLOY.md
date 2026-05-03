# Cloudy — Deploy en Orion

## Estructura del proyecto

```
cloudy/
├── public/          ← frontend estático (HTML/CSS/JS)
│   └── index.html
├── server/          ← backend Node.js
│   └── index.js
├── uploads/         ← archivos subidos (se crea solo)
├── package.json
└── nginx.conf       ← config de nginx lista para copiar
```

---

## 1. Instalar Ollama en Orion

```bash
curl -fsSL https://ollama.com/install.sh | sh

# Verificar que quedó corriendo
systemctl status ollama

# Bajar el modelo (tarda unos minutos, ~4 GB)
ollama pull deepseek-r1:7b

# Probar que funciona
ollama run deepseek-r1:7b "hola, respondé en una oración"
```

Ollama queda corriendo como servicio del sistema automáticamente.

---

## 2. Copiar el proyecto a Orion

```bash
scp -r ./cloudy usuario@orion:/opt/cloudy
# o con rsync:
rsync -av ./cloudy/ usuario@orion:/opt/cloudy/
```

---

## 3. Instalar dependencias Node

```bash
cd /opt/cloudy
npm install
```

---

## 4. Arrancar con PM2

```bash
npm install -g pm2
pm2 start server/index.js --name cloudy
pm2 startup
pm2 save
```

---

## 5. Configurar Nginx

```bash
sudo cp /opt/cloudy/nginx.conf /etc/nginx/sites-available/cloudy
sudo nano /etc/nginx/sites-available/cloudy   # ajustá server_name y root
sudo ln -s /etc/nginx/sites-available/cloudy /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 6. Permisos de uploads

```bash
mkdir -p /opt/cloudy/uploads
chmod 755 /opt/cloudy/uploads
```

---

## Variables de entorno opcionales

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3001` | Puerto del backend Node.js |
| `OLLAMA_URL` | `http://localhost:11434` | URL de Ollama |
| `OLLAMA_MODEL` | `deepseek-r1:7b` | Modelo a usar |

Para cambiar el modelo:
```bash
ollama pull llama3.2:3b
OLLAMA_MODEL=llama3.2:3b pm2 restart cloudy
```

---

## Verificar que todo funciona

```bash
# Ollama corriendo?
systemctl status ollama && ollama list

# Backend corriendo?
pm2 status
pm2 logs cloudy

# Test del endpoint de status:
curl http://localhost:3001/api/status

# Test de búsqueda:
curl -X POST http://localhost:3001/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"archivos de presupuesto"}'
```

---

## Notas

- La primera búsqueda tarda ~5-10 seg mientras Ollama carga el modelo en RAM.
- Las siguientes son rápidas (modelo ya en memoria).
- Con 8 GB RAM el sistema + Node + deepseek-r1:7b caben bien.
- **100% local, 100% gratis, sin internet necesario para la IA.**
