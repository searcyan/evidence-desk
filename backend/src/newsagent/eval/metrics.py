"""计算时间线、检索指标和按任务配对的置信区间。"""

import math
import random
import re
from collections import Counter, defaultdict
from statistics import mean
from typing import Any

from ..contracts import models as m
from ..tools.dates import day


def f_score(overlap: float, predicted: float, reference: float) -> float:
    return 2 * overlap / (predicted + reference) if predicted + reference else 0.0


def ngrams(text: str, size: int) -> Counter[tuple[str, ...]]:
    tokens = re.findall(r"\w+", text.casefold())
    return Counter(tuple(tokens[i : i + size]) for i in range(len(tokens) - size + 1))


def date_aligned(predicted: dict[str, str], reference: dict[str, str], n: int) -> float:
    # 双向最近日期对齐，保留一对多映射，并以日期距离惩罚跨期匹配。
    def overlap(left: dict[str, str], right: dict[str, str]) -> tuple[float, int]:
        right_days = {date: day(date) for date in right}
        matched = 0.0
        total = 0
        for date, text in left.items():
            counts = ngrams(text, n)
            total += counts.total()
            if not right_days:
                continue
            closest = min(
                right_days, key=lambda key: (abs((day(date) - right_days[key]).days), key)
            )
            distance = abs((day(date) - right_days[closest]).days)
            matched += (counts & ngrams(right[closest], n)).total() / (1 + distance)
        return matched, total

    tp, p_count = overlap(predicted, reference)
    tr, r_count = overlap(reference, predicted)
    precision = tp / p_count if p_count else 0
    recall = tr / r_count if r_count else 0
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def aligned_scores(prediction: dict[str, str], reference: dict[str, str]) -> tuple[float, float]:
    if not prediction or not reference:
        return 0.0, 0.0
    try:
        from tilse.data.timelines import GroundTruth, Timeline  # type: ignore
        from tilse.evaluation.rouge import TimelineRougeEvaluator  # type: ignore
    except ImportError:
        return date_aligned(prediction, reference, 1), date_aligned(prediction, reference, 2)
    system = Timeline({day(d): t.splitlines() for d, t in prediction.items()})
    gold = GroundTruth([Timeline({day(d): t.splitlines() for d, t in reference.items()})])
    evaluator = TimelineRougeEvaluator(measures=["rouge_1", "rouge_2"])
    scores = evaluator.evaluate_align_date_content_costs_many_to_one(system, gold)
    return float(scores["rouge_1"]["f_score"]), float(scores["rouge_2"]["f_score"])


def timeline_metrics(state: m.RunDetail, references: list[dict[str, str]]) -> dict[str, float]:
    sources = {c.id: c.independent_sources for c in state.claims}
    ranked = sorted(
        state.timeline,
        key=lambda item: (
            not item.is_milestone,
            -sum(sources.get(cid, 0) for cid in item.claim_ids),
            item.date.start,
        ),
    )
    unique_dates: dict[str, list[str]] = defaultdict(list)
    for item in ranked:
        unique_dates[item.date.start].append(f"{item.title}. {item.summary}".strip())
    scores: list[dict[str, float]] = []
    for reference in references:
        prediction = {
            date: "\n".join(unique_dates[date]) for date in list(unique_dates)[: len(reference)]
        }
        ar1, ar2 = aligned_scores(prediction, reference)
        scores.append(
            {
                "date_f1": f_score(
                    len(prediction.keys() & reference.keys()), len(prediction), len(reference)
                ),
                "ar1_f1": ar1,
                "ar2_f1": ar2,
            }
        )
    return (
        {metric: mean(row[metric] for row in scores) for metric in ("date_f1", "ar1_f1", "ar2_f1")}
        if scores
        else {}
    )


def retrieval_metrics(
    results: list[dict[str, Any]], qrels: dict[str, int]
) -> dict[str, float | None]:
    ranking = list(dict.fromkeys(str(item["doc_id"]) for item in results if item.get("doc_id")))
    relevant = {doc for doc, score in qrels.items() if score > 0}

    def dcg(gains: list[int]) -> float:
        return sum((2**value - 1) / math.log2(index + 2) for index, value in enumerate(gains[:10]))

    optimum = dcg(sorted(qrels.values(), reverse=True))
    return {
        "evidence_recall": len(relevant.intersection(ranking)) / len(relevant)
        if relevant
        else None,
        "ndcg_at_10": dcg([qrels.get(doc, 0) for doc in ranking]) / optimum if optimum else None,
    }


def paired_bootstrap(tasks: list[m.TaskResult]) -> list[dict[str, object]]:
    values: dict[tuple[str, str, str], dict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for task in tasks:
        for name, value in task.metrics.items():
            if value is not None:
                values[(task.benchmark, task.condition, name)][task.task_id].append(value)
    result = []
    rng = random.Random(2026)
    for (benchmark, condition, metric), scores in sorted(values.items()):
        baseline = values.get((benchmark, "base", metric))
        if not baseline or condition == "base":
            continue
        paired = [
            mean(scores[key]) - mean(baseline[key])
            for key in sorted(scores.keys() & baseline.keys())
        ]
        if not paired:
            continue
        samples = sorted(mean(rng.choices(paired, k=len(paired))) for _ in range(2000))
        result.append(
            {
                "benchmark": benchmark,
                "condition": condition,
                "metric": metric,
                "paired_tasks": len(paired),
                "mean_delta": mean(paired),
                "ci95": [samples[50], samples[1949]] if len(paired) > 1 else None,
            }
        )
    return result
