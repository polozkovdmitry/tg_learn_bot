# tg_learn_bot

A personal Telegram bot for studying: it stores deadlines and learning aims in a local SQLite database and keeps reminding you until you confirm each reminder.

It runs on your own Mac (long polling, no public server needed) and is kept alive by a macOS LaunchAgent.

## Commands

Times are GMT+3.

| Command | What it does |
| --- | --- |
| `/dd <name> yyyy mm dd hh mm` | Add a deadline, e.g. `/dd Thesis draft 2026 11 03 18 00` |
| `/aim <text> yyyy mm dd hh mm` | Add a learning aim |
| `/list`, `/dds`, `/aims` | Show all active items, only deadlines, or only aims |
| `/del <id>` | Delete an item |

The date is the last five words of the message. The year must be four digits starting with `20`. Deadlines and aims share one ID space, so an ID is unique across both.

## Reminders

- **Deadlines:** 2 days, 1 day and 3 hours before the due time.
- **Aims:** 7, 2 and 1 days before, at 11:00. At the due time the bot asks **Done / Prolong**. A prolonged aim reminds you every day at 11:00 until you `/del` it.
- Every reminder has an **OK** button. Until all reminders are confirmed, the bot sends one merged list of unconfirmed alerts every 10 minutes.
- Reminders that fell due while the Mac was off or asleep are sent on startup.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Find your numeric Telegram user ID (for example with @userinfobot).
3. Create the environment:

   ```sh
   python3 -m venv .venv
   .venv/bin/pip install -r requirements.txt
   cp .env.example .env   # then fill in BOT_TOKEN and ALLOWED_USER_IDS
   ```

4. Run it in the foreground to test:

   ```sh
   .venv/bin/python -m bot.main
   ```

## Run automatically (macOS)

```sh
deploy/install.sh
```

This installs a LaunchAgent that starts the bot at login and restarts it if it exits. [deploy/run.sh](deploy/run.sh) delays the start until the Mac has been up for 15 minutes (only relevant right after boot). Logs go to `data/bot.log`.

If the project lives under `~/Documents`, `~/Desktop` or `~/Downloads`, macOS blocks background jobs from reading it. Either keep the project elsewhere (for example `~/Developer`) or grant Full Disk Access to `/bin/zsh` and to the real Python binary (`.venv/bin/python` resolved with `realpath`). The second option breaks when Homebrew upgrades Python.

To stop it: `launchctl bootout gui/$(id -u)/com.dp.tglearnbot`.

## Layout

```
bot/main.py       handlers and the reminder loop
bot/db.py         SQLite schema and queries
bot/parsing.py    date parsing and formatting
bot/schedule.py   reminder times
deploy/           launchd wrapper and installer
data/             database and logs (git-ignored)
```

Every row is tied to a `user_id`, and an allowlist from `.env` decides who may use the bot, so more users can be added later without a schema change.

## Planned

A Telegram Mini App with simple flashcards (key:value cards, random review, swipe left to drop a card from the session, swipe right to keep it), hosted on GitHub Pages and stored in Telegram CloudStorage.
