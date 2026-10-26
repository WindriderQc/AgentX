/** Carry a legacy RPC handler on authenticated exact routes of DSH's shared API. */
export function registerFetchRpc(ctx, { channel, endpoints, parse, handler }) {
  for (const endpoint of endpoints) {
    ctx.connection.fetch.register({
      path: `/api/${channel}/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let raw;
        try { raw = await request.json(); }
        catch { return new Response('body is not JSON', { status: 400 }); }
        const parsed = parse(raw);
        if (!parsed.success || parsed.data.method !== `${channel}/${endpoint}`) {
          return new Response('invalid RPC envelope or endpoint', { status: 400 });
        }
        const message = parsed.data;
        const result = await handler(endpoint, message.payload, request.signal);
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result });
      },
    });
  }
}
