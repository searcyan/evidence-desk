"""按首次引用顺序导出报告和可追溯的来源编号。"""

from ..contracts import models as m


def export_markdown(run: m.RunDetail) -> str:
    report = run.report
    zh = (report.language if report else run.request.report_language) == "zh"
    labels = (
        ("截止时间", "模式", "答案", "时间线", "日期", "事件", "未解决问题", "停止原因", "参考来源")
        if zh
        else (
            "Cutoff",
            "Mode",
            "Answer",
            "Timeline",
            "Date",
            "Event",
            "Open questions",
            "Stop reason",
            "Sources",
        )
    )
    lines = [
        f"# {report.title if report else run.title}",
        "",
        f"{labels[0]} {run.request.cutoff}",
        f"{labels[1]} {run.request.temporal_mode}",
        "",
    ]
    if report is None:
        lines.append("暂无可导出的报告。" if zh else "No report is available yet.")
        return "\n".join(lines) + "\n"
    evidence = {item.id: item.document_id for item in run.evidence}
    documents = {item.id: item for item in run.documents}
    citations: dict[str, int] = {}

    def paragraph(item: m.ReportParagraph) -> str:
        result = []
        for sentence in item.sentences:
            refs = []
            for evidence_id in sentence.evidence_ids:
                doc_id = evidence.get(evidence_id)
                if doc_id is not None and doc_id in documents:
                    refs.append(citations.setdefault(doc_id, len(citations) + 1))
            suffix = "".join(f"[{n}]" for n in dict.fromkeys(refs))
            result.append(sentence.text + (" " + suffix if suffix else ""))
        return " ".join(result)

    lines.extend([f"## {labels[2]}", "", paragraph(report.answer), ""])
    for section in report.sections:
        if section.kind == "answer":
            continue
        lines.extend([f"## {section.title}", ""])
        for item in section.paragraphs:
            lines.extend([paragraph(item), ""])
    if run.timeline:
        lines.extend([f"## {labels[3]}", "", f"| {labels[4]} | {labels[5]} |", "| --- | --- |"])
        for item in run.timeline:
            date = (
                item.date.start
                if item.date.start == item.date.end
                else (f"{item.date.start} – {item.date.end}")
            )
            content = (item.title + ". " + item.summary).replace("|", r"\|").replace("\n", " ")
            lines.append(f"| {date} | {content} |")
        lines.append("")
    if report.open_questions:
        lines.extend([f"## {labels[6]}", "", *[f"- {q}" for q in report.open_questions], ""])
    if report.stop_reason:
        lines.extend([f"{labels[7]} {report.stop_reason}", ""])
    if citations:
        lines.extend([f"## {labels[8]}", ""])
        original = {
            True: "原始来源" if zh else "original",
            False: "转载" if zh else "republication",
            None: "原始来源未知" if zh else "origin unknown",
        }
        for doc_id, number in citations.items():
            doc = documents[doc_id]
            lines.append(
                f"- [{number}] {doc.title} · {doc.publisher or doc.domain} · "
                f"{doc.published_at or '—'} · {original[doc.is_original]} · {doc.url}"
            )
    return "\n".join(lines).rstrip() + "\n"
