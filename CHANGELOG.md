# Changelog — SHATKI FPS

## v2.0.0 — синхронизация движения
- Добавлена серверная коррекция позиции локального игрока с сохранением отзывчивого локального управления.
- Удалённые игроки плавно интерполируются между серверными снимками.
- Движение блокируется на сервере во время экрана завершённого раунда.
- Угол поворота нормализуется; добавлен тест на экстремальное конечное значение yaw.
- Это улучшает согласованность клиентов, но не заменяет компенсацию задержки и тестирование на реальном сервере.

## v1.9.0 — стабильнее комнаты и цикл раундов
- Deathmatch теперь перезапускается после экрана результата; счёт Deathmatch сбрасывается для новой игры.
- Bomb Defusal продолжает следующий раунд после 5 секунд и сохраняет счёт команд.
- Добавлено событие `room:list-updated`, чтобы список комнат обновлялся у всех подключённых клиентов.
- Исправлен крайний случай повторного входа игрока в ту же комнату, когда он единственный участник.
- При завершении и начале раунда список комнат получает актуальную фазу и счёт.


## v1.6.0 — Render hardening
- Added baseline security response headers and disabled `X-Powered-By`.
- Added per-IP rate limits for guest creation, account upgrade, equip/unequip, and case opening.
- Added Socket.IO event burst limits for movement, shooting, and general events.
- Profile JSON snapshots now write to a temporary file and atomically rename to reduce corruption risk during interruption.
- Added graceful SIGTERM/SIGINT shutdown for Render deployments and cleanup of timers.
- Kept single-origin production hosting for Vite, API, and Socket.IO.

Note: rate limiting is per process and is not a substitute for a shared Redis limiter when scaling to multiple instances. Run `npm install`, `npm test`, and `npm run build` after deployment.


## v1.7.0 — автоматический подбор матчей
- Added `room:quick-join` for Deathmatch and Bomb Defusal.
- Quick matchmaking fills the oldest compatible live room with fewer than 10 players.
- If no slot is available, the server creates a new independent room.
- Centralized room creation/player joining and balanced teams for manually created rooms too.
- Initial match state is included in room acknowledgements so the client can initialize the HUD immediately.
- JSON profile persistence remains unchanged; PostgreSQL is not required for this iteration.
