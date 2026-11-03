# LIVE GEMINI VERIFICATION REPORT — Phase 10

## Audit finding (root cause)

Semantic failure was **not primarily a model quality issue**.

Section B previously called Gemini with a **stripped prompt** that listed categories but **did not list allowed intents**. The model therefore returned `intent: "informational"` for nearly every fixture. The validator also remapped unknown intent strings to `informational`, which hid better raw labels.

Additional issues:
- Category `delivery` vs expected `shopping` (taxonomy mismatch).
- Missing structured fields because the weak harness prompt did not demand order/travel/financial extraction.
- Ambiguous weekday dates not forced to `requires_confirmation`.

## Fixes applied

1. **Shared production prompt** — harness now uses `DaylightAI.SYSTEM` + `DaylightAI.buildPrompt`.
2. **Canonical intent vocabulary** with aliases (`order_confirmation` → `order_confirmed`, `delivery_update` → `delivery_scheduled`, `cancellation` → `booking_cancelled`, etc.).
3. **No silent coerce** of unknown intents to `informational` before structure-based inference.
4. **Category normalization** — `delivery` + order_id → `shopping` (secondary keeps `delivery`).
5. **Richer schema** for order / travel / financial fields and relative-date rules.
6. **Diagnostics** — each fixture reports expected vs actual category/intent/fields (no secrets, no full bodies).

## Latest local run (this environment)

| Section | Result |
|---------|--------|
| A Local heuristics | **11/11** (Phase 10 fixtures) |
| B Live Gemini | **NOT RUN** — `GEMINI_API_KEY` not present in this agent shell |
| C Worker routes / auth / consent | **deployed=true, auth=true**, consent + financial opt-in pass |
| D Lifecycle dedupe | **sameOrder=true, samePnr=true** |
| Synthetic suite `ai-email-suite.js` | **33/33** after intent rename |

## Production readiness

**Not declared.** Acceptance requires a fresh Section B run with the API key:

```powershell
# Create gitignored .env (do not paste the key into chat)
# GEMINI_API_KEY=...
# GEMINI_MODEL=gemini-3.5-flash-lite
node tests/live-gemini-verify.js
```

Target: **12/12** (or 13/13 with delivered fixture) semantic pass, **intent accuracy 100%**.

## Unresolved until key is available here

- Live Gemini classification/intent/date accuracy numbers after the prompt fix
- Token usage / cost for the new longer system prompt
- End-to-end Worker-proxied analyse with a real session (Section B uses direct API by design)
