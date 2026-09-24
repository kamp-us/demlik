---
"@demlik/tea": patch
---

`@demlik/tea/otel` now hands OpenTelemetry every span start and end as an exact `HrTime` built from the event's `at`, read as epoch milliseconds. It used to pass `at` as a bare number, and the OTel SDK reads a number no bigger than `performance.now()` as time since process start. So a host whose `clock` returns small values (a logical or test clock) got its span times silently moved to process start plus `at`.
