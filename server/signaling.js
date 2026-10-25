/**
 * ProxiSpeak — WebRTC Signaling Module
 *
 * This module does NOT handle audio directly.
 * It acts as a "post office" — routing WebRTC handshake messages
 * (offer, answer, ICE candidates) between two specific socket IDs.
 *
 * Flow:
 *   1. User A wants to call User B → sends 'webrtc:offer'
 *   2. Server forwards to User B
 *   3. User B responds with 'webrtc:answer'
 *   4. Server forwards back to User A
 *   5. Both exchange ICE candidates → P2P audio established
 */
function attachSignaling(io) {
  io.on('connection', (socket) => {

    // ── Offer ──────────────────────────────────────────────────────────────
    // Caller initiates a WebRTC connection to targetId
    socket.on('webrtc:offer', ({ targetId, offer }) => {
      console.log(`📞 Offer: ${socket.id} → ${targetId}`);
      socket.to(targetId).emit('webrtc:offer', {
        fromId: socket.id,
        offer
      });
    });

    // ── Answer ─────────────────────────────────────────────────────────────
    // Callee accepts and sends back its SDP answer
    socket.on('webrtc:answer', ({ targetId, answer }) => {
      console.log(`✅ Answer: ${socket.id} → ${targetId}`);
      socket.to(targetId).emit('webrtc:answer', {
        fromId: socket.id,
        answer
      });
    });

    // ── ICE Candidates ─────────────────────────────────────────────────────
    // Exchange network path candidates for NAT traversal
    socket.on('webrtc:ice-candidate', ({ targetId, candidate }) => {
      socket.to(targetId).emit('webrtc:ice-candidate', {
        fromId: socket.id,
        candidate
      });
    });

    // ── Hangup ─────────────────────────────────────────────────────────────
    // User moved out of earshot — tell the peer to close the connection
    socket.on('webrtc:hangup', ({ targetId }) => {
      console.log(`📴 Hangup: ${socket.id} → ${targetId}`);
      socket.to(targetId).emit('webrtc:hangup', { fromId: socket.id });
    });

  });
}

module.exports = { attachSignaling };
