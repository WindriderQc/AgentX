# Custom Dashboards Feature - ARCHIVED

**Archived Date:** 2026-01-09
**Reason:** Feature not required for current release

## Archived Files

This directory contains the custom dashboard builder feature that was removed from the main application:

- `custom-dashboard.html` - Custom dashboard viewer page
- `dashboard-builder.html` - Dashboard builder UI
- `dashboard-builder.js` - Dashboard builder JavaScript logic

## What Was This Feature?

The custom dashboard feature allowed users to:
- Create custom dashboards with configurable widgets
- Build personalized views using a visual builder
- Save and manage multiple dashboard layouts

## Why Archived?

This feature was determined to be non-essential for the current production release. The core monitoring, analytics, and operations dashboards provide sufficient functionality without the added complexity of custom user-created dashboards.

## Changes Made

1. **Files Moved:**
   - `/public/custom-dashboard.html` → `/archive/custom-dashboards/custom-dashboard.html`
   - `/public/dashboard-builder.html` → `/archive/custom-dashboards/dashboard-builder.html`
   - `/public/js/dashboard-builder.js` → `/archive/custom-dashboards/dashboard-builder.js`

2. **Navigation Updated:**
   - Removed "Dashboards" menu group from `/public/js/components/nav.js`
   - Removed page IDs: `custom-dashboards`, `dashboard-builder`

3. **Documentation Updated:**
   - Updated nav.js header comments
   - Created this archive README

## Restoring This Feature

If this feature needs to be restored in the future:

1. Move files back to original locations:
   ```bash
   mv custom-dashboard.html ../../public/
   mv dashboard-builder.html ../../public/
   mv dashboard-builder.js ../../public/js/
   ```

2. Re-add to navigation in `/public/js/components/nav.js`:
   ```javascript
   {
       label: 'Dashboards', icon: 'fa-columns', id: 'grp-dash',
       children: [
           { label: 'All Dashboards', href: 'custom-dashboard.html', icon: 'fa-columns', id: 'custom-dashboards' },
           { label: 'Builder', href: 'dashboard-builder.html', icon: 'fa-layer-group', id: 'dashboard-builder' }
       ]
   }
   ```

3. Update nav.js header to include page IDs

4. Test functionality and update any dependencies

## Related Backend Code

Note: There may be backend API routes or models related to custom dashboards that were not removed. Review the following before fully restoring:

- Check for routes in `/routes/*dashboard*.js`
- Check for models in `/models/*Dashboard*.js`
- Check for services in `/src/services/*dashboard*.js`

---

**Status:** Archived, not deleted
**Safe to restore:** Yes
**Dependencies:** Minimal - self-contained feature
