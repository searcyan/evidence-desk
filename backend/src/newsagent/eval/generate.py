"""冻结实验输入并生成可续跑的任务结果。"""

import asyncio
import hashlib
import subprocess
from collections.abc import Iterable
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Literal

from ..contracts import models as m
from ..reporting.export_md import export_markdown
from ..runtime.manager import RunManager
from ..runtime.state import now
from ..settings import ROOT, SETTINGS_FILE
from ..tools.storage import file_key, read_json, safe_id, write_json
from .benchmarks import Case, load_cases

Preset = Literal["small", "medium", "large"]
CONDITIONS: dict[m.ConditionId, m.Mechanisms] = {
    "base": m.Mechanisms(source_verification=False, temporal_planning=False),
    "source": m.Mechanisms(source_verification=True, temporal_planning=False),
    "temporal": m.Mechanisms(source_verification=False, temporal_planning=True),
    "full": m.Mechanisms(source_verification=True, temporal_planning=True),
}
DEFAULT_MODE: dict[m.BenchmarkId, m.SearchMode] = {
    "open_tls": "snapshot",
    "deepresearch_bench": "live",
    "browsecomp_plus": "corpus",
    "manual": "live",
}


def tree_hash(files: Iterable[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(files):
        digest.update(path.name.encode())
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def commit(folder: Path) -> str | None:
    try:
        command = subprocess.run(
            ["git", "-C", str(folder), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        return command.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def package_version(package: str) -> str | None:
    try:
        return version(package)
    except PackageNotFoundError:
        return None


def frozen(
    manager: RunManager,
    benchmark: m.BenchmarkId,
    split: str | None,
    snapshot: str | None,
    model: str | None,
    judge: str | None,
    search_mode: m.SearchMode,
) -> dict[str, Any]:
    root = manager.root
    benchmark_root = root / "benchmarks" / benchmark
    split_file = root / "benchmarks/splits" / f"{benchmark}.json"
    profile = manager.config.profile(model)
    referee = manager.config.profile(judge or model)
    snapshot_file = root / "snapshots" / safe_id(snapshot) / "manifest.json" if snapshot else None
    data_paths = [
        p
        for p in benchmark_root.rglob("*")
        if p.is_file()
        and ".git" not in p.parts
        and p.suffix in (".jsonl", ".tsv", ".txt", ".json")
        and p.name != "bm25.json"
    ]
    if search_mode != "corpus":
        data_paths = [p for p in data_paths if p.name != "corpus.sqlite"]
    return {
        "git_commit": commit(ROOT),
        "settings_sha256": tree_hash([SETTINGS_FILE]),
        "prompts_sha256": tree_hash((ROOT / "src/newsagent/llm/prompts").glob("*.j2")),
        "model_profile": profile.id,
        "model_ids": profile.roles,
        "judge_profile": referee.id,
        "judge_model": referee.roles["reviewer"],
        "dataset_version": commit(benchmark_root),
        "dataset_sha256": tree_hash(data_paths),
        "snapshot_id": snapshot,
        "snapshot_hash": tree_hash([snapshot_file])
        if snapshot_file and snapshot_file.exists()
        else None,
        "evaluator_version": "0.1.0",
        "tilse_version": package_version("tilse"),
        "evaluator_sha256": tree_hash(Path(__file__).parent.glob("*.py")),
        "split_hash": tree_hash([split_file]) if split and split_file.exists() else None,
    }


def run_request(
    case: Case,
    budget: Preset,
    condition: m.ConditionId,
    mode: m.SearchMode,
    snapshot: str | None,
    model: str | None,
    tags: list[str],
) -> m.RunRequest:
    return m.RunRequest(
        question=case.question,
        event_hint=None,
        cutoff=case.cutoff,
        temporal_mode=case.mode,
        seed_url=None,
        report_language=case.language,
        budget_preset=budget,
        budget=None,
        mechanisms=CONDITIONS[condition],
        search_mode=mode,
        snapshot_id=snapshot,
        model_profile=model,
        tags=tags,
    )


def locate_output(
    root: Path,
    benchmark: m.BenchmarkId,
    key: str,
    condition: m.ConditionId,
    repeat: int,
    budget: Preset,
    primary_budget: Preset,
) -> Path:
    try:
        dirname = safe_id(key)
    except ValueError:
        dirname = "task_" + file_key(key)[:24]
    folder = root / "outputs" / benchmark / dirname / condition
    if budget != primary_budget:
        folder = folder / budget
    return folder / f"r{repeat}.json"


async def generate(
    manager: RunManager,
    exp_id: str,
    benchmark: m.BenchmarkId,
    split: str | None,
    conditions: list[m.ConditionId],
    repeats: int,
    budgets: list[Preset],
    mode: m.SearchMode | None,
    snapshot: str | None,
    model: str | None,
    judge: str | None,
    concurrency: int,
    count: int | None,
    notes: str | None,
) -> m.ExperimentSummary:
    manager.recover()
    path = manager.root / "experiments" / safe_id(exp_id)
    manifest_file = path / "manifest.json"
    search = "corpus" if benchmark == "browsecomp_plus" else mode or DEFAULT_MODE[benchmark]
    cases = load_cases(manager.root, benchmark, split, count)
    if search == "snapshot":
        from ..tools.local_index import snapshot_infos

        if snapshot not in {snap.id for snap in snapshot_infos(manager.root)}:
            raise ValueError("请选择已冻结的检索快照")
    if (
        search == "corpus"
        and not (manager.root / "benchmarks/browsecomp_plus/corpus/corpus.sqlite").is_file()
    ):
        raise ValueError("缺少 BrowseComp-Plus 本地语料文件")
    metadata = frozen(manager, benchmark, split, snapshot, model, judge, search)
    selection = {
        "benchmark": benchmark,
        "task_ids": [case.key for case in cases],
        "split": split,
        "conditions": conditions,
        "repeats": repeats,
        "budgets": budgets,
        "search_mode": search,
        "cutoffs": {case.key: case.cutoff for case in cases},
    }
    summary = m.ExperimentSummary(
        id=exp_id,
        name=exp_id,
        created_at=now(),
        status="running",
        benchmarks=[benchmark],
        conditions=conditions,
        model_profile=metadata["model_profile"],
        budget_preset=budgets[0],
        repeats=repeats,
        task_count=len(cases),
        notes=notes,
    )
    if manifest_file.exists():
        previous = read_json(manifest_file)
        saved = dict(previous["selection"])
        selection["cutoffs"] = saved["cutoffs"]
        if previous["frozen"] != metadata or saved != selection:
            raise ValueError("续跑配置与冻结实验不一致，请使用新的实验标识符")
        summary = m.ExperimentSummary.model_validate(previous["summary"]).model_copy(
            update={"status": "running"},
        )
    metadata_file = {
        "summary": summary.model_dump(mode="json"),
        "frozen": metadata,
        "selection": selection,
    }
    write_json(manifest_file, metadata_file)

    sem = asyncio.Semaphore(concurrency)

    async def one(case: Case, condition: m.ConditionId, repeat: int, budget: Preset) -> None:
        destination = locate_output(
            path, benchmark, case.key, condition, repeat, budget, budgets[0]
        )
        if destination.exists():
            return
        combination = "eval:" + file_key(
            f"{exp_id}|{benchmark}|{case.key}|{condition}|{repeat}|{budget}"
        )
        async with sem:
            summary_for_run = manager.store.by_tag(combination)
            if summary_for_run is None:
                request = run_request(
                    case,
                    budget,
                    condition,
                    search,
                    snapshot,
                    model,
                    [
                        f"exp:{exp_id}",
                        f"cond:{condition}",
                        combination,
                    ],
                ).model_copy(update={"cutoff": selection["cutoffs"][case.key]})
                summary_for_run = manager.start(request)
            elif (
                summary_for_run.status == "failed"
                and (bus := manager.bus(summary_for_run.id)).state.error
                and bus.state.error.type == "interrupted"
            ):
                summary_for_run = manager.resume(summary_for_run.id)
            task = manager.tasks.get(summary_for_run.id)
            if task is not None:
                await task
            state = manager.bus(summary_for_run.id).state
            actions = list(
                dict.fromkeys(
                    call.action_id
                    for call in state.tool_calls
                    if call.tool == "search" and call.ok and call.action_id
                )
            )
            retrieved = []
            for action_id in actions:
                result_path = manager.root / "retrieval" / state.id / f"{action_id}.json"
                if result_path.exists():
                    retrieved.extend(read_json(result_path)["hits"])
            answer = manager.store.short_answer(state.id)
            if not answer and state.report and state.report.answer.sentences:
                answer = state.report.answer.sentences[0].text
            write_json(
                destination,
                {
                    "task_id": case.key,
                    "benchmark": benchmark,
                    "condition": condition,
                    "repeat": repeat,
                    "budget": budget,
                    "run_id": state.id,
                    "short_answer": answer,
                    "markdown": export_markdown(state),
                    "retrieved": retrieved,
                    "run": state.model_dump(mode="json"),
                },
            )
            manager.buses.pop(state.id, None)

    async with asyncio.TaskGroup() as group:
        for budget in budgets:
            for case in cases:
                for condition in conditions:
                    for repeat in range(1, repeats + 1):
                        group.create_task(one(case, condition, repeat, budget))
    finished = summary.model_copy(update={"status": "completed"})
    metadata_file["summary"] = finished.model_dump(mode="json")
    write_json(manifest_file, metadata_file)
    return finished
