# NUCLEA ERP — Integrated Development Build (v2.1 · UX & Workflow Revision v6)

This archive integrates the original Express/EJS ERP with roadmap modules for manufacturing planning/execution, live batch records, QA history, quarantine inventory, partner qualification, asset change control, Material Requisition, delivery/fleet checks and driver GPS. Existing legacy pages remain available during transition. It is an integration/development build, not a validated production release.

## Run locally on Windows / VS Code

1. Install Node.js LTS and PostgreSQL.
2. Create a PostgreSQL database named `nuclea_erp`.
3. Copy `.env.example` to `.env` and replace `PGPASSWORD` with the password for your local PostgreSQL user. Change `SESSION_SECRET` to a random 32+ character string.
4. Open this folder (the one containing `index.js` and `package.json`) in VS Code.
5. In the integrated terminal run:
   ```powershell
   npm install
   npm start
   ```
6. Visit `http://localhost:3000`. In development, the current seed logic creates the legacy demo admin if it does not already exist. Legacy initial credential in the original seed remains `admin@ims.com` / `admin123`; change it immediately after local access.
7. Use the module names in the left sidebar; use the breadcrumb above each page title to orient yourself.

Database table additions are applied by `modules/erp-integrated.js` and `modules/roadmap-erp.js` during startup after the legacy schema. Back up data before upgrading an existing installation. For production, run a reviewed/staged migration rather than relying on application startup for schema change.


## Roadmap modules implemented in this build

- Dashboard uses operational counts for planned work orders, QA review backlog, quarantine stock, low inventory, customer/vendor QA, open material requests, material issue queue, live record filling, QA release queue and deliveries in transit. Demo-only yield/location charts have been removed so mock numbers are not presented as live production data.
- `/manufacturing/planning`: multi-customer Work Order/calendar with required fields from `IMS.PD.005-F-01`, Production parameters, cancellation reason and audit history.
- `/manufacturing/execution`: Production concentration input (`mCi/mL` and `MBq/mL`), material requirement list from active Material Master, SCM selection of actual released/unexpired lot allocations and an execution gate; issue transactions update lot/master stock, ledger, batch trace details and audit atomically.
- `/manufacturing/batch-records` and `/manufacturing/history`: source-derived BMR choice (Citrate / Duo First Run / Duo Second Run), common BPR, row-by-row live tracking, controlled template print reconstruction, CoA upload and separate QA release.
- `/inventory`: material master + goods receipt/lot quarantine, QC inspection and PIN-controlled release by a different user; issued stock links back to batches and movement ledger.
- `/customers` and `/vendors`: register, private files, QA qualification requests and 41-item questionnaire. Vendor `Qualified` approval also checks source-required documents by vendor category.
- `/assets`: visual asset catalog/photo, department mutation and disposal request with K3LL checklist.
- `/material-requisition`: requester-facing form aligned to `IMS.SC.006-F-01`; SCM stock verification, Process PR/Rejected decision, PR number and ETA, then Plant Manager sign-off. Purchasing operations themselves remain external.
- Profile (`/profile`) accepts a private signature image and account security stays in the profile menu. `Security Control` combines users, custom roles, module permissions and audit trail.
- Source-form-to-module mapping, process interlocks, test commands and go-live gates are detailed in [`docs/ROADMAP_IMPLEMENTATION.md`](docs/ROADMAP_IMPLEMENTATION.md).

## UX & Workflow Revision v6

- Global shell includes breadcrumb/directory for module/page, responsive header, search, notifications, theme toggle and profile actions. Sidebar includes Manufacturing, Inventory, Asset, Vendor, Customer, Material Requisition, Distribution/Live Tracking, and Security Control.
- Inventory has material + lot detail, per-lot movement history, reason/PIN controlled manual adjustment and guarded Delete trial.
- Production Planning provides a Delete trial action only for non-executed SCHEDULED/CANCELLED Work Orders without controlled records or downstream dispatch history.
- Production material needs are entered per batch in Open Execution; SCM selects actual lot(s) and quantity. The legacy automatic BOM/FEFO production-start path is retired so it cannot silently issue stock.
- Label shortcuts live beside Open Execution; final label artwork must still be approved/provided before production use.
- Live Tracking App lets assigned drivers share browser GPS for IN_TRANSIT delivery while other authorized ERP users can view active positions. Mobile geolocation over LAN normally requires HTTPS; background browser tracking may be suspended by the operating system.
- Detailed scope and limitations: [`docs/UX_REVISION_V6.md`](docs/UX_REVISION_V6.md), installation: [`docs/LOCAL_INSTALL_V6.md`](docs/LOCAL_INSTALL_V6.md), and acceptance checks: [`docs/UAT_CHECKLIST_V6.md`](docs/UAT_CHECKLIST_V6.md).

## Packaging and environment safety

The handoff ZIP excludes the local `.env`, `node_modules/` and private uploaded files. Copy `.env.example` to `.env`, configure a staging PostgreSQL database and run `npm install` before use. Do not copy secrets from a developer workstation into the deployment package.

## Code changes in this build

- `.env`-based database configuration, configurable port, session secret from environment, HttpOnly/SameSite cookies, and startup waits for database/schema initialization.
- Legacy password compatibility: plaintext legacy passwords are upgraded to Node.js `scrypt` hashes at successful login; new signup passwords use `scrypt`. Users cannot assign themselves a privileged role at signup or via their own profile.
- Administrator-only role assignment page (`/erp/access-control`) with allowed role list and audit records.
- Integration Health has been removed; security settings and audit events are handled in Security Control.
- Legacy BOM tables remain for historical compatibility, but `/erp/bom` redirects to the unified Open Execution workflow. The legacy `/execute-production` auto-FEFO path is retired; Production defines requirements and SCM chooses actual lot allocation in Open Execution.
- Digital batch record screens (`/erp/batch-records`): sequential BMR/BPR step start/completion with server timestamps, append-only actual parameter records, QC results with range checks, PIN re-authentication sign-offs, document hash and role/separation-of-duties checks for review/QA release.
- Inventory ledger page (`/erp/inventory-adjustment`) with authorized manual stock issue tied to a released lot, PIN re-auth, reason and audit record.
- Integrated label print jobs for vial/leadpot/container (`/erp/labels`) with batch-linked metadata, Code 39 barcode SVG, printable label view, print job hash, and reprint history.
- Digital distribution (`/erp/distribution`): e-DO creation only for QA-released batch with an active/Qualified customer and available registered leadpot/container; source-derived 13-item pre-departure vehicle checklist, internal product handover, assigned driver and personal dosimeter calibration; required survey-meter calibration date; independent PIN-verified radiation measurement approval; dispatch interlocks; driver GPS ingestion endpoint and mobile browser page; e-POD acknowledgment and reverse logistics return.
- Business audit trail viewer (`/erp/audit`).
- Fix for the legacy QA-release transaction which previously called `BEGIN`, writes and `COMMIT` on different pooled connections; new version uses a single checked-out client.

## Important limitations — not yet production validated

This is an improved functional development build with newly implemented integrated screens and routes. It is **not** a declaration that every feature in the roadmap is complete or validated. The companion `docs/ROADMAP_IMPLEMENTATION.md` maps supplied source forms to modules and lists specific acceptance gates. In particular:

- The mobile GPS page uses browser Geolocation and requires permission; background behavior on target phones must be field tested. It is not a guaranteed always-on native tracker.
- The receiver's POD acknowledgement is a typed confirmation/reference, not a certified external digital signature.
- The label template is an editable development template. QA must approve mandatory text, size, barcode scanner/printer compatibility, activity fields, and applicable radiation labels before use.
- Radiation measurement data is recorded but the app intentionally does not assign regulatory TI/packaging categories or decide safety compliance automatically. PPR/QA must validate formulas, units, acceptance limits, instrument calibration requirements and dispatch SOP first.
- QC specs entered at runtime are not controlled product-specification masters yet. A controlled specification/method master, OOS/deviation/CAPA workflows, sample chain-of-custody details and instrument import adapters still need implementation/validation.
- Existing legacy Procurement UI is preserved, but complete vendor qualification/AVL, RFQ/bidding, PO, GRN/invoice 3-way matching and annual budget approvals are not all newly integrated end-to-end in this build.
- Legacy screens still exist in the monolithic `index.js`; further modularization and route-by-route regression testing remain needed.
- The old seed data is for development only. Production startup does not auto-create the default admin or seed operational data; provision authorized users securely.
- `scrypt` password migration preserves compatibility, but you still need a managed session store, CSRF protection, rate limiting, private file/object storage, backup/restore drills, least-privilege DB users and security validation before production.
- Electronic sign-off in this application uses PIN re-authentication and an application-side document hash. It is not, by itself, a certified legal digital-signature service nor proof of regulatory compliance with 21 CFR Part 11/GMP/BAPETEN requirements.

## Recommended first-run order

1. Configure role/identity records under User Role Control.
2. Reconcile opening stock at material + lot + expiry + status level. Do not fabricate batches to force aggregate stock to match.
3. Register/receive actual materials, upload real documents, and release the correct lots after QC approval.
4. Define and QA-approve BOM lines using the exact Work Order `item_code`.
5. Create schedule/Work Order → start batch (BOM issue commits automatically) → complete process and steps → record parameter/QC data → production review → QC verification by a different user → QA release by a separate authorized user.
6. Create the e-DO only after QA release, record radiation measurements with calibrated instrument details, have a different authorized verifier approve them, then dispatch, track, record e-POD and reconcile the returned leadpot.
7. Complete UAT and parallel run with the existing approved paper procedure before controlled go-live.

## Do not overwrite your original source

Keep a backup of your original project. Test this build in a fresh folder and staging database first. If an existing production database is used, back it up and review the table additions and behavior before executing.
