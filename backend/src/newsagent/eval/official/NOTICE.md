# 第三方评测提示词

本目录中的文本从官方评测仓库原样抽取（未修改），用于按官方协议复现评分：

| 文件 | 来源 | 许可 |
|---|---|---|
| `race_score_en.txt` / `race_score_zh.txt` | DeepResearch Bench `prompt/score_prompt_{en,zh}.py` 中的 `generate_merged_score_prompt`（https://github.com/Ayanami0730/deep_research_bench） | Apache-2.0 |
| `fact_validate_en.txt` / `fact_validate_zh.txt` | DeepResearch Bench `utils/validate.py` 中的 `prompt_template_en` / `prompt_template` | Apache-2.0 |
| `browsecomp_grader.txt` | BrowseComp-Plus `scripts_evaluation/evaluate_run.py` 中的 `GRADER_TEMPLATE`（https://github.com/texttron/BrowseComp-Plus） | MIT |

与官方实现的差异（评委模型、文章清洗方式等）记录在 `docs/evaluation-spec.md` 的「与官方协议的差异」一节（§10.3）。
