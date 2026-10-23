# District Fire — Family FPS

Mobile-browser multiplayer FPS for Josh Geiger and sons (max 3 players).  
**Inspired by** Urban Terror’s tactical arena feel — original geometry and materials only (no UT/Quake assets or trademarks).

## Features (v1)

- Free-for-all deathmatch, first to N kills (default 10)
- Room codes (4 letters), max 3 players
- Assault-rifle hitscan with spread/recoil feel, headshot bonus
- Health 100, short respawn delay
- Phone touch: left joystick, right look, FIRE / JUMP / R
- Desktop fallback: WASD, mouse look (click canvas), LMB fire, Space jump, R reload
- Small urban arena: buildings, cover, raised platforms

## Run locally

```bash
cd /workspace/family-fps
npm install
npm start
```

Open `http://localhost:3080` (or the machine’s LAN IP on port 3080).

## Public HTTPS link (phones)

```bash
npm start
# other terminal:
npx -y cloudflared tunnel --url http://localhost:3080
```

Share the `https://….trycloudflare.com` URL. All players open it, one **Create Room**, others **Join** with the 4-letter code.

## How to play

1. Enter a callsign → **Create Room** or **Join** with code  
2. Host can set kill limit → everyone taps **Ready** (need 2–3)  
3. Landscape phone recommended  
4. Move with left stick, look on right half, hold **FIRE**, **JUMP** to jump, **R** to reload  
5. First to the kill limit wins → **Back to Lobby**

## Controls summary

| Action | Touch | Desktop |
|--------|-------|---------|
| Move | Left virtual stick | WASD |
| Look | Drag right side | Mouse (pointer lock) |
| Fire | FIRE button | Left mouse |
| Jump | JUMP | Space |
| Reload | R | R |

## Stack

- Node.js + Express + Socket.io (~25 Hz authoritative HP/kills/spawns)
- Three.js (CDN) client, vanilla JS
- Listens on `0.0.0.0:3080`

## Known limits (v1)

- Simple box collision (no true ramps / stairs mesh)
- No prediction / lag compensation beyond server tick
- One weapon (AR); no knife/pistol yet
- Max 3 players; no bots
- iOS Safari needs user gesture for audio (no SFX in v1 yet)
- Same tunnel URL for all; keep phones awake

## License

Original code for personal/family use. Not affiliated with Urban Terror / FrozenSand / id Software.
