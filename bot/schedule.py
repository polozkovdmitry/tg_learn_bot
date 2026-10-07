from datetime import datetime, timedelta, timezone

REMIND_HOUR = 11


def _at_11(local_date, tz) -> int:
    return int(datetime(local_date.year, local_date.month, local_date.day, REMIND_HOUR, tzinfo=tz).timestamp())


def next_daily_11(after: int, tz_min: int) -> int:
    tz = timezone(timedelta(minutes=tz_min))
    d = datetime.fromtimestamp(after, tz).date()
    t = _at_11(d, tz)
    return t if t > after else _at_11(d + timedelta(days=1), tz)


def plan(kind: str, due: int, tz_min: int, now: int) -> list[tuple[str, int]]:
    """Reminder (stage, fire_utc) pairs that are still in the future."""
    tz = timezone(timedelta(minutes=tz_min))
    if kind == "dd":
        stages = [("2d", due - 2 * 86400), ("1d", due - 86400), ("3h", due - 3 * 3600)]
    else:
        due_date = datetime.fromtimestamp(due, tz).date()
        stages = [(f"{n}d", _at_11(due_date - timedelta(days=n), tz)) for n in (7, 2, 1)]
        stages.append(("due", due))
    return [(s, t) for s, t in stages if t > now]
