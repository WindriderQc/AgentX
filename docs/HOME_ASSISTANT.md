# Home Assistant in personal Nestor

The optional Maison page appears beside the personal conversation when a turn
mentions Home Assistant, a configured plug or the garage camera. A named plug
opens its own readings. The configured shortcuts open in separate tabs.
Home Assistant serves its own authenticated dashboard and video.

Core's owner MCP tool `home_assistant_plug` shares the page's reader. An empty
object reads the original plug. The optional `device` key selects another
configured plug. It returns the switch state, watts and an optional cumulative
kWh reading, each with its own Home Assistant `reportedAt` time in UTC. The
separate `checkedAt` is when Core completed the read. Older installations can
supply the recorded `last_updated` time when `last_reported` is absent.
The tool distinguishes partial readings from an unavailable plug. An old
report remains dated. The page reads on opening,
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
  },
  "additionalPlugs": [
    {
      "id": "outlet-two",
      "label": "Second outlet",
      "aliases": ["plug two"],
      "switchEntity": "switch.example_outlet_two",
      "powerEntity": "sensor.example_outlet_two_power",
      "energyEntity": "sensor.example_outlet_two_energy"
    }
  ]
}
```

Map each plug's switch and watt sensor. `energyEntity` is optional. The
operator can set `aliases` for the original plug as well. Put the token for a local
Home Assistant read-only user in
`AGENTX_INSTANCE_ROOT/credentials/home-assistant-nestor.token` and restrict
that file to the operator and Core. Use a protected local transport if the
connection crosses a network. The reader calls only the selected plug's configured
`GET /api/states/<entity_id>` paths with a timeout and redirects disabled.
The token and the upstream response's other attributes stay in Core.

Use `config/screen-services.json` for the browser destinations `home-assistant`
and `garage-camera` with mode `link`. The panel uses the existing personal
Nestor page boundary. It has no device controls and is absent from the family
catalogue. Runtimes use the existing owner tool transport. See
[Home Assistant's REST state API](https://contributors.home-assistant.io/core/internals/rest-api/#states).

An optional `config/housex-layout.json` adds the HouseX scene to Maison. Use
`version: 1`, an `approximate` flag, `boxes` with `position` and `size`
triples, a six-digit hex `color` and a drawing `layer` (base 0, floor 1,
structures 2), `rooms` with a `label` and `position`, and `pins` with an
`id` and `position`. Pin IDs are `default`, a configured additional plug ID,
or `garage-camera`. If the ecosystem destination is configured, the same
HouseX page can show the existing ecosystem view. The layout and physical
reference material belong to the private instance.
