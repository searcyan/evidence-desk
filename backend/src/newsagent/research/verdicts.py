"""根据可用证据和独立来源计算声明状态。"""

from ..contracts import models as m


def verdict(
    links: list[m.ClaimEvidenceLink],
    evidence: dict[str, m.Evidence],
    documents: dict[str, m.SourceDocument],
    mode: m.TemporalMode,
) -> tuple[m.Verdict, set[str]]:
    support: set[str] = set()
    refute: set[str] = set()
    for link in links:
        item = evidence.get(link.evidence_id)
        doc = documents.get(item.document_id) if item else None
        if doc is None or (mode == "as_of" and doc.available_at_cutoff is False):
            continue
        group = doc.origin_group_id or doc.id
        if link.relation == "supports":
            support.add(group)
        elif link.relation == "contradicts":
            refute.add(group)
    if support and refute:
        return "conflicting", support
    if support:
        return "supported", support
    if refute:
        return "contradicted", support
    return "insufficient", support


def applicable(
    event: m.DateRef | None, cutoff: str, mode: m.TemporalMode, known_support: bool
) -> bool | None:
    if event is None:
        return None
    if event.start > cutoff[:10]:
        return False
    return True if mode == "retrospective" or known_support else None
