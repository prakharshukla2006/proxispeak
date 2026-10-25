/**
 * ProxiSpeak — Redis Pub/Sub & Shared State Module  (Week 3)
 *
 * Why Redis?
 * ----------
 * When you scale to multiple Node.js instances (e.g., 2 servers behind
 * a load balancer), each instance has its own in-memory `users` object.
 * A user on Instance A can't hear a Socket.io event emitted on Instance B.
 *
 * Redis solves this two ways:
 *  1. Socket.io Redis Adapter  — makes io.emit() and socket.to(id).emit()
 *     work across ALL instances by routing through Redis Pub/Sub channels.
 *  2. Shared Position Hash     — stores user X/Y in Redis so ANY instance
 *     can answer proximity queries without hitting MongoDB every move.
 *
 * Architecture:
 *   Instance A ──┐
 *                ├──► Redis Pub/Sub ◄──► Instance B
 *   Instance C ──┘                        Instance D
 */

const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

let pubClient = null;
let subClient = null;
let redisReady = false;

const POSITION_HASH = 'proxispeak:positions'; // Redis hash key for all user positions
const POSITION_TTL  = 3600;                    // 1 hour — auto-expire stale data

/**
 * Connect to Redis and attach the Socket.io adapter.
 * Called once at server startup — fails gracefully if Redis is unavailable.
 *
 * @param {Server} io - The Socket.io Server instance
 * @returns {boolean} true if Redis connected successfully
 */
async function setupRedis(io) {
  try {
    // socket: false disables auto-reconnect loops on failure
    const clientOpts = {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => {
          if (retries >= 2) return false; // Give up after 2 retries — don't spam errors
          return 500;                     // 500ms between retries
        },
        connectTimeout: 3000
      }
    };

    pubClient = createClient(clientOpts);
    subClient = pubClient.duplicate();

    // Log Redis errors without crashing the server
    pubClient.on('error', (err) => {
      if (!pubClient._errLogged) { console.warn('⚠ Redis unavailable:', err.code || err.message); pubClient._errLogged = true; }
    });
    subClient.on('error', () => {}); // sub errors silenced after pub logs once

    // Connect both clients (pub and sub must be separate connections)
    await Promise.all([pubClient.connect(), subClient.connect()]);

    // Attach the adapter — now io.emit() works across all Node instances
    io.adapter(createAdapter(pubClient, subClient));

    redisReady = true;
    console.log('✅ Redis connected — Socket.io scaled across instances');
    console.log(`   Redis URL: ${process.env.REDIS_URL || 'redis://localhost:6379'}`);
    return true;

  } catch (err) {
    redisReady = false;
    console.warn('⚠ Redis unavailable — running single-instance mode');
    console.warn('  Install Redis or set REDIS_URL to enable multi-instance scaling');
    return false;
  }
}

// ─── Shared Position Store ────────────────────────────────────────────────────
// These functions use Redis hashes as a shared user position registry.
// Much faster than MongoDB for hot-path proximity reads.

/**
 * Store/update a user's position in Redis.
 * Called on every 'move' event — must be fast.
 */
async function setPosition(socketId, data) {
  if (!redisReady || !pubClient?.isReady) return;
  try {
    await pubClient.hSet(POSITION_HASH, socketId, JSON.stringify({ ...data, ts: Date.now() }));
    // Refresh TTL on every write
    await pubClient.expire(POSITION_HASH, POSITION_TTL);
  } catch (_) {} // Silent — position sync is best-effort
}

/**
 * Remove a user from the shared position store on disconnect.
 */
async function removePosition(socketId) {
  if (!redisReady || !pubClient?.isReady) return;
  try {
    await pubClient.hDel(POSITION_HASH, socketId);
  } catch (_) {}
}

/**
 * Get all user positions across ALL server instances.
 * Returns array of { socketId, x, y, name, color, ts }
 */
async function getAllPositions() {
  if (!redisReady || !pubClient?.isReady) return [];
  try {
    const all = await pubClient.hGetAll(POSITION_HASH);
    return Object.values(all).map(v => JSON.parse(v));
  } catch (_) {
    return [];
  }
}

/**
 * Find users within a given pixel radius of (x, y) using the Redis position store.
 * This is the multi-instance-aware alternative to MongoDB $near.
 * For single-instance, MongoDB $near is still used (more efficient with indexing).
 *
 * @param {number} x           - Query X coordinate
 * @param {number} y           - Query Y coordinate
 * @param {string} excludeId   - Socket ID to exclude from results
 * @param {number} radius      - Search radius in pixels
 * @returns {Promise<Array>}
 */
async function findNearbyInRedis(x, y, excludeId, radius = 100) {
  const all = await getAllPositions();
  return all.filter(u => {
    if (u.socketId === excludeId) return false;
    const dist = Math.sqrt(Math.pow(u.x - x, 2) + Math.pow(u.y - y, 2));
    return dist <= radius;
  });
}

/** Returns true if Redis is connected and ready */
function isRedisReady() { return redisReady && pubClient?.isReady; }

/** Returns Redis connection stats for the /health endpoint */
async function getRedisStats() {
  if (!isRedisReady()) return { status: 'disconnected' };
  try {
    const info = await pubClient.info('clients');
    const connectedMatch = info.match(/connected_clients:(\d+)/);
    return {
      status: 'connected',
      connectedClients: connectedMatch ? parseInt(connectedMatch[1]) : 'unknown',
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    };
  } catch (_) {
    return { status: 'error' };
  }
}

module.exports = {
  setupRedis,
  setPosition,
  removePosition,
  getAllPositions,
  findNearbyInRedis,
  isRedisReady,
  getRedisStats
};
