"""冻结快照、语料文档和可复现的 BM25 检索。"""

import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from threading import Lock
from urllib.parse import quote, urlsplit

from pydantic import ValidationError

from ..contracts import models as m
from ..runtime.state import now
from .search import Page, SearchHit, canonical_url
from .storage import file_key, read_json, safe_id, write_json, write_text

TOKENS = re.compile(r"[\u3400-\u9fff]|[^\W_]+")
INDEXES: dict[Path, tuple[int, "LocalIndex"]] = {}
INDEX_LOCK = Lock()


def snapshot_infos(root: Path) -> list[m.SnapshotInfo]:
    result = []
    for path in (root / "snapshots").glob("*/manifest.json"):
        try:
            info = m.SnapshotInfo.model_validate(read_json(path)["info"])
            if info.id == path.parent.name and (path.parent / "documents.jsonl").is_file():
                result.append(info)
        except (OSError, ValueError, KeyError):
            continue
    return sorted(result, key=lambda item: (item.created_at, item.id), reverse=True)


def page_from_row(row: dict) -> Page:
    if "final_url" in row:
        return Page.model_validate(row)
    key = str(row["docid"] if "docid" in row else row["id"])
    uri = row.get("url") or "https://corpus.local/document/" + quote(key, safe="")
    return Page(url=uri, final_url=uri, text=row["text"], doc_id=key, title=row.get("title") or key)


class LocalIndex:
    def __init__(self, path: Path):
        self.path = path
        self.docs: list[tuple[int, str, str, str | None, str | None]] = []
        self.by_url: dict[str, int] = {}
        self.lengths: list[int] = []
        self.postings: dict[str, list[tuple[int, int]]] = defaultdict(list)
        self.index_path = path.parent / "bm25.json"
        if self.index_path.is_file():
            stored = read_json(self.index_path)
            self.docs = [(row[0], row[1], row[2], row[3], row[4]) for row in stored["documents"]]
            self.by_url = stored["urls"]
            self.lengths = stored["lengths"]
            self.postings = stored["postings"]
        else:
            self.build()
        self.average = max(sum(self.lengths) / max(len(self.lengths), 1), 1)

    def build(self) -> None:
        with self.path.open("rb") as stream:
            while True:
                offset = stream.tell()
                line = stream.readline()
                if not line:
                    break
                if not line.strip():
                    continue
                page = page_from_row(json.loads(line.decode("utf-8-sig")))
                url = canonical_url(page.final_url)
                if url in self.by_url:
                    continue
                idx = len(self.docs)
                self.by_url[url] = idx
                self.by_url.setdefault(canonical_url(page.url), idx)
                self.docs.append(
                    (offset, page.final_url, page.title, page.published_at, page.doc_id)
                )
                counts = Counter(TOKENS.findall((page.title + " " + page.text).casefold()))
                self.lengths.append(sum(counts.values()))
                for token, frequency in counts.items():
                    self.postings[token].append((idx, frequency))

    def save(self) -> None:
        write_json(
            self.index_path,
            {
                "documents": self.docs,
                "urls": self.by_url,
                "lengths": self.lengths,
                "postings": self.postings,
            },
        )

    def read(self, url: str) -> Page:
        idx = self.by_url[canonical_url(url)]
        with self.path.open("rb") as stream:
            stream.seek(self.docs[idx][0])
            return page_from_row(json.loads(stream.readline().decode("utf-8-sig")))

    def search(
        self, query: str, window: m.TimeWindow | None, count: int, exclude: list[str]
    ) -> list[SearchHit]:
        scores: dict[int, float] = defaultdict(float)
        for term in dict.fromkeys(TOKENS.findall(query.casefold())):
            postings = self.postings.get(term, [])
            idf = math.log1p((len(self.docs) - len(postings) + 0.5) / (len(postings) + 0.5))
            for idx, frequency in postings:
                norm = 1.2 * (0.25 + 0.75 * self.lengths[idx] / self.average)
                scores[idx] += idf * frequency * 2.2 / (frequency + norm)
        ranked = sorted(scores, key=lambda i: (-scores[i], self.docs[i][1]))
        hits = []
        for i in ranked:
            _, url, title, published, doc_id = self.docs[i]
            domain = urlsplit(url).hostname or ""
            if any(domain == item or domain.endswith("." + item) for item in exclude):
                continue
            if window and published and not window.start <= published[:10] <= window.end:
                continue
            hits.append(
                SearchHit(
                    url=url, title=title, published_at=published, score=scores[i], doc_id=doc_id
                )
            )
            if len(hits) == count:
                break
        return hits


def open_index(path: Path) -> LocalIndex:
    changed = path.stat().st_mtime_ns
    cached = INDEXES.get(path)
    if cached and cached[0] == changed:
        return cached[1]
    with INDEX_LOCK:
        cached = INDEXES.get(path)
        if cached and cached[0] == changed:
            return cached[1]
        result = LocalIndex(path)
        if len(INDEXES) >= 4:
            INDEXES.pop(next(iter(INDEXES)), None)
        INDEXES[path] = (changed, result)
        return result


def build_snapshot(root: Path, snapshot_id: str, runs: list[m.RunDetail]) -> m.SnapshotInfo:
    folder = root / "snapshots" / safe_id(snapshot_id)
    if (folder / "manifest.json").exists():
        raise ValueError("快照已冻结，请使用新的标识符")
    pages: dict[str, Page] = {}
    for run in runs:
        for doc in run.documents:
            filename = file_key(canonical_url(doc.url)) + ".json"
            recorded = root / "retrieval" / run.id / "pages" / filename
            cached = recorded if recorded.is_file() else root / "cache/pages" / filename
            try:
                page = Page.model_validate(read_json(cached)["value"])
            except (OSError, ValidationError, ValueError, KeyError):
                continue
            pages[canonical_url(page.final_url)] = page
    if not pages:
        raise ValueError("指定运行没有缓存正文")
    info = m.SnapshotInfo(id=snapshot_id, label=snapshot_id, created_at=now(), entries=len(pages))
    text = "".join(pages[key].model_dump_json() + "\n" for key in sorted(pages))
    write_text(folder / "documents.jsonl", text)
    LocalIndex(folder / "documents.jsonl").save()
    write_json(
        folder / "manifest.json",
        {
            "info": json.loads(info.model_dump_json()),
            "runs": [run.id for run in runs],
            "documents_sha256": file_key(text),
        },
    )
    return info
