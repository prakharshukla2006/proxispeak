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
