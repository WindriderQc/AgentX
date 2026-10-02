# Modernization candidates

No stack replacement is part of the consolidation.

| Candidate | Reason / impact | Disposition |
|---|---|---|
| Dependency security updates | Prior review identified qs and xmldom findings; recheck current lockfiles and relevant advisories before a focused upgrade | Separate bounded maintenance, not an opportunistic upgrade |
| Large retrieval scans | Corpus pagination is correct but large inventories still scan all pages | Measure before introducing another index/store |
| Parallel requests on the hybrid `qwen35` architecture | Ollama forces one request at a time for it ("model architecture does not currently support parallel requests"), so the resident 27B model serves strictly sequentially | Revisit when upstream llama.cpp server or a newer Ollama supports it; no stack change now |

The known `pdf-parse` v2 fallback mismatch is a correctness defect, not a
modernization idea. It was fixed by using `PDFParse` and
releasing its worker; the installed-package regression passed. Keep that fix
separate from any future parser or retrieval-stack replacement.
