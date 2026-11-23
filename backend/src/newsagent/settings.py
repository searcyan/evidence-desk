"""加载环境变量和可复现实验配置。"""

import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import yaml
from dotenv import dotenv_values
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .contracts.models import (
    AppConfig,
    AppConfigBudgetPresets,
    AppConfigDefaults,
    BudgetLimits,
    ModelProfile,
    ModelProfileRoles,
    ModelRole,
    RunRequest,
)

ROOT = Path(__file__).resolve().parents[2]
SETTINGS_FILE = ROOT / "config" / "settings.yaml"
ENV_FILE = ROOT / ".env"


class Environment(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")
    newsagent_data_dir: Path = ROOT.parent / "data"
    newsagent_host: str = "127.0.0.1"
    newsagent_port: int = Field(default=8000, ge=1, le=65535)
    newsagent_max_concurrent_runs: int = Field(default=2, ge=1)
    clarification_timeout_seconds: float = Field(default=1800, ge=0)
    newsagent_cache_hours: float = Field(default=24, ge=0)
    log_level: str = "INFO"


class Profile(BaseModel):
    id: str
    label: str
    base_url_env: str
    api_key_env: str
    roles: dict[ModelRole, str]
    structured_output: Literal["tool", "native", "prompted"]
    # 按角色覆盖结构化输出模式（例如长篇嵌套的写作输出用 native 约束解码）
    role_output: dict[ModelRole, Literal["tool", "native", "prompted"]] = Field(
        default_factory=dict
    )
    # 透传给 OpenAI 兼容端点的额外请求字段（例如关闭思考模式），会写入实验清单以便复现
    extra_body: dict[str, object] = Field(default_factory=dict)

    def endpoint(self) -> str:
        return env_value(self.base_url_env) or "https://api.deepseek.com/v1"

    def public(self) -> ModelProfile:
        return ModelProfile(
            id=self.id,
            label=self.label,
            provider=urlsplit(self.endpoint()).hostname or "",
            roles=ModelProfileRoles.model_validate(self.roles),
        )


class Price(BaseModel):
    input: float = Field(ge=0)
    output: float = Field(ge=0)


class Stopping(BaseModel):
    core_coverage_threshold: float = Field(ge=0, le=1)
    no_progress_rounds_limit: int = Field(ge=1)
    min_round_budget_ratio: float = Field(ge=0, le=1)


ProviderId = Literal["tavily", "exa"]


class Research(BaseModel):
    default_lookback_days: int = Field(ge=1)
    max_actions_per_round: int = Field(ge=1)
    search_results_per_query: int = Field(ge=1, le=20)
    max_reads_per_round: int = Field(ge=1)
    action_concurrency: int = Field(ge=1)
    news_order: list[ProviderId]
    verification_order: list[ProviderId]


class Configuration(BaseModel):
    model_profiles: list[Profile]
    default_model_profile: str
    prices_usd_per_mtok: dict[str, Price]
    budget_presets: AppConfigBudgetPresets
    stopping: Stopping
    research: Research
    defaults: AppConfigDefaults

    def profile(self, key: str | None) -> Profile:
        selected = key or self.default_model_profile
        for profile in self.model_profiles:
            if profile.id == selected:
                return profile
        raise ValueError("指定的模型配置不存在")

    def budget(self, request: RunRequest) -> BudgetLimits:
        overrides = request.budget.model_dump(exclude_unset=True) if request.budget else {}
        if request.budget_preset == "custom":
            return BudgetLimits.model_validate(overrides)
        limits = getattr(self.budget_presets, request.budget_preset).model_dump()
        return BudgetLimits.model_validate(limits | overrides)


def env_value(name: str) -> str:
    return (os.environ.get(name, dotenv_values(ENV_FILE).get(name)) or "").strip()


def load_settings() -> Configuration:
    with SETTINGS_FILE.open(encoding="utf-8") as fh:
        config = Configuration.model_validate(yaml.safe_load(fh))
    config.profile(None)
    return config


def data_dir(environment: Environment) -> Path:
    path = environment.newsagent_data_dir
    return path if path.is_absolute() else (ROOT / path).resolve()


def public_config(config: Configuration, root: Path, mode: Literal["live", "mock"]) -> AppConfig:
    from .tools.local_index import snapshot_infos

    return AppConfig.model_validate(
        {
            "mode": mode,
            "version": "0.1.0",
            "model_profiles": [profile.public() for profile in config.model_profiles],
            "default_model_profile": config.default_model_profile,
            "search_providers": [
                {"id": "tavily", "available": bool(env_value("TAVILY_API_KEY"))},
                {"id": "exa", "available": bool(env_value("EXA_API_KEY"))},
                {
                    "id": "corpus",
                    "available": (
                        root / "benchmarks/browsecomp_plus/corpus/corpus.sqlite"
                    ).is_file(),
                },
            ],
            "snapshots": snapshot_infos(root),
            "budget_presets": config.budget_presets,
            "defaults": config.defaults,
        }
    )
