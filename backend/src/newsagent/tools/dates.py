"""区分发布时间、事件日期与信息截止时间。"""

import calendar
import re
from datetime import UTC, date, datetime, timedelta
from email.utils import parsedate_to_datetime

from ..contracts import models as m


def publication(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        instant = datetime.fromisoformat(value.strip())
    except ValueError:
        try:
            instant = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
    return (
        instant.replace(tzinfo=instant.tzinfo or UTC)
        .astimezone(UTC)
        .isoformat()
        .replace(
            "+00:00",
            "Z",
        )
    )


def parse_date_text(text: str, anchor: datetime | None) -> datetime | None:
    cleaned = re.sub(r"^(?:early |mid[- ]|late )", "", text, flags=re.IGNORECASE).replace(",", "")
    for pattern in ("%B %d %Y", "%b %d %Y", "%d %B %Y", "%d %b %Y", "%B %Y", "%b %Y"):
        try:
            return datetime.strptime(cleaned, pattern).replace(tzinfo=UTC)
        except ValueError:
            continue
    offsets = {"today": 0, "yesterday": -1, "tomorrow": 1, "当天": 0, "昨天": -1, "明天": 1}
    if anchor is not None and text.casefold() in offsets:
        return anchor + timedelta(days=offsets[text.casefold()])
    try:
        from dateparser import parse  # type: ignore
    except ImportError:
        return None
    return parse(text, settings={"RELATIVE_BASE": anchor.replace(tzinfo=None)} if anchor else {})


STATE_PREFIX = re.compile(r"^(?:截至|截止|直至|迄今|as of|until|through)\s*", re.IGNORECASE)
DATE_SEPARATOR = re.compile(r"\s*(?:[、,，;；/]|和|及|与|\band\b)\s*")
HAS_YEAR = re.compile(r"\d{4}")
HAS_MONTH_WORD = re.compile(r"[A-Za-z]|月|天")
MIN_YEAR, MAX_YEAR = 1000, 2200


def event_date(text: str | None, anchor: str | None = None) -> m.DateRef | None:
    """把模型给出的事件日期文本解析为 DateRef；解析不出可信日期时返回 None。

    - "截至某日 / as of ..." 描述的是某时点的状态而不是事件，不作为事件日期；
    - 含多个日期（"1900年、2000年"）时只取第一个；
    - 解析库的结果必须落在合理年份内，且原文要么带四位年份、要么带月份词，
      防止 "26-10-08" 之类被猜成公元 26 年或错位日期。
    """
    if not text:
        return None
    text = text.strip()
    if STATE_PREFIX.match(text):
        return None
    parts: list[str] = [p for p in DATE_SEPARATOR.split(text) if p]
    if len(parts) > 1 and sum(bool(HAS_YEAR.search(p)) for p in parts) > 1:
        text = parts[0]
    result = _event_date(text, anchor)
    if result is None or not MIN_YEAR <= int(result.start[:4]) <= MAX_YEAR:
        return None
    return result


def _event_date(text: str, anchor: str | None) -> m.DateRef | None:
    if re.fullmatch(r"\d{4}年?", text):
        year = text[:4]
        return (
            m.DateRef(start=f"{year}-01-01", end=f"{year}-12-31", precision="year", text=text)
            if int(year)
            else None
        )
    bounds = re.split(r"\s+(?:to|–|—|至)\s+", text, maxsplit=1)
    if len(bounds) == 2:
        lower, upper = (_event_date(value, anchor) for value in bounds)
        if lower and upper and lower.start <= upper.end:
            return m.DateRef(start=lower.start, end=upper.end, precision="range", text=text)
    month = re.fullmatch(r"(\d{4})[-年](\d{1,2})月?", text)
    normalized = re.sub(r"(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日", r"\1-\2-\3", text)
    canonical = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", normalized)
    if canonical:
        year, number, day_number = map(int, canonical.groups())
        normalized = f"{year:04}-{number:02}-{day_number:02}"
    base = datetime.fromisoformat(anchor) if anchor else None
    if month:
        try:
            parsed = datetime(int(month[1]), int(month[2]), 1, tzinfo=UTC)
        except ValueError:
            return None
    else:
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            # 自由文本必须带四位年份或月份词，纯数字短串（"26-10-08"）交给解析库只会得到猜测
            if not (HAS_YEAR.search(text) or HAS_MONTH_WORD.search(text)):
                return None
            parsed = parse_date_text(text, base)
    if not parsed:
        return None
    if month or re.fullmatch(r"(?:early |mid[- ]|late )?[A-Za-z]+\.?\s+\d{4}", text, re.IGNORECASE):
        last = calendar.monthrange(parsed.year, parsed.month)[1]
        return m.DateRef(
            start=parsed.replace(day=1).date().isoformat(),
            end=parsed.replace(day=last).date().isoformat(),
            precision="month",
            text=text,
        )
    day = parsed.date().isoformat()
    return m.DateRef(start=day, end=day, precision="day", text=text)


def cutoff_availability(published: str | None, cutoff: str) -> bool | None:
    return (
        datetime.fromisoformat(published) <= datetime.fromisoformat(cutoff) if published else None
    )


def day(value: str) -> date:
    return date.fromisoformat(value[:10])
