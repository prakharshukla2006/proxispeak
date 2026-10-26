/**
 * ProxiSpeak — Main Server  (Week 1 + Week 2)
 * Week 1: Real-time position broadcasting via Socket.io
 * Week 2: WebRTC signaling for proximity-based audio
 */

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');

const User                = require('./models/User');
const { attachSignaling } = require('./signaling');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());

// Serve client files
const clientPath = path.join(__dirname, '../client/public');
app.use(express.static(clientPath));

// ─── State ────────────────────────────────────────────────────────────────────
const users = {};  // socketId → { id, name, x, y, color }

const COLORS     = ['#4F46E5','#EF4444','#10B981','#F59E0B','#EC4899','#06B6D4','#8B5CF6','#F97316'];
let   colorIndex = 0;

const EARSHOT_PX = 150;  // proximity radius in pixels

// ─── REST ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:      'ok',
    connections: Object.keys(users).length,
    mongodb:     mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime:      Math.round(process.uptime()) + 's'
  });
});

app.get('/api/users', (req, res) => res.json(Object.values(users)));

// ─── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.warn('⚠ MongoDB unavailable:', err.message));

// ─── Socket.io Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);

  // User joins with a name and position
  socket.on('join', ({ name, x, y }) => {
    const color    = COLORS[colorIndex++ % COLORS.length];
    const userData = { id: socket.id, name: name || 'Anonymous', x, y, color };
    users[socket.id] = userData;

    // Save to MongoDB
    User.findOneAndUpdate(
      { socketId: socket.id },
      { socketId: socket.id, name: name || 'Anonymous', color, x, y, updatedAt: new Date() },
      { upsert: true, new: true }
    ).catch(err => console.warn('MongoDB save failed:', err.message));

    socket.emit('self:joined', { id: socket.id, color });
    io.emit('users:update', Object.values(users));
    console.log(`👤 ${name} joined at (${Math.round(x)}, ${Math.round(y)})`);
  });

  // User moves — broadcast new position + check proximity
  socket.on('move', ({ x, y }) => {
    if (!users[socket.id]) return;
    users[socket.id].x = x;
    users[socket.id].y = y;

    // Update MongoDB (non-blocking)
    User.findOneAndUpdate({ socketId: socket.id }, { x, y, updatedAt: new Date() }).catch(() => {});

    // Broadcast position to all
    socket.broadcast.emit('user:moved', { id: socket.id, x, y });

    // Find nearby users (in-memory Euclidean distance)
    const nearbyIds = Object.values(users)
      .filter(u => u.id !== socket.id)
      .filter(u => Math.sqrt((u.x - x) ** 2 + (u.y - y) ** 2) <= EARSHOT_PX)
      .map(u => u.id);

    socket.emit('proximity:update', { nearbyIds, radius: EARSHOT_PX });
  });

  // User disconnects
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
  console.log('🚀 ProxiSpeak server running!');
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/health`);
  console.log('');
});
