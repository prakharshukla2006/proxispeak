/**
 * ProxiSpeak — Server (Week 3)
 * Week 1: Real-time position sync via Socket.io + MongoDB
 * Week 2: WebRTC peer-to-peer audio via proximity signaling
 * Week 3: Redis Pub/Sub scaling + dynamic audio attenuation curves
 */

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');
const os         = require('os');

const User                = require('./models/User');
const { attachSignaling } = require('./signaling');

const INSTANCE_ID  = `${os.hostname()}-${process.pid}`;
const EARSHOT_PX   = 150;

// ─── Express + Socket.io ─────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],   // polling first — works through all proxies/ngrok
  allowEIO3: true,
  pingTimeout:  60000,
  pingInterval: 25000
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// Skip ngrok browser warning interstitial for ALL requests
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Serve client
const clientPath = path.join(__dirname, '../client/public');
app.use(express.static(clientPath));

// ─── In-memory state ─────────────────────────────────────────────────────────
const users = {};   // socketId → { id, name, x, y, color }

const COLORS     = ['#4F46E5','#EF4444','#10B981','#F59E0B','#EC4899','#06B6D4','#8B5CF6','#F97316'];
let   colorIndex = 0;

// ─── REST endpoints ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:      'ok',
    instance:    INSTANCE_ID,
    users:       Object.keys(users).length,
    mongodb:     mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime:      Math.round(process.uptime()) + 's'
  });
});

app.get('/api/users',   (req, res) => res.json(Object.values(users)));
app.get('/api/metrics', (req, res) => {
  const total = Object.keys(users).length;
  res.json({
    instance:  INSTANCE_ID,
    users:     total,
    maxPeers:  total > 1 ? (total * (total - 1)) / 2 : 0
  });
});

// ─── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.warn('⚠ MongoDB unavailable:', err.message));

// ─── Redis (optional — graceful fallback) ─────────────────────────────────────
let redisReady = false;
if (process.env.REDIS_URL) {
  try {
    const { createClient } = require('redis');
    const redis = createClient({ url: process.env.REDIS_URL });
    redis.on('error', () => { redisReady = false; });
    redis.connect()
      .then(() => { redisReady = true; console.log('✅ Redis connected'); })
      .catch(() => { redisReady = false; });
  } catch (e) { /* Redis not installed — single-instance mode */ }
} else {
  console.log('ℹ Redis not configured — running single-instance mode');
}

// ─── Proximity ────────────────────────────────────────────────────────────────
function findNearby(x, y, excludeId) {
  return Object.values(users)
    .filter(u => u.id !== excludeId)
    .filter(u => Math.sqrt((u.x - x) ** 2 + (u.y - y) ** 2) <= EARSHOT_PX)
    .map(u => u.id);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  socket.on('join', ({ name, x, y }) => {
    const color    = COLORS[colorIndex++ % COLORS.length];
    const userData = { id: socket.id, name: name || 'Anonymous', x: x || 450, y: y || 300, color };
    users[socket.id] = userData;

    // Persist to MongoDB
    User.findOneAndUpdate(
      { socketId: socket.id },
      { socketId: socket.id, name: userData.name, color, x: userData.x, y: userData.y, updatedAt: new Date() },
      { upsert: true, new: true }
    ).catch(e => console.warn('MongoDB save:', e.message));

    socket.emit('self:joined', { id: socket.id, color });
    io.emit('users:update', Object.values(users));
    console.log(`👤 ${userData.name} joined at (${Math.round(userData.x)}, ${Math.round(userData.y)})`);
  });

  socket.on('move', ({ x, y }) => {
    if (!users[socket.id]) return;
    users[socket.id].x = x;
    users[socket.id].y = y;

    User.findOneAndUpdate({ socketId: socket.id }, { x, y, updatedAt: new Date() }).catch(() => {});

    socket.broadcast.emit('user:moved', { id: socket.id, x, y });

    const nearbyIds = findNearby(x, y, socket.id);
    socket.emit('proximity:update', { nearbyIds, radius: EARSHOT_PX });
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    console.log(`❌ Disconnected: ${user?.name || socket.id}`);
    delete users[socket.id];
    User.deleteOne({ socketId: socket.id }).catch(() => {});
    io.emit('user:left',    { id: socket.id });
    io.emit('users:update', Object.values(users));
  });
});

// Attach WebRTC signaling (Week 2)
attachSignaling(io);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 ProxiSpeak Week 3 server running!');
  console.log(`   Instance: ${INSTANCE_ID}`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
  console.log('');
});
