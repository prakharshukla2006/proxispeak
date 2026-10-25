/**
 * AudioMixer.js — Spatial Audio Engine for ProxiSpeak  (Week 3 upgrade)
 *
 * Week 3 changes vs Week 2:
 *  - Now powered by AttenuationEngine (5 selectable falloff curves)
 *  - Exposes getAnalyser() for real-time volume meters
 *  - Tracks per-peer audio stats (gain, pan, distance)
 *  - setGlobalCurve() allows runtime curve switching for demo
 *
 * Audio Graph per peer:
 *   MediaStreamSource → GainNode → StereoPannerNode → AnalyserNode → destination
 */

import { AttenuationEngine, CURVES } from './AttenuationEngine.js';

export { CURVES };   // re-export so consumers only need this module

export class SpatialAudioMixer {
  /**
   * @param {object} options
   * @param {number} options.maxDistance - Earshot radius in px (default 100)
   * @param {string} options.curve       - Initial falloff curve (default QUADRATIC)
   */
  constructor(options = {}) {
    this._context = null;
    this.engine   = new AttenuationEngine({
      maxDistance: options.maxDistance ?? 100,
      curve:       options.curve       ?? CURVES.QUADRATIC,
    });

    // peerId → { source, gainNode, pannerNode, analyser, stats }
    this.peers = new Map();
  }

  // ── AudioContext (lazy, browser-policy safe) ──────────────────────────────
  get context() {
    if (!this._context) this._context = new AudioContext();
    return this._context;
  }

  async resume() {
    if (this.context.state === 'suspended') await this.context.resume();
  }

  // ── Peer Management ───────────────────────────────────────────────────────

  /**
   * Connect a remote peer's audio stream into the spatial audio graph.
   * Call when RTCPeerConnection fires the `track` event.
   */
  addPeer(peerId, mediaStream) {
    if (this.peers.has(peerId)) this.removePeer(peerId);

    const ac      = this.context;
    const source  = ac.createMediaStreamSource(mediaStream);
    const gain    = ac.createGain();
    const panner  = ac.createStereoPanner();
    const analyser= ac.createAnalyser();
    analyser.fftSize = 256;

    // Source → Gain → Panner → Analyser → Speakers
    source.connect(gain);
    gain.connect(panner);
    panner.connect(analyser);
    analyser.connect(ac.destination);

    gain.gain.value    = 1.0;
    panner.pan.value   = 0;

    this.peers.set(peerId, {
      source, gainNode: gain, pannerNode: panner, analyser,
      stats: { gain: 1, pan: 0, distance: 0, db: 0 }
    });

    console.log(`🔊 AudioMixer: peer added [${peerId.slice(0,6)}]`);
  }

  /**
   * Update spatial audio for a peer based on current position delta.
   * Call every animation frame for nearby peers.
   *
   * @param {string} peerId
   * @param {number} distance  - Pixel distance between avatars
   * @param {number} myX       - My canvas X
   * @param {number} theirX    - Their canvas X
   */
  updatePeer(peerId, distance, myX, theirX) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    const gain = this.engine.calculateGain(distance);
    const pan  = this.engine.calculatePan(myX, theirX);
    const t    = this.context.currentTime;

    // Smooth 100ms ramp — prevents clicking artifacts
    peer.gainNode.gain.setTargetAtTime(gain, t, 0.1);
    peer.pannerNode.pan.setTargetAtTime(pan,  t, 0.1);

    // Update stats for UI meters
    peer.stats = { gain, pan, distance, db: this.engine.toDb(gain) };
  }

  /**
   * Fade out and disconnect a peer.
   * Call when they leave earshot or disconnect.
   */
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // 50ms fade out to avoid audio pop
    peer.gainNode.gain.setTargetAtTime(0, this.context.currentTime, 0.05);
    setTimeout(() => {
      try {
        peer.source.disconnect();
        peer.gainNode.disconnect();
        peer.pannerNode.disconnect();
        peer.analyser.disconnect();
      } catch (_) {}
    }, 200);

    this.peers.delete(peerId);
    console.log(`🔇 AudioMixer: peer removed [${peerId.slice(0,6)}]`);
  }

  // ── Curve Switching (Week 3 feature) ──────────────────────────────────────

  /** Switch the active attenuation curve for all future updates. */
  setCurve(curveName) {
    this.engine.setCurve(curveName);
    console.log(`🎛 Attenuation curve → ${curveName}`);
  }

  /** Get the active curve name */
  getCurve() { return this.engine.curve; }

  /**
   * Get current gain curve samples for drawing the visualiser.
   * @returns {Array<{distance, gain, db}>}
   */
  getCurveSamples(steps = 60) {
    return this.engine.getSamples(steps);
  }

  // ── Audio Analysis ────────────────────────────────────────────────────────

  /**
   * Get the instantaneous RMS (root-mean-square) volume level for a peer.
   * Returns 0.0 – 1.0.  Use for animated audio meter bars.
   */
  getPeerVolume(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return 0;

    const buf = new Uint8Array(peer.analyser.fftSize);
    peer.analyser.getByteTimeDomainData(buf);

    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
  }

  /** Get stats object for a peer { gain, pan, distance, db } */
  getPeerStats(peerId) {
    return this.peers.get(peerId)?.stats ?? null;
  }

  // ── Obstacle support (Week 4 hook) ────────────────────────────────────────
  setObstacleDecay(factor) {
    this.engine.setObstacleDecay(factor);
  }

  // ── Teardown ──────────────────────────────────────────────────────────────
  destroy() {
    this.peers.forEach((_, id) => this.removePeer(id));
    this._context?.close();
    this._context = null;
  }
}
