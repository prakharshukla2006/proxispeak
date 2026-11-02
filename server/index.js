/**
 * ProxiSpeak — Server
 * Real-time proximity audio ecosystem
 * Week 1: Socket.io position sync + MongoDB persistence
 * Week 2: WebRTC peer-to-peer audio signaling
 * Week 3: Dynamic audio attenuation + Redis-ready scaling
 * Week 4: Named rooms + room persistence + 60 FPS support
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
const Room                = require('./models/Room');
const { attachSignaling } = require('./signaling');
const { findNearby: nearbyIn, EARSHOT_RADIUS_PX } = require('./proximity');

const INSTANCE_ID = `${os.hostname()}-${process.pid}`;
const EARSHOT_PX  = EARSHOT_RADIUS_PX;
const MAX_USERS_PER_ROOM = 20;
const WORLD_MAX = 4000; // sanity bound for coordinates

// ─── Express + Socket.io ─────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports:   ['polling', 'websocket'],
  allowEIO3:    true,
  pingTimeout:  60000,
  pingInterval: 25000
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
app.use(express.static(path.join(__dirname, '../client/public')));

// ─── In-memory state ──────────────────────────────────────────────────────────
// roomUsers: { roomName → { socketId → { id, name, x, y, color, room } } }
const roomUsers = {};

const COLORS     = ['#4F46E5','#EF4444','#10B981','#F59E0B','#EC4899','#06B6D4','#8B5CF6','#F97316'];
let   colorIndex = 0;

function getRoomUsers(room) {
  if (!roomUsers[room]) roomUsers[room] = {};
  return roomUsers[room];
}

function findNearby(room, x, y, excludeId) {
  return nearbyIn(getRoomUsers(room), x, y, excludeId, EARSHOT_PX);
}

// Last nearby-set we told each user about: socketId → sorted id list (as string)
const lastNearby = {};

/**
 * Recompute proximity for EVERY user in the room and notify only those whose set changed.
 * This keeps both sides of a pair in sync (the other user also learns when you move
 * in or out of range), which the WebRTC call/hangup logic depends on.
 */
function syncProximity(room, force = false) {
  Object.values(getRoomUsers(room)).forEach(u => {
    const ids = findNearby(room, u.x, u.y, u.id).sort();
    const key = ids.join(',');
    if (!force && lastNearby[u.id] === key) return;
    lastNearby[u.id] = key;
    io.to(u.id).emit('proximity:update', { nearbyIds: ids, radius: EARSHOT_PX });
  });
}

const cleanText = (s, max, fallback) =>
  String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) || fallback;
const num = (v, fallback) => (Number.isFinite(v) ? Math.max(0, Math.min(WORLD_MAX, v)) : fallback);

// ─── MongoDB ──────────────────────────────────────────────────────────────────
const dbReady = () => mongoose.connection.readyState === 1;
if (process.env.MONGO_URI) {
  mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.warn('⚠ MongoDB unavailable (running in-memory only):', err.message));
} else {
  console.warn('⚠ MONGO_URI not set — running in-memory only (rooms will not persist)');
}

// ─── REST endpoints ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const totalUsers = Object.values(roomUsers).reduce((s, r) => s + Object.keys(r).length, 0);
  res.json({
    status:   'ok',
    instance: INSTANCE_ID,
    rooms:    Object.keys(roomUsers).length,
    users:    totalUsers,
    mongodb:  mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime:   Math.round(process.uptime()) + 's'
  });
});

app.get('/api/rooms', async (req, res) => {
  try {
    if (!dbReady()) throw new Error('db offline');
    const persisted = await Room.find().sort({ lastActive: -1 }).limit(20);
    const rooms = persisted.map(r => ({
      name:       r.name,
      users:      Object.keys(getRoomUsers(r.name)).length,
      maxUsers:   r.maxUsers,
      lastActive: r.lastActive
    }));
    // Add live rooms not yet persisted
    Object.keys(roomUsers).forEach(name => {
      if (!rooms.find(r => r.name === name))
        rooms.push({ name, users: Object.keys(roomUsers[name]).length, maxUsers: 20 });
    });
    res.json(rooms.filter(r => r.users > 0)); // only show rooms with active users
  } catch (e) {
    const rooms = Object.entries(roomUsers)
      .filter(([, u]) => Object.keys(u).length > 0)
      .map(([name, u]) => ({ name, users: Object.keys(u).length, maxUsers: 20 }));
    res.json(rooms);
  }
});

app.get('/api/rooms/:name/users', (req, res) => {
  res.json(Object.values(getRoomUsers(req.params.name)));
});

app.get('/api/metrics', (req, res) => {
  const totalUsers = Object.values(roomUsers).reduce((s, r) => s + Object.keys(r).length, 0);
  res.json({ instance: INSTANCE_ID, rooms: Object.keys(roomUsers).length, users: totalUsers });
});

// ─── Redis (optional — graceful fallback) ─────────────────────────────────────
if (process.env.REDIS_URL) {
  try {
    const { createClient } = require('redis');
    const redis = createClient({ url: process.env.REDIS_URL });
    redis.connect()
      .then(() => console.log('✅ Redis connected'))
      .catch(() => console.log('ℹ Redis unavailable — single-instance mode'));
  } catch (e) {}
} else {
  console.log('ℹ Single-instance mode (no REDIS_URL)');
}

// ─── Socket.io Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);
  let currentRoom = null;

  // ── Join ──────────────────────────────────────────────────────────────────
  socket.on('join', async (payload = {}) => {
    if (currentRoom) return; // already joined — ignore duplicate join events
    const { name, room, x, y } = payload;
    const roomName = cleanText(room, 30, 'General');
    if (Object.keys(getRoomUsers(roomName)).length >= MAX_USERS_PER_ROOM) {
      socket.emit('join:error', { message: `Room "${roomName}" is full (${MAX_USERS_PER_ROOM} users)` });
      return;
    }
    const color    = COLORS[colorIndex++ % COLORS.length];
    const spawnX   = num(x, 0) || Math.floor(Math.random() * 600) + 200; // random spawn
    const spawnY   = num(y, 0) || Math.floor(Math.random() * 400) + 100;

    const userData = { id: socket.id, name: cleanText(name, 20, 'Anonymous'), x: spawnX, y: spawnY, color, room: roomName };

    currentRoom = roomName;
    socket.join(roomName);
    getRoomUsers(roomName)[socket.id] = userData;

    // Persist room + user to MongoDB
    if (dbReady()) Room.findOneAndUpdate(
      { name: roomName },
      { name: roomName, lastActive: new Date() },
      { upsert: true, new: true }
    ).catch(() => {});

    if (dbReady()) User.findOneAndUpdate(
      { socketId: socket.id },
      { socketId: socket.id, name: userData.name, color, x: spawnX, y: spawnY, room: roomName, updatedAt: new Date() },
      { upsert: true, new: true }
    ).catch(() => {});

    // Tell the joining user who they are
    socket.emit('self:joined', { id: socket.id, color, room: roomName, x: spawnX, y: spawnY });

    // Send full user list to everyone in room
    io.to(roomName).emit('users:update', Object.values(getRoomUsers(roomName)));

    // Late-join fix: recompute proximity for everyone, forcing the newcomer's first update
    delete lastNearby[socket.id];
    syncProximity(roomName, true);

    console.log(`👤 ${userData.name} joined room "${roomName}" at (${Math.round(spawnX)}, ${Math.round(spawnY)})`);
  });

  // ── Move ──────────────────────────────────────────────────────────────────
  socket.on('move', (pos = {}) => {
    const me = currentRoom && getRoomUsers(currentRoom)[socket.id];
    if (!me || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    const x = num(pos.x, me.x), y = num(pos.y, me.y);
    me.x = x; me.y = y;

    socket.to(currentRoom).emit('user:moved', { id: socket.id, x, y });
    if (dbReady()) User.findOneAndUpdate({ socketId: socket.id }, { x, y, updatedAt: new Date() }).catch(() => {});

    // Notify every user whose nearby-set changed (both sides of each pair)
    syncProximity(currentRoom);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const user = getRoomUsers(currentRoom)[socket.id];
    console.log(`❌ ${user?.name || socket.id} left room "${currentRoom}"`);
    delete getRoomUsers(currentRoom)[socket.id];

    // Clean up empty rooms
    if (Object.keys(getRoomUsers(currentRoom)).length === 0) {
      delete roomUsers[currentRoom];
    }

    delete lastNearby[socket.id];
    if (dbReady()) User.deleteOne({ socketId: socket.id }).catch(() => {});
    io.to(currentRoom).emit('user:left',    { id: socket.id });
    io.to(currentRoom).emit('users:update', Object.values(roomUsers[currentRoom] || {}));
    if (roomUsers[currentRoom]) syncProximity(currentRoom);
  });
});

// Attach WebRTC signaling (Week 2)
attachSignaling(io);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 ProxiSpeak server running!');
  console.log(`   Instance: ${INSTANCE_ID}`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
  console.log('');
});

process.on('unhandledRejection', err => console.warn('⚠ Unhandled rejection:', err?.message || err));
process.on('uncaughtException',  err => console.error('⚠ Uncaught exception:', err));
