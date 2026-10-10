'use strict';

const IOT_METRICS = Object.freeze({
  temperature: { label: 'Température', tone: 'coral', icon: 'temperature', order: 1 },
  humidity: { label: 'Humidité', tone: 'blue', icon: 'drop', order: 2 },
  wifi_rssi: { label: 'Signal Wi-Fi', tone: 'mint', icon: 'wifi', order: 3 },
  battery_voltage: { label: 'Batterie', tone: 'gold', icon: 'battery', order: 4 },
  cpu_temperature: { label: 'Température CPU', tone: 'violet', icon: 'chip', order: 5 },
  pressure: { label: 'Pression', tone: 'blue', icon: 'pressure', order: 6 },
  altitude: { label: 'Altitude', tone: 'violet', icon: 'altitude', order: 7 },
  dht_temperature: { label: 'Température DHT', tone: 'coral', icon: 'temperature', order: 8 },
  free_heap: { label: 'Mémoire libre', tone: 'mint', icon: 'chip', order: 9 },
  cpu_frequency: { label: 'Fréquence CPU', tone: 'violet', icon: 'chip', order: 10 },
  lux: { label: 'Luminosité', tone: 'gold', icon: 'sun', order: 11 }
});
const IOT_ICONS = Object.freeze({
  temperature: '<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0Z"/><path d="M12 9v9"/><circle cx="12" cy="18" r="1"/>',
  drop: '<path d="M12 3c-2 3-6 7-6 11a6 6 0 0 0 12 0c0-4-4-8-6-11Z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
  wifi: '<path d="M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><circle cx="12" cy="20" r=".8"/>',
  battery: '<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M22 10v4M7 10v4M11 10v4M15 10v4"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="3"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  pressure: '<path d="M4 17a9 9 0 1 1 16 0M12 4v3M5 10l2 1M19 10l-2 1M12 14l4-5"/><circle cx="12" cy="14" r="2"/>',
  altitude: '<path d="m3 19 6-10 4 6 3-4 5 8H3Zm4-7 2 2 2-2M17 3v4M15 5l2-2 2 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
  chart: '<path d="M4 4v16h16M7 14l4-4 4 2 5-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  refresh: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>'
});

function iotIcon(name) {
  const paths = Object.hasOwn(IOT_ICONS, name) ? IOT_ICONS[name] : IOT_ICONS.chart;
  return `<svg class="iot-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function iotMetric(key, name) {
  const profile = Object.hasOwn(IOT_METRICS, key) ? IOT_METRICS[key] : { label: key, tone: 'blue', icon: 'chart', order: 99 };
  const normalized = text => String(text || '').toLowerCase().replace(/[_-]/g, ' ');
  return { ...profile, label: name && normalized(name) !== normalized(key) ? name : profile.label };
}

function iotCardMeasures(device) {
  return array(device.measures).slice().sort((a, b) => iotMetric(a.key).order - iotMetric(b.key).order).slice(0, 4);
}
