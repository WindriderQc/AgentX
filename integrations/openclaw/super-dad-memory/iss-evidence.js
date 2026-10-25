// Verify the returned Core read contract, not the orbital calculation or delivery.
// This projection retains no observer, arguments, passes or external-view URL.
const dated = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function verifiedIssResult(data) {
  return data?.status === 'ok' && dated(data.computedAt)
    && dated(data.window?.start) && dated(data.window?.end)
    && Date.parse(data.window.end) > Date.parse(data.window.start)
    && typeof data.observer?.label === 'string' && data.observer.label.length > 0
    && dated(data.tle?.epoch) && typeof data.tle.stale === 'boolean'
    && Number.isInteger(data.counts?.geometric) && data.counts.geometric >= 0
    && Number.isInteger(data.counts?.observable) && data.counts.observable >= 0
    && data.counts.observable <= data.counts.geometric
    && Array.isArray(data.passes) && data.passes.length <= data.counts.geometric;
}
