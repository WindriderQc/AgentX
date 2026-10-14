# Answer tables

Core accepts optional passive tables on assistant messages through the existing
`POST /api/history` create/append route. They are declared conversation fields,
stored with canonical transcript pages and complete payloads. Playground restores
them as accessible HTML tables beside the answer's narrative and a complete
expandable **Text version**. Copy, text-only consumers and model context retain
the full answer in `content`.

This capability accepts explicitly supplied history data. There is no automatic
model-output adapter yet. Chat inference, Household, OpenClaw and Hermes do not
generate or render this envelope automatically.

## History contract

Use the existing authenticated history entrance; do not select an owner in the
payload. Omit `conversationId` to create a conversation, or supply an existing
visible Playground conversation ID to append:

```json
{
  "messages": [
    {
      "role": "assistant",
      "content": "These recorded outcomes remain uncertain.",
      "answerBlocks": {
        "schema": "agentx.answer-blocks/v1",
        "blocks": [
          {
            "kind": "table",
            "title": "Recorded outcomes",
            "columns": ["Option", "Outcome"],
            "rows": [["Example", "Unknown"]]
          }
        ]
      }
    }
  ]
}
```

`answerBlocks` is optional. When present it requires `role: "assistant"` and
nonempty string `content`. Core validates the complete batch before writing and
appends a deterministic, literal-text rendering of every table to `content`.
Reimporting that canonical message does not append the same suffix again.
`GET /api/history/:id` and `GET /api/history/conversations/:id` return the stored
envelope, complete content and existing message identities.

The only envelope keys are `schema` and `blocks`; table keys are exactly `kind`,
`title`, `columns` and `rows`. Unknown schemas, kinds and fields refuse the write
with HTTP 400. Labels and cells are strings, with no newlines or control
characters. Sparse arrays, numeric coercion and row-width mismatches refuse.
Empty cells and tables with no rows are supported.

| Bound | Maximum |
| --- | --- |
| Tables per message | 5 (at least 1) |
| Columns per table | 8 (at least 1) |
| Rows per table | 50 |
| Title / column label length | 120 each |
| Cell length | 500 |
| Combined title, label and cell length | 16,000 per message |

Lengths use JavaScript string length. Accepted data is preserved; bounds do not
truncate it. Direct canonical model callers use
`shared/answerBlocks.normalizeMessage` before creating an assistant message;
the declared model schema also requires the complete matching fallback.

## Visibility and failure behavior

New table writes are restricted to the authenticated owner's nonarchived,
nonprobe Playground history, without a surface or surface-session namespace.
An explicit malformed ID returns HTTP 400; an unavailable, foreign, archived or
hidden target returns HTTP 404 and never creates a replacement conversation.
Stale version writes return HTTP 409; loss of visibility before saving refuses
the append. Native conversation owner fences, version checks, page hydration
and erasure remain the authority. Block-bearing hidden conversations cannot be
read through the history aliases, latest-message entrance, previews or search.
Search/list counts exclude them before pagination. Existing plaintext
history consumers keep their legacy contract.

Table values become DOM text, never HTML, links, images, component imports or
commands. The text suffix uses a code fence longer than any backtick run in the
data, so existing Markdown rendering keeps hostile cells literal. Tables grant
no tools, actions, network requests, routing or business authority.

Playground renders complete text first. If the optional renderer is unavailable,
or historical block data has an unsupported schema, malformed shape or incomplete
fallback, that text remains visible. Enhanced tables retain narrative and
uncertainty; keyboard users can focus horizontally scrollable tables and open
**Text version**. Copy always uses the complete canonical `content`.

## Verification

After the normal Core dependency preparation:

```sh
node --test shared/answerBlocks.test.js
npm run build --prefix core
cd core
node scripts/run-jest.js --runInBand --runTestsByPath tests/unit/answerBlocksModel.test.js tests/unit/answerBlocksUi.test.js tests/integration/history-answer-blocks.test.js
ANSWER_BLOCKS_REPORT_DIR=/tmp/agentx-answer-blocks-browser npm run test:answers:browser
```

The Jest history tests use a disposable local MongoDB. The optional browser
journey requires a locally available Playwright package and its Chromium browser;
these are development tools, separate from the Core runtime dependencies. It uses
production Playground layout and restore/render modules with synthetic history;
it sends no model request. Set its output directory outside the checkout, as in
the example above. These are CPU checks, not deployment or live
model acceptance.
