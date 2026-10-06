'use strict';

function buildLocalPayload(request, model, options, keepAlive) {
  const common = {
    model,
    stream: request.stream === true,
    ...(Object.keys(options).length > 0 && { options }),
    ...(keepAlive !== undefined && { keep_alive: keepAlive })
  };
  if (request.mode === 'embed') {
    return {
      model,
      input: request.input,
      ...(request.truncate !== undefined && { truncate: request.truncate }),
      ...(Object.keys(options).length > 0 && { options }),
      ...(keepAlive !== undefined && { keep_alive: keepAlive })
    };
  }
  if (request.mode === 'chat') {
    return {
      ...common,
      messages: request.messages,
      ...(Array.isArray(request.tools) && { tools: request.tools }),
      ...(request.format !== undefined && { format: request.format }),
      ...(request.think !== undefined && { think: request.think })
    };
  }
  return {
    ...common,
    prompt: request.prompt,
    ...(request.system !== undefined && { system: request.system }),
    ...(request.format !== undefined && { format: request.format }),
    ...(request.think !== undefined && { think: request.think })
  };
}

module.exports = { buildLocalPayload };
