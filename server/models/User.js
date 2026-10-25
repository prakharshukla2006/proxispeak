const mongoose = require('mongoose');

/**
 * User schema — stores name, color, and socket info.
 *
 * NOTE: We intentionally do NOT store canvas (x,y) in MongoDB.
 * Canvas pixel coordinates (0-900, 0-600) are incompatible with
 * MongoDB's geo indexes (which expect lon/lat -180→180, -90→90).
 *
 * Proximity queries use:
 *   1. In-memory Euclidean distance (primary — instant, O(n))
 *   2. Redis shared hash (cross-instance, Week 3)
 * MongoDB here stores only persistent user profile data.
 */
const userSchema = new mongoose.Schema({
  socketId:  { type: String, required: true, unique: true },
  name:      { type: String, default: 'Anonymous' },
  color:     { type: String, default: '#4F46E5' },
  // x, y stored as plain numbers — no geo index
  x:         { type: Number, default: 0 },
  y:         { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
