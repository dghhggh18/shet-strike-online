# SHATKI FPS — prototype v2.0.0

Оригинальный браузерный FPS-прототип на React, TypeScript, Three.js, Vite и Socket.IO. Проект не использует игровые ассеты Valve.

## Что есть в v2.0
- Серверная коррекция локального движения уменьшает накопление расхождения между клиентом и сервером.
- Удалённые игроки плавно интерполируются между сетевыми обновлениями.
- Сервер отклоняет движение в завершённом раунде и нормализует угол поворота.
- Полная браузерная сборка и многоклиентный сетевой тест всё ещё должны быть выполнены перед публичным запуском.
- **Новое в v1.9:** Deathmatch и Bomb Defusal автоматически начинают следующий раунд после 5 секунд экрана результата; Deathmatch сбрасывает счёт на новый матч, Bomb Defusal сохраняет счёт раундов.
- Список комнат автоматически обновляется у подключённых клиентов при входе, выходе и смене фазы раунда. Повторное присоединение к уже открытой комнате не удаляет её, если игрок там единственный.

- Тренировочная 3D-сцена с управлением от первого лица, оружием, мишенями и базовой физикой Rapier.
- Онлайн-комнаты Deathmatch и Bomb Defusal через Socket.IO.
- **Новое в v1.7:** быстрая игра автоматически находит старейшую совместимую комнату с местом; лимит каждой комнаты — 10 игроков, одиннадцатый игрок попадает в отдельный матч. Если подходящей комнаты нет, сервер создаёт новую. Поддерживается отдельно для Deathmatch и Bomb Defusal.
- Серверная проверка выстрелов, урона, состояний раунда и действий с бомбой (прототип, не production anti-cheat).
- Гостевые профили с токеном, статистикой и виртуальной валютой.
- Серверное открытие кейсов и сохранение скинов.
- **Новое:** экипировка принадлежащего профилю скина через `POST /api/me/equip`; сервер проверяет владение и сохраняет выбранный скин для конкретного оружия. Экипированный скин влияет на цвет и материал модели оружия в тренировочной сцене.
- Тесты на серверную экономику и экипировку.

- **Новое в v1.6:** базовые security headers, лимиты частоты для API и Socket.IO-событий, атомарная запись JSON-профилей и корректное завершение процесса при SIGTERM/SIGINT на Render.
- **Новое:** гостевой профиль можно защитить логином и паролем без потери Шэток и инвентаря. Пароли хешируются через Node.js `scrypt`; API входа ограничивает частые попытки с одного IP.

## Требования

- Node.js 20 или новее (рекомендуется).
- npm.
- Для онлайна нужен доступный серверный процесс и публичный адрес, если подключаются другие устройства.

## Запуск локально

```bash
npm install
npm run dev
```

Во втором терминале:

```bash
npm run server
```

Клиент по умолчанию ожидает API/Socket.IO на `http://localhost:3001`. Для удалённого сервера укажи переменную `VITE_SERVER_URL` при сборке клиента и `CLIENT_ORIGIN` на сервере. Пример переменных есть в `.env.example`.

## Команды проверки

```bash
npm run typecheck
npm run build
npm test
```

## Профиль и API

- `POST /api/guest` — создать гостевой профиль; токен нужно сохранить.
- `POST /api/account/upgrade` — защитить текущий гостевой профиль логином и паролем (`Authorization: Bearer <token>`, body: `{ "username": "player_01", "password": "at-least-10-characters" }`). Логин: 3–20 символов `a-z`, `0-9`, `_`; пароль: 10–128 символов.
- `POST /api/account/login` — вход по логину и паролю; возвращает новый токен. При входе токен ротируется, старый токен становится недействительным.
- `GET /api/me` — получить свой профиль (`Authorization: Bearer <token>`).
- `PATCH /api/me` — изменить никнейм.
- `POST /api/cases/open` — открыть кейс на сервере.
- `POST /api/me/equip` — экипировать скин, тело `{ "skinId": "..." }`.
- `POST /api/me/unequip` — снять скин, тело `{ "weaponId": "rifle" }`.
- `GET /api/leaderboard` — таблица лидеров.

## Ограничения прототипа

- Профили хранятся в JSON-файле, а не PostgreSQL; атомарное переименование снижает риск частичной записи, но не обеспечивает транзакции и конкурентный доступ нескольких процессов.
- Гостевой токен фактически является ключом доступа; потеря токена означает потерю доступа к профилю, пока профиль не привязан к паролю.
- Аккаунты всё ещё хранятся в локальном JSON-файле, не PostgreSQL; для публичного сервера нужны HTTPS, PostgreSQL-транзакции, общая rate-limit инфраструктура и процесс восстановления доступа. Лимиты API и входа действуют только в памяти одного процесса и могут обходиться распределением запросов по нескольким инстансам; перед горизонтальным масштабированием нужен общий Redis limiter.
- Экипировка хранится отдельно для каждого оружия, но в текущей тренировочной сцене используется упрощённый общий силуэт оружия с материалом выбранного скина.
- Онлайн-физика, столкновения и синхронизация всё ещё прототипные; не следует считать сервер готовым к публичному соревновательному использованию.
- Зависимости и автоматические тесты в среде сборки не удалось проверить из-за тайм-аута `npm install`. После загрузки на хостинг запусти команды проверки выше.


## Deploy on Render (GitHub auto-deploy + WebSocket)

The repository includes `render.yaml` for a **single Render Web Service**. It serves the built React/Vite website, the `/api/*` endpoints, and Socket.IO from the same public URL. Socket.IO negotiates WebSocket automatically and falls back to HTTP long-polling if necessary. In production the client uses `window.location.origin`, so do not set `VITE_SERVER_URL` to `localhost`.

1. Push the repository to GitHub.
2. In Render choose **New → Blueprint**, connect this repository, and apply `render.yaml` (or configure the existing Web Service with the same commands).
3. Build command: `npm install && npm run build`; start command: `npm start`; health check path: `/health`.
4. Ensure `NODE_ENV=production` and `SHATKI_DATA_FILE=/var/data/profiles.json` are set. The Blueprint mounts a persistent disk at `/var/data`.
5. After deployment, open `https://YOUR-SERVICE.onrender.com/health`; expect JSON with `"ok": true`. Then open the website and check the connection status in Online Lobby.

**Important:** the Blueprint declares a persistent disk, which requires a paid Render web-service plan. If you use a free ephemeral service without a disk, JSON profile data can be lost on restart or redeploy. For a durable production economy, move profiles/inventory to PostgreSQL. Remove `VITE_SERVER_URL` from the Render environment variables (or leave it unset); a `localhost` value will point visitors to their own device, not your server.


## v1.6 deployment and safety notes

- API endpoints that create guest profiles, upgrade accounts, open cases, and change equipment have per-IP rate limits.
- Socket.IO applies per-connection burst limits to movement, shooting, and other events. If a client sends too many events, the event is rejected by Socket.IO middleware; clients should avoid sending movement at excessive frequency.
- JSON persistence writes a temporary snapshot then renames it over the target file. Keep `SHATKI_DATA_FILE` on Render's persistent disk (for example `/var/data/profiles.json`).
- SIGTERM/SIGINT trigger graceful shutdown. Render's HTTPS terminates TLS; do not expose the Node port directly without HTTPS.
- Rate limiting is intentionally single-process. Do not scale this JSON-backed prototype to multiple instances; use PostgreSQL transactions and shared rate limiting first.


## v2.0 — синхронизация движения

## v1.9 — цикл раундов и обновление лобби
- Автоматический переход к следующему раунду в обоих режимах.
- Обновление списка комнат через Socket.IO.
- Исправлена обработка повторного присоединения к текущей комнате.

## v1.7 — подбор матчей

- Добавлены кнопки «Быстрая игра» для Deathmatch и Bomb Defusal.
- Сервер сначала заполняет самую старую активную комнату выбранного режима, в которой меньше 10 игроков.
- При отсутствии свободной комнаты автоматически создаётся новый матч.
- Список комнат по-прежнему доступен для ручного подключения.
- Ответ подключения содержит начальное состояние матча, чтобы HUD не ждал первого движения для отображения игроков.
- PostgreSQL не добавлялся: профили остаются в JSON, как и раньше.
