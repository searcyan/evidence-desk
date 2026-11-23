"""按各 benchmark 官方协议实现的评分。

- Open-TLS：与 CHRONOS `evaluation.py` 一致——参考时间线合并为 tilse GroundTruth，预测日期数截断到
  参考日期并集的大小；Date F1 为日期集合 F1；AR-1/AR-2 为 tilse `align_date_content_costs_many_to_one`
  的 ROUGE-1/2 F1（使用 tilse 自带的 Python 重实现，而非 Perl ROUGE-1.5.5）。
- DeepResearch Bench RACE：与 `deepresearch_bench_race.py` 一致——官方逐任务评分标准 + 参考报告，对比打分，
  按维度权重求加权平均，最终分 = target / (target + reference)。
- DeepResearch Bench FACT：与 `utils/validate.py` + `utils/stat.py` 一致——按 URL 分组的陈述，以被引网页
  为参考判定 supported / unsupported / unknown；引用准确率 = supported / (supported + unsupported)，
  有效引用数 = supported 数。陈述与 URL 的对应来自报告的结构化引用（官方由 LLM 从正文抽取）。
- BrowseComp-Plus：官方 GRADER_TEMPLATE 判定答案正确；Recall = 运行中检索到的文档 ∩ 证据文档 / 证据文档数。
"""

import json
from datetime import date
from itertools import batched
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..contracts import models as m
from ..llm.runner import ModelRunner
from ..reporting.report import report_sentences

PROMPTS = Path(__file__).parent / "official"


def prompt(name: str) -> str:
    return (PROMPTS / name).read_text(encoding="utf-8")


# ───────────────────────── Open-TLS ─────────────────────────


def opentls_scores(state: m.RunDetail, references: list[dict[str, list[str]]]) -> dict[str, float]:
    from tilse.data.timelines import GroundTruth, Timeline
    from tilse.evaluation import rouge

    gold = GroundTruth(
        [Timeline({date.fromisoformat(d): texts for d, texts in ref.items()}) for ref in references]
    )
    num_dates = len(gold.get_dates())
    # 预测：里程碑优先，其次按支持声明的独立来源数，再按日期；同日条目合并为当日摘要
    sources = {c.id: c.independent_sources for c in state.claims}
    ranked = sorted(
        state.timeline,
        key=lambda t: (
            not t.is_milestone,
            -sum(sources.get(cid, 0) for cid in t.claim_ids),
            t.date.start,
        ),
    )
    predicted: dict[date, list[str]] = {}
    for item in ranked:
        day = date.fromisoformat(item.date.start)
        if day not in predicted and len(predicted) >= num_dates:
            continue
        predicted.setdefault(day, []).append(f"{item.title}. {item.summary}".strip())
    if not predicted:
        return {"date_f1": 0.0, "ar1_f1": 0.0, "ar2_f1": 0.0}
    system = Timeline(predicted)
    shared = system.get_dates() & gold.get_dates()
    precision = len(shared) / len(system.get_dates())
    recall = len(shared) / len(gold.get_dates())
    date_f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    evaluator = rouge.TimelineRougeEvaluator(
        measures=["rouge_1", "rouge_2"], rouge_computation="reimpl"
    )
    scores = evaluator.evaluate_align_date_content_costs_many_to_one(system, gold)
    return {
        "date_f1": date_f1,
        "ar1_f1": float(scores["rouge_1"]["f_score"]),
        "ar2_f1": float(scores["rouge_2"]["f_score"]),
    }


# ───────────────────────── DeepResearch Bench：RACE ─────────────────────────


class RaceItem(BaseModel):
    criterion: str
    analysis: str = ""
    article_1_score: float = Field(ge=0, le=10)
    article_2_score: float = Field(ge=0, le=10)


class RaceOutput(BaseModel):
    comprehensiveness: list[RaceItem]
    insight: list[RaceItem]
    instruction_following: list[RaceItem]
    readability: list[RaceItem]


DIMENSIONS = ("comprehensiveness", "insight", "instruction_following", "readability")


def race_weighted(output: RaceOutput, criteria: dict[str, Any]) -> dict[str, float]:
    """官方 `calculate_weighted_scores` + 归一化：返回各维度与总分的 target/(target+reference)。"""
    weights = criteria["dimension_weight"]
    target_total = reference_total = 0.0
    result: dict[str, float] = {}
    for dim in DIMENSIONS:
        table = {c["criterion"]: c["weight"] for c in criteria["criterions"].get(dim, [])}
        if not table:
            continue
        t_sum = r_sum = w_sum = 0.0
        for item in getattr(output, dim):
            text = item.criterion.strip()
            weight = table.get(text)
            if weight is None:
                lower = text.lower()
                weight = next(
                    (
                        v
                        for k, v in table.items()
                        if k.lower() == lower or lower in k.lower() or k.lower() in lower
                    ),
                    sum(table.values()) / len(table),
                )
            t_sum += item.article_1_score * weight
            r_sum += item.article_2_score * weight
            w_sum += weight
        t_avg = t_sum / w_sum if w_sum else 0.0
        r_avg = r_sum / w_sum if w_sum else 0.0
        result[dim] = t_avg / (t_avg + r_avg) if t_avg + r_avg else 0.0
        target_total += t_avg * weights.get(dim, 0)
        reference_total += r_avg * weights.get(dim, 0)
    result["overall"] = (
        target_total / (target_total + reference_total) if target_total + reference_total else 0.0
    )
    return result


def clean_article(markdown: str) -> str:
    """官方用 LLM 去掉文中引用标记与参考文献；这里确定性地去掉 [n] 标记与"参考来源"小节。"""
    import re

    text = re.split(r"\n## (Sources|参考来源)\n", markdown)[0]
    return re.sub(r"\[\d+\]", "", text)


async def race_scores(
    llm: ModelRunner,
    question: str,
    language: str,
    markdown: str,
    criteria: dict[str, Any],
    reference_article: str,
) -> dict[str, float]:
    criteria_for_prompt = {
        dim: [{"criterion": c["criterion"], "explanation": c["explanation"]} for c in items]
        for dim, items in criteria["criterions"].items()
    }
    template = prompt("race_score_zh.txt" if language == "zh" else "race_score_en.txt")
    text = template.format(
        task_prompt=question,
        article_1=clean_article(markdown),
        article_2=reference_article,
        criteria_list=json.dumps(criteria_for_prompt, ensure_ascii=False, indent=2),
    )
    output = await llm.run(
        "reviewer", "official", {"prompt": text, "language": language}, RaceOutput, research=False
    )
    return race_weighted(output, criteria)


# ───────────────────────── DeepResearch Bench：FACT ─────────────────────────


class FactJudgement(BaseModel):
    idx: int
    result: Literal["supported", "unsupported", "unknown"]


class FactOutput(BaseModel):
    results: list[FactJudgement]


def citation_groups(state: m.RunDetail) -> dict[str, list[str]]:
    """URL → 去重后的陈述列表（官方：抽取 (statement, url) 对后按 URL 去重）。"""
    if not state.report:
        return {}
    evidence = {e.id: e for e in state.evidence}
    urls = {d.id: d.url for d in state.documents}
    groups: dict[str, list[str]] = {}
    for sentence in report_sentences(state.report):
        for eid in sentence.evidence_ids:
            ev = evidence.get(eid)
            url = urls.get(ev.document_id) if ev else None
            if url and sentence.text not in groups.setdefault(url, []):
                groups[url].append(sentence.text)
    return groups


async def fact_scores(
    llm: ModelRunner, state: m.RunDetail, language: str, page_text: Any
) -> dict[str, float | None]:
    template = prompt("fact_validate_zh.txt" if language == "zh" else "fact_validate_en.txt")
    supported = unsupported = 0
    for url, statements in citation_groups(state).items():
        reference = page_text(url)
        if not reference:
            continue  # 官方：网页抓取失败（validate_error）的引用不计入
        for chunk in batched(statements, 20):
            numbered = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(chunk))
            text = template.format(reference=reference[:60_000], statements=numbered)
            output = await llm.run(
                "reviewer",
                "official",
                {"prompt": text, "language": language},
                FactOutput,
                research=False,
            )
            for item in output.results:
                if 1 <= item.idx <= len(chunk):
                    supported += item.result == "supported"
                    unsupported += item.result == "unsupported"
    total = supported + unsupported
    return {
        "fact_citation_accuracy": supported / total if total else None,
        "fact_effective_citations": float(supported),
    }


# ───────────────────────── BrowseComp-Plus ─────────────────────────


class GraderOutput(BaseModel):
    extracted_final_answer: str
    reasoning: str
    correct: Literal["yes", "no"]
    confidence: float | None = None


async def browsecomp_accuracy(
    llm: ModelRunner, question: str, response: str, answer: str
) -> float | None:
    if not response:
        return 0.0
    text = prompt("browsecomp_grader.txt").format(
        question=question, response=response, correct_answer=answer
    )
    output = await llm.run(
        "reviewer", "official", {"prompt": text, "language": "en"}, GraderOutput, research=False
    )
    return 1.0 if output.correct == "yes" else 0.0


def browsecomp_recall(retrieved: list[dict[str, Any]], qrels: dict[str, int]) -> float | None:
    positives = {doc for doc, score in qrels.items() if score > 0}
    docs = {str(item["doc_id"]) for item in retrieved if item.get("doc_id")}
    return len(positives & docs) / len(positives) if positives else None
