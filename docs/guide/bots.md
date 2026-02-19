# Bots (Telegram + Discord)

## Telegram

```bash
IDLEHANDS_TG_TOKEN=123456:ABC-DEF idlehands bot telegram
```

Recommended hardening:
- Disable groups and inline mode in BotFather
- Keep privacy on
- Restrict `allowed_users`
- Do not run as root

Telegram bot commands:
- `/reset`, `/cancel`, `/status`
- `/dir <path>`, `/model <name>`, `/approval <mode>`, `/mode <mode>`
- `/changes`, `/undo`, `/vault <query>`, `/compact`
- `/hosts`, `/backends`, `/rtmodels`, `/rtstatus`, `/switch <model-id>`

## Discord

```bash
IDLEHANDS_DISCORD_TOKEN=... idlehands bot discord
```

Recommended hardening:
- Restrict `allowed_users` to trusted Discord IDs
- Set `guild_id` to lock to one server
- Do not run as root

Discord bot commands:
- `/reset`, `/cancel`, `/status`
- `/hosts`, `/backends`, `/rtmodels`, `/rtstatus`, `/switch <model-id>`

Set `allow_guilds: true` to enable guild channels (default is DM-only).

## Service management

The setup wizard can install a systemd user service that runs `idlehands bot --all`.

```bash
idlehands service status
idlehands service start
idlehands service stop
idlehands service restart
idlehands service logs
idlehands service install
idlehands service uninstall
```

::: warning Linger requirement
User-level services stop on logout unless linger is enabled:

```bash
loginctl enable-linger
```
:::
