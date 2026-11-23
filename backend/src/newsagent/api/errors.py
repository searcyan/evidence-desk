"""对外提供一致的错误响应。"""

from fastapi.responses import JSONResponse


class APIError(Exception):
    def __init__(self, status: int, kind: str, message: str):
        super().__init__(message)
        self.status, self.kind = status, kind

    def response(self) -> JSONResponse:
        return JSONResponse(
            {
                "error": {
                    "type": self.kind,
                    "message": str(self),
                    "details": None,
                }
            },
            status_code=self.status,
            media_type="application/json; charset=utf-8",
        )


def invalid(message: str) -> APIError:
    return APIError(422, "validation_error", message)


def conflict(message: str) -> APIError:
    return APIError(409, "conflict", message)


def not_found(message: str) -> APIError:
    return APIError(404, "not_found", message)
