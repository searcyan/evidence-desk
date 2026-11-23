"""PydanticAI 适配器：OpenAI 兼容端点 + 类型化结构化输出 + 用量统计。"""

import httpx
from pydantic import BaseModel
from pydantic_ai import Agent, NativeOutput, PromptedOutput, ToolOutput
from pydantic_ai.exceptions import UnexpectedModelBehavior, UsageLimitExceeded
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.usage import RunUsage, UsageLimits

from ..settings import Profile
from .openai_compat import InvalidOutput, Usage


async def complete_pydantic[T: BaseModel](
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
    output = {"tool": ToolOutput, "native": NativeOutput, "prompted": PromptedOutput}[
        profile.structured_output
    ](schema)
    provider = OpenAIProvider(base_url=profile.endpoint(), api_key=key, http_client=client)
    agent = Agent(OpenAIChatModel(model_name, provider=provider), output_type=output, retries=0)
    counted = RunUsage()
    try:
        # 一律流式请求：部分网关会在约 60 秒无数据时断开非流式连接，长输出（评分、写作）会被截断
        async with agent.run_stream(
            prompt,
            usage=counted,
            model_settings={"max_tokens": max_output, "extra_body": profile.extra_body or None},
            usage_limits=UsageLimits(
                request_limit=1, total_tokens_limit=total, output_tokens_limit=max_output
            ),
        ) as result:
            output = await result.get_output()
        return schema.model_validate(output)
    except (UnexpectedModelBehavior, UsageLimitExceeded, ValueError) as exc:
        detail = " ".join(str(exc.__cause__ or exc).split())[:600]
        raise InvalidOutput(f"模型返回无效结构化输出：{detail}") from exc
    finally:
        usage.requests = counted.requests
        usage.input_tokens = counted.input_tokens
        usage.output_tokens = counted.output_tokens
