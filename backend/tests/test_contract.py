"""校验契约样例、HTTP 响应、流折叠和分页。"""

import json
from pathlib import Path

from fastapi.testclient import TestClient
from jsonschema import Draft7Validator

from newsagent.contracts import models as m
from newsagent.main import create_app
from newsagent.runtime.state import apply_event, empty_detail, initial_summary
from newsagent.settings import Environment

ROOT = Path(__file__).resolve().parents[2] / "contracts"
SCHEMA = json.loads((ROOT / "schema.json").read_text(encoding="utf-8"))


def fixture(name):
    return json.loads((ROOT / "fixtures" / f"{name}.json").read_text(encoding="utf-8"))


def validates(name, value):
    Draft7Validator(
        {"definitions": SCHEMA["definitions"], "$ref": f"#/definitions/{name}"}
    ).validate(value)


def received_events(body):
    return [
        json.loads(line[6:])
        for line in body.splitlines()
        if line.startswith("data: ") and line != "data: {}"
    ]


def test_fixture_folds():
    for name in ("run", "run_partial", "run_failed"):
        snapshot = m.RunDetail.model_validate(fixture(f"{name}_snapshot"))
        state = empty_detail(
            initial_summary(snapshot.id, snapshot.request, snapshot.budget, snapshot.created_at)
        )
        for data in fixture(f"{name}_events"):
            validates("RunEvent", data)
            state = apply_event(state, m.EVENT_ADAPTER.validate_python(data))
        assert state == snapshot


def test_http_contract(tmp_path):
    app = create_app(Environment(newsagent_data_dir=tmp_path), fixture_mode=True)
    with TestClient(app) as client:
        for endpoint, kind in (
            ("health", "HealthResponse"),
            ("config", "AppConfig"),
            ("runs", "RunListResponse"),
        ):
            response = client.get(f"/api/{endpoint}")
            assert response.status_code == 200
            validates(kind, response.json())
        assert client.get("/api/experiments").json() == []
        created = client.post("/api/runs", json=fixture("run_request"))
        assert created.status_code == 201
        validates("RunSummary", created.json())
        run_id = created.json()["id"]
        response = client.get(f"/api/runs/{run_id}/events")
        assert response.text.endswith("event: end\ndata: {}\n\n")
        events = received_events(response.text)
        state = empty_detail(m.RunSummary.model_validate(created.json()))
        for ev in events:
            validates("RunEvent", ev)
            state = apply_event(state, m.EVENT_ADAPTER.validate_python(ev))
        assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
        final = client.get(f"/api/runs/{run_id}").json()
        validates("RunDetail", final)
        assert state.model_dump(mode="json") == final
        midpoint = events[len(events) // 2]["seq"]
        resumed = client.get(f"/api/runs/{run_id}/events", params={"after": midpoint})
        assert received_events(resumed.text) == events[midpoint:]
        export = client.get(f"/api/runs/{run_id}/export")
        assert export.headers["content-type"].startswith("text/markdown")
        assert "[1]" in export.text and "Sources" in export.text
        assert client.get(f"/api/runs/{run_id}/export?format=json").json() == final
        assert client.post(f"/api/runs/{run_id}/cancel").status_code == 409

        new = client.post("/api/runs", json=fixture("run_request")).json()
        active = client.post(f"/api/runs/{new['id']}/cancel")
        assert active.json()["status"] == "cancelled"
        validates("RunSummary", active.json())
        first = client.get("/api/runs?limit=1").json()
        second = client.get("/api/runs", params={"limit": 1, "cursor": first["next_cursor"]}).json()
        assert first["items"][0]["id"] != second["items"][0]["id"]
        assert client.delete(f"/api/runs/{new['id']}").status_code == 204
        assert client.get(f"/api/runs/{new['id']}").status_code == 404

        invalid = client.post("/api/runs", json=fixture("run_request") | {"question": "  "})
        assert invalid.status_code == 422
        assert invalid.json()["error"]["details"] is None
        assert (
            client.post(
                "/api/runs",
                json=fixture("run_request")
                | {
                    "budget_preset": "custom",
                    "budget": {"max_seconds": 20},
                },
            ).status_code
            == 422
        )


def test_experiment_endpoints(tmp_path):
    from newsagent.tools.storage import write_json

    detail = fixture("experiment_detail")
    folder = tmp_path / "experiments" / detail["id"]
    summary = m.ExperimentSummary.model_validate(
        {key: detail[key] for key in m.ExperimentSummary.model_fields}
    )
    write_json(folder / "manifest.json", {"summary": summary.model_dump(mode="json")})
    write_json(folder / "summary.json", detail)
    with TestClient(
        create_app(Environment(newsagent_data_dir=tmp_path), fixture_mode=True)
    ) as client:
        for item in client.get("/api/experiments").json():
            validates("ExperimentSummary", item)
        response = client.get(f"/api/experiments/{detail['id']}")
        assert response.status_code == 200
        validates("ExperimentDetail", response.json())
        assert client.get("/api/experiments/unknown").status_code == 404
