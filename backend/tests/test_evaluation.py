"""用上游格式的小样本验证四种条件、续跑、评分和汇总。"""

import asyncio
import json

import pytest
from test_contract import validates
from test_workflow import FakeLLM, manager, prepare_pool

from newsagent.eval.aggregate import aggregate
from newsagent.eval.generate import generate
from newsagent.eval.grade import grade
from newsagent.tools.storage import read_json, write_json, write_text


@pytest.mark.parametrize(
    "benchmark", ["open_tls", "deepresearch_bench", "browsecomp_plus", "manual"]
)
def test_eval_smoke(tmp_path, benchmark):
    pages = prepare_pool(tmp_path)
    folder = tmp_path / "benchmarks" / benchmark
    key = "orion"
    if benchmark == "open_tls":
        key = "Orion_Aurora_2021.3.4"
        pages = [p.model_copy(update={"published_at": "2021-03-03T10:00:00Z"}) for p in pages]
        write_text(
            tmp_path / "snapshots/news/documents.jsonl",
            "".join(page.model_dump_json() + "\n" for page in pages),
        )
        write_text(
            folder / "open" / key / "timelines.jsonl",
            json.dumps([["2021-03-03T00:00:00", ["Orion announced Aurora acquisition."]]]),
        )
        write_text(
            folder / "news_keywords.py",
            "TARGET_KEYWORDS = {'open': [('" + key + "', 'Orion Aurora acquisition', 0)]}\n",
        )
    elif benchmark == "deepresearch_bench":
        prompt = "When did Orion announce its Aurora acquisition?"
        write_text(
            folder / "query.jsonl", json.dumps({"id": key, "prompt": prompt, "language": "en"})
        )
        criterion = {"criterion": "c1", "explanation": "e", "weight": 1.0}
        write_text(
            folder / "criteria.jsonl",
            json.dumps(
                {
                    "id": key,
                    "prompt": prompt,
                    "dimension_weight": {
                        "comprehensiveness": 0.3,
                        "insight": 0.3,
                        "instruction_following": 0.2,
                        "readability": 0.2,
                    },
                    "criterions": {
                        d: [criterion]
                        for d in (
                            "comprehensiveness",
                            "insight",
                            "instruction_following",
                            "readability",
                        )
                    },
                }
            ),
        )
        write_text(
            folder / "reference.jsonl",
            json.dumps({"prompt": prompt, "article": "Reference report."}),
        )
    elif benchmark == "browsecomp_plus":
        import pyarrow as pa
        import pyarrow.parquet as pq

        from newsagent.tools.corpus_index import build_corpus

        write_text(
            folder / "queries.jsonl",
            json.dumps(
                {
                    "query_id": key,
                    "query": "When did Orion announce its Aurora acquisition?",
                    "answer": "March 3, 2021",
                    "evidence_docids": ["0", "1"],
                }
            ),
        )
        table = pa.table(
            {
                "docid": [p.doc_id for p in pages],
                "text": [p.title + "\n" + p.text for p in pages],
                "url": [p.url for p in pages],
            }
        )
        (folder / "raw").mkdir(parents=True, exist_ok=True)
        pq.write_table(table, folder / "raw/corpus.parquet")
        build_corpus([folder / "raw/corpus.parquet"], folder / "corpus")
        write_text(folder / "qrel_evidence.txt", f"{key} 0 0 1\n{key} 0 1 1")
    else:
        write_text(
            folder / "cases.jsonl",
            json.dumps(
                {
                    "case_id": key,
                    "category": "republished",
                    "temporal_mode": "as_of",
                    "question": "When did Orion announce its Aurora acquisition?",
                    "cutoff": "2024-06-30T20:00:00Z",
                    "reference_facts": [{"text": "Announced in March 2021"}],
                    "reference_status_at_cutoff": "announced",
                    "provenance": [],
                    "disagreements_resolved": True,
                }
            ),
        )
    write_json(
        tmp_path / "benchmarks/splits" / f"{benchmark}.json",
        {
            "test": [key],
            "dev": ["other"],
        },
    )
    conditions = ["base", "source", "temporal", "full"]
    snapshot = None if benchmark == "browsecomp_plus" else "news"
    output = tmp_path / "experiments" / "exp_test"

    async def scenario():
        for _ in range(2):
            mgr = manager(tmp_path, FakeLLM())
            try:
                summary = await generate(
                    mgr,
                    "exp_test",
                    benchmark,
                    "test",
                    conditions,
                    1,
                    ["medium"],
                    "snapshot",
                    snapshot,
                    None,
                    None,
                    2,
                    None,
                    None,
                )
                assert summary.task_count == 1
                assert len(mgr.store.list(limit=-1)) == 4
            finally:
                await mgr.close()
        assert await grade(mgr, output, override=FakeLLM()) == 4
        assert await grade(mgr, output, override=FakeLLM()) == 0
        detail = aggregate(output)
        assert len(detail.tasks) == 4
        assert all(row.metrics for row in detail.tasks)
        assert len(detail.results) == 4
        assert {row.condition for row in detail.results} == set(conditions)
        assert all(row.status in ("completed", "partial") for row in detail.tasks)
        validates("ExperimentDetail", detail.model_dump(mode="json"))
        frozen = read_json(output / "manifest.json")["frozen"]
        for field in (
            "git_commit",
            "settings_sha256",
            "prompts_sha256",
            "model_ids",
            "dataset_version",
            "snapshot_id",
            "judge_model",
            "evaluator_version",
            "split_hash",
        ):
            assert field in frozen

    asyncio.run(scenario())
