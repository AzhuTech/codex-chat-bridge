# codex-chat-bridge

Relay Telegram chats to existing Codex app-server threads.

This service does **not** run Codex itself. It only forwards chat messages to a running Codex app-server endpoint, then sends Codex responses back to chat.

## Status

MVP transport: Telegram.

MVP Codex backend: `codex app-server` WebSocket JSON-RPC.

## Start Codex app-server

```bash
codex app-server --listen ws://127.0.0.1:17374
```

## Configure

Create `config/config.json` from `config/config.example.json`, or use environment variables:

```bash
export TELEGRAM_BOT_TOKEN=...
export BRIDGE_ADMIN_TOKEN=$(openssl rand -hex 24)
export CODEX_REMOTE_URL=ws://127.0.0.1:17374
```

## Start bridge locally

```bash
npm start
```

## Start bridge with Docker

```bash
docker compose up -d
```

For Docker, point `CODEX_REMOTE_URL` at `ws://host.docker.internal:17374`.

## Bind a Telegram chat to a Codex thread

```bash
curl -X POST http://127.0.0.1:8088/api/bind \
  -H "authorization: Bearer $BRIDGE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"transport":"telegram","chatId":"1038609497","threadId":"019d...","name":"main"}'
```

After binding, normal Telegram messages sent to the bot become user turns in that Codex thread.

## Notify a channel

```bash
curl -X POST http://127.0.0.1:8088/api/notify \
  -H "authorization: Bearer $BRIDGE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"channel":"automation","title":"Done","text":"Automation finished."}'
```

## Telegram commands

- `/start` - show bridge status for this chat.
- `/help` - show help.
- `/status` - show current binding.
- `/new` - create and bind a new Codex thread.

## Security Notes

- Only chats listed in `security.allowedChatIds` may issue Codex instructions. If the list is empty, no chat is allowed until bound through the admin API.
- The bridge stores chat/thread mappings in `data/state.json`.
- The bridge should be exposed only on localhost or a trusted network.
