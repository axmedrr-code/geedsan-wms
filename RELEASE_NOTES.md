# Release Notes — v1-foundation

Release Date: 2026-06-26

## Overview
NUWACO WMS v1-foundation is a production-grade foundation release for the GEEDSAN smart water management platform. This release adds Billing and Tanker Delivery management modules, improves frontend navigation, and provides a stable Docker-based deployment snapshot.

## Key Features
- New Billing module with invoice management and line-item support.
- New Tanker Delivery module for scheduling and tracking water deliveries.
- Role-based dashboard navigation for `admin`, `operator`, and `viewer` users.
- Authenticated backend API endpoints with JWT refresh support.
- Healthcheck endpoint at `/health` and robust backend startup logging.
- Updated database schema with billing and tanker delivery tables.
- Deployment and installation documentation in `docs/INSTALLATION_GUIDE.md` and `docs/DEPLOYMENT_GUIDE.md`.

## Deployment Notes
- The backend API is available at `http://localhost:5000`.
- The frontend dashboard is available at `http://localhost:3000`.
- Default demo accounts are seeded by `backend/scripts/seed.js`.
- All `/api/*` endpoints require authentication.
- The frontend redirect from `/` to `/dashboard` is intentional for the authenticated dashboard experience.

## Default Login Credentials
- Admin: `admin` / `Admin@Nuwaco2024`
- Operator: `operator1` / `Operator@2024`
- Viewer: `viewer1` / `Viewer@2024`

## Notes for QA
- Verify backend health at `http://localhost:5000/health`.
- Log in via the frontend and ensure Billing and Deliveries pages appear for admin/operator roles.
- Confirm `invoices`, `invoice_items`, and `tanker_deliveries` tables are created successfully.
- Check that the new API routes return `401 Unauthorized` when unauthenticated and `200` when authenticated.
