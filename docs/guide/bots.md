# Bots (Telegram + Discord)

Idle Hands supports Telegram and Discord frontends for remote operation.

## Security-first defaults

Before enabling bots:

- restrict `allowed_users` to trusted IDs only
- keep bots on least-privilege accounts
- avoid running as root
- use explicit `allowed_dirs` to limit filesystem scope

## Telegram

Start:

```bash
IDLEHANDS_TG_TOKEN=123456:ABC-DEF idlehands bot telegram
```

Recommended BotFather settings:

- disable groups unless explicitly needed
- disable inline mode
- keep group privacy enabled

Common commands:

- `/new`, `/cancel`, `/status`
- `/dir <path>`, `/model`, `/approval <mode>`, `/mode <mode>`
- `/changes`, `/undo`, `/vault <query>`, `/compact`
- `/hosts`, `/backends`, `/rtmodels`, `/rtstatus`, `/switch <model-id>`

## Discord

Start:

```bash
IDLEHANDS_DISCORD_TOKEN=... idlehands bot discord
```

Recommended configuration:

- restrict `allowed_users`
- set `guild_id` when using guild mode
- keep DM-only mode unless channel operation is required

Common commands:

- `/new`, `/cancel`, `/status`
- `/dir <path>`, `/model`, `/approval <mode>`, `/mode <mode>`
- `/changes`, `/undo`, `/vault <query>`, `/compact`
- `/hosts`, `/backends`, `/rtmodels`, `/rtstatus`, `/switch <model-id>`

Set `allow_guilds: true` to enable guild channels.

## Reply threading behavior

By default, bot responses are sent as normal messages (not native threaded replies).

Enable native reply threading if you want quote/reply coupling:

```json
{
  "bot": {
    "telegram": { "reply_to_user_messages": true },
    "discord": { "reply_to_user_messages": true }
  }
}
```

## Service management

Use systemd user service commands:

```bash
idlehands service install
idlehands service start
idlehands service status
idlehands service logs
idlehands service stop
idlehands service restart
idlehands service uninstall
```

::: warning Linger requirement
User-level services stop on logout unless linger is enabled:

```bash
sudo loginctl enable-linger <user>
```
:::
