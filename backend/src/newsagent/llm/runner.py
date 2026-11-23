"""集中选择模型、校验结构化输出并记录用量。"""

import asyncio
import json
import os
import random
from collections.abc import Mapping
from pathlib import Path
from time import monotonic
from typing import Protocol

import httpx
from jinja2 import Environment, PackageLoader, StrictUndefined
from pydantic import BaseModel
from pydantic_ai.exceptions import ModelAPIError

from ..contracts.models import ModelRole
from ..runtime.budget import BudgetExceeded, BudgetTracker
from ..settings import Price, Profile, env_value
from .openai_compat import InvalidOutput, Usage, complete

TEMPLATES = Environment(
    loader=PackageLoader("newsagent", "llm/prompts"), undefined=StrictUndefined, autoescape=False
)


class ModelFailure(Exception):
    pass


_INFLIGHT: dict[int, asyncio.Semaphore] = {}


def inflight() -> asyncio.Semaphore:
    """进程级的模型请求并发上限（NEWSAGENT_MAX_LLM_INFLIGHT，默认 4），避免触发账号级限流。"""
    loop = id(asyncio.get_running_loop())
    if loop not in _INFLIGHT:
        _INFLIGHT[loop] = asyncio.Semaphore(int(os.environ.get("NEWSAGENT_MAX_LLM_INFLIGHT", "4")))
    return _INFLIGHT[loop]


class ModelRunner(Protocol):
    async def run[T: BaseModel](
        self,
        role: ModelRole,
        name: str,
        inputs: Mapping[str, object],
        schema: type[T],
        *,
        research: bool = True,
    ) -> T: ...


class LLM:
    def __init__(
        self, profile: Profile, prices: dict[str, Price], tracker: BudgetTracker, log_path: Path
    ):
        self.profile, self.prices, self.tracker, self.log_path = profile, prices, tracker, log_path
        self.client: httpx.AsyncClient | None = None

    async def close(self) -> None:
        if self.client:
            await self.client.aclose()

    async def run[T: BaseModel](
        self,
        role: ModelRole,
        name: str,
        inputs: Mapping[str, object],
        schema: type[T],
        *,
        research: bool = True,
    ) -> T:
        model_name = self.profile.roles[role]
        profile = (
            self.profile.model_copy(update={"structured_output": self.profile.role_output[role]})
            if role in self.profile.role_output
            else self.profile
        )
        key = env_value(self.profile.api_key_env)
        if not key:
            raise ModelFailure("模型密钥尚未配置")
        price = self.prices.get(model_name)
        if price is None:
            raise ModelFailure("当前模型缺少价格配置")
        if self.client is None:
            # 评分调用（如 RACE 逐条打分，评委默认开启思考）可能持续数分钟；研究调用另受运行时间预算约束
            self.client = httpx.AsyncClient(timeout=httpx.Timeout(900, connect=15))
        prompt = TEMPLATES.get_template(f"{name}.md.j2").render(
            payload=json.dumps(inputs, ensure_ascii=False, separators=(",", ":")),
            inputs=inputs,
            report_language=inputs.get("language", "en"),
        )
        base_estimate = len(prompt.encode()) + len(json.dumps(schema.model_json_schema()).encode())
        correction = ""
        validation_failures = network_failures = attempts = 0
        while True:
            backoff = 0
            # 锁只保护"预检 + 预扣"，网络请求在锁外进行，使同一运行内的模型调用可以真正并发
            async with self.tracker.lock:
                estimate = base_estimate + len(correction.encode()) + 512
                total, max_output = self.tracker.model_limits(estimate, price, research)
                reservation = self.tracker.reserve(
                    estimate + max_output,
                    (estimate * price.input + max_output * price.output) / 1e6,
                )
            usage = Usage()
            started = monotonic()
            attempts += 1
            error: str | None = None
            try:
                async with inflight(), asyncio.timeout(self.tracker.seconds_left(research)):
                    answer = await complete(
                        self.client,
                        profile,
                        key,
                        model_name,
                        prompt + correction,
                        schema,
                        total,
                        max_output,
                        usage,
                    )
                if usage.total_tokens > total:
                    raise BudgetExceeded()
                return answer
            except TimeoutError as exc:
                raise BudgetExceeded("time_limit") from exc
            except InvalidOutput as exc:
                error = str(exc)[:600]
                if usage.total_tokens > total:
                    raise BudgetExceeded() from exc
                validation_failures += 1
                if validation_failures > 2:
                    raise ModelFailure("模型结构化输出校验失败") from exc
                correction = "\nThe prior output was invalid. Match the schema exactly."
            except Exception as exc:
                status = (
                    exc.response.status_code
                    if isinstance(exc, httpx.HTTPStatusError)
                    else getattr(exc, "status_code", None)
                )
                # ModelAPIError 无状态码时为超时 / 连接中断（ModelHTTPError 是其子类，带状态码）
                retryable = (
                    isinstance(exc, httpx.TransportError)
                    or (isinstance(exc, ModelAPIError) and status is None)
                    or (isinstance(status, int) and (status == 429 or status >= 500))
                )
                if isinstance(exc, BudgetExceeded):
                    raise
                error = f"{type(exc).__name__} status={status}"
                # 429（账号限流）比一般故障更常见且可恢复：允许更多次、更长的退避
                limit = 8 if status == 429 else 3
                if not retryable or network_failures >= limit:
                    raise ModelFailure(f"模型服务请求失败：{type(exc).__name__}") from exc
                network_failures += 1
                backoff = min(60.0, 2.0**network_failures) + random.uniform(0, 2)
            finally:
                # 被拒绝的请求（无用量）不计为一次模型调用
                requests = usage.requests
                self.tracker.release(reservation)
                self.tracker.model_usage(requests, usage.input_tokens, usage.output_tokens, price)
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                record = {
                    "role": role,
                    "template": name,
                    "model": model_name,
                    "requests": requests,
                    "input_tokens": usage.input_tokens,
                    "output_tokens": usage.output_tokens,
                    "cost_usd": (
                        usage.input_tokens * price.input + usage.output_tokens * price.output
                    )
                    / 1e6,
                    "duration_ms": int((monotonic() - started) * 1000),
                    "retry": attempts > 1,
                    "error": error,
                }
                with self.log_path.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            if backoff:
                # 限流等待属于外部服务约束，不计入运行的时间预算
                await asyncio.sleep(backoff)
                self.tracker.pause_seconds += backoff
