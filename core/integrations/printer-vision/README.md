# Printer evidence adapter

Set `AGENTX_PROFILE=full` and `AGENTX_PRINTER_VISION_ENABLED=true` to register the
existing `/api/printer-vision` contract in Core. Status images and manual 3x3 bed
maps use the canonical Mongo connection and retain their original collection
names. This adapter is alert-only: it never sends printer-control commands.

Keep camera endpoints, monitor configuration and snapshots outside Git. The
external monitor and existing private records require separate live acceptance. The disposable HTTP/Mongo test verifies persistence, image
retrieval, per-printer isolation and malformed-input rejection.
