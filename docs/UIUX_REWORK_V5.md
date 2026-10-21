# NUCLEA ERP UI/UX Revision v5

## User-requested updates

- Production Planning product field is now free-text with browser datalist suggestions. Existing product names are reused; a new product name creates a normalized internal product code automatically and is audit logged. The product creation and Work Order creation are in the same transaction.
- Added explicit permanent-delete actions for trial data on material masters, customers/vendors, and assets. These routes require an authorized role, ask for confirmation in the UI, record an audit event, and refuse deletion when the entity has dependent lot, BOM, Work Order, qualification, vendor PR, asset-request, event, or non-photo document history. Use archive/deactivate for records that have been used by operational workflows.
- Trial asset deletion can remove the associated asset photo metadata/file when the asset has no operational history beyond its initial creation event. Disposed assets are never hard-deleted.
- Material deletion is only shown where no lot exists and is checked server-side against lot, BOM, and batch-material references.
- Partner delete action is shown for records without pending QA qualification and uploaded documents, with server-side relationship checks.

## Safe delete semantics

Delete is intended for accidental or trial records only. A delete action can still be rejected by a database foreign-key constraint if a legacy module references that record; the route returns an error rather than cascading through unrelated business records. Never use hard delete for released batch records, inventory movements, CoA, controlled BMR/BPR, delivery evidence, or records required by retention policy.

## Verification status

- JavaScript syntax checks pass (`node --check` on the three application entry points/modules).
- Full `npm test` could not be completed in this build workspace because npm dependency installation did not complete and the local EJS package directory is incomplete. Run `npm install` and `npm test` on the target Windows machine before using this build.
- No live PostgreSQL integration test or browser UAT was performed for this revision. Verify free-text product creation, transaction rollback, delete guards, dark/light mode, modals, and role restrictions in a staging database before operational release.
