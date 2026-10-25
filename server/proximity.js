const User = require('./models/User');

const EARSHOT_RADIUS_PX = 100;

/**
 * Find all users within pixel radius of (x, y).
 *
 * Uses MongoDB's flat '2d' index with the $near operator.
 * Syntax for 2d index: { $near: [x, y], $maxDistance: pixels }
 * (NOT the GeoJSON $geometry form — that's only for 2dsphere)
 */
async function getUsersInEarshot(x, y, excludeSocketId) {
  const nearby = await User.find({
    socketId: { $ne: excludeSocketId },
    location: {
      $near:       [x, y],
      $maxDistance: EARSHOT_RADIUS_PX
    }
  });
  return nearby;
}

function getDistance(x1, y1, x2, y2) {
  return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
}

module.exports = { getUsersInEarshot, getDistance, EARSHOT_RADIUS_PX };
