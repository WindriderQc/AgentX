# Modernization candidates

No stack replacement is part of the consolidation.

| Candidate | Reason / impact | Disposition |
|---|---|---|
| Dependency security updates | Prior review identified qs and xmldom findings; recheck current lockfiles and relevant advisories before a focused upgrade | Separate bounded maintenance, not an opportunistic upgrade |
| Large retrieval scans | Corpus pagination is correct but large inventories still scan all pages | Measure before introducing another index/store |
| Parallel requests on the hybrid `qwen35` architecture | Ollama forces one request at a time for the `qwen35`/`qwen3next` families (still in its scheduler as of 0.34.4), so the resident 27B model serves strictly sequentially and voice, reviews, agents and judges queue behind each other. A runtime that serves that model with concurrent slots (llama.cpp `llama-server` with parallel sequences, or vLLM) would let them share the host | Owner decision; evaluate on one host behind the existing Core admission, host gate and pin contracts before any change. Until then, concurrency comes from light-task offload and co-resident smaller models |

The known `pdf-parse` v2 fallback mismatch is a correctness defect, not a
modernization idea. It was fixed by using `PDFParse` and
releasing its worker; the installed-package regression passed. Keep that fix
separate from any future parser or retrieval-stack replacement.
