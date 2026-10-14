'use strict';

const { createReplyChannels } = require('./reply-channels');

// Compose the same ear/screen channels for a saved Main answer as for its
// foreground conversation. The native result and its receipts stay unchanged.
function workResultPresentation(result, { language = 'fr' } = {}) {
  const channels = createReplyChannels({ allowSecrets: false, language });
  channels.push(result.text);
  const ordinary = channels.end();
  const reading = createReplyChannels({ allowSecrets: false, readAloud: true, language });
  reading.push(result.text);
  return {
    language,
    spokenText: ordinary.say,
    readingText: reading.end().say,
    displayText: [ordinary.say, ...ordinary.display.filter(block => !['image', 'secret'].includes(block.kind))
      .map(block => [block.title, block.body].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n'),
  };
}

module.exports = { workResultPresentation };
