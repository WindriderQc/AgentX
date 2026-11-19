# Home Assistant in personal Nestor

The optional Maison page appears beside the personal conversation when a turn
mentions Home Assistant, the configured workshop plug or the garage camera.
It shows the plug's two readings and offers the configured shortcuts in
separate tabs. Home Assistant serves its own authenticated dashboard and video.

Core's owner MCP tool `home_assistant_plug` takes an empty object and shares
the page's reader. It returns the switch's `on` or `off` state and the power
in watts, each with its own Home Assistant `reportedAt` time in UTC. The
separate `checkedAt` is when Core completed the read. Older installations can
supply the recorded `last_updated` time when `last_reported` is absent.
The tool returns partial readings if one is missing and unavailable readings
if both are missing. An old report remains dated. The page reads on opening,
and the refresh button requests another read.

If the personal Hermes response stream closes after dispatch, Core keeps
the admitted Maison turn. When the browser can reach Core again, it reads
the exact saved turn and opens its Maison page alongside the recovered
answer. An explicit stop still uses the normal interruption contract.

Place the instance configuration under `AGENTX_INSTANCE_ROOT/config/home-assistant.json`.
For example:

```json
{
  "baseUrl": "https://home-assistant.example.invalid",
  "plug": {
    "label": "Workshop plug",
    "switchEntity": "switch.example_outlet",
    "powerEntity": "sensor.example_outlet_power"
  }
}
```

Map a single plug's switch and watt sensor. Put the bearer token for a local
Home Assistant read-only user in
`AGENTX_INSTANCE_ROOT/credentials/home-assistant-nestor.token` and restrict
that file to the operator and Core. Use a protected local transport if the
connection crosses a network. The reader calls only the two configured
`GET /api/states/<entity_id>` paths with a timeout and redirects disabled.
The token and the upstream response's other attributes stay in Core.

Use `config/screen-services.json` for the browser destinations `home-assistant`
and `garage-camera` with mode `link`. The panel uses the existing personal
Nestor page boundary. It has no device controls and is absent from the family
catalogue. Runtimes use the existing owner tool transport. See
[Home Assistant's REST state API](https://contributors.home-assistant.io/core/internals/rest-api/#states).
