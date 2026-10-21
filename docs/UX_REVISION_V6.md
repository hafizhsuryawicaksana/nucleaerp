# NUCLEA ERP — UX & Workflow Revision v6

## Navigation and global shell
- Added a consistent breadcrumb/directory above the page heading (`Home > module > page`) for the current roadmap modules and common legacy pages.
- Role-aware navigation and dashboard shortcuts hide modules that a custom role cannot view.
- Retained profile, account security, theme toggle, notifications and sign-out in the header; Account & Security is not a sidebar module.
- Light-mode logo remains in its original colors with reduced brightness/saturation; dark mode avoids the old white-inversion conflict.

## Operations UX
- Dashboard includes operational KPI cards, workflow queues, quick actions, low-stock attention, and module shortcuts; links are filtered for custom roles.
- Production Planning / Execution / Batch Record / Production History and Distribution retain search/filter controls and workflow-oriented summaries.
- Inventory is the module name (formerly Material Master), with material register, lot/batch detail dialogs and per-lot ledger/movement actions.
- Asset, partner (Customer/Vendor) and Material Requisition forms/actions use dialog-oriented workflows, detailed records and status/search controls.
- `Integration Control Center` is presented as `Integration Health`: it summarizes workflow health and helps navigate to the area where a status is produced. It is not a third-party integration runtime or external connector manager.
- `Driver GPS Checkin` is presented as `Live Tracking App`.
- Vial/leadpot label shortcuts are shown beside `Open Execution` in Production Execution. Final approved label artwork is intentionally pending from the business owner.

## Material issue control
- Production enters the per-batch material requirements inside `Open Execution`.
- SCM must allocate one or more actual released, unexpired lots per requested material and quantity. Server-side validation checks lot/material relationship, lot status, expiry, available stock and exact total allocation.
- Lot issues, aggregate master stock updates, movement ledger rows, batch material trace details and audit entries run in a single PostgreSQL transaction. Failed validation rolls the transaction back.
- The former standalone BOM editor route redirects into Production Execution, and the legacy `/execute-production` endpoint no longer performs implicit FEFO/BOM material issue. Historical BOM records remain untouched except when an administrator explicitly deletes an unused trial material after server-side checks.

## Delete Trial policy
- Delete actions are available on appropriate master/register pages. Server-side checks still protect data used by executed batches, issued stock, controlled Batch Records, qualification history or downstream delivery references.
- Inventory material deletion can remove unissued draft material requirement lines and unused BOM references when no production issue/release/record depends on them; dependent trial lots, QC metadata and trial ledger rows are removed in the same transaction. Production issue and controlled batch history are protected.
- Production Planning now offers `Delete trial` for SCHEDULED/CANCELLED Work Orders only when there is no issued material, Batch Record, controlled parameter/QC/signature, label job, Delivery Order, or non-draft dispatch history. The server performs checks and cleanup in a database transaction and records an audit event before deletion.
- A blocked delete should be treated as a relationship/traceability constraint, not as a UI defect. Use deactivate/archive when business history must remain.

## UX design references consulted
- SAP Fiori Shell Bar / hierarchy guidance informs the persistent global header, identity/profile actions, navigation hierarchy and breadcrumb treatment: https://experience.sap.com/fiori-design-web/v1-66/shell-bar/ and https://experience.sap.com/fiori-design-web/category-navigation/
- SAP Fiori table/list guidance informs concise table titles, row counts, and search/filter placement: https://experience.sap.com/fiori-design-web/explore_group/table-list-tree/page/3/
- Odoo 18 search/filter/grouping guidance informs consistent register filters: https://www.odoo.com/documentation/18.0/applications/essentials/search.html
- Odoo 19 dashboard guidance informs relevant KPI summaries and filtering: https://www.odoo.com/documentation/19.0/applications/productivity/dashboards.html
These sources informed layout patterns; the ERP implementation is custom and still requires business UAT and accessibility/usability testing.
