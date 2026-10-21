# NUCLEA ERP — UI/UX Rework v4

## Included changes

- Unified dark-mode surfaces for Bootstrap tables (including `table-light`), table cells, cards, inputs, dropdowns, modals, list groups, and borders so legacy and roadmap views follow the selected theme.
- Standardized form presentation with Bootstrap modal dialogs. The shared footer promotes marked cards, inline marked forms, `details` forms, and expandable `collapse` forms into dialogs without cloning file inputs or form controls.
- Restored the common sidebar/header shell on Asset Management, Material Requisition, Material Requisition Detail, and User Management.
- Replaced the static headbar identity and example notification count with the logged-in session identity and notifications exposed by the server; theme preference is synchronized with local storage.
- Reduced Dashboard to core operational KPIs and actionable workflow queues, plus low-stock exceptions; illustrative/mock charts were removed.
- Material Master supports creating the master from a modal, Goods Receipt from a modal, opening each master item to its batch/lot sublist, seeing expiry and lot balance, and audited manual issue from an eligible released lot.
- Manual issue requires a positive quantity, a reason, PIN re-authentication, sufficient lot/master balance, a released non-expired lot, and writes a movement ledger and audit record inside a database transaction.
- Master materials and customers/vendors use reversible archive/reactivate actions to avoid breaking batch, inventory, or audit references. User accounts are deactivated rather than physically deleted. Asset records can be archived/reactivated and show details/events; mutation/disposal requests are dialogs and retain approval history.
- Asset archive/reactivate and manual stock adjustments use database transactions. Reactivating an archived asset restores its pre-archive status where recorded, rather than always setting `AVAILABLE`.
- Removed the hard-coded PostgreSQL password fallback from `index.js`; configure the database password in the local `.env` file.
- Asset event history no longer truncates at 500 events.

## Safe upgrade to a local installation

1. Stop the current Node.js server with `Ctrl+C`.
2. Back up the PostgreSQL database in pgAdmin (use **Backup…** on the database) before replacing source code.
3. Back up `.env`, `public/uploads/`, and any configured private upload directory separately. They may contain credentials, profile photos, vendor/customer documents, CoAs, and other site-specific files.
4. Extract this ZIP into a **new folder** instead of overwriting the only working copy. Copy your existing `.env` and upload directories into the new folder; do not copy the old `node_modules`.
5. From the new project folder run `npm install`, then `npm test`. Resolve errors before opening the database-backed application.
6. Point `.env` at a **staging/test database** where possible; start the app with `npm start` and carry out acceptance tests before testing on the existing working database.
7. Verify roles, all create/edit/archive actions, modal behavior, lot balance, ledger/audit results, BMR/BPR printouts, and delivery forms. Check both light and dark themes at desktop and mobile widths.

Do not drop/reset the existing database to resolve a schema error. Compare the error to actual schema and build a reviewed migration or restore a verified backup.

## Verification performed for this package

- `npm test` passed in the build workspace: JavaScript syntax checks passed and the actual EJS compiler compiled all 54 templates (`EJS compile OK: 54 templates`).
- This check is static/template compilation only; it does not verify live PostgreSQL routes, browser interactions, concurrency, or business-process acceptance.
- ZIP integrity and sensitive-file exclusions are checked during packaging.

## Release limitation

This is a UI/UX and workflow development revision, not a GMP/radiofarmaka validation claim. PostgreSQL integration/regression tests, role-separation tests, concurrency tests, backup/restore, GPS/device field tests, document formatting comparison, QA approval of controlled forms, and documented UAT remain required before any controlled go-live. Archive and manual stock issue functions must follow approved SOPs and cannot substitute for deviation, waste, or stock correction procedures where those are required.
