"""读取各 benchmark 的本地数据，并把研究输入与评分用的参考答案隔离。

数据目录（`data/benchmarks/<benchmark>/`）由 `newsagent eval prepare` 从官方仓库与 HuggingFace 数据整理而来：

- open_tls/：`open/<topic>/timelines.jsonl` 与 `news_keywords.py`（CHRONOS 官方仓库）
- deepresearch_bench/：`query.jsonl`、`criteria.jsonl`、`reference.jsonl`（官方仓库 data/ 下的同名数据）
- browsecomp_plus/：`queries.jsonl`（解密后的问题、答案与证据文档）、`qrel_evidence.txt`
- manual/：`cases.jsonl`（人工案例，需两名标注者审核）
"""

import ast
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ..contracts import models as m
from ..runtime.state import now
from ..tools.dates import publication
from ..tools.storage import read_json, read_jsonl


@dataclass(frozen=True)
class Case:
    key: str
    question: str
    cutoff: str
    language: m.Lang
    mode: m.TemporalMode
    reference: dict[str, Any]


def official_date(value: str) -> str:
    """CHRONOS 的日期解析：YYYY-MM-DD / YYYY-MM / YYYY（后两者取当月 1 日 / 当年 1 月 1 日）。"""
    text = value.replace(" ", "").removesuffix("T00:00:00")
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f"无法解析参考日期：{value}")


def open_tls(root: Path) -> list[Case]:
    keywords_file = root / "news_keywords.py"
    if not keywords_file.exists():
        return []
    # 不执行第三方代码：只用 ast 解析 TARGET_KEYWORDS 字面量
    tree = ast.parse(keywords_file.read_text(encoding="utf-8"))
    table: dict[str, list[tuple[str, str, int]]] = next(
        ast.literal_eval(node.value)
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(getattr(t, "id", None) == "TARGET_KEYWORDS" for t in node.targets)
    )
    cases = []
    for folder, query, _ in table["open"]:
        path = root / "open" / folder / "timelines.jsonl"
        if not path.exists():
            continue
        timelines: list[dict[str, list[str]]] = []
        for row in read_jsonl(path):
            timeline: dict[str, list[str]] = {}
            for stamp, texts in row:
                timeline.setdefault(official_date(stamp), []).extend(texts)
            if timeline:
                timelines.append(timeline)
        # 目录名末尾的日期是官方检索的 freshness 上限，即本任务的信息截止时间
        match = re.search(r"_(\d{4})\.(\d{1,2})\.(\d{1,2})$", folder)
        if not match or not timelines:
            continue
        y, mo, d = (int(x) for x in match.groups())
        cases.append(
            Case(
                key=folder,
                question=f"Build a timeline of the key events and milestones for: {query}",
                cutoff=f"{y:04d}-{mo:02d}-{d:02d}T23:59:59Z",
                language="en",
                mode="retrospective",
                reference={"timelines": timelines, "query": query},
            )
        )
    return cases


def deepresearch(root: Path) -> list[Case]:
    queries = root / "query.jsonl"
    if not queries.exists():
        return []
    criteria = {row["prompt"]: row for row in read_jsonl(root / "criteria.jsonl")}
    references = {row["prompt"]: row["article"] for row in read_jsonl(root / "reference.jsonl")}
    cases = []
    for row in read_jsonl(queries):
        prompt = row["prompt"]
        if prompt not in criteria or prompt not in references:
            continue
        cases.append(
            Case(
                key=str(row["id"]),
                question=prompt,
                cutoff=now(),
                language="zh" if str(row.get("language", "")).lower().startswith("zh") else "en",
                mode="retrospective",
                reference={
                    "criteria": criteria[prompt],
                    "reference_article": references[prompt],
                    "topic": row.get("topic"),
                },
            )
        )
    return cases


def browsecomp(root: Path) -> list[Case]:
    source = root / "queries.jsonl"
    if not source.exists():
        return []
    qrels: dict[str, dict[str, int]] = {}
    path = root / "qrel_evidence.txt"
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            parts = line.split()
            if len(parts) == 4:
                qrels.setdefault(parts[0], {})[parts[2]] = int(parts[3])
    cases = []
    for row in read_jsonl(source):
        key = str(row["query_id"])
        labels = qrels.get(key) or {str(doc): 1 for doc in row.get("evidence_docids", [])}
        cases.append(
            Case(
                key=key,
                question=row["query"],
                cutoff=now(),
                language="en",
                mode="retrospective",
                reference={"answer": row["answer"], "qrels": labels},
            )
        )
    return cases


def manual(root: Path) -> list[Case]:
    path = root / "cases.jsonl"
    if not path.exists():
        return []
    cases = []
    for row in read_jsonl(path):
        if not row.get("disagreements_resolved"):
            continue  # 未经两名标注者对齐的案例不计入评测
        cutoff = publication(row["cutoff"])
        if not cutoff:
            raise ValueError("人工案例截止时间无效")
        cases.append(
            Case(
                str(row["case_id"]),
                row["question"],
                cutoff,
                row.get("report_language", "en"),
                row["temporal_mode"],
                {
                    key: value
                    for key, value in row.items()
                    if key.startswith("reference_")
                    or key in ("provenance", "category", "annotators", "disagreements_resolved")
                },
            )
        )
    return cases


LOADERS = {
    "open_tls": open_tls,
    "deepresearch_bench": deepresearch,
    "browsecomp_plus": browsecomp,
    "manual": manual,
}


def load_cases(
    root: Path, benchmark: m.BenchmarkId, split: str | None = None, count: int | None = None
) -> list[Case]:
    cases = LOADERS[benchmark](root / "benchmarks" / benchmark)
    if not cases:
        raise ValueError(f"缺少 {benchmark} 的基准数据")
    if split:
        path = root / "benchmarks/splits" / f"{benchmark}.json"
        if not path.exists():
            raise ValueError(f"缺少冻结分组文件 {path.name}")
        raw = read_json(path)
        dev, test = {str(key) for key in raw["dev"]}, {str(key) for key in raw["test"]}
        if not raw[split] or dev.intersection(test):
            raise ValueError("开发集与测试集必须非空且互斥")
        available = {case.key: case for case in cases}
        missing = {str(key) for key in raw[split]} - available.keys()
        if missing:
            raise ValueError("分组列出了基准数据中不存在的任务")
        cases = [available[str(key)] for key in dict.fromkeys(raw[split])]
    return cases[:count]
