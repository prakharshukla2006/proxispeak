# ProxiSpeak — Geospatial Proximity Audio

Move your avatar on a 2D canvas. Walk near someone and a peer-to-peer WebRTC voice call connects automatically; volume fades with distance.

## Stack
Node.js · Express · Socket.io · WebRTC (STUN) · Web Audio API · MongoDB (Mongoose) · HTML5 Canvas

## Features
- Named rooms with persistence (MongoDB) and a live room list
- Server-side proximity detection (150px earshot), including late joiners
- WebRTC audio: server only relays offer/answer/ICE; audio is P2P
- 5 attenuation curves (linear, quadratic, cubic, inverse-square, logarithmic) with live dB meters
- 60 FPS interpolated avatar movement
- Optional Redis adapter for horizontal scaling (`REDIS_URL`)

## Run
```bash
npm install
# server/.env  ->  MONGO_URI=<your mongodb uri>
cd server && node index.js
```
Open http://localhost:3001 in two browser tabs, join the same room, enable **Mic**, and move the avatars together.

Microphone access requires `localhost` or HTTPS. To share publicly: `cloudflared tunnel --url http://localhost:3001`.

## Layout
```
server/  index.js (rooms, movement, proximity)  signaling.js (WebRTC relay)  models/
client/public/index.html  (canvas UI, WebRTC, audio engine)
```

## Week 3 - Attenuation Engine
Five distance-based volume curves (linear, quadratic, cubic, inverse-square, logarithmic), live dB meters on the canvas, and an optional Redis pub/sub adapter for horizontal scaling.

## Week 3 - Attenuation Engine
Five distance-based volume curves (linear, quadratic, cubic, inverse-square, logarithmic), live dB meters on the canvas, and an optional Redis pub/sub adapter for horizontal scaling.

### Attenuation formulas (r = distance / 150px earshot, gain 0..1)
| Curve | Gain |
|---|---|
| Linear | 1 - r |
| Quadratic | (1 - r)^2 |
| Cubic | (1 - r)^3 |
| Inverse square | 1 / (10 r^2 + 1) |
| Logarithmic | 1 - log10(1 + 9r) |

Gain is applied per peer through a Web Audio GainNode and shown in dB as 20 * log10(gain).

### Testing the attenuation engine
1. Open two tabs, join the same room and enable the mic in both.
2. Drag one avatar toward the other: the dB label on the connection line rises toward 0 dB.
3. Drag it to the edge of the 150px ring: the meter falls toward -inf dB and the audio fades out.
4. Switch curves in the side panel (linear, quadratic, cubic, inverse square, logarithmic) and compare how fast the volume drops at the same distance.
5. Leave earshot: the call closes and the RTC badge disappears.
