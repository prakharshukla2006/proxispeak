import { useRef, useCallback, useEffect } from 'react';
import { SpatialAudioMixer } from '../audio/AudioMixer';

/**
 * useWebRTC — React hook for managing WebRTC peer connections in ProxiSpeak
 *
 * Responsibilities:
 *  - Request microphone access (getUserMedia)
 *  - Create / manage RTCPeerConnection per peer
 *  - Handle offer/answer/ICE via the Socket.io signaling server
 *  - Feed remote audio tracks into SpatialAudioMixer
 *
 * Usage:
 *   const { initMic, connectToPeer, disconnectFromPeer, updateAudio, micActive } = useWebRTC(socket);
 *
 * @param {Socket} socket - Connected Socket.io client instance
 * @returns {object} WebRTC control functions
 */

// ICE servers — add TURN credentials here in production
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export function useWebRTC(socket) {
  // Our microphone stream
  const localStream   = useRef(null);
  // peerId → RTCPeerConnection
  const peerConns     = useRef(new Map());
  // Spatial audio mixer
  const audioMixer    = useRef(new SpatialAudioMixer());
  // Flag
  const micActive     = useRef(false);

  // ── Get Microphone ─────────────────────────────────────────────────────────
  const initMic = useCallback(async () => {
    if (localStream.current) return localStream.current; // Already have it

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });
      localStream.current = stream;
      micActive.current   = true;
      await audioMixer.current.resume(); // Unblock AudioContext
      console.log('🎤 Microphone acquired');
      return stream;
    } catch (err) {
      console.error('❌ getUserMedia failed:', err.message);
      throw err;
    }
  }, []);

  // ── Create Peer Connection ─────────────────────────────────────────────────
  const createPeerConnection = useCallback((peerId) => {
    if (peerConns.current.has(peerId)) {
      return peerConns.current.get(peerId);
    }

    const pc = new RTCPeerConnection(ICE_CONFIG);

    // Add our local mic tracks to this connection
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        pc.addTrack(track, localStream.current);
      });
    }

    // When we receive remote audio → plug into AudioMixer
    pc.ontrack = (event) => {
      console.log(`🔊 Received audio track from ${peerId}`);
      const [remoteStream] = event.streams;
      audioMixer.current.addPeer(peerId, remoteStream);
    };

    // Forward ICE candidates to the peer via signaling server
    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('webrtc:ice-candidate', {
          targetId: peerId,
          candidate: event.candidate
        });
      }
    };

    // Log connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`🔗 Peer ${peerId} connection: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        disconnectFromPeer(peerId);
      }
    };

    peerConns.current.set(peerId, pc);
    return pc;
  }, [socket]);

  // ── Initiate Connection (We are the Caller) ────────────────────────────────
  const connectToPeer = useCallback(async (peerId) => {
    if (!socket || !localStream.current) return;
    if (peerConns.current.has(peerId)) return; // Already connected

    console.log(`📞 Calling peer: ${peerId}`);
    const pc = createPeerConnection(peerId);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit('webrtc:offer', { targetId: peerId, offer });
    } catch (err) {
      console.error('Failed to create offer:', err);
    }
  }, [socket, createPeerConnection]);

  // ── Close a Peer Connection ────────────────────────────────────────────────
  const disconnectFromPeer = useCallback((peerId) => {
    const pc = peerConns.current.get(peerId);
    if (pc) {
      pc.close();
      peerConns.current.delete(peerId);
    }
    audioMixer.current.removePeer(peerId);

    if (socket) {
      socket.emit('webrtc:hangup', { targetId: peerId });
    }
    console.log(`📴 Disconnected from peer: ${peerId}`);
  }, [socket]);

  // ── Update Audio Levels (Call on every position update) ───────────────────
  const updateAudio = useCallback((peerId, distance, myX, theirX) => {
    audioMixer.current.updatePeer(peerId, distance, myX, theirX);
  }, []);

  // ── Socket.io Signaling Listeners ─────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    // ── Incoming Offer (We are the Callee) ───────────────────────────────────
    const handleOffer = async ({ fromId, offer }) => {
      console.log(`📲 Received offer from: ${fromId}`);
      if (!localStream.current) {
        console.warn('No local stream — mic not initialized yet');
        return;
      }

      const pc = createPeerConnection(fromId);

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { targetId: fromId, answer });
      } catch (err) {
        console.error('Failed to handle offer:', err);
      }
    };

    // ── Incoming Answer ───────────────────────────────────────────────────────
    const handleAnswer = async ({ fromId, answer }) => {
      const pc = peerConns.current.get(fromId);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error('Failed to set remote description:', err);
      }
    };

    // ── ICE Candidate ─────────────────────────────────────────────────────────
    const handleIce = async ({ fromId, candidate }) => {
      const pc = peerConns.current.get(fromId);
      if (!pc) return;
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Failed to add ICE candidate:', err);
      }
    };

    // ── Remote Hangup ─────────────────────────────────────────────────────────
    const handleHangup = ({ fromId }) => {
      const pc = peerConns.current.get(fromId);
      if (pc) {
        pc.close();
        peerConns.current.delete(fromId);
      }
      audioMixer.current.removePeer(fromId);
    };

    socket.on('webrtc:offer',         handleOffer);
    socket.on('webrtc:answer',        handleAnswer);
    socket.on('webrtc:ice-candidate', handleIce);
    socket.on('webrtc:hangup',        handleHangup);

    return () => {
      socket.off('webrtc:offer',         handleOffer);
      socket.off('webrtc:answer',        handleAnswer);
      socket.off('webrtc:ice-candidate', handleIce);
      socket.off('webrtc:hangup',        handleHangup);
    };
  }, [socket, createPeerConnection, disconnectFromPeer]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      peerConns.current.forEach(pc => pc.close());
      localStream.current?.getTracks().forEach(t => t.stop());
      audioMixer.current.destroy();
    };
  }, []);

  return {
    initMic,
    connectToPeer,
    disconnectFromPeer,
    updateAudio,
    micActive,
    audioMixer,
    localStream
  };
}
