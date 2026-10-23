'use strict';

const { createReplyChannels } = require('./reply-channels');
const { limitRequestedLists } = require('./requested-list-limit');

// Compose the same ear/screen channels for a saved Main answer as for its
// foreground conversation. The native result and its receipts stay unchanged.
function workResultPresentation(result, { language = 'fr', pageCatalog, requestText } = {}) {
  const text = limitRequestedLists(result.text, requestText);
  const channels = createReplyChannels({ allowSecrets: false, allowPages: true, pageCatalog, language });
  channels.push(text);
  const ordinary = channels.end();
  const reading = createReplyChannels({ allowSecrets: false, allowPages: true, pageCatalog, readAloud: true, language });
  reading.push(text);
  return {
    language,
    display: ordinary.display.filter(block => block.kind === 'page'),
    spokenText: ordinary.say,
    readingText: reading.end().say,
    displayText: [ordinary.say, ...ordinary.display.filter(block => !['image', 'secret', 'page'].includes(block.kind))
      .map(block => [block.title, block.body].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n'),
  };
}

module.exports = { workResultPresentation };
