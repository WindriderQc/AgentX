# Pull Request

## Description
<!-- Brief description of changes - what and why -->

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Breaking change (fix or feature causing existing functionality to change)
- [ ] Documentation update
- [ ] Refactoring (no functional changes)

## Testing
- [ ] Unit tests pass (`npm test`)
- [ ] Integration tests pass (`./test-all.sh`)
- [ ] Manual testing completed
- [ ] Load testing performed (if performance-critical)

**Test Coverage:**
- Lines covered: __%
- New tests added: __ unit, __ integration

## Documentation
- [ ] API reference updated (`docs/SBQC-Stack-Final/07-AGENTX-API-REFERENCE.md`)
- [ ] CLAUDE.md updated (if architectural changes)
- [ ] Changelog entry added (`CHANGELOG.md`)
- [ ] Code comments added for complex logic

## Environment Variables
- [ ] No new environment variables
- [ ] New variables documented in CLAUDE.md and .env.example

**New Variables (if any):**
```bash
# VARIABLE_NAME=default_value  # Description
```

## Related Issues
Closes #
Relates to #

## Screenshots
<!-- Add screenshots for UI changes -->

## Deployment Notes
<!-- Any special deployment steps or migration requirements -->

---

## Pre-Merge Checklist
- [ ] Code follows SOA pattern (routes → services → models)
- [ ] No console.log() statements (using logger instead)
- [ ] Secrets not hardcoded or exposed in logs
- [ ] Rate limiting applied to new endpoints (if applicable)
- [ ] Error handling follows project patterns
- [ ] Branch is up to date with main
