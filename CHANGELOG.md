# Changelog

## [v1-foundation] - 2026-06-26

### Added
- Added Billing / Invoice management backend API and database schema.
- Added Tanker Delivery scheduling backend API and database schema.
- Added new dashboard pages for Billing and Deliveries.
- Added frontend API wrappers for billing and tanker modules.
- Added dashboard navigation items for Billing and Deliveries with RBAC support.
- Added healthcheck endpoint at `/health` for backend service readiness.
- Added deployment and installation documentation in `docs/INSTALLATION_GUIDE.md` and `docs/DEPLOYMENT_GUIDE.md`.
- Added seed script support for default demo users in backend.

### Changed
- Updated backend startup to mount billing and tanker routes.
- Updated database schema to include invoices, invoice_items, and tanker_deliveries tables.
- Updated frontend dashboard layout to show Billing and Deliveries only to appropriate roles.
- Updated API client configuration for token refresh and authenticated requests.

### Fixed
- Fixed duplicate schema definitions in `database/schema.sql`.
- Fixed dashboard redirect behavior by ensuring root path forwards to `/dashboard`.
- Verified backend health endpoint is healthy.

### Notes
- All API routes under `/api/*` require authentication.
- Use seeded admin credentials from `backend/scripts/seed.js` to log in and access protected dashboard pages.
