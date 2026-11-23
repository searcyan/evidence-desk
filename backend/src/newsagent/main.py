"""FastAPI 应用入口与配置、运行和实验接口。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal, get_args

from fastapi import FastAPI, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.exceptions import HTTPException

from .api.errors import APIError, invalid, not_found
from .contracts import models as m
from .reporting.export_md import export_markdown
from .runtime.fake import fake_workflow
from .runtime.manager import RunManager, Workflow
from .runtime.store import Store
from .settings import Configuration, Environment, data_dir, env_value, load_settings, public_config
from .tools.storage import read_json, safe_id


class JsonResponse(JSONResponse):
    media_type = "application/json; charset=utf-8"


def create_app(
    environment: Environment | None = None,
    configuration: Configuration | None = None,
    workflow: Workflow | None = None,
    *,
    fixture_mode: bool = False,
) -> FastAPI:
    env = environment or Environment()
    config = configuration or load_settings()
    root = data_dir(env)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        from .workflow.controller import run_workflow

        selected = workflow or (fake_workflow if fixture_mode else run_workflow)
        manager = RunManager(Store(root / "app.db"), env, config, selected)
        manager.recover()
        application.state.manager = manager
        try:
            yield
        finally:
            await manager.close()

    application = FastAPI(
        title="Evidence Desk", lifespan=lifespan, default_response_class=JsonResponse
    )

    def manager(request: Request) -> RunManager:
        return request.app.state.manager

    @application.exception_handler(APIError)
    async def api_error(_request: Request, error: APIError) -> JSONResponse:
        return error.response()

    @application.exception_handler(RequestValidationError)
    async def validation(_request: Request, error: RequestValidationError) -> JSONResponse:
        location = ".".join(str(i) for i in error.errors()[0]["loc"])
        return invalid(f"请求字段无效：{location}").response()

    @application.exception_handler(HTTPException)
    async def http_error(_request: Request, error: HTTPException) -> JSONResponse:
        kind = {
            404: "not_found",
            409: "conflict",
            422: "validation_error",
            429: "rate_limited",
        }.get(error.status_code, "internal_error")
        return APIError(error.status_code, kind, "请求无法处理").response()

    @application.exception_handler(Exception)
    async def internal_error(_request: Request, _error: Exception) -> JSONResponse:
        return APIError(500, "internal_error", "服务内部错误").response()

    @application.get("/api/health")
    async def health(request: Request) -> m.HealthResponse:
        info = {
            "database": manager(request).store.ready(),
            "llm": fixture_mode or bool(env_value(config.profile(None).api_key_env)),
            "tavily": bool(env_value("TAVILY_API_KEY")),
            "exa": bool(env_value("EXA_API_KEY")),
        }
        return m.HealthResponse(
            status="ok"
            if info["database"] and info["llm"] and (info["tavily"] or info["exa"] or fixture_mode)
            else "degraded",
            checks={
                key: m.HealthResponseChecksValue(
                    ok=value,
                    detail=None if value else "不可用或尚未配置",
                )
                for key, value in info.items()
            },
        )

    @application.get("/api/config")
    async def app_config() -> m.AppConfig:
        return public_config(config, root, "mock" if fixture_mode else "live")

    @application.post("/api/runs", status_code=201)
    async def start(body: m.RunRequest, request: Request) -> m.RunSummary:
        return manager(request).start(body)

    @application.get("/api/runs")
    async def runs(
        request: Request,
        status: str = "",
        q: str = "",
        limit: Annotated[int, Query(ge=1, le=250)] = 50,
        cursor: str | None = None,
    ) -> m.RunListResponse:
        statuses = status.split(",") if status else None
        if statuses and any(s not in get_args(m.RunStatus) for s in statuses):
            raise invalid("未知的运行状态")
        key = None
        if cursor:
            created, sep, run_id = cursor.partition("|")
            if not sep or not run_id.startswith("run_"):
                raise invalid("分页游标无效")
            try:
                key = (m.normalize_datetime(created), safe_id(run_id))
            except ValueError as exc:
                raise invalid("分页游标无效") from exc
        items = manager(request).store.list(statuses, q.strip(), limit + 1, key)
        next_cursor = (
            f"{items[limit - 1].created_at}|{items[limit - 1].id}" if len(items) > limit else None
        )
        return m.RunListResponse(items=items[:limit], next_cursor=next_cursor)

    @application.get("/api/runs/{run_id}")
    async def detail(run_id: str, request: Request) -> m.RunDetail:
        return manager(request).bus(run_id).state

    @application.get("/api/runs/{run_id}/events")
    async def events(
        run_id: str, request: Request, after: Annotated[int, Query(ge=0)] = 0
    ) -> StreamingResponse:
        return StreamingResponse(
            manager(request).bus(run_id).stream(after),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @application.post("/api/runs/{run_id}/clarification")
    async def answer(run_id: str, body: m.ClarificationAnswer, request: Request) -> m.RunSummary:
        return manager(request).answer(run_id, body)

    @application.post("/api/runs/{run_id}/cancel")
    async def cancel(run_id: str, request: Request) -> m.RunSummary:
        return await manager(request).cancel(run_id)

    @application.post("/api/runs/{run_id}/resume")
    async def resume(run_id: str, request: Request) -> m.RunSummary:
        return manager(request).resume(run_id)

    @application.delete("/api/runs/{run_id}", status_code=204)
    async def delete(run_id: str, request: Request) -> Response:
        await manager(request).delete(run_id)
        return Response(status_code=204)

    @application.get("/api/runs/{run_id}/export")
    async def export(
        run_id: str, request: Request, format: Literal["md", "json"] = "md"
    ) -> Response:
        state = manager(request).bus(run_id).state
        if format == "json":
            return JsonResponse(
                state.model_dump(mode="json", exclude_none=False, exclude_unset=False)
            )
        return Response(
            export_markdown(state),
            media_type="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="report-{run_id}.md"'},
        )

    @application.get("/api/experiments")
    async def experiments() -> list[m.ExperimentSummary]:
        results = []
        for path in (root / "experiments").glob("*/manifest.json"):
            try:
                results.append(m.ExperimentSummary.model_validate(read_json(path)["summary"]))
            except (OSError, KeyError, ValueError):
                continue
        return sorted(results, key=lambda item: item.created_at, reverse=True)

    @application.get("/api/experiments/{exp_id}")
    async def experiment(exp_id: str) -> m.ExperimentDetail:
        try:
            path = root / "experiments" / safe_id(exp_id)
            if (path / "summary.json").is_file():
                return m.ExperimentDetail.model_validate(read_json(path / "summary.json"))
            summary = m.ExperimentSummary.model_validate(
                read_json(path / "manifest.json")["summary"]
            )
            return m.ExperimentDetail(
                **summary.model_dump(), metric_defs=[], results=[], tasks=[], budget_levels=[]
            )
        except (FileNotFoundError, ValueError) as exc:
            raise not_found("实验不存在") from exc

    return application


app = create_app()
