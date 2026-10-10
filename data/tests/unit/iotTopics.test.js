/**
 * What the IoT store accepts from the broker: topic shapes, numeric payloads,
 * Home Assistant discovery (hostile and oversized included) and commands.
 */
const topics = require('../../services/iot/topics');
const { parseDiscovery, defaultsFor } = require('../../services/iot/discovery');
const { validateCommand, toPublish, MAX_GPIO } = require('../../services/iot/commands');

describe('parseTopic', () => {
  test.each([
    ['sensors/SYN_01/temperature', { kind: 'reading', device: 'SYN_01', measure: 'temperature' }],
    ['sensors/SYN_01/soil-moisture_2', { kind: 'reading', device: 'SYN_01', measure: 'soil-moisture_2' }],
    ['sensors/SYN_01/availability', { kind: 'availability', device: 'SYN_01' }],
    ['esp32/alive/SYN_01', { kind: 'seen', device: 'SYN_01', what: 'alive' }],
    ['esp32/data/SYN_01', { kind: 'seen', device: 'SYN_01', what: 'data' }],
    ['esp32/register', { kind: 'announce', what: 'register' }],
    ['esp32/config', { kind: 'announce', what: 'config' }],
    ['homeassistant/device/SYN_01/config', { kind: 'discovery', device: 'SYN_01' }]
  ])('%s', (topic, expected) => {
    expect(topics.parseTopic(topic)).toEqual(expected);
  });

  test.each([
    'liveData/iss', 'esp32/SYN_01/io/on', 'esp32/SYN_01/reboot', 'homeassistant/sensor/x/config', 'homeassistant/status', '', 'other'
  ])('ignores %s', (topic) => {
    expect(topics.parseTopic(topic)).toEqual({ kind: 'ignored' });
  });

  test.each([
    ['sensors/SYN_01', 'topic_shape'],
    ['sensors/SYN_01/a/b', 'topic_shape'],
    ['sensors//temperature', 'device_name'],
    ['sensors/bad name/temperature', 'device_name'],
    ['sensors/__proto__/temperature', 'device_name'],
    ['sensors/constructor/temperature', 'device_name'],
    ['sensors/SYN_01/bad$measure', 'measure_name'],
    ['sensors/SYN_01/__proto__', 'measure_name'],
    [`sensors/${'d'.repeat(65)}/temperature`, 'device_name'],
    [`sensors/SYN_01/${'m'.repeat(49)}`, 'measure_name'],
    [`sensors/SYN_01/${'m'.repeat(400)}`, 'topic_too_long'],
    ['esp32/alive/bad name', 'device_name'],
    ['homeassistant/device/bad name/config', 'device_name']
  ])('refuses %s as %s', (topic, reason) => {
    expect(topics.parseTopic(topic)).toEqual({ kind: 'refused', reason });
  });

  test('a non-string is ignored', () => {
    expect(topics.parseTopic(null)).toEqual({ kind: 'ignored' });
    expect(topics.parseTopic(42)).toEqual({ kind: 'ignored' });
  });
});

describe('payloads', () => {
  test.each([['27.2', 27.2], ['-73', -73], [' 1016.6\n', 1016.6], ['+4', 4], ['.5', 0.5], ['1e3', 1000], ['0', 0]])(
    'numeric %j', (text, value) => {
      expect(topics.parseNumeric(text)).toBe(value);
      expect(topics.parseNumeric(Buffer.from(text))).toBe(value);
    });

  test.each(['', ' ', 'online', 'NaN', 'Infinity', '-inf', '0x1F', '1,5', '12abc', '{"value":1}', '[1]', 'true', '1e999', '1'.repeat(40)])(
    'refuses %j as a number', (text) => {
      expect(topics.parseNumeric(text)).toBeNull();
    });

  test('a number payload object, null or undefined is not a reading', () => {
    expect(topics.parseNumeric(undefined)).toBeNull();
    expect(topics.parseNumeric(null)).toBeNull();
    expect(topics.parseNumeric(12)).toBeNull();
  });

  test('availability is online or offline, whatever the case', () => {
    expect(topics.parseAvailability(Buffer.from('online'))).toBe('online');
    expect(topics.parseAvailability(' OFFLINE ')).toBe('offline');
    expect(topics.parseAvailability('maybe')).toBeNull();
    expect(topics.parseAvailability('online'.repeat(10))).toBeNull();
  });

  test('an announced device id must be a device name', () => {
    expect(topics.parseAnnouncedDevice(Buffer.from('SYN_01'))).toBe('SYN_01');
    expect(topics.parseAnnouncedDevice('{"id":"SYN_01"}')).toBeNull();
    expect(topics.parseAnnouncedDevice('x'.repeat(200))).toBeNull();
  });
});

describe('Home Assistant discovery', () => {
  const component = (measure, extra = {}) => ({
    platform: 'sensor', unique_id: `SYN_01_${measure}`, state_topic: `sensors/SYN_01/${measure}`, ...extra
  });
  const payload = (body) => Buffer.from(JSON.stringify(body));

  test('reads device info, names, units and device classes (long keys)', () => {
    const parsed = parseDiscovery('SYN_01', payload({
      device: { identifiers: ['SYN_01'], name: 'SYN_01', manufacturer: 'Synthetic', model: 'Sensor node', sw_version: '1.2.3' },
      origin: { name: 'Synthetic firmware' },
      availability_topic: 'sensors/SYN_01/availability',
      components: {
        temperature: component('temperature', { name: 'Temperature', device_class: 'temperature', unit_of_measurement: '°C' }),
        wifi_rssi: component('wifi_rssi', { name: 'Wi-Fi signal', device_class: 'signal_strength', unit_of_measurement: 'dBm' })
      }
    }));
    expect(parsed.info).toEqual({ name: 'SYN_01', manufacturer: 'Synthetic', model: 'Sensor node', swVersion: '1.2.3', origin: 'Synthetic firmware' });
    expect([...parsed.measures]).toEqual([
      ['temperature', { name: 'Temperature', unit: '°C', deviceClass: 'temperature' }],
      ['wifi_rssi', { name: 'Wi-Fi signal', unit: 'dBm', deviceClass: 'signal_strength' }]
    ]);
  });

  test('reads the abbreviated keys and the ~ base topic', () => {
    const parsed = parseDiscovery('SYN_01', payload({
      '~': 'sensors/SYN_01',
      dev: { ids: 'SYN_01', mf: 'Synthetic', mdl: 'Node', sw: '2.0', hw: 'rev B' },
      o: { name: 'fw', sw: '9.9' },
      cmps: { a: { p: 'sensor', stat_t: '~/humidity', unit_of_meas: '%', dev_cla: 'humidity', name: 'Humidity' } }
    }));
    expect(parsed.info).toEqual({ manufacturer: 'Synthetic', model: 'Node', swVersion: '2.0', hwVersion: 'rev B', origin: 'fw' });
    expect(parsed.measures.get('humidity')).toEqual({ name: 'Humidity', unit: '%', deviceClass: 'humidity' });
  });

  test('a component about another device, another namespace or no topic is left out', () => {
    const parsed = parseDiscovery('SYN_01', payload({
      device: { name: 'SYN_01' },
      components: {
        other: { state_topic: 'sensors/SYN_99/temperature', unit_of_measurement: 'K' },
        elsewhere: { state_topic: 'home/kitchen/temperature' },
        nothing: { name: 'No topic' },
        notAnObject: 'text',
        availability: { state_topic: 'sensors/SYN_01/availability' }
      }
    }));
    expect(parsed.measures.size).toBe(0);
  });

  test.each([
    ['not JSON', Buffer.from('{oops')],
    ['an array', Buffer.from('[1,2,3]')],
    ['a string', Buffer.from('"text"')],
    ['empty', Buffer.from('')],
    ['nothing useful', Buffer.from('{"unrelated":true}')],
    ['oversized', Buffer.from(JSON.stringify({ device: { name: 'x'.repeat(40_000) } }))]
  ])('refuses %s', (_name, body) => {
    expect(parseDiscovery('SYN_01', body)).toBeNull();
  });

  test('hostile content is cut, cleaned and cannot touch prototypes', () => {
    const many = {};
    for (let i = 0; i < 100; i++) many[`c${i}`] = component(`m${i}`, { name: `n${i}` });
    const hostile = JSON.stringify({
      device: { name: `evil\u0000\u0007name ${'x'.repeat(500)}`, manufacturer: { $gt: '' }, model: ['a'], sw_version: 7 },
      components: {
        first: component('temperature', { name: '<script>alert(1)</script>'.repeat(20), unit_of_measurement: 'u'.repeat(200), device_class: { nested: true } }),
        ...many
      }
    }).replace('"components":{', '"components":{"__proto__":{"polluted":true,"state_topic":"sensors/SYN_01/pwned"},"constructor":{"state_topic":"sensors/SYN_01/constructor"},');
    expect(Buffer.byteLength(hostile)).toBeLessThan(32 * 1024);
    const parsed = parseDiscovery('SYN_01', Buffer.from(hostile));
    expect(parsed.info.name).toHaveLength(80);
    expect(parsed.info.name).not.toMatch(/[\u0000-\u001f]/);
    expect(parsed.info.manufacturer).toBeUndefined();
    expect(parsed.info.model).toBeUndefined();
    expect(parsed.info.swVersion).toBe('7');
    expect(parsed.measures.get('temperature').name).toHaveLength(80);
    expect(parsed.measures.get('temperature').unit).toHaveLength(16);
    expect(parsed.measures.get('temperature').deviceClass).toBeNull();
    expect(parsed.measures.size).toBeLessThanOrEqual(64);
    expect(parsed.measures.has('constructor')).toBe(false);
    expect({}.polluted).toBeUndefined();
  });

  test('default unit and name by measure name', () => {
    expect(defaultsFor('temperature')).toMatchObject({ name: 'Temperature', unit: '°C', source: 'default' });
    expect(defaultsFor('cpu_temperature')).toMatchObject({ name: 'Cpu temperature', unit: '°C' });
    expect(defaultsFor('pressure').unit).toBe('hPa');
    expect(defaultsFor('battery_voltage').unit).toBe('V');
    expect(defaultsFor('wifi_rssi').unit).toBe('dBm');
    expect(defaultsFor('altitude').unit).toBe('m');
    expect(defaultsFor('humidity').unit).toBe('%');
    expect(defaultsFor('soil_moisture')).toMatchObject({ name: 'Soil moisture', unit: null });
    expect(defaultsFor('toString').unit).toBeNull();
  });
});

describe('commands', () => {
  test('exact firmware topics and payloads', () => {
    expect(toPublish('SYN_01', validateCommand({ command: 'io_on', gpio: 12 }))).toEqual({ topic: 'esp32/SYN_01/io/on', payload: '12', retain: false });
    expect(toPublish('SYN_01', validateCommand({ command: 'io_off', gpio: 0 }))).toEqual({ topic: 'esp32/SYN_01/io/off', payload: '0', retain: false });
    expect(toPublish('SYN_01', validateCommand({ command: 'reboot' }))).toEqual({ topic: 'esp32/SYN_01/reboot', payload: '', retain: false });
  });

  test.each([
    [null], [[]], ['io_on'],
    [{ command: 'configIOs' }], [{ command: 'io_on' }], [{ command: 'io_on', gpio: '12' }],
    [{ command: 'io_on', gpio: 1.5 }], [{ command: 'io_on', gpio: -1 }], [{ command: 'io_on', gpio: MAX_GPIO + 1 }],
    [{ command: 'reboot', gpio: 2 }], [{ command: 'io_on', gpio: 2, topic: 'x' }], [{ command: 'toString' }], [{}]
  ])('refuses %j', (body) => {
    expect(() => validateCommand(body)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
