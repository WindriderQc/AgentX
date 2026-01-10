# Security Hardening Guide (Phase 2)

**Status:** Critical Action Required
**Date:** 2026-01-04

This document outlines the steps required to harden the security of the SBQC Stack, specifically addressing the "Secret Rotation" and "Git Hygiene" tasks from Track 8.

---

## 1. Secret Rotation (Immediate Action)

The following keys have been exposed in previous commits or documentation and MUST be rotated immediately in production environments.

### A. AgentX API Keys
1.  **Generate new keys:**
    ```bash
    # Run this in your terminal to generate random 32-byte hex strings
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    ```
2.  **Update `.env` in AgentX:**
    *   `SESSION_SECRET`
    *   `CSRF_SECRET`
    *   `AGENTX_API_KEY`
    *   `DATAAPI_API_KEY` (Must match DataAPI's new key)

### B. DataAPI Keys
1.  **Update `.env` in DataAPI:**
    *   `DATAAPI_API_KEY` (Must match AgentX's new key)
    *   `INTEGRATIONS_API_KEY`

### C. External Service Keys
1.  **OpenAI / Anthropic / Google:**
    *   Revoke existing keys in the respective provider dashboards.
    *   Generate new keys.
    *   Update `.env` in AgentX.
2.  **n8n:**
    *   Update the `x-api-key` header in your n8n HTTP Request nodes to match the new `AGENTX_API_KEY`.

---

## 2. Git Hygiene (BFG Repo-Cleaner)

**Warning:** This process rewrites git history. Ensure you have a backup of your repository before proceeding.

### Goal
Remove `.env` files and other secrets that may have been accidentally committed.

### Steps

1.  **Install BFG:**
    *   Download from: https://rtyley.github.io/bfg-repo-cleaner/
    *   Or use `brew install bfg` (macOS) / `apt install bfg` (Linux - if available, otherwise use jar).

2.  **Prepare the Repo:**
    ```bash
    cd /path/to/repo
    git pull
    ```

3.  **Run BFG:**
    ```bash
    # Delete all .env files from history
    bfg --delete-files .env

    # Replace specific text (e.g., old API key) in all files
    # Create a file named 'replacements.txt' with "old_secret_key==>REDACTED"
    bfg --replace-text replacements.txt
    ```

4.  **Clean GC:**
    ```bash
    git reflog expire --expire=now --all && git gc --prune=now --aggressive
    ```

5.  **Force Push:**
    ```bash
    git push --force
    ```

---

## 3. Ongoing Security Practices

*   **Never commit `.env` files.** Ensure `.gitignore` contains `.env`.
*   **Use Environment Variables for Secrets.** Do not hardcode secrets in `ecosystem.config.js` or source code.
*   **Regular Audits.** Periodically check `git log -p` for accidental secret inclusion.
