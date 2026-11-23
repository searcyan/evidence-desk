"""启动服务、执行单次研究、构建快照与运行评测。"""

import asyncio
from pathlib import Path
from typing import Annotated, Literal, cast

import typer
import uvicorn

from .contracts import models as m
from .eval.aggregate import aggregate
from .eval.generate import CONDITIONS, Preset, generate
from .eval.grade import grade
from .main import create_app
from .reporting.export_md import export_markdown
from .runtime.manager import RunManager
from .runtime.state import now
from .runtime.store import Store
from .settings import Environment, data_dir, load_settings
from .tools.local_index import build_snapshot, snapshot_infos
from .tools.storage import safe_id, write_text
from .workflow.controller import run_workflow

app = typer.Typer(no_args_is_help=True)
snapshots = typer.Typer(no_args_is_help=True)
evaluation = typer.Typer(no_args_is_help=True)
app.add_typer(snapshots, name="snapshot")
app.add_typer(evaluation, name="eval")

Benchmark = Literal["open_tls", "deepresearch_bench", "browsecomp_plus", "manual"]


def manager(concurrency: int | None = None) -> RunManager:
    environment = Environment()
    if concurrency:
        environment = environment.model_copy(update={"newsagent_max_concurrent_runs": concurrency})
    return RunManager(
        Store(data_dir(environment) / "app.db"), environment, load_settings(), run_workflow
    )


@app.command()
def serve(
    host: str | None = None,
    port: int | None = None,
    fixture_mode: Annotated[bool, typer.Option("--fixture-mode")] = False,
) -> None:
    """启动本地 FastAPI 服务。"""
    environment = Environment()
    uvicorn.run(
        create_app(environment, fixture_mode=fixture_mode),
        host=host or environment.newsagent_host,
        port=port or environment.newsagent_port,
        log_level=environment.log_level.lower(),
    )


@app.command()
def run(
    question: str,
    cutoff: str | None = None,
    language: m.Lang = "en",
    budget: Preset = "small",
    search_mode: m.SearchMode = "live",
    snapshot: str | None = None,
    condition: m.ConditionId = "full",
    temporal_mode: m.TemporalMode = "as_of",
    output: Path | None = None,
    model_profile: str | None = None,
    seed: str | None = None,
) -> None:
    """执行一次研究并输出 Markdown。"""
    mgr = manager()
    request = m.RunRequest(
        question=question,
        cutoff=cutoff or now(),
        event_hint=None,
        temporal_mode=temporal_mode,
        seed_url=seed,
        report_language=language,
        budget=None,
        budget_preset=budget,
        mechanisms=CONDITIONS[condition],
        search_mode=search_mode,
        snapshot_id=snapshot,
        model_profile=model_profile,
        tags=[],
    )

    async def execute() -> m.RunDetail:
        mgr.recover()
        summary = mgr.start(request)
        bus = mgr.bus(summary.id)
        try:
            async for event in bus.stream(0):
                first = event.splitlines()[0]
                if first.startswith("id:"):
                    detail = bus.state
                    typer.echo(f"{detail.id} · {detail.status} · {detail.phase or '—'}", err=True)
                if bus.state.clarification:
                    responses = [
                        m.ClarificationAnswerAnswersItem(
                            question_id=item.id,
                            answer=typer.prompt(item.text),
                        )
                        for item in bus.state.clarification.questions
                    ]
                    mgr.answer(summary.id, m.ClarificationAnswer(answers=responses))
            return bus.state
        finally:
            await mgr.close()

    detail = asyncio.run(execute())
    markdown = export_markdown(detail)
    if output:
        write_text(output, markdown)
    else:
        typer.echo(markdown)
    if detail.status == "failed":
        raise typer.Exit(1)


@snapshots.command("build")
def snapshot_build(
    from_runs: Annotated[list[str], typer.Option("--from-runs")],
    snapshot_id: Annotated[str, typer.Option("--id")],
) -> None:
    """从已缓存的运行正文构建冻结快照。"""
    mgr = manager()
    ids = [run_id for value in from_runs for run_id in value.split(",") if run_id]
    runs = [mgr.bus(run_id).state for run_id in ids]
    typer.echo(build_snapshot(mgr.root, snapshot_id, runs).model_dump_json())


@snapshots.command("from-experiments")
def snapshot_from_experiments(
    experiments: Annotated[list[str], typer.Option("--exp")],
    snapshot_id: Annotated[str, typer.Option("--id")],
) -> None:
    """用录制实验中全部运行读到的正文构建冻结快照。"""
    from .tools.storage import read_json

    mgr = manager()
    ids: list[str] = []
    for exp in experiments:
        folder = mgr.root / "experiments" / safe_id(exp)
        ids.extend(
            read_json(path)["run_id"] for path in sorted((folder / "outputs").rglob("r*.json"))
        )
    runs = [mgr.bus(run_id).state for run_id in dict.fromkeys(ids)]
    typer.echo(build_snapshot(mgr.root, snapshot_id, runs).model_dump_json())


@snapshots.command("list")
def snapshot_list() -> None:
    """列出可用的冻结检索快照。"""
    for item in snapshot_infos(data_dir(Environment())):
        typer.echo(item.model_dump_json())


def choice_list[T: str](raw: str, options: tuple[T, ...], name: str) -> list[T]:
    found = list(dict.fromkeys(item.strip() for item in raw.split(",") if item.strip()))
    if not found or any(item not in options for item in found):
        raise typer.BadParameter(f"{name} 必须取自 {', '.join(options)}")
    return cast(list[T], found)


def execute_eval(
    exp: str,
    benchmark: Benchmark,
    split: str | None,
    conditions: str,
    repeats: int,
    budget: Preset,
    scan: str | None,
    search_mode: m.SearchMode | None,
    snapshot: str | None,
    concurrency: int,
    model_profile: str | None,
    judge_profile: str | None,
    limit: int | None,
    notes: str | None,
) -> None:
    mgr = manager(concurrency)
    condition_ids = choice_list(conditions, tuple(CONDITIONS), "conditions")
    budget_ids: tuple[Preset, ...] = ("small", "medium", "large")
    budgets = (
        [budget]
        if not scan
        else list(
            dict.fromkeys(
                [budget, *choice_list(scan, budget_ids, "budget-scan")],
            )
        )
    )
    caveats = {
        "open_tls": "按 CHRONOS 官方协议评分（tilse 对齐 ROUGE 使用其 Python 重实现）。",
        "deepresearch_bench": "按官方 RACE/FACT 协议与官方提示词评分，评委模型为替代模型，"
        "与排行榜不可直接比较，仅用于组内条件对比；时事子集。",
        "browsecomp_plus": "固定语料（SQLite FTS5 BM25）检索；答案按官方评委模板评分，评委为替代模型。",
        "manual": "仅计入两名标注者已对齐的案例；模型评分需组员复核。",
    }
    summary_note = f"{caveats[benchmark]} {notes or ''}".strip()
    if limit is not None:
        summary_note += f" 子集上限 {limit}。"

    async def run_eval() -> m.ExperimentSummary:
        try:
            return await generate(
                mgr,
                exp,
                benchmark,
                split,
                cast(list[m.ConditionId], condition_ids),
                repeats,
                cast(list[Preset], budgets),
                search_mode,
                snapshot,
                model_profile,
                judge_profile,
                concurrency,
                limit,
                summary_note,
            )
        finally:
            await mgr.close()

    typer.echo(asyncio.run(run_eval()).model_dump_json())
    aggregate(mgr.root / "experiments" / safe_id(exp))


@evaluation.command("run")
def eval_run(
    exp: Annotated[str, typer.Option("--exp")],
    benchmark: Annotated[Benchmark, typer.Option("--benchmark")],
    split: Literal["dev", "test", "record"] = "test",
    conditions: str = "base,source,temporal,full",
    repeats: Annotated[int, typer.Option(min=1)] = 3,
    budget: Preset = "medium",
    budget_scan: str | None = None,
    search_mode: m.SearchMode | None = None,
    snapshot: str | None = None,
    concurrency: Annotated[int, typer.Option(min=1)] = 2,
    model_profile: str | None = None,
    judge_profile: str | None = None,
    limit: Annotated[int | None, typer.Option(min=1)] = None,
    notes: str | None = None,
) -> None:
    """运行冻结数据集上的 2×2 实验，跳过已经保存的组合。"""
    execute_eval(
        exp,
        benchmark,
        split,
        conditions,
        repeats,
        budget,
        budget_scan,
        search_mode,
        snapshot,
        concurrency,
        model_profile,
        judge_profile,
        limit,
        notes,
    )


@evaluation.command("pilot")
def eval_pilot(
    benchmark: Annotated[Benchmark, typer.Option("--benchmark")],
    n: Annotated[int, typer.Option(min=1)] = 5,
    exp: str | None = None,
    snapshot: str | None = None,
    search_mode: m.SearchMode | None = None,
    concurrency: Annotated[int, typer.Option(min=1)] = 2,
    model_profile: str | None = None,
    judge_profile: str | None = None,
) -> None:
    """在开发集上用三档预算试运行。"""
    execute_eval(
        exp or f"pilot_{benchmark}_{now()[:10]}",
        benchmark,
        "dev",
        "full",
        1,
        "medium",
        "small,large",
        search_mode,
        snapshot,
        concurrency,
        model_profile,
        judge_profile,
        n,
        "开发集试运行。",
    )


@evaluation.command("grade")
def eval_grade(
    exp: Annotated[str, typer.Option("--exp")], benchmark: Benchmark | None = None
) -> None:
    """独立打分并汇总结果。"""
    mgr = manager()
    folder = mgr.root / "experiments" / safe_id(exp)
    if benchmark:
        from .tools.storage import read_json

        if benchmark not in read_json(folder / "manifest.json")["summary"]["benchmarks"]:
            raise typer.BadParameter("实验未配置该基准")
    typer.echo(f"已评分 {asyncio.run(grade(mgr, folder))} 个任务结果")
    aggregate(folder)


@evaluation.command("prepare")
def eval_prepare(benchmark: Annotated[Benchmark, typer.Option("--benchmark")]) -> None:
    """整理官方原始数据并生成（或校验已冻结的）dev / test 划分。"""
    from .eval.prepare import prepare

    result = prepare(data_dir(Environment()), benchmark)
    typer.echo(f"{benchmark}: dev={result['dev']} test={result['test']}")


@evaluation.command("aggregate")
def eval_aggregate(exp: Annotated[str, typer.Option("--exp")]) -> None:
    """生成实验页面使用的汇总结果。"""
    detail = aggregate(data_dir(Environment()) / "experiments" / safe_id(exp))
    typer.echo(f"{detail.id} · {len(detail.tasks)} 项任务结果")


if __name__ == "__main__":
    app()
