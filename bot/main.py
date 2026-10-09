import logging
import os
import time
from pathlib import Path

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes

from . import db
from .parsing import DEFAULT_TZ_MIN, ParseError, fmt, parse_text_and_date
from .schedule import next_daily_11, plan

ROOT = Path(__file__).resolve().parent.parent
NAG_SECONDS = 600
TICK_SECONDS = 30
KIND_LABEL = {"dd": "Deadline", "aim": "Aim"}
STAGE_LABEL = {"2d": "in 2 days", "1d": "in 1 day", "3h": "in 3 hours", "7d": "in a week",
               "due": "is due now", "daily": "is still open"}

log = logging.getLogger("bot")


def load_env():
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def con_of(ctx):
    return ctx.application.bot_data["db"]


def allowed(ctx, user_id: int) -> bool:
    return user_id in ctx.application.bot_data["allowed"]


def kb_for(reminder) -> InlineKeyboardMarkup:
    if reminder["stage"] == "due":
        row = [InlineKeyboardButton("✅ Done", callback_data=f"done:{reminder['item_id']}"),
               InlineKeyboardButton("⏩ Prolong", callback_data=f"prol:{reminder['item_id']}")]
    else:
        row = [InlineKeyboardButton("OK", callback_data=f"ok:{reminder['id']}")]
    return InlineKeyboardMarkup([row])


def reminder_text(r, tz_min) -> str:
    return (f"⏰ {KIND_LABEL[r['kind']]} #{r['item_id']} {STAGE_LABEL[r['stage']]}\n"
            f"{r['text']}\nDue: {fmt(r['due_utc'], tz_min)} (GMT+{tz_min // 60})")


async def guard(update: Update, ctx) -> bool:
    uid = update.effective_user.id
    if not allowed(ctx, uid):
        return False
    db.ensure_user(con_of(ctx), uid)
    return True


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    await update.message.reply_text(
        "/dd <name> yyyy mm dd hh mm — add deadline\n"
        "/aim <text> yyyy mm dd hh mm — add aim\n"
        "/list, /dds, /aims — show active items\n"
        "/del <id> — delete item\n/app — open flashcards\nTimes are GMT+3.")


async def cmd_app(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    url = os.environ.get("MINIAPP_URL")
    if not url:
        await update.message.reply_text("MINIAPP_URL is not set in .env.")
        return
    await update.message.reply_text(
        "Flashcards", reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("📇 Open", web_app=WebAppInfo(url))]]))


async def _add(update: Update, ctx, kind: str):
    if not await guard(update, ctx):
        return
    con, uid = con_of(ctx), update.effective_user.id
    tz = db.get_user(con, uid)["tz_min"]
    try:
        text, due = parse_text_and_date(ctx.args, tz)
    except ParseError as e:
        await update.message.reply_text(f"❌ {e}\nUsage: /{kind} <text> yyyy mm dd hh mm")
        return
    item_id = db.add_item(con, uid, kind, text, due, plan(kind, due, tz, int(time.time())))
    await update.message.reply_text(f"Saved {KIND_LABEL[kind]}. Id #{item_id}\nDesc: {text}\nDue {fmt(due, tz)}")


async def cmd_dd(update, ctx):
    await _add(update, ctx, "dd")


async def cmd_aim(update, ctx):
    await _add(update, ctx, "aim")


async def _show(update: Update, ctx, kind):
    if not await guard(update, ctx):
        return
    con, uid = con_of(ctx), update.effective_user.id
    tz = db.get_user(con, uid)["tz_min"]
    items = db.list_items(con, uid, kind)
    if not items:
        await update.message.reply_text("Nothing active.")
        return
    lines = [f"#{i['id']} [{i['kind']}] {fmt(i['due_utc'], tz)}"
             f"{' (prolonged)' if i['status'] == 'prolonged' else ''} — {i['text']}" for i in items]
    await update.message.reply_text("\n".join(lines))


async def cmd_list(update, ctx):
    await _show(update, ctx, None)


async def cmd_dds(update, ctx):
    await _show(update, ctx, "dd")


async def cmd_aims(update, ctx):
    await _show(update, ctx, "aim")


async def cmd_del(update: Update, ctx):
    if not await guard(update, ctx):
        return
    if len(ctx.args) != 1 or not ctx.args[0].isdigit():
        await update.message.reply_text("Usage: /del <id>")
        return
    ok = db.delete_item(con_of(ctx), update.effective_user.id, int(ctx.args[0]))
    await update.message.reply_text("Deleted." if ok else "No active item with that id.")


async def on_button(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    uid = q.from_user.id
    if not allowed(ctx, uid):
        await q.answer()
        return
    con = con_of(ctx)
    action, _, arg = q.data.partition(":")
    note = "✅ OK"
    if action == "ok":
        msg_ids = db.ack(con, uid, int(arg))
        chat_id = q.message.chat_id
        for mid in set(msg_ids) | {q.message.message_id}:
            try:
                await ctx.bot.delete_message(chat_id, mid)
            except Exception:
                pass  # already deleted or older than 48h
        await q.answer("✅ OK")
        return
    elif action in ("done", "prol"):
        item = db.get_item(con, uid, int(arg))
        if not item or item["status"] not in ("active", "prolonged"):
            await q.answer("Item no longer active")
            return
        if action == "done":
            db.resolve_due_prompt(con, item["id"], "done")
            note = "✅ Done"
        else:
            tz = db.get_user(con, uid)["tz_min"]
            db.resolve_due_prompt(con, item["id"], "prolonged", next_daily_11(int(time.time()), tz))
            note = "⏩ Prolonged — daily at 11:00 until /del"
    await q.answer(note)
    try:
        await q.edit_message_text(f"{q.message.text}\n\n{note}")
    except Exception:
        pass


async def tick(ctx: ContextTypes.DEFAULT_TYPE):
    con, now = con_of(ctx), int(time.time())
    for it in db.due_dailies(con, now):
        db.add_daily(con, it["id"], now, next_daily_11(now, it["tz_min"]))
    for r in db.due_reminders(con, now):
        try:
            msg = await ctx.bot.send_message(r["chat_id"], reminder_text(r, r["tz_min"]), reply_markup=kb_for(r))
        except Exception:
            log.exception("send failed for reminder %s", r["id"])
            continue
        db.mark_sent(con, r["id"], r["user_id"], now, msg.message_id)
    for u in con.execute("SELECT * FROM users").fetchall():
        if now - u["last_alert_utc"] < NAG_SECONDS:
            continue
        pend = db.pending_reminders(con, u["user_id"])
        if not pend:
            continue
        rows, lines = [], []
        for r in pend[:20]:
            lines.append(f"• {KIND_LABEL[r['kind']]} #{r['item_id']} {STAGE_LABEL[r['stage']]}: {r['text']} "
                         f"(due {fmt(r['due_utc'], u['tz_min'])})")
            rows.append(kb_for({"stage": r["stage"], "item_id": r["item_id"], "id": r["id"]}).inline_keyboard[0])
        try:
            if u["nag_msg_id"]:
                try:
                    await ctx.bot.delete_message(u["chat_id"], u["nag_msg_id"])
                except Exception:
                    pass
            msg = await ctx.bot.send_message(u["chat_id"], "🔔 Unconfirmed alerts:\n" + "\n".join(lines),
                                             reply_markup=InlineKeyboardMarkup(rows))
            db.touch_alert(con, u["user_id"], now, msg.message_id)
        except Exception:
            log.exception("nag failed for user %s", u["user_id"])


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # request URLs contain the bot token
    load_env()
    token = os.environ["BOT_TOKEN"]
    allowed_ids = {int(x) for x in os.environ["ALLOWED_USER_IDS"].split(",") if x.strip()}
    (ROOT / "data").mkdir(exist_ok=True)
    con = db.connect(str(ROOT / "data" / "bot.sqlite"))
    for uid in allowed_ids:
        db.ensure_user(con, uid)

    app = Application.builder().token(token).build()
    app.bot_data.update(db=con, allowed=allowed_ids)
    for name, fn in [("start", cmd_start), ("dd", cmd_dd), ("aim", cmd_aim), ("list", cmd_list),
                     ("dds", cmd_dds), ("aims", cmd_aims), ("del", cmd_del), ("app", cmd_app)]:
        app.add_handler(CommandHandler(name, fn))
    app.add_handler(CallbackQueryHandler(on_button))
    app.job_queue.run_repeating(tick, interval=TICK_SECONDS, first=1)
    app.run_polling()


if __name__ == "__main__":
    main()
