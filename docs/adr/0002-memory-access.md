# Reuse existing memory classification across surfaces

The owner confirmed the original intent during consolidation: Super Dad / personal
Nestor can consult all of the owner's information, including PsyX information.
Family and child surfaces retain their information restrictions. PsyX may keep
its conversation/domain structure without becoming inaccessible to the owner.
Persona presentation does not grant access to another information scope.

Reuse the implemented Memory Policy V2 vocabulary (`scope`, `sensitivity`) and
Household's existing personal/family session boundaries. Do not create another
classification system, memory database or repository. Shared mechanisms belong
in Core; consumer permissions come from the server-side session/surface, not
from a child's message or a client-selected persona.

The existing policy already distinguishes normal, private and highly private
information and separate owner, household and private-domain scopes. It also
contains automatic memory dispositions and explicit exceptions. That policy is
preserved as is.

## Implementation state

Reviewed memory keeps its `scope` and `sensitivity` through Core, the RAG API,
vector storage, search and document reads. Content-only reingestion preserves
existing labels, and automatic deduplication cannot change a document's
classification. Unlabelled historical data stays unclassified; the absence of a
label is never permission to expose it to children.

Core exposes an audience-bound memory read capability. Owner reads keep all
information scopes, including private-domain and unclassified historical
records. Household reads force `scope=household` and `sensitivity=normal` before
retrieval and recheck every returned record before supplying context. Caller
filters and personas cannot widen a capability selected by the server.

The Nestor consumer, Core memory adapter, chat context builder and MCP RAG
search use this capability. The Household approved-corpus reader receives the
owner/family capability from the stored session pack and keeps its stricter
corpus/lane/hash checks. Approved documents need explicit labels before they are
eligible for family recall; no stored document is silently relabelled.

Selected notes share one Core capability across the browser, voice and the native
`personal_memory` tool. Family note reads require household/normal labels and a
matching space. Household and PsyX sessions use canonical Core conversations, so
the owner can recall PsyX history without a second index or a copied memory.

Browser adult entry uses the [parental session](../PARENTAL_ACCESS.md).
Model-generated native recall and physical-device journeys are open acceptance;
see [status](../STATUS.md).
