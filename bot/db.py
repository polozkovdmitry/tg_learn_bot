import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
    user_id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    tz_min INTEGER NOT NULL DEFAULT 180,
    last_alert_utc INTEGER NOT NULL DEFAULT 0
);
-- one table for deadlines and aims so ids never collide
CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(user_id),
    kind TEXT NOT NULL CHECK(kind IN ('dd','aim')),
    text TEXT NOT NULL,
    due_utc INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','prolonged','done','deleted')),
    next_daily_utc INTEGER
);
CREATE TABLE IF NOT EXISTS reminders(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    stage TEXT NOT NULL,
    fire_utc INTEGER NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    acked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rem_due ON reminders(sent, fire_utc);
"""


def connect(path: str) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    return con


def ensure_user(con, user_id: int):
    con.execute("INSERT OR IGNORE INTO users(user_id, chat_id) VALUES(?,?)", (user_id, user_id))
    con.commit()


def get_user(con, user_id: int):
    return con.execute("SELECT * FROM users WHERE user_id=?", (user_id,)).fetchone()


def add_item(con, user_id, kind, text, due, reminders) -> int:
    cur = con.execute("INSERT INTO items(user_id,kind,text,due_utc) VALUES(?,?,?,?)", (user_id, kind, text, due))
    item_id = cur.lastrowid
    con.executemany(
        "INSERT INTO reminders(item_id,stage,fire_utc) VALUES(?,?,?)",
        [(item_id, s, t) for s, t in reminders],
    )
    con.commit()
    return item_id


def list_items(con, user_id, kind=None, now=None):
    now = now or int(time.time())
    q = ("SELECT * FROM items WHERE user_id=? AND status IN ('active','prolonged') "
         "AND (kind='aim' OR due_utc>=?)")
    args = [user_id, now]
    if kind:
        q += " AND kind=?"
        args.append(kind)
    return con.execute(q + " ORDER BY due_utc", args).fetchall()


def delete_item(con, user_id, item_id) -> bool:
    cur = con.execute(
        "UPDATE items SET status='deleted' WHERE id=? AND user_id=? AND status IN ('active','prolonged')",
        (item_id, user_id),
    )
    con.commit()
    return cur.rowcount > 0


def due_reminders(con, now):
    return con.execute(
        "SELECT r.*, i.user_id, i.kind, i.text, i.due_utc, u.chat_id, u.tz_min FROM reminders r "
        "JOIN items i ON i.id=r.item_id JOIN users u ON u.user_id=i.user_id "
        "WHERE r.sent=0 AND r.fire_utc<=? AND i.status IN ('active','prolonged') ORDER BY r.fire_utc",
        (now,),
    ).fetchall()


def pending_reminders(con, user_id):
    """Sent but not acknowledged reminders of live items."""
    return con.execute(
        "SELECT r.*, i.kind, i.text, i.due_utc FROM reminders r JOIN items i ON i.id=r.item_id "
        "WHERE i.user_id=? AND r.sent=1 AND r.acked=0 AND i.status IN ('active','prolonged') "
        "ORDER BY r.fire_utc",
        (user_id,),
    ).fetchall()


def mark_sent(con, reminder_id, user_id, now):
    con.execute("UPDATE reminders SET sent=1 WHERE id=?", (reminder_id,))
    con.execute("UPDATE users SET last_alert_utc=? WHERE user_id=?", (now, user_id))
    con.commit()


def touch_alert(con, user_id, now):
    con.execute("UPDATE users SET last_alert_utc=? WHERE user_id=?", (now, user_id))
    con.commit()


def ack(con, user_id, reminder_id=None, all_=False) -> int:
    base = ("UPDATE reminders SET acked=1 WHERE acked=0 AND stage!='due' AND item_id IN "
            "(SELECT id FROM items WHERE user_id=?)")
    if all_:
        cur = con.execute(base, (user_id,))
    else:
        cur = con.execute(base + " AND id=?", (user_id, reminder_id))
    con.commit()
    return cur.rowcount


def get_item(con, user_id, item_id):
    return con.execute("SELECT * FROM items WHERE id=? AND user_id=?", (item_id, user_id)).fetchone()


def resolve_due_prompt(con, item_id, status, next_daily=None):
    con.execute("UPDATE items SET status=?, next_daily_utc=? WHERE id=?", (status, next_daily, item_id))
    con.execute("UPDATE reminders SET acked=1 WHERE item_id=? AND stage='due'", (item_id,))
    con.commit()


def due_dailies(con, now):
    """Prolonged aims whose daily 11:00 reminder is due and has no unacked daily open."""
    return con.execute(
        "SELECT i.*, u.chat_id, u.tz_min FROM items i JOIN users u ON u.user_id=i.user_id "
        "WHERE i.status='prolonged' AND i.next_daily_utc<=? "
        "AND NOT EXISTS(SELECT 1 FROM reminders r WHERE r.item_id=i.id AND r.stage='daily' AND r.acked=0)",
        (now,),
    ).fetchall()


def add_daily(con, item_id, now, next_daily):
    cur = con.execute("INSERT INTO reminders(item_id,stage,fire_utc) VALUES(?,?,?)", (item_id, "daily", now))
    con.execute("UPDATE items SET next_daily_utc=? WHERE id=?", (next_daily, item_id))
    con.commit()
    return cur.lastrowid
