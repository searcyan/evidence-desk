"""模型提议结构。所有外部 ID 和约束由控制器校验。"""

import calendar
import re
from typing import Any, Literal

from annotated_types import MaxLen
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..contracts import models as m

DATE_KEYS = {"start", "end", "date"}
DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]")
MONTH = re.compile(r"^(\d{4})-(\d{2})$")
YEAR = re.compile(r"^(\d{4})$")


def _day(key: str, value: str) -> str | None:
    """日期字段规整：完整时间戳截为 YYYY-MM-DD；只到年 / 月时，窗口 end 取期末、start 取期初；
    单点日期 date 用于前后数日的聚焦窗口，精度不足时置空，由控制器改用相关声明的日期。"""
    if DATETIME.match(value):
        return value[:10]
    month, year = MONTH.match(value), YEAR.match(value)
    if not (month or year):
        return value
    if key == "date":
        return None
    if month:
        y, mon = int(month[1]), int(month[2])
        if not 1 <= mon <= 12:
            return value
        last = calendar.monthrange(y, mon)[1] if key == "end" else 1
        return f"{y:04d}-{mon:02d}-{last:02d}"
    assert year
    return f"{year[1]}-12-31" if key == "end" else f"{year[1]}-01-01"


def _dates(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: (_day(k, v) if k in DATE_KEYS and isinstance(v, str) else _dates(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_dates(v) for v in value]
    return value


class Draft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _normalize_dates(cls, data: Any) -> Any:
        data = _dates(data)
        # 部分模型会忽略 schema 中的列表上限：保留排在前面的条目，而不是让整次调用失败
        if isinstance(data, dict):
            for name, field in cls.model_fields.items():
                value = data.get(name)
                limit = next((c.max_length for c in field.metadata if isinstance(c, MaxLen)), None)
                if limit is not None and isinstance(value, list) and len(value) > limit:
                    data = {**data, name: value[:limit]}
        return data


class QuestionDraft(Draft):
    text: str
    priority: Literal["core", "supporting"]


class ClarifyDraft(Draft):
    text: str
    options: list[str] = Field(default_factory=list)


class AssessDraft(Draft):
    event_name: str
    event_type: m.EventType
    entities: list[str]
    questions: list[QuestionDraft]
    stage_model: list[str]
    assumptions: list[str]
    initial_window: m.TimeWindow | None = None
    clarifications: list[ClarifyDraft] = Field(default_factory=list)


class ActionDraft(Draft):
    type: m.ActionType
    rationale: str
    question_ids: list[str]
    gap_id: str | None = None
    params: m.ResearchActionParams

    @model_validator(mode="before")
    @classmethod
    def _nullable_params(cls, data: Any) -> Any:
        # 契约中的可空参数字段必须出现；模型省略时补 null
        if isinstance(data, dict) and isinstance(data.get("params"), dict):
            params = {name: None for name in m.ResearchActionParams.model_fields}
            data = {**data, "params": params | data["params"]}
        return data


class PlanDraft(Draft):
    rationale: str
    source_strategy: str
    actions: list[ActionDraft]


class PassageDraft(Draft):
    quote: str = Field(min_length=1, max_length=1800)
    event_date_text: str | None = None


class EvidenceDraft(Draft):
    passages: list[PassageDraft] = Field(max_length=8)
    attribution: str | None = None
    is_original: bool | None = None
    publication_date: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _hoist_publication(cls, data: Any) -> Any:
        # 模型有时把文档级的 publication_date 写进段落里：移回顶层
        if isinstance(data, dict) and isinstance(data.get("passages"), list):
            found = data.get("publication_date")
            passages = []
            for item in data["passages"]:
                if isinstance(item, dict) and "publication_date" in item:
                    item = dict(item)
                    found = found or item.pop("publication_date")
                passages.append(item)
            data = {**data, "passages": passages, "publication_date": found}
        return data


class ClaimDraft(Draft):
    text: str
    subject: str
    stage: str | None = None
    event_date_text: str | None = None
    question_ids: list[str]
    evidence_id: str
    existing_id: str | None = None
    relation: Literal["supports", "contradicts", "context"]


class ClaimsDraft(Draft):
    claims: list[ClaimDraft] = Field(max_length=20)


class RelationDraft(Draft):
    claim_id: str
    evidence_id: str
    relation: Literal["supports", "contradicts", "context", "irrelevant"]
    note: str


class RelationsDraft(Draft):
    links: list[RelationDraft] = Field(max_length=20)


class ConflictDraft(Draft):
    same_assertion: bool
    reason: str
    alternatives: list[ClaimDraft]


class TimelineDraft(Draft):
    title: str
    summary: str
    claim_ids: list[str]


class AnswerDraft(Draft):
    question_id: str
    answer_claim_ids: list[str]
    complete: bool


class UpdateDraft(Draft):
    timeline: list[TimelineDraft]
    answers: list[AnswerDraft]


class SentenceDraft(Draft):
    text: str
    # 不确定性句可以不带引用；模型省略字段时视为无引用，由审查环节判断是否合规
    evidence_ids: list[str] = Field(default_factory=list)
    claim_ids: list[str] = Field(default_factory=list)


class SectionDraft(Draft):
    title: str
    kind: Literal["answer", "background", "timeline_analysis", "analysis", "uncertainty", "other"]
    paragraphs: list[list[SentenceDraft]]

    @model_validator(mode="before")
    @classmethod
    def _paragraph_objects(cls, data: Any) -> Any:
        """把模型给出的各种段落写法统一成"段落 = 句子数组"。

        见过的写法：句子数组（标准）、{"sentences": [...]}、直接平铺的句子对象
        （重写时常见，曾被当成空段落导致整章丢失）、模仿上一版报告带 id 的句子、纯字符串句子。
        连续的平铺句子合并为一个段落。
        """
        if not (isinstance(data, dict) and isinstance(data.get("paragraphs"), list)):
            return data

        def sentence(item: Any) -> Any:
            if isinstance(item, str):
                return {"text": item}
            if isinstance(item, dict):
                return {k: v for k, v in item.items() if k != "id"}
            return item

        paragraphs: list[list[Any]] = []
        loose: list[Any] = []
        for p in data["paragraphs"]:
            if isinstance(p, str) or (isinstance(p, dict) and "text" in p):
                loose.append(sentence(p))
                continue
            if loose:
                paragraphs.append(loose)
                loose = []
            items = p.get("sentences", []) if isinstance(p, dict) else p
            paragraphs.append([sentence(x) for x in items] if isinstance(items, list) else items)
        if loose:
            paragraphs.append(loose)
        return {**data, "paragraphs": paragraphs}


class ReportDraft(Draft):
    title: str
    answer: list[SentenceDraft]
    sections: list[SectionDraft]
    open_questions: list[str]
    short_answer: str | None = None


class FindingDraft(Draft):
    type: Literal[
        "unsupported_citation",
        "temporal_error",
        "stage_confusion",
        "omission",
        "unavailable_at_cutoff",
        "other",
    ]
    severity: Literal["high", "medium", "low"]
    sentence_id: str | None
    description: str


class ReviewDraft(Draft):
    findings: list[FindingDraft]
