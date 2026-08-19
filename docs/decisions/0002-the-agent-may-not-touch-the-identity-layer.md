# 2. The agent may not touch the identity layer

**Decided:** 2026-08-19 · **Status:** accepted

## Context

Lobee is required to handle "any kind of web-agentic task and browser-internal config/settings
tasks". Taken literally that includes the settings that define the profile's fingerprint — languages,
timezone, proxy, WebRTC handling, fonts, page zoom, hardware acceleration.

It cannot include them. A profile is one browser identity, and its whole value is that the identity
stays fixed for the life of the session. An agent that changes the timezone halfway through a task
does not adjust a preference; it destroys the thing the customer bought, mid-session, on a site that
has already seen the old value.

## Decision

Fingerprint and network-path settings are **hard-blocked with no override**, and the block is
enforced on the key before any write is dispatched. Everything else in Chrome's preference surface is
reachable through a curated allowlist over `chrome.settingsPrivate`, each key with a closed value
domain.

Three refinements the obvious implementation misses:

**Reads are screened, not just writes.** A run's outcome travels to a third-party model, so
`get_pref('proxy')` is an exfiltration rather than a query.

**Keys are screened with `.` and `_` folded to spaces.** `intl.accept_languages` walks straight past
a word-boundary regex; `intl accept languages` does not.

**Page zoom counts as identity.** It moves `devicePixelRatio` and `innerWidth`/`innerHeight` off the
display the persona declares, which is the same class of leak as screen resolution — not an
appearance preference, which is where it had been filed.

## Consequences

- "Any settings task" is false as stated, and the refusal says which area it declined and why.
- The allowlist is a strict subset of what the engine's own `PrefsUtil::GetAllowlistedKeys()` accepts,
  so a key outside it would fail the driver's read-back anyway.
- An invariant test asserts every advertised area is actually reachable, because a guard that offers
  something the denylist always refuses is a promise the model cannot keep.
