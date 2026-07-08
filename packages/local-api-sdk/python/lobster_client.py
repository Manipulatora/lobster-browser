"""Zero-dependency Python client for the Lobster **Local Automation API**.

The desktop core (Rust/Axum) exposes a loopback HTTP API — deliberately mirroring the proven
AdsPower/Octo contract — so existing automation ports over with near-zero friction. This module is
a thin, typed wrapper over that API: it builds the base URL once, attaches the Bearer key, enforces
a per-request timeout, retries transient network failures, and unwraps the ``{code, data, msg}``
envelope so callers work with plain dictionaries.

Uses only the standard library (``urllib``), so it has **zero third-party dependencies**.

Contract: ../../docs/contracts/local-automation-api.md

Example
-------
    from lobster_client import LobsterClient

    # A context manager keeps the connection lifecycle explicit.
    with LobsterClient(api_key="lb_...", port=53211) as client:
        data = client.start("my-profile-id")

        # Selenium (via debuggerAddress):
        #   opts = webdriver.ChromeOptions()
        #   opts.debugger_address = data["debuggerAddress"]
        #   driver = webdriver.Chrome(options=opts)

        # Playwright (via connect_over_cdp):
        #   browser = playwright.chromium.connect_over_cdp(data["ws"])

        client.stop("my-profile-id")

See ``README.md`` for full, runnable Selenium / Playwright / Puppeteer connect recipes.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, NotRequired, TypedDict


# --- Typed result payloads -----------------------------------------------------------------------
# These mirror the `@lobster/shared-types` interfaces one-for-one. They are `TypedDict`s (not
# dataclasses) because the wire format is JSON objects and we return them verbatim — the types are
# documentation and editor autocomplete, with no runtime cost or coercion.


class HealthResult(TypedDict):
    """``data`` of ``GET /health``."""

    status: str  # "ok" when the local API is up.


class StartProfileResult(TypedDict):
    """``data`` of ``POST /profile/start`` — both connect styles, zero friction."""

    profileId: str
    ws: str  # CDP WebSocket. Playwright/Puppeteer: connect_over_cdp(ws) / browserWSEndpoint.
    debuggerAddress: str  # "host:port". Selenium: options.debugger_address = this.
    webDriver: NotRequired[str]  # WebDriver/automation base HTTP endpoint, when applicable.
    pid: NotRequired[int]  # OS process id of the launched browser.


class StopProfileResult(TypedDict):
    """``data`` of ``POST /profile/stop``."""

    profileId: str
    stopped: bool


class ProfileStatusResult(TypedDict):
    """``data`` of ``GET /profile/status``."""

    profileId: str
    running: bool
    ws: NotRequired[str]  # Present only while the profile is running.
    debuggerAddress: NotRequired[str]  # Present only while the profile is running.


class LocalApiListItem(TypedDict):
    """One entry of ``GET /profile/list``."""

    profileId: str
    name: str
    running: bool


class ProxyConfig(TypedDict, total=False):
    """Proxy config accepted by ``POST /proxy/test``."""

    id: str
    type: str
    host: str
    port: int
    username: str
    password: str
    label: str


class ProxyTestResult(TypedDict, total=False):
    """``data`` of ``POST /proxy/test``."""

    ok: bool
    latencyMs: int
    geo: dict[str, Any]
    error: str


# --- Errors ----------------------------------------------------------------------------------------


class LobsterError(RuntimeError):
    """Base class for every error this client raises."""


class LobsterApiError(LobsterError):
    """The API responded but reported failure.

    Raised for a non-zero envelope ``code``, a non-2xx HTTP status, or an unparseable body. These
    are **application** errors and are never retried — retrying a deterministic failure just wastes
    time. The originating ``endpoint`` and the server ``msg`` are attached for diagnosis.
    """

    def __init__(
        self,
        endpoint: str,
        msg: str,
        *,
        code: int | None = None,
        http_status: int | None = None,
    ) -> None:
        super().__init__(f"Lobster API error on {endpoint}: {msg}")
        self.endpoint = endpoint
        self.msg = msg
        self.code = code
        self.http_status = http_status


class LobsterNetworkError(LobsterError):
    """The request never produced a usable response.

    Raised when the connection was refused/reset or the request timed out, **after** all retries
    were exhausted. These are the failures the client retries.
    """

    def __init__(self, endpoint: str, msg: str, *, attempts: int | None = None) -> None:
        suffix = f" after {attempts} attempt(s)" if attempts else ""
        super().__init__(f"Lobster API request {endpoint} failed{suffix}: {msg}")
        self.endpoint = endpoint
        self.msg = msg
        self.attempts = attempts


# --- Client ----------------------------------------------------------------------------------------


@dataclass
class LobsterClient:
    """Typed client for the Lobster Local Automation API.

    Every method returns the unwrapped ``data`` payload and raises :class:`LobsterApiError` (the API
    reported failure) or :class:`LobsterNetworkError` (transport failed after retries).

    Parameters
    ----------
    api_key:
        Bearer key. Required by every endpoint except ``/health``. May be ``None`` if you only call
        :meth:`health`.
    host, port:
        Loopback host/port the desktop core is bound to (default ``127.0.0.1:53211``).
    timeout:
        Per-request timeout in seconds, passed to ``urlopen``.
    retries:
        Number of retries on network/timeout errors only — never on an error envelope.
    retry_delay:
        Base backoff in seconds; grows exponentially (0.25, 0.5, ...).

    Usable as a context manager::

        with LobsterClient(api_key="lb_...") as client:
            client.start("profile-id")
    """

    api_key: str | None = None
    host: str = "127.0.0.1"
    port: int = 53211
    timeout: float = 30.0
    retries: int = 2
    retry_delay: float = 0.25

    def __post_init__(self) -> None:
        # The single, canonical base URL — built once so no method has to reassemble it.
        self.base_url = f"http://{self.host}:{self.port}/api/v1"

    # --- Context manager ---------------------------------------------------------------------------

    def __enter__(self) -> LobsterClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        """Release any client-side resources.

        ``urllib`` opens a fresh connection per call, so there is nothing to tear down today; the
        method (and context-manager support) exists so callers can adopt ``with`` now and keep it
        if a pooled transport is introduced later.
        """

    # --- Endpoints ---------------------------------------------------------------------------------

    def health(self) -> HealthResult:
        """``GET /health`` — liveness probe. **No auth required.**"""
        return self._call("GET", "/health")

    def start(
        self, profile_id: str, headless: bool = False, password: str | None = None
    ) -> StartProfileResult:
        """``POST /profile/start`` — launch a profile and return its live CDP endpoints."""
        body: dict[str, Any] = {"profileId": profile_id, "headless": headless}
        if password is not None:
            body["password"] = password
        return self._call(
            "POST",
            "/profile/start",
            body=body,
        )

    def stop(self, profile_id: str) -> StopProfileResult:
        """``POST /profile/stop`` — stop a running profile."""
        return self._call("POST", "/profile/stop", body={"profileId": profile_id})

    def status(self, profile_id: str) -> ProfileStatusResult:
        """``GET /profile/status`` — whether a profile is running (and its endpoints, if so)."""
        query = urllib.parse.urlencode({"profileId": profile_id})
        return self._call("GET", f"/profile/status?{query}")

    def list(self) -> list[LocalApiListItem]:
        """``GET /profile/list`` — all known profiles and their running state."""
        return self._call("GET", "/profile/list")

    def test_proxy(self, config: ProxyConfig, id: str | None = None) -> ProxyTestResult:
        """``POST /proxy/test`` — test a proxy endpoint and return exit-IP geo/latency."""
        body: dict[str, Any] = {"config": config}
        if id is not None:
            body["id"] = id
        return self._call("POST", "/proxy/test", body=body)

    # --- Convenience -------------------------------------------------------------------------------

    def connect_playwright(
        self, profile_id: str, headless: bool = False, password: str | None = None
    ) -> dict[str, str]:
        """Start a profile and return just the two endpoints an automation framework needs.

        Deliberately does not import Playwright/Selenium — pass ``ws`` to
        ``chromium.connect_over_cdp(ws)`` or ``debuggerAddress`` to Selenium yourself.
        """
        data = self.start(profile_id, headless=headless, password=password)
        return {"ws": data["ws"], "debuggerAddress": data["debuggerAddress"]}

    # --- Internals ---------------------------------------------------------------------------------

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        """Perform a request with timeout + retry, then unwrap the ``{code, data, msg}`` envelope.

        Retries apply **only** to :class:`LobsterNetworkError` (connection/timeout). A
        :class:`LobsterApiError` — a non-zero envelope or a bad HTTP response — is deterministic and
        propagates on the first attempt without retry.
        """
        route = f"{method} {path}"
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                return self._attempt(method, path, route, body)
            except LobsterApiError:
                # Application errors are final — never retry a deterministic failure.
                raise
            except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
                # Transient transport failures: remember and back off before the next attempt.
                #   - URLError        connection refused / DNS / connect-timeout
                #   - ConnectionError reset mid-response (http.client.RemoteDisconnected)
                #   - TimeoutError    read timeout (socket.timeout is TimeoutError on 3.10+)
                # Note HTTPError (a URLError subclass carrying an envelope) is converted to a
                # LobsterApiError in `_attempt`, so it never reaches here.
                last_error = exc
                if attempt < self.retries:
                    time.sleep(self.retry_delay * 2**attempt)

        reason = _describe(last_error)
        raise LobsterNetworkError(route, reason, attempts=self.retries + 1)

    def _attempt(self, method: str, path: str, route: str, body: dict[str, Any] | None) -> Any:
        """A single HTTP attempt: send the request under the timeout, then validate the envelope."""
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/json")
        if self.api_key:
            req.add_header("Authorization", f"Bearer {self.api_key}")
        if data is not None:
            req.add_header("Content-Type", "application/json")

        try:
            # noqa: S310 — loopback (127.0.0.1) only; scheme is fixed to http by base_url.
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310
                raw = resp.read()
                http_status = resp.status
        except urllib.error.HTTPError as exc:
            # The server answers non-2xx *with* the envelope body — surface its `msg`, don't retry.
            raw = exc.read()
            http_status = exc.code
            payload = _parse_envelope(raw, route, http_status)
            raise LobsterApiError(
                route,
                payload.get("msg") or f"HTTP {http_status}",
                code=payload.get("code"),
                http_status=http_status,
            ) from exc

        payload = _parse_envelope(raw, route, http_status)
        code = payload.get("code")
        if not isinstance(code, int):
            raise LobsterApiError(route, f"malformed envelope (HTTP {http_status})", http_status=http_status)
        if code != 0:
            raise LobsterApiError(
                route,
                payload.get("msg") or "unknown error",
                code=code,
                http_status=http_status,
            )
        return payload.get("data")


def _parse_envelope(raw: bytes, route: str, http_status: int) -> dict[str, Any]:
    """Decode a response body to a ``{code, data, msg}`` dict, or raise a clear API error."""
    try:
        parsed = json.loads(raw.decode() or "{}")
    except (ValueError, UnicodeDecodeError) as exc:
        raise LobsterApiError(route, f"non-JSON response body (HTTP {http_status})", http_status=http_status) from exc
    if not isinstance(parsed, dict):
        raise LobsterApiError(route, f"unexpected response shape (HTTP {http_status})", http_status=http_status)
    return parsed


def _describe(error: Exception | None) -> str:
    """Human-readable reason for a transport failure (unwraps ``URLError.reason``)."""
    if error is None:
        return "unknown transport error"
    reason = getattr(error, "reason", None)
    return str(reason) if reason is not None else str(error)
