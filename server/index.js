/**
 * ProxiSpeak — Main Server Entry Point  (Week 3: Redis Scaling)
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
const { EARSHOT_RADIUS_PX } = require('./proximity');
const {
  setupRedis, setPosition, removePosition,
  findNearbyInRedis, isRedisReady, getRedisStats
} = require('./redis/pubsub');

const INSTANCE_ID = `${os.hostname()}-${process.pid}`;

// ─── App + Socket.io ─────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false
  },
  // Render.com: start with polling (always works), upgrade to websocket
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  allowUpgrades: true
});

app.use(cors());
app.use(express.json());
// Required for ngrok free tier — skips the "Visit Site" interstitial page
app.use((req, res, next) => { res.setHeader('ngrok-skip-browser-warning', 'true'); next(); });
// Serve client — works whether started from root (Railway) or server/ folder (local)
const clientPath = path.join(__dirname, '../client/public');
app.use(express.static(clientPath));

// ─── State ────────────────────────────────────────────────────────────────────
const users         = {};  // socketId → { id, name, x, y, color }
const userProximity = {};  // socketId → Set<socketId>

const COLORS     = ['#4F46E5','#EF4444','#10B981','#F59E0B','#EC4899','#06B6D4','#8B5CF6','#F97316'];
let   colorIndex = 0;

// ─── REST Endpoints ───────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const redisStats = await getRedisStats();
  res.json({
    status:      'ok',
    instanceId:  INSTANCE_ID,
    connections: Object.keys(users).length,
    mongodb:     mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    redis:       redisStats,
    uptime:      Math.round(process.uptime()) + 's'
  });
});

app.get('/api/users',   (req, res) => res.json(Object.values(users)));

app.get('/api/metrics', (req, res) => {
  const total = Object.keys(users).length;
  res.json({
    instanceId:    INSTANCE_ID,
    totalUsers:    total,
    maxMeshConns:  total > 1 ? (total * (total - 1)) / 2 : 0,
    redis:         isRedisReady() ? 'ready' : 'offline',
    proximityPairs:Object.values(userProximity).reduce((s, p) => s + p.size, 0)
  });
});

// ─── MongoDB (profile persistence only — no geo queries) ─────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.warn('⚠ MongoDB unavailable:', err.message));

// ─── Redis (Socket.io scaling) ────────────────────────────────────────────────
setupRedis(io).catch(() => {});

// ─── Proximity Query ──────────────────────────────────────────────────────────
// Priority:
//   1. In-memory Euclidean  — instant, O(n), single instance
//   2. Redis position hash  — shared across instances, O(n)
async function queryNearby(x, y, socketId) {
  // Always try in-memory first (fastest, no async overhead)
  const local = Object.values(users)
    .filter(u => u.id !== socketId)
    .filter(u => Math.sqrt((u.x - x) ** 2 + (u.y - y) ** 2) <= EARSHOT_RADIUS_PX)
    .map(u => u.id);

  if (local.length > 0 || !isRedisReady()) return local;

  // Redis covers users on OTHER instances not in local `users` map
  const remote = await findNearbyInRedis(x, y, socketId, EARSHOT_RADIUS_PX);
  const remoteIds = remote.map(u => u.socketId).filter(id => !users[id]);
  return [...local, ...remoteIds];
}

// ─── Socket.io Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 [${INSTANCE_ID}] Connected: ${socket.id}`);
  userProximity[socket.id] = new Set();

  socket.on('join', async ({ name, x, y }) => {
    const color    = COLORS[colorIndex++ % COLORS.length];
    const userData = { id: socket.id, name: name || 'Anonymous', x, y, color };
    users[socket.id] = userData;

    // Save profile to MongoDB (x/y as plain numbers — no geo index)
    User.findOneAndUpdate(
      { socketId: socket.id },
      { socketId: socket.id, name: name || 'Anonymous', color, x, y, updatedAt: new Date() },
      { upsert: true, new: true }
    ).catch(err => console.warn('MongoDB save failed:', err.message));

    // Share position with other Redis instances
    await setPosition(socket.id, { socketId: socket.id, name: name || 'Anonymous', x, y, color });

    socket.emit('self:joined', { id: socket.id, color });
    io.emit('users:update', Object.values(users));
    console.log(`👤 ${name} joined at (${Math.round(x)}, ${Math.round(y)})`);
  });

  socket.on('move', async ({ x, y }) => {
    if (!users[socket.id]) return;
    users[socket.id].x = x;
    users[socket.id].y = y;

    // Update MongoDB position (non-blocking)
    User.findOneAndUpdate(
      { socketId: socket.id },
      { x, y, updatedAt: new Date() }
    ).catch(() => {});

    // Update Redis shared store
    await setPosition(socket.id, { ...users[socket.id], socketId: socket.id, x, y });

    // Broadcast position to all peers
    socket.broadcast.emit('user:moved', { id: socket.id, x, y });

    // Proximity diff
    const newNearbyIds  = await queryNearby(x, y, socket.id);
    const newNearbySet  = new Set(newNearbyIds);
    const prevNearbySet = userProximity[socket.id] || new Set();

    const entered = [...newNearbySet].filter(id => !prevNearbySet.has(id));
    const left    = [...prevNearbySet].filter(id => !newNearbySet.has(id));
    userProximity[socket.id] = newNearbySet;

    if (entered.length > 0) socket.emit('proximity:enter', { ids: entered });
    if (left.length > 0)    socket.emit('proximity:leave', { ids: left });

    socket.emit('proximity:update', {
      nearbyIds: [...newNearbySet],
      radius:    EARSHOT_RADIUS_PX,
      source:    isRedisReady() ? 'redis+memory' : 'memory'
    });
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    console.log(`❌ Disconnected: ${user?.name || socket.id}`);
    delete users[socket.id];
    delete userProximity[socket.id];
    User.deleteOne({ socketId: socket.id }).catch(() => {});
    removePosition(socket.id).catch(() => {});
    io.emit('user:left',     { id: socket.id });
    io.emit('users:update',  Object.values(users));
  });
});

attachSignaling(io);

const PORT = process.env.PORT || 3001;

// Detect if running on a cloud platform
const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
const renderUrl  = process.env.RENDER_EXTERNAL_URL   || null;
const publicUrl  = railwayUrl || renderUrl;

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 ProxiSpeak server running! (Week 3)');
  console.log(`   Instance:   ${INSTANCE_ID}`);
  if (publicUrl) {
    console.log(`   Public URL: ${publicUrl}  ← share this with anyone!`);
  } else {
    console.log(`   Local:      http://localhost:${PORT}`);
    console.log(`   Network:    http://192.168.29.92:${PORT}  ← LAN only`);
  }
  console.log(`   Health:     http://localhost:${PORT}/health`);
  console.log('');
});
