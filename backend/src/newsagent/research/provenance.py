"""通过正文近重复和明确归因归并转载。"""

import re
from collections.abc import Callable
from difflib import SequenceMatcher

from ..contracts import models as m
from ..runtime.state import stable_id
from ..tools.dates import day
from ..tools.search import Page


def normalize(text: str) -> str:
    return " ".join(re.findall(r"\w+", text.casefold()))


def shingles(text: str) -> set[tuple[str, ...]]:
    words = re.findall(r"[\u3400-\u9fff]|[^\W_]+", text.casefold())
    return {tuple(words[i : i + 5]) for i in range(len(words) - 4)}


def attribution(value: str | None) -> str:
    cleaned = normalize(value or "")
    return re.sub(r"^(?:according to|reported by|via|source) ", "", cleaned)


def origin_groups(
    documents: list[m.SourceDocument],
    previous: list[m.OriginGroup],
    fetch: Callable[[m.SourceDocument], Page | None],
) -> list[m.OriginGroup]:
    groups: dict[str, m.OriginGroup] = {g.id: g for g in previous}
    by_id = {doc.id: doc for doc in documents}
    fingerprints: dict[str, set[tuple[str, ...]]] = {}

    def fingerprint(doc: m.SourceDocument) -> set[tuple[str, ...]]:
        if doc.id not in fingerprints:
            page = fetch(doc)
            fingerprints[doc.id] = shingles(page.text[:30_000]) if page else set()
        return fingerprints[doc.id]

    def shared(a: m.SourceDocument, b: m.SourceDocument) -> bool:
        left, right = attribution(a.attribution), attribution(b.attribution)
        if left and left == right:
            return True
        for root, cited in ((a, right), (b, left)):
            if root.is_original and cited:
                title = normalize(root.title)
                if len(title) > 12 and title in cited:
                    return True
        if a.published_at and b.published_at:
            difference = abs((day(a.published_at) - day(b.published_at)).days)
            if (
                a.title
                and b.title
                and difference < 2
                and SequenceMatcher(
                    None,
                    normalize(a.title),
                    normalize(b.title),
                ).ratio()
                >= 0.94
            ):
                return True
        left_words, right_words = fingerprint(a), fingerprint(b)
        overlap = len(left_words & right_words)
        return overlap >= 5 and overlap / len(left_words | right_words) >= 0.6

    members = {doc_id for group in previous for doc_id in group.document_ids}
    for doc in documents:
        if doc.id in members:
            continue
        matches = [
            g
            for g in groups.values()
            if any(shared(doc, by_id[doc_id]) for doc_id in g.document_ids if doc_id in by_id)
        ]
        # 契约没有来源组删除事件，首次匹配保留稳定 ID。
        group = matches[0] if matches else None
        ids = [*group.document_ids, doc.id] if group else [doc.id]
        root = next((key for key in ids if by_id[key].is_original is True), None)
        label = (
            (by_id[root].publisher or by_id[root].title)
            if root
            else next((by_id[key].attribution for key in ids if by_id[key].attribution), None)
        )
        group_id = group.id if group else stable_id("og", doc.id)
        groups[group_id] = m.OriginGroup(
            id=group_id,
            label=label or doc.publisher or doc.domain,
            root_document_id=root,
            document_ids=ids,
            reason="正文或归因指向同一出处"
            if group
            else ("已识别原始文档" if root else "暂未发现同源文档"),
        )
    return list(groups.values())
