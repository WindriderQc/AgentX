## 2026-01-14 - Icon-Only Button Accessibility
**Learning:** Chat interfaces heavily rely on icon-only buttons for density, but frequently lack accessible names, making them unusable for screen reader users.
**Action:** Systematically audit all icon-only buttons (`.icon-btn` class) and ensure they have descriptive `aria-label` attributes, even if they have `title` tooltips.
