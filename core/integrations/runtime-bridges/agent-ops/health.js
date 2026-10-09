'use strict';

const { fetchJson } = require('./projection');

function publicUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return null;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString().replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

function productService(service, productOk, links) {
  const id = String(service?.id || '').toLowerCase();
  const status = productOk && service?.status === 'ok'
    ? 'ok'
    : service?.status === 'degraded' ? 'degraded' : 'down';
  return {
    id,
    name: service?.label || id,
    owner: 'AgentX Product',
    port: Number(service?.port) || null,
    status,
    latencyMs: Number(service?.latency_ms) || 0,
    issues: Array.isArray(service?.issues) ? service.issues : [],
    href: id === 'core' ? '/playground' : links[id] || null,
  };
}

// Data is an optional service (Compose profile `data`): its row reports its real
// state, but it never turns the summary down.
function dataService(result, href) {
  const healthy = result?.ok && result.body?.ok === true && result.body?.status === 'success';
  return {
    id: 'data', name: 'Data', owner: 'AgentX Product', port: 3083, optional: true,
    status: healthy ? 'ok' : 'down',
    latencyMs: Number(result?.durationMs) || 0,
    issues: healthy ? [] : [result?.error || result?.body?.message || 'Data health check failed.'],
    href,
  };
}

async function buildServiceHealth(options = {}) {
  const productBaseUrl = String(options.productBaseUrl || `http://127.0.0.1:${process.env.PORT || 3080}`).replace(/\/+$/, '');
  const dataBaseUrl = String(options.dataBaseUrl || process.env.DATAAPI_BASE_URL || 'http://data:3083').replace(/\/+$/, '');
  const getProduct = options.getProduct || (() => fetchJson(productBaseUrl, '/api/portal/health'));
  const getData = options.getData || (() => fetchJson(dataBaseUrl, '/health'));
  const links = {
    benchmark: publicUrl(options.publicLinks?.benchmark || process.env.BENCHMARK_PUBLIC_URL),
    rag: publicUrl(options.publicLinks?.rag || process.env.RAG_PUBLIC_URL),
    data: publicUrl(options.publicLinks?.data || process.env.DATAAPI_PUBLIC_URL),
  };
  const [product, data] = await Promise.all([getProduct(), getData()]);
  const expected = new Map((Array.isArray(product?.body?.services) ? product.body.services : [])
    .map((service) => [String(service.id || '').toLowerCase(), service]));
  const services = ['core', 'benchmark', 'rag'].map((id) => productService(
    expected.get(id) || { id, label: id === 'core' ? 'AgentX Core' : id === 'rag' ? 'RAG' : 'Benchmark' },
    product?.ok === true,
    links,
  ));
  services.push(dataService(data, links.data));
  const healthy = services.filter((service) => service.status === 'ok').length;
  const degraded = services.filter((service) => service.status === 'degraded').length;
  const down = services.length - healthy - degraded;
  const optionalDown = services.filter((service) => service.optional && service.status === 'down').length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summary: {
      status: down > optionalDown ? 'down' : degraded || optionalDown ? 'degraded' : 'ok',
      total: services.length, healthy, degraded, down, optionalDown,
    },
    services,
  };
}

module.exports = { buildServiceHealth, publicUrl };
