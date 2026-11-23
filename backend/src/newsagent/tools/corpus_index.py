"""BrowseComp-Plus 固定语料（约 10 万篇）的 BM25 检索。

使用 SQLite FTS5（porter 词干化 + 内置 bm25() 排序，k1=1.2、b=0.75）对全文建索引：
索引与正文都在磁盘上，检索时不需要把语料载入内存。官方基线使用 Pyserini/Lucene BM25（k1=0.9、b=0.4），
参数差异在 evaluation-spec.md 的实现差异中注明。
"""

import re
import sqlite3
from pathlib import Path
from threading import Lock
from urllib.parse import quote, unquote, urlsplit

from ..contracts import models as m
from .search import Page, SearchHit, canonical_url

CORPUS_DIR = Path("benchmarks/browsecomp_plus/corpus")
LOCAL_PREFIX = "https://corpus.local/document/"
WORDS = re.compile(r"[^\W_]+", re.UNICODE)
_CACHE: dict[Path, "CorpusIndex"] = {}
_LOCK = Lock()


def build_corpus(parquet_files: list[Path], folder: Path, batch_size: int = 2000) -> int:
    """从官方 parquet 分片构建 FTS5 索引库，返回文档数。"""
    import pyarrow.parquet as pq

    folder.mkdir(parents=True, exist_ok=True)
    db_path = folder / "corpus.sqlite"
    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(
        """
        CREATE TABLE docs (n INTEGER PRIMARY KEY, docid TEXT UNIQUE, url TEXT, title TEXT, text TEXT);
        CREATE VIRTUAL TABLE fts USING fts5(
            title, text, content='docs', content_rowid='n', tokenize='porter unicode61'
        );
        """
    )
    count = 0
    for path in sorted(parquet_files):
        for batch in pq.ParquetFile(path).iter_batches(
            batch_size=batch_size, columns=["docid", "text", "url"]
        ):
            rows = []
            for r in batch.to_pylist():
                text = r.get("text") or ""
                title = text.strip().splitlines()[0][:200] if text.strip() else str(r["docid"])
                rows.append((count, str(r["docid"]), r.get("url") or "", title, text))
                count += 1
            db.executemany("INSERT INTO docs VALUES (?, ?, ?, ?, ?)", rows)
            db.executemany(
                "INSERT INTO fts (rowid, title, text) VALUES (?, ?, ?)",
                [(n, title, text) for n, _, _, title, text in rows],
            )
    db.execute("CREATE INDEX docs_url ON docs(url)")
    db.execute("INSERT INTO fts(fts) VALUES ('optimize')")
    db.commit()
    db.close()
    return count


def frontmatter(text: str) -> tuple[str | None, str | None]:
    """解析官方语料文档开头的 YAML 头信息（title / date 两行，前后以 --- 包围），返回 (标题, 日期)。"""
    if not text.startswith("---"):
        return None, None
    head = text[3:].split("\n---", 1)[0]
    title = date = None
    for line in head.splitlines():
        key, _, value = line.partition(":")
        if key.strip() == "title" and value.strip():
            title = value.strip()[:200]
        elif key.strip() == "date" and value.strip():
            date = value.strip()[:10]
    return title, date


def match_query(query: str) -> str | None:
    words = list(dict.fromkeys(w.casefold() for w in WORDS.findall(query)))[:48]
    return " OR ".join('"' + w.replace('"', "") + '"' for w in words) if words else None


class CorpusIndex:
    def __init__(self, folder: Path):
        self.db_path = folder / "corpus.sqlite"
        if not self.db_path.is_file():
            raise FileNotFoundError(self.db_path)

    def _db(self) -> sqlite3.Connection:
        return sqlite3.connect(f"file:{self.db_path.as_posix()}?mode=ro", uri=True)

    @staticmethod
    def doc_url(docid: str, url: str) -> str:
        return url or LOCAL_PREFIX + quote(docid, safe="")

    def search(
        self, query: str, window: m.TimeWindow | None, count: int, exclude: list[str]
    ) -> list[SearchHit]:
        del window  # 固定语料不按日期过滤
        expression = match_query(query)
        if not expression:
            return []
        db = self._db()
        try:
            rows = db.execute(
                """
                SELECT d.docid, d.url, d.title, substr(d.text, 1, 400), bm25(fts) AS score
                FROM fts JOIN docs d ON d.n = fts.rowid
                WHERE fts MATCH ? ORDER BY score LIMIT ?
                """,
                (expression, count * 3),
            ).fetchall()
        finally:
            db.close()
        hits: list[SearchHit] = []
        for docid, url, title, snippet, score in rows:
            title = frontmatter(snippet)[0] or title
            domain = urlsplit(url).hostname or ""
            if any(domain == item or domain.endswith("." + item) for item in exclude):
                continue
            hits.append(
                SearchHit(
                    url=self.doc_url(docid, url),
                    title=title,
                    snippet=snippet,
                    score=-float(score),
                    doc_id=docid,
                )
            )
            if len(hits) == count:
                break
        return hits

    def read(self, url: str) -> Page:
        db = self._db()
        try:
            if url.startswith(LOCAL_PREFIX):
                cursor = db.execute(
                    "SELECT docid, url, title, text FROM docs WHERE docid = ?",
                    (unquote(url.removeprefix(LOCAL_PREFIX)),),
                )
            else:
                cursor = db.execute(
                    "SELECT docid, url, title, text FROM docs WHERE url = ? OR url = ? LIMIT 1",
                    (url, canonical_url(url)),
                )
            found = cursor.fetchone()
        finally:
            db.close()
        if found is None:
            raise KeyError(url)
        docid, doc_url, title, text = found
        address = self.doc_url(docid, doc_url)
        parsed_title, date = frontmatter(text)
        return Page(
            url=address,
            final_url=address,
            title=parsed_title or title,
            text=text,
            doc_id=docid,
            published_at=f"{date}T00:00:00Z" if date and len(date) == 10 else None,
            published_at_source="metadata" if date else "unknown",
        )


def open_corpus(folder: Path) -> CorpusIndex:
    with _LOCK:
        if folder not in _CACHE:
            _CACHE[folder] = CorpusIndex(folder)
        return _CACHE[folder]
