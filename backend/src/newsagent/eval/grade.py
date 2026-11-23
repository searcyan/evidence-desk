"""独立评分，保存逐任务指标和评分用量。"""

from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from ..contracts import models as m
from ..llm.runner import LLM, ModelRunner
from ..runtime.budget import BudgetTracker
from ..runtime.events import EventBus
from ..runtime.manager import RunManager
from ..runtime.state import empty_detail, initial_summary, new_id
from ..runtime.store import Store
from ..tools.search import canonical_url
from ..tools.storage import file_key, read_json, write_json
from . import official
from .benchmarks import Case, load_cases
from .generate import package_version

METRICS: dict[m.BenchmarkId, dict[str, tuple[str, str, bool]]] = {
    "open_tls": {
        "date_f1": ("Date F1（官方）", "ratio", True),
        "ar1_f1": ("AR-1 F1（tilse 对齐 ROUGE-1）", "ratio", False),
        "ar2_f1": ("AR-2 F1（tilse 对齐 ROUGE-2）", "ratio", False),
    },
    "deepresearch_bench": {
        "race_overall": ("RACE 总分（相对参考报告，0.5 为持平）", "ratio", True),
        "race_comprehensiveness": ("RACE 覆盖度", "ratio", False),
        "race_insight": ("RACE 洞察", "ratio", False),
        "race_instruction_following": ("RACE 遵循指令", "ratio", False),
        "race_readability": ("RACE 可读性", "ratio", False),
        "fact_citation_accuracy": ("FACT 引用准确率", "ratio", False),
        "fact_effective_citations": ("FACT 有效引用数", "count", False),
    },
    "browsecomp_plus": {
        "accuracy": ("答案正确率（官方评委模板）", "ratio", True),
        "evidence_recall": ("证据文档召回率", "ratio", False),
        "search_calls": ("检索次数", "count", False),
    },
    "manual": {
        "status_accuracy": ("事件状态正确率", "ratio", True),
        "citation_support": ("引用支持率", "ratio", False),
        "factual_correctness": ("事实正确率", "ratio", False),
        "temporal_error_rate": ("时间错误率", "ratio", False),
        "provenance_accuracy": ("出处判断准确率", "ratio", False),
        "duplicate_query_rate": ("重复查询率", "ratio", False),
        "traceability": ("摘要引用可追溯率", "ratio", False),
    },
}


class Scores(BaseModel):
    metrics: dict[str, float | None]


MANUAL_RUBRIC = (
    "Compare factual assertions with verified reference facts, excluding unassessable assertions. "
    "Count errors involving date, stage, or evidence availability at cutoff. Compare asserted "
    "independent provenance with annotated source origin and compare the answer's state with the "
    "reference state. Output ratios from zero to one, or null where judgment is impossible."
)


def metric_defs(benchmark: m.BenchmarkId) -> list[m.MetricDef]:
    result = []
    for key, (label, unit, primary) in METRICS[benchmark].items():
        result.append(
            m.MetricDef.model_validate(
                {
                    "id": key,
                    "benchmark": benchmark,
                    "label": label,
                    "description": label,
                    "higher_is_better": key
                    not in ("temporal_error_rate", "duplicate_query_rate", "search_calls"),
                    "unit": unit,
                    "primary": primary,
                }
            )
        )
    return result


async def judge_case(
    case: Case,
    benchmark: m.BenchmarkId,
    state: m.RunDetail,
    payload: dict[str, Any],
    llm: ModelRunner | None,
    page_text: Callable[[str], str | None] = lambda _url: None,
) -> dict[str, float | None]:
    if state.status not in ("completed", "partial") or state.report is None:
        return dict.fromkeys(METRICS[benchmark])
    if benchmark == "open_tls":
        return dict(official.opentls_scores(state, case.reference["timelines"]))
    if llm is None:
        raise ValueError("该基准需要配置评审模型")
    if benchmark == "browsecomp_plus":
        response = payload.get("short_answer") or ""
        if state.report.answer.sentences:
            answer_text = " ".join(s.text for s in state.report.answer.sentences)
            response = f"{response}\n{answer_text}".strip()
        return {
            "accuracy": await official.browsecomp_accuracy(
                llm, case.question, response, case.reference["answer"]
            ),
            "evidence_recall": official.browsecomp_recall(
                payload["retrieved"], case.reference["qrels"]
            ),
            "search_calls": float(state.usage.search_calls),
        }
    if benchmark == "deepresearch_bench":
        race = await official.race_scores(
            llm,
            case.question,
            case.language,
            payload["markdown"],
            case.reference["criteria"],
            case.reference["reference_article"],
        )
        fact = await official.fact_scores(llm, state, case.language, page_text)
        return {
            "race_overall": race.get("overall"),
            "race_comprehensiveness": race.get("comprehensiveness"),
            "race_insight": race.get("insight"),
            "race_instruction_following": race.get("instruction_following"),
            "race_readability": race.get("readability"),
            **fact,
        }
    support = (await official.fact_scores(llm, state, case.language, page_text))[
        "fact_citation_accuracy"
    ]
    common = {"language": case.language, "question": case.question}
    fields = (
        "factual_correctness",
        "temporal_error_rate",
        "provenance_accuracy",
        "status_accuracy",
    )
    judged = await llm.run(
        "reviewer",
        "grade",
        common
        | {
            "report": payload["markdown"][:30_000],
            "reference": case.reference,
            "rubric": MANUAL_RUBRIC,
            "metrics": fields,
            "claims": [c.model_dump() for c in state.claims][:30],
            "sources": [g.model_dump() for g in state.origin_groups][:30],
            "documents": [d.model_dump(exclude={"snippet"}) for d in state.documents][:30],
            "cutoff": case.cutoff,
        },
        Scores,
        research=False,
    )
    queries = [
        " ".join(call.input.casefold().split())
        for call in state.tool_calls
        if call.tool == "search" and call.ok
    ]
    references = [
        eid for claim in state.claims for eid in [link.evidence_id for link in claim.links]
    ]
    evidence = {ev.id for ev in state.evidence}
    return {name: bounded(judged.metrics.get(name), 1) for name in fields} | {
        "citation_support": support,
        "duplicate_query_rate": (len(queries) - len(set(queries))) / len(queries)
        if queries
        else None,
        "traceability": sum(eid in evidence for eid in references) / len(references)
        if references
        else None,
    }


def page_reader(root: Path, state: m.RunDetail) -> Callable[[str], str | None]:
    """按 URL 读取运行中实际读到的网页正文（FACT 以被引网页为参考）。"""

    def read(url: str) -> str | None:
        key = file_key(canonical_url(url)) + ".json"
        for path in (root / "retrieval" / state.id / "pages" / key, root / "cache/pages" / key):
            if path.is_file():
                data = read_json(path)
                value = data.get("value", data)
                text = value.get("text") if isinstance(value, dict) else None
                if text:
                    return text
        return None

    return read


def bounded(value: float | None, maximum: int) -> float | None:
    return value if value is not None and 0 <= value <= maximum else None


async def grade(manager: RunManager, folder: Path, *, override: ModelRunner | None = None) -> int:
    manifest = read_json(folder / "manifest.json")
    summary = m.ExperimentSummary.model_validate(manifest["summary"])
    benchmark = summary.benchmarks[0]
    if benchmark == "open_tls" and manifest["frozen"].get("tilse_version") != package_version(
        "tilse"
    ):
        raise ValueError("当前时间线评分依赖与冻结实验不一致")
    cases = {case.key: case for case in load_cases(manager.root, benchmark)}
    referee = manager.config.profile(manifest["frozen"]["judge_profile"])
    if referee.roles["reviewer"] != manifest["frozen"]["judge_model"]:
        raise ValueError("当前评审模型与冻结实验不一致")
    store = Store(folder / "grading.sqlite")
    written = 0
    for path in sorted((folder / "outputs").rglob("r*.json")):
        destination = folder / "grades" / path.relative_to(folder / "outputs")
        if destination.exists():
            continue
        payload = read_json(path)
        state = m.RunDetail.model_validate(payload["run"])
        case = cases[payload["task_id"]]
        grading = initial_summary(
            new_id("grade"), state.request, manager.config.budget_presets.large
        )
        store.create(grading)
        meter = BudgetTracker(EventBus(empty_detail(grading), store))
        client = LLM(
            referee,
            manager.config.prices_usd_per_mtok,
            meter,
            folder / "grading_logs" / f"{grading.id}.jsonl",
        )
        try:
            scores = await judge_case(
                case,
                benchmark,
                state,
                payload,
                override or client,
                page_reader(manager.root, state),
            )
        finally:
            await client.close()
        write_json(
            destination,
            {
                "metrics": scores,
                "grading_cost_usd": meter.usage.cost_usd,
                "grading_usage": meter.usage.model_dump(mode="json"),
            },
        )
        written += 1
    return written
