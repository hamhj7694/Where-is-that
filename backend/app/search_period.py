from __future__ import annotations

import calendar
import re
from datetime import date, datetime, timedelta, timezone

from . import lostfound_codes

KST = timezone(timedelta(hours=9))
DEFAULT_MONTHS = 2
MAX_MONTHS = 6
LOSS_DATE_BUFFER_DAYS = 10


def _shift_months(value: date, months: int) -> date:
    year, month = divmod(value.year * 12 + value.month - 1 + months, 12)
    if year < 1:
        return date.min
    if year > date.max.year:
        return date.max
    day = min(value.day, calendar.monthrange(year, month + 1)[1])
    return date(year, month + 1, day)


def _iso_date(value: object) -> date | None:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _query_dates(query: str, current: date) -> tuple[date | None, date | None]:
    dates = []
    for match in re.finditer(r"(?<!\d)(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})(?!\d)", query):
        try:
            dates.append(date(*map(int, match.groups())))
        except ValueError:
            continue
    if dates:
        return dates[0], dates[-1]
    if "지난주" in query or "지난 주" in query:
        last_monday = current - timedelta(days=current.weekday() + 7)
        return last_monday, last_monday + timedelta(days=6)
    if "지난달" in query or "지난 달" in query:
        end = current.replace(day=1) - timedelta(days=1)
        return end.replace(day=1), end
    if match := re.search(r"(\d{1,2})\s*(개월|달)\s*(?:쯤\s*)?전", query):
        middle = _shift_months(current, -int(match[1]))
        if middle > date.min + timedelta(days=7):
            return middle - timedelta(days=7), middle + timedelta(days=7)
    relative = {"그저께": 2, "그제": 2, "어제": 1, "오늘": 0, "금일": 0}
    days = [current - timedelta(days=relative[word]) for word in re.findall("|".join(relative), query)]
    if days:
        return days[0], days[-1]
    return None, None


def resolve_period(filters: dict | None, hints: dict | None, today: date | None = None, *, query: str = "") -> dict:
    current = today or datetime.now(KST).date()
    filters = filters or {}
    hints = hints or {}
    explicit = (_iso_date(filters.get("from")), _iso_date(filters.get("to")))
    inferred = (_iso_date(hints.get("fromDate")), _iso_date(hints.get("toDate")))
    if query:
        parsed = _query_dates(query, current)
        if any(parsed):
            inferred = parsed
        elif not re.search(r"(지난|이번|저번|최근|며칠|얼마|오래|그저께|그제|\d\s*(?:년|월|일|주|달)|(?:한|두|세|몇)\s*(?:달|주|개월))", query):
            inferred = (None, None)
    source = "explicit" if any(explicit) else "inferred" if any(inferred) else "default"
    start, end = explicit if source == "explicit" else inferred
    if start and end and start > end:
        start, end = end, start
    if source == "inferred":
        anchor = min(start or end or current, current)
        buffer = min(LOSS_DATE_BUFFER_DAYS, (anchor - date.min).days)
        start = anchor - timedelta(days=buffer)
        # 오래된 분실일은 검색 범위에 남기고, 그 시점부터 가능한 최신 습득일까지 확인한다.
        latest = _shift_months(start, MAX_MONTHS)
        return {
            "from": start.isoformat(),
            "to": min(current, latest).isoformat(),
            "basis": source,
            "clipped": latest < current,
            "dateBufferDays": buffer,
        }
    end = min(end or current, current)
    start = min(start or _shift_months(end, -DEFAULT_MONTHS), end)
    earliest = _shift_months(end, -MAX_MONTHS)
    return {
        "from": max(start, earliest).isoformat(),
        "to": end.isoformat(),
        "basis": source,
        "clipped": start < earliest,
    }


def category_priority(hint: object, query: str, keywords: list[str]) -> dict[str, str]:
    # 모델 분류와 원문의 마지막 품목어는 별도 조회의 우선순위로만 쓴다.
    if isinstance(hint, str) and (params := lostfound_codes.category_params(hint)):
        return params
    for word in [*reversed(re.findall(r"[가-힣A-Za-z0-9]+", query)), *reversed(keywords)]:
        if params := lostfound_codes.category_params(word):
            return params
    return {}
