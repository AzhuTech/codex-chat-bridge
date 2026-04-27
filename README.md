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
export CODEX_APPROVALS_REVIEWER=auto_review
export CODEX_REASONING_EFFORT=medium
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
  -d '{"transport":"telegram","chatId":"1038609497","threadId":"019d...","name":"main","cwd":"/Users/you/project","model":"gpt-5.5","effort":"medium"}'
```

After binding, normal Telegram messages sent to the bot are delivered to that Codex thread.
Messages from the same Telegram chat are queued in order. If the thread is idle, the bridge starts a new turn; if the thread already has an active turn, it uses Codex app-server `turn/steer` so Telegram input is delivered to the active session instead of waiting forever.

While a Telegram message is being processed, the bot uses Telegram's `typing` chat action instead of sending an acknowledgement message for every input. The chat receives only the final Codex response or an error.

## Codex Desktop Visibility

The bridge writes to the Codex app-server thread/session data. Codex Desktop may not live-refresh turns that were added externally through app-server. If a Telegram-delivered message does not appear immediately in the open Desktop window, restart Codex Desktop or reopen the thread; the persisted conversation should then include the bridge-delivered user and assistant turns.

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
- `/status` - show current session status, including bound thread, cwd, model, thinking depth, and Codex thread state.
- `/new` - create and bind a new Codex thread using configured defaults.
- `/models` - list models reported by the connected Codex app-server.
- `/model` - show the current model.
- `/model <model>` - set the model for future new turns in this chat.
- `/model default` - reset the chat to the bridge default model.
- `/thinking` - show the current reasoning effort.
- `/thinking <none|minimal|low|medium|high|xhigh>` - set reasoning effort for future new turns in this chat.
- `/effort <none|minimal|low|medium|high|xhigh>` - alias for `/thinking`.
- `/thinking default` - reset the chat to the bridge default reasoning effort.
- `/cwd` - show the bound working directory.
- `/cwd <absolute-host-path>` - set the host working directory for future new turns.

Model, thinking depth, and cwd changes are persisted per Telegram chat binding. They apply when the bridge starts a new Codex turn. If the Codex thread already has an active turn, Telegram input is delivered with `turn/steer`; Codex app-server does not accept model or thinking changes for an already-active turn.

## Security Notes

- Only chats listed in `security.allowedChatIds` may issue Codex instructions. If the list is empty, no chat is allowed until bound through the admin API.
- The bridge stores chat/thread mappings in `data/state.json`.
- The bridge should be exposed only on localhost or a trusted network.
