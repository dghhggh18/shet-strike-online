# SHATKI FPS server

- `GET /health` reports server status.
- Socket.IO room events: `room:list`, `room:create`, `room:quick-join`, `room:join`, `room:leave`.
- `room:quick-join` fills the oldest live room of the selected mode with fewer than 10 players; otherwise it creates a new room.
- Match events: `player:input`, `combat:shoot`, `match:state`, `match:clock`, `match:round-end`, `match:killfeed`.
- Server-authoritative parts: bounded movement, weapon cooldowns, health/armor damage, team kill score, round timer/end, basic ray blocking against blockout walls/crates, kill rewards.

This is still a prototype, not a production anti-cheat or full game server. The client does not yet use a server physics simulation, the defusal mode has no bomb objective, and rounds do not automatically restart.


### v0.8 notes
Movement is bounded by the server-side arena blockout and shot rays are checked against server-held yaw/pitch. This is not production anti-cheat: network prediction/reconciliation, vertical physics, lag compensation and a shared collision asset are still outstanding.

## Persistent guest profiles (v1.1)

The server exposes `POST /api/guest`, `GET /api/me`, `PATCH /api/me`, and `GET /api/leaderboard`. Guest bearer tokens are random and only their SHA-256 hashes are stored on disk. Profile records are persisted in `./data/profiles.json` by default; set `SHATKI_DATA_FILE` to a durable writable path for hosting. The `data/` directory is gitignored and must not be committed. This JSON-backed implementation is a prototype and is not a replacement for PostgreSQL transactions, backups, rate limiting, or account recovery in production.


### Server-side case economy (v1.2)

`POST /api/cases/open` requires `Authorization: Bearer <token>`. The server charges 150 Shatki and awards/persists a random item. A profile starts with 500 Shatki. This endpoint uses the prototype JSON store; use a transactional database before scaling beyond one server process.


## Account API (v1.4)
- `POST /api/account/upgrade` binds a guest profile to a username and password without losing inventory.
- `POST /api/account/login` verifies the scrypt password hash and rotates the bearer token.
- Password policy: 10–128 characters. Username policy: 3–20 lowercase letters, digits, underscores.
- Login throttling is in-memory per IP; deploy behind HTTPS and use a shared rate limiter plus PostgreSQL before public release.
