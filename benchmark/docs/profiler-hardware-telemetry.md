# Profiler runtime telemetry

The model profiler records bounded runtime telemetry beside each model profile.
It talks directly to the Ollama endpoint selected by the user; it does not
install or depend on an operating-system agent.

## Captured data

- Generation speed, prompt-evaluation speed, TTFT, latency, and token counts.
- Loaded-model VRAM reported by Ollama `/api/ps`.
- Total VRAM only when the user explicitly records it in the host profile.
- VRAM pressure derived when both loaded and configured totals are available.

An explicitly configured Data GPU collector can supply fresh temperature, power,
clocks, throttling and topology evidence through the existing telemetry contract.
Missing or stale collector samples stay labelled unknown; configured VRAM totals
and Ollama residency do not invent those measurements. Collector deployment,
credentials and machine-specific targets remain instance configuration.

## UI controls

The Models tab can display the runtime snapshot used during profiling. Missing
hardware metadata is shown as unavailable; the profiler does not propose an
agent installer or silently reach an operations control plane. The
[runtime continuity panel](../../docs/OPERATOR_UI.md#profiler) presents interrupted
operations and their next safe action separately from saved profile measurements.
