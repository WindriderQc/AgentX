const { parseLegacyReadings, MAX_PAYLOAD_BYTES } = require('../../services/iot/legacyReadings');

describe('legacy JSON telemetry', () => {
  test('normalizes known fields without treating metadata or configuration as measures', () => {
    const parsed = parseLegacyReadings('SYN_01', JSON.stringify({
      sender: 'SYN_01', time: 1, wifi: -65, CPUtemp: 48, heap: 200000, CPUFreq: 240,
      battery: 0, tempBM_280: 23, airHumid: 55, tempDht: 24, soil1: 41,
      co2: 600, lux: 1.2, gpio: 4, unknown: 123, outputs: [{ value: 1 }]
    }));
    expect(Object.fromEntries(parsed)).toEqual({ wifi_rssi: -65, cpu_temperature: 48,
      free_heap: 200000, cpu_frequency: 240, battery_voltage: 0,
      temperature: 23, humidity: 55, dht_temperature: 24, soil1: 41, co2: 600, lux: 1.2 });
  });

  test('supports the payload envelope and gives canonical fields precedence', () => {
    expect(Object.fromEntries(parseLegacyReadings('SYN_01', JSON.stringify({ sender: 'SYN_01',
      payload: { cpu_temp_c: 40, bmx_temp_c: 25, wifi: -80, wifi_rssi: -70 } }))))
      .toEqual({ cpu_temperature: 40, temperature: 25, wifi_rssi: -70 });
  });

  test.each(['null', '[]', '{', JSON.stringify({ sender: 'SYN_02', wifi: -70 }),
    JSON.stringify({ payload: { sender: 'SYN_02', wifi: -70 } }), ' '.repeat(MAX_PAYLOAD_BYTES + 1)])
  ('rejects malformed, oversized or mismatched payloads', raw => expect(parseLegacyReadings('SYN_01', raw)).toBeNull());

  test('never coerces strings, booleans or overflowing JSON numbers', () => {
    expect([...parseLegacyReadings('SYN_01', '{"wifi":"-70","battery":false,"CPUtemp":1e999,"heap":null}')]).toEqual([]);
  });
});
