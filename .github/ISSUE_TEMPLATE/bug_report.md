---
name: Bug report
about: Report a tool/server defect — wrong data, broken promise, crash, misleading output
title: "[P?][bug] <tool>: <one-line summary>"
labels: [bug]
---
<!-- Severity: P0 advertised feature broken / wrong-or-fabricated data · P1 agent-UX gap
     (misleading, unverifiable, dead-end) · P2 minor bug/consistency · P3 chore/docs -->
<!-- Failure class: 1 — advertised feature silently not working · 2 — agent-UX gap · 3 — infrastructure/CI/tests -->

| Severity | P0 / P1 / P2 / P3 |
|---|---|
| Failure class | 1 / 2 / 3 |
| Tool | `tools.biomcp.<name>` / cross-tool / other |
| Found | YYYY-MM-DD, <live QA campaign / manual use / CI> |

## Summary

<what's wrong and why it matters, 2–4 sentences>

## Reproduction (live)

```js
await tools.biomcp.<tool>({ /* … */ })
```

**Actual:** …

**Expected:** …

## Root cause (if known)

<file:line evidence — or "unknown — needs investigation">

## Suggested fix

<concrete direction + rejected alternatives>
