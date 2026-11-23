"""汇总各条件的质量、成本、预算扫描和任务级置信区间。"""

from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean, stdev

from ..contracts import models as m
from ..tools.storage import read_json, write_json, write_text
from .generate import Preset
from .grade import metric_defs
from .metrics import paired_bootstrap


def aggregate(folder: Path) -> m.ExperimentDetail:
    manifest = read_json(folder / "manifest.json")
    summary = m.ExperimentSummary.model_validate(manifest["summary"])
    benchmark = summary.benchmarks[0]
    budgets = manifest["selection"]["budgets"]
    primary = budgets[0]
    tasks: list[m.TaskResult] = []
    grouped: dict[tuple[Preset, str], list[tuple[m.TaskResult, int, float]]] = defaultdict(list)
    for file in sorted((folder / "outputs").rglob("r*.json")):
        payload = read_json(file)
        state = m.RunDetail.model_validate(payload["run"])
        budget = payload["budget"]
        grade_file = folder / "grades" / file.relative_to(folder / "outputs")
        grade = read_json(grade_file) if grade_file.exists() else {}
        result = m.TaskResult(
            task_id=payload["task_id"],
            benchmark=benchmark,
            condition=payload["condition"],
            repeat=payload["repeat"],
            run_id=state.id,
            status=state.status if state.status in ("completed", "partial") else "failed",
            metrics=grade.get("metrics", {}),
            cost_usd=state.usage.cost_usd,
            tokens=state.usage.input_tokens + state.usage.output_tokens,
            seconds=state.usage.elapsed_seconds,
        )
        grouped[(budget, result.condition)].append(
            (
                result,
                state.usage.search_calls + state.usage.read_calls,
                grade.get("grading_cost_usd", 0),
            )
        )
        if budget == primary:
            tasks.append(result)

    definitions = metric_defs(benchmark)
    results: list[m.ConditionResult] = []
    scans: list[m.BudgetLevelPoint] = []
    statistics: list[dict[str, object]] = []
    for budget in budgets:
        for condition in summary.conditions:
            rows = grouped.get((budget, condition), [])
            if not rows:
                continue
            samples = [row[0] for row in rows]
            metrics: dict[str, m.MetricStat] = {}
            for definition in definitions:
                values = [
                    value
                    for row in samples
                    if (value := row.metrics.get(definition.id)) is not None
                ]
                if not values:
                    continue
                score = m.MetricStat(
                    mean=mean(values), std=stdev(values) if len(values) > 1 else 0, n=len(values)
                )
                metrics[definition.id] = score
                if len(budgets) > 1:
                    scans.append(
                        m.BudgetLevelPoint(
                            benchmark=benchmark,
                            condition=condition,
                            budget_preset=budget,
                            metric_id=definition.id,
                            metric_mean=score.mean,
                            mean_cost_usd=mean(row.cost_usd for row in samples),
                        )
                    )
                by_task: dict[str, list[float]] = defaultdict(list)
                for row in samples:
                    value = row.metrics.get(definition.id)
                    if value is not None:
                        by_task[row.task_id].append(value)
                task_means = [mean(numbers) for numbers in by_task.values()]
                statistics.append(
                    {
                        "benchmark": benchmark,
                        "budget": budget,
                        "condition": condition,
                        "metric": definition.id,
                        "task_mean_std": stdev(task_means) if len(task_means) > 1 else None,
                        "within_task_std_mean": mean(
                            stdev(v) if len(v) > 1 else 0 for v in by_task.values()
                        ),
                    }
                )
            if budget != primary:
                continue
            counts = Counter(row.status for row in samples)
            results.append(
                m.ConditionResult(
                    benchmark=benchmark,
                    condition=condition,
                    metrics=metrics,
                    cost=m.CostStat(
                        mean_cost_usd=mean(row.cost_usd for row in samples),
                        mean_tokens=mean(row.tokens for row in samples),
                        mean_seconds=mean(row.seconds for row in samples),
                        mean_tool_calls=mean(row[1] for row in rows),
                        total_cost_usd=sum(row.cost_usd for row in samples),
                        grading_cost_usd=sum(row[2] for row in rows),
                    ),
                    completion=m.ConditionResultCompletion(
                        completed=counts["completed"],
                        partial=counts["partial"],
                        failed=counts["failed"],
                    ),
                )
            )
    detail = m.ExperimentDetail(
        **summary.model_dump(),
        metric_defs=definitions,
        results=results,
        tasks=tasks,
        budget_levels=scans,
    )
    write_text(folder / "tasks.jsonl", "".join(task.model_dump_json() + "\n" for task in tasks))
    write_json(
        folder / "statistics.json",
        {
            "task_variability": statistics,
            "paired_bootstrap": paired_bootstrap(tasks),
        },
    )
    write_json(folder / "summary.json", detail.model_dump(mode="json"))
    return detail
