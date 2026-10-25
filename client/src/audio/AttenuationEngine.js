/**
 * AttenuationEngine.js — Advanced Audio Attenuation for ProxiSpeak  (Week 3)
 *
 * What is attenuation?
 * --------------------
 * In the real world, sound gets quieter as you move away from the source.
 * The rate at which it fades depends on the environment:
 *   - Open air field → gentle fade (linear)
 *   - Concert hall   → moderate fade (quadratic)
 *   - Small room     → steep fade (cubic / inverse square)
 *
 * This engine supports 5 curves so ProxiSpeak can feel right
 * in any virtual environment. Obstacles (walls/desks from Week 4)
 * are also wired in as an attenuation multiplier.
 *
 * All functions return a GAIN VALUE: 0.0 (silent) → 1.0 (full volume).
 *
 * Gain → dB: dB = 20 * log10(gain)
 *   gain 1.0 →  0 dB  (no attenuation)
 *   gain 0.5 → -6 dB  (half volume)
 *   gain 0.25 → -12 dB
 *   gain 0.0 → -∞ dB  (silent)
 */

// ─── Curve Types ──────────────────────────────────────────────────────────────
export const CURVES = {
  LINEAR:        'linear',         // Straight line: feels open / spacious
  QUADRATIC:     'quadratic',      // Squared:       natural for offices (default)
  CUBIC:         'cubic',          // Cubed:         walls feel close / intimate
  INVERSE_SQUARE:'inverse_square', // Physics law:   most realistic outdoors
  LOGARITHMIC:   'logarithmic',    // dB scale:      how human ears perceive
};

// ─── Curve Metadata (for UI) ──────────────────────────────────────────────────
export const CURVE_META = {
  [CURVES.LINEAR]:         { label: 'Linear',        color: '#60a5fa', desc: 'Slow, even fade' },
  [CURVES.QUADRATIC]:      { label: 'Quadratic',     color: '#10b981', desc: 'Natural office feel (default)' },
  [CURVES.CUBIC]:          { label: 'Cubic',         color: '#f59e0b', desc: 'Intimate / close rooms' },
  [CURVES.INVERSE_SQUARE]: { label: 'Inv. Square',   color: '#ef4444', desc: 'Real-world physics law' },
  [CURVES.LOGARITHMIC]:    { label: 'Logarithmic',   color: '#c084fc', desc: 'How ears perceive loudness' },
};

// ─── Pure Curve Functions ──────────────────────────────────────────────────────
// Each takes a normalised distance t ∈ [0, 1]  (0 = touching, 1 = edge of earshot)
// and returns gain ∈ [0, 1].

const curveFn = {
  [CURVES.LINEAR]:         (t) => 1 - t,
  [CURVES.QUADRATIC]:      (t) => (1 - t) ** 2,
  [CURVES.CUBIC]:          (t) => (1 - t) ** 3,
  [CURVES.INVERSE_SQUARE]: (t) => 1 / (1 + (t * 4) ** 2),   // ref distance = 25% of max
  [CURVES.LOGARITHMIC]:    (t) => t < 1 ? Math.max(0, 1 + Math.log10(1 - t * 0.99) / 2) : 0,
};

// ─── AttenuationEngine ────────────────────────────────────────────────────────

export class AttenuationEngine {
  /**
   * @param {object} options
   * @param {number}  options.maxDistance   - Earshot radius in pixels (default 100)
   * @param {string}  options.curve         - One of CURVES.* (default QUADRATIC)
   * @param {number}  options.softZone      - Distance within which gain is always 1.0 (default 10px)
   * @param {number}  options.obstacleDecay - Extra attenuation multiplier from obstacles 0-1 (default 1 = no obstruction)
   */
  constructor(options = {}) {
    this.maxDistance   = options.maxDistance   ?? 100;
    this.curve         = options.curve         ?? CURVES.QUADRATIC;
    this.softZone      = options.softZone      ?? 10;    // full-volume zone near the avatar
    this.obstacleDecay = options.obstacleDecay ?? 1.0;  // Week 4: walls set this < 1
  }

  /**
   * Calculate gain for a given pixel distance.
   * @param   {number} distance - Raw pixel distance between two avatars
   * @returns {number}          - Gain 0.0 → 1.0
   */
  calculateGain(distance) {
    if (distance <= this.softZone)      return 1.0;
    if (distance >= this.maxDistance)   return 0.0;

    // Normalise into [0, 1] range, accounting for soft zone
    const range = this.maxDistance - this.softZone;
    const t     = (distance - this.softZone) / range; // 0 at softZone, 1 at maxDistance

    const fn   = curveFn[this.curve] ?? curveFn[CURVES.QUADRATIC];
    const gain = Math.max(0, Math.min(1, fn(t)));

    // Apply obstacle decay (Week 4 hook)
    return gain * this.obstacleDecay;
  }

  /**
   * Calculate stereo pan value.
   * @param   {number} myX    - My avatar X coordinate
   * @param   {number} theirX - Their avatar X coordinate
   * @returns {number}        - Pan -1 (full left) → 0 (center) → 1 (full right)
   */
  calculatePan(myX, theirX) {
    const diff = theirX - myX;
    return Math.max(-1, Math.min(1, diff / (this.maxDistance * 0.8)));
  }

  /**
   * Convert gain to decibels (for display).
   * @param   {number} gain - 0.0 → 1.0
   * @returns {number}      - dB value (0 = full, -∞ = silent)
   */
  toDb(gain) {
    if (gain <= 0) return -Infinity;
    return 20 * Math.log10(gain);
  }

  /**
   * Generate a gain curve sample array for visualisation.
   * Returns [{distance, gain, db}, ...] for plotting.
   * @param   {number} steps - Number of sample points (default 50)
   * @returns {Array}
   */
  getSamples(steps = 50) {
    const samples = [];
    for (let i = 0; i <= steps; i++) {
      const distance = (i / steps) * this.maxDistance;
      const gain     = this.calculateGain(distance);
      samples.push({ distance, gain, db: this.toDb(gain) });
    }
    return samples;
  }

  /**
   * Set obstacle decay (used in Week 4 when avatars are separated by walls).
   * @param {number} factor - 0.0 (fully blocked) → 1.0 (no obstruction)
   */
  setObstacleDecay(factor) {
    this.obstacleDecay = Math.max(0, Math.min(1, factor));
  }

  /** Switch the active falloff curve at runtime */
  setCurve(curveName) {
    if (CURVES[curveName.toUpperCase()] || Object.values(CURVES).includes(curveName)) {
      this.curve = curveName;
    }
  }
}

// ─── Convenience factory (default engine instance) ────────────────────────────
export const defaultEngine = new AttenuationEngine();
