"""直接访问 OpenAI 兼容服务，校验结构化输出和供应商用量。"""

import json
from dataclasses import dataclass
from typing import Any

import httpx
from pydantic import BaseModel

from ..settings import Profile


class InvalidOutput(ValueError):
    pass


@dataclass
class Usage:
    requests: int = 0
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


async def complete[T: BaseModel](
    client: httpx.AsyncClient,
    profile: Profile,
    key: str,
    model_name: str,
    prompt: str,
    schema: type[T],
    total: int,
    max_output: int,
    usage: Usage,
) -> T:
    # 提案约定使用 PydanticAI 做类型化输出；complete_http 仅作为测试与排障用的直连实现
    from .pydantic_provider import complete_pydantic

    return await complete_pydantic(
        client, profile, key, model_name, prompt, schema, total, max_output, usage
    )


async def complete_http[T: BaseModel](
    client: httpx.AsyncClient,
    profile: Profile,
    key: str,
    model_name: str,
    prompt: str,
    schema: type[T],
    max_output: int,
    usage: Usage,
) -> T:
    definition = schema.model_json_schema()
    payload: dict[str, Any] = {"model": model_name, "max_tokens": max_output, **profile.extra_body}
    if profile.structured_output == "tool":
        payload.update(
            tools=[
                {
                    "type": "function",
                    "function": {
                        "name": "submit_result",
                        "description": "Return the validated result",
                        "parameters": definition,
                    },
                }
            ],
            tool_choice={"type": "function", "function": {"name": "submit_result"}},
        )
    elif profile.structured_output == "native":
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "result",
                "schema": definition,
            },
        }
    else:
        prompt += "\nReturn a JSON object with this schema:\n" + json.dumps(definition)
        payload["response_format"] = {"type": "json_object"}
    payload["messages"] = [{"role": "user", "content": prompt}]
    response = await client.post(
        profile.endpoint().rstrip("/") + "/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json=payload,
    )
    response.raise_for_status()
    body = response.json()
    raw_usage = body.get("usage")
    if not isinstance(raw_usage, dict):
        raise InvalidOutput("模型未返回可计量的用量")
    usage.requests = 1
    try:
        usage.input_tokens = max(0, int(raw_usage["prompt_tokens"]))
        usage.output_tokens = max(0, int(raw_usage["completion_tokens"]))
        message = body["choices"][0]["message"]
        raw = message["content"]
        if profile.structured_output == "tool":
            raw = message["tool_calls"][0]["function"]["arguments"]
        return schema.model_validate_json(raw)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise InvalidOutput("模型返回无效结构化输出") from exc
