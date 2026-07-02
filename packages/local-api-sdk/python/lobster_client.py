"""Minimal Python client for the Lobster local automation API.

Uses only the stdlib (urllib) so it has zero dependencies.

Example
-------
    from lobster_client import LobsterClient

    client = LobsterClient(api_key="lb_...", port=53211)
    data = client.start("profile-id")
    # Selenium:
    #   opts = webdriver.ChromeOptions()
    #   opts.debugger_address = data["debuggerAddress"]
    # Playwright:
    #   browser = playwright.chromium.connect_over_cdp(data["ws"])
    client.stop("profile-id")

The full-featured SDK (retries, typed models) is fleshed out on Day 6.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any


class LobsterApiError(RuntimeError):
    pass


class LobsterClient:
    def __init__(self, api_key: str, host: str = "127.0.0.1", port: int = 53211) -> None:
        self.base = f"http://{host}:{port}/api/v1"
        self.api_key = api_key

    def _call(self, path: str, body: dict[str, Any] | None = None) -> Any:
        url = f"{self.base}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
        req.add_header("Authorization", f"Bearer {self.api_key}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req) as resp:  # noqa: S310 (loopback only)
            payload = json.loads(resp.read().decode())
        if payload.get("code") != 0:
            raise LobsterApiError(payload.get("msg", "lobster local api error"))
        return payload.get("data")

    def start(self, profile_id: str, headless: bool = False) -> dict[str, Any]:
        return self._call("/profile/start", {"profileId": profile_id, "headless": headless})

    def stop(self, profile_id: str) -> dict[str, Any]:
        return self._call("/profile/stop", {"profileId": profile_id})

    def status(self, profile_id: str) -> dict[str, Any]:
        q = urllib.parse.urlencode({"profileId": profile_id})
        return self._call(f"/profile/status?{q}")

    def list(self) -> list[dict[str, Any]]:
        return self._call("/profile/list")
