/**
 * ProxiSpeak — Server (Week 4)
 * Week 1: Real-time position sync via Socket.io + MongoDB
 * Week 2: WebRTC peer-to-peer audio via proximity signaling
 * Week 3: Dynamic audio attenuation curves + Redis-ready scaling
 * Week 4: Named room persistence + 60 FPS smooth movement
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

const INSTANCE_ID = `${os.hostname()}-${process.pid}`;
const EARSHOT_PX  = 150;

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

// ─── In-memory state (per room) ──────────────────────────────────────────────
// rooms → { roomName → { socketId → { id, name, x, y, color } } }
const roomUsers = {};

const COLORS     = ['#4F46E5','#EF4444','#10B981','#F59E0B','#EC4899','#06B6D4','#8B5CF6','#F97316'];
let   colorIndex = 0;

function getRoomUsers(room) {
  if (!roomUsers[room]) roomUsers[room] = {};
  return roomUsers[room];
}

function findNearby(room, x, y, excludeId) {
  return Object.values(getRoomUsers(room))
    .filter(u => u.id !== excludeId)
    .filter(u => Math.sqrt((u.x - x) ** 2 + (u.y - y) ** 2) <= EARSHOT_PX)
    .map(u => u.id);
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.warn('⚠ MongoDB unavailable:', err.message));

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

// Get all active rooms with user counts
app.get('/api/rooms', async (req, res) => {
  try {
    // Merge persisted rooms from MongoDB with live user counts
    const persisted = await Room.find().sort({ lastActive: -1 }).limit(20);
    const rooms = persisted.map(r => ({
      name:      r.name,
      users:     Object.keys(getRoomUsers(r.name)).length,
      maxUsers:  r.maxUsers,
      lastActive:r.lastActive
    }));

    // Add in-memory only rooms (not yet persisted)
    Object.keys(roomUsers).forEach(name => {
      if (!rooms.find(r => r.name === name)) {
        rooms.push({ name, users: Object.keys(roomUsers[name]).length, maxUsers: 20 });
      }
    });

    res.json(rooms);
  } catch (e) {
    // Fallback: in-memory only
    const rooms = Object.entries(roomUsers).map(([name, u]) => ({
      name, users: Object.keys(u).length, maxUsers: 20
    }));
    res.json(rooms);
  }
});

app.get('/api/rooms/:name/users', (req, res) => {
  res.json(Object.values(getRoomUsers(req.params.name)));
});

app.get('/api/metrics', (req, res) => {
  const totalUsers = Object.values(roomUsers).reduce((s, r) => s + Object.keys(r).length, 0);
  res.json({
    instance:  INSTANCE_ID,
    rooms:     Object.keys(roomUsers).length,
    users:     totalUsers
  });
});

// ─── Redis (optional) ─────────────────────────────────────────────────────────
if (process.env.REDIS_URL) {
  try {
    const { createClient } = require('redis');
    const redis = createClient({ url: process.env.REDIS_URL });
    redis.connect()
      .then(() => console.log('✅ Redis connected'))
      .catch(() => console.log('ℹ Redis unavailable — single-instance mode'));
  } catch (e) {}
} else {
  console.log('ℹ Redis not configured — single-instance mode');
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);
  let currentRoom = null;

  // ── Join a room ──────────────────────────────────────────────────────────
  socket.on('join', async ({ name, room, x, y }) => {
    const roomName = (room || 'General').trim() || 'General';
    const color    = COLORS[colorIndex++ % COLORS.length];
    const userData = {
      id: socket.id,
      name: name || 'Anonymous',
      x: x || 450,
      y: y || 300,
      color,
      room: roomName
    };

    currentRoom = roomName;
    socket.join(roomName);   // Socket.io room
    getRoomUsers(roomName)[socket.id] = userData;

    // Persist room to MongoDB
    Room.findOneAndUpdate(
      { name: roomName },
      { name: roomName, lastActive: new Date() },
      { upsert: true, new: true }
    ).catch(() => {});

    // Persist user to MongoDB
    User.findOneAndUpdate(
      { socketId: socket.id },
      { socketId: socket.id, name: userData.name, color, x: userData.x, y: userData.y, room: roomName, updatedAt: new Date() },
      { upsert: true, new: true }
    ).catch(() => {});

    socket.emit('self:joined', { id: socket.id, color, room: roomName });
    // Send all users in this room
    io.to(roomName).emit('users:update', Object.values(getRoomUsers(roomName)));
    console.log(`👤 ${userData.name} joined room "${roomName}"`);
  });

  // ── Move ─────────────────────────────────────────────────────────────────
  socket.on('move', ({ x, y }) => {
    if (!currentRoom || !getRoomUsers(currentRoom)[socket.id]) return;
    getRoomUsers(currentRoom)[socket.id].x = x;
    getRoomUsers(currentRoom)[socket.id].y = y;

    User.findOneAndUpdate({ socketId: socket.id }, { x, y, updatedAt: new Date() }).catch(() => {});

    // Broadcast to same room only
    socket.to(currentRoom).emit('user:moved', { id: socket.id, x, y });

    const nearbyIds = findNearby(currentRoom, x, y, socket.id);
    socket.emit('proximity:update', { nearbyIds, radius: EARSHOT_PX });
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (currentRoom) {
      const user = getRoomUsers(currentRoom)[socket.id];
      console.log(`❌ ${user?.name || socket.id} left room "${currentRoom}"`);
      delete getRoomUsers(currentRoom)[socket.id];

      // Clean up empty rooms from memory
      if (Object.keys(getRoomUsers(currentRoom)).length === 0) {
        delete roomUsers[currentRoom];
      }

      User.deleteOne({ socketId: socket.id }).catch(() => {});
      io.to(currentRoom).emit('user:left',    { id: socket.id });
      io.to(currentRoom).emit('users:update', Object.values(getRoomUsers(currentRoom) || {}));
    }
  });
});

// Attach WebRTC signaling (Week 2)
attachSignaling(io);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('🚀 ProxiSpeak Week 4 server running!');
  console.log(`   Instance: ${INSTANCE_ID}`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
  console.log('');
});
