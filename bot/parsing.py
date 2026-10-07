from datetime import datetime, timedelta, timezone

DEFAULT_TZ_MIN = 180  # GMT+3


class ParseError(ValueError):
    pass


def parse_text_and_date(args: list[str], tz_min: int) -> tuple[str, int]:
    """'Thesis draft 2026 11 03 18 00' -> ('Thesis draft', due_utc_epoch)."""
    if len(args) < 6:
        raise ParseError("Need: <name> yyyy mm dd hh mm")
    year, month, day, hour, minute = args[-5:]
    if not (year.isdigit() and len(year) == 4 and year.startswith("20")):
        raise ParseError("Year must be 4 digits starting with 20, e.g. 2026")
    if not all(p.isdigit() for p in (month, day, hour, minute)):
        raise ParseError("Month, day, hour, minute must be numbers")
    name = " ".join(args[:-5]).strip()
    if not name:
        raise ParseError("Name is empty")
    tz = timezone(timedelta(minutes=tz_min))
    try:
        due = datetime(int(year), int(month), int(day), int(hour), int(minute), tzinfo=tz)
    except ValueError as e:
        raise ParseError(f"Invalid date: {e}")
    return name, int(due.timestamp())


def fmt(epoch: int, tz_min: int) -> str:
    tz = timezone(timedelta(minutes=tz_min))
    return datetime.fromtimestamp(epoch, tz).strftime("%Y-%m-%d %H:%M")
