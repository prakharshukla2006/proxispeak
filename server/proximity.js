/**
 * ProxiSpeak — proximity helpers.
 * Distance is calculated in memory (Euclidean, canvas pixels). MongoDB geo indexes
 * were dropped because they reject plain pixel coordinates.
 */
const EARSHOT_RADIUS_PX = 150;

function getDistance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** Ids of users (from a { id → user } map) within earshot of (x, y). */
function findNearby(users, x, y, excludeId, radius = EARSHOT_RADIUS_PX) {
  return Object.values(users)
    .filter(u => u.id !== excludeId && getDistance(u.x, u.y, x, y) <= radius)
    .map(u => u.id);
}

module.exports = { getDistance, findNearby, EARSHOT_RADIUS_PX };
