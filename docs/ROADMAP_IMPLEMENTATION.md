# NUCLEA ERP — Roadmap Integration Map

Build date: 19 October 2026  
Status: integrated development build; not yet released for controlled GMP/radiopharmaceutical use.

## 1. Application navigation and operational chain

`Dashboard → Manufacturing / Production Planning → Production Execution → Batch Record → Production History / QA Release → Distribution → GPS / e-POD / Reverse Logistics`

Cross-functional modules:

- `Inventory`: material master, lot-level Goods Receipt, QC quarantine, release by a different authorized supervisor, lot traceability and automatic production issue.
- `Customer Management` and `Vendor Management`: Registered partner, supporting documents, qualification request, QA questionnaire and decision.
- `Asset Management`: catalog/photo, department mutation and disposal request with EHS/K3LL checklist and approval.
- `Material Requisition`: requester form → SCM stock verification → SCM Supervisor PR/Reject decision → Plant Manager approval; purchasing itself remains outside this ERP.
- `User Management` and `Accounts & Security`: role/status administration, non-destructive deactivation and profile signature image.

## 2. Source-form mapping

| Source document | Implementation location | Data / control carried into the ERP |
|---|---|---|
| `IMS.PD.005-F-01 Work Order` | `/manufacturing/planning` | Work Order and batch identifiers, date, one or more customers from Customer Management, calibration/activity/arrival/travel/delay/delivery/dispensing/vehicle/required production activity, total activity summary, SCM and Production parameters, cancellation audit. |
| `IMS.QA.I-BMR.005 … Citrate` | `/manufacturing/batch-records` and `/manufacturing/history` | `BMR_CITRATE` controlled-copy table/row text is retained in `config/controlled-record-templates.json`; choose when starting the BMR. |
| `IMS.QA.I-BMR.059 … Duo Citrate First Run` | same | `BMR_DUO_FIRST_RUN` template. |
| `IMS.QA.I-BMR.060 … Duo Citrate Second Run` | same | `BMR_DUO_SECOND_RUN` template. |
| `IMS.QA-BPR.006 … Citrate Cassette` | same | `BPR_CITRATE` common BPR for any supported run. |
| `IMS.SC.007-F-01` fleet checklist | `/erp/distribution` | Source-derived inspection items for brakes, tire pressure/spare, lights, fuel, cargo/cabin AC, cargo cleanliness, double lock, cargo seatbelt, GPS, APAR, first aid, radiation spill kit and active/worn dosimeter. A passing checklist is required before dispatch. |
| `IMS.SC.007-F-02` internal product handover | `/erp/distribution` | Three required checks: primary radiation shield, packaging condition and secure shielding lid. Dispatch is blocked until recorded. |
| `IMS.SC.007-F-03` Delivery Order | `/erp/distribution` → `Print IMS.SC.007-F-03` | Batch, customer PO, sales order, customer code, driver/vehicle, product, calibration/expiry, ordered activity, package category, surface dose and leadpot. Transport index and radiation classification remain subject to PPR/QA verification. |
| `IMS.QA.004-F-01` document requirements | `/vendors` | Checklist table and document upload types based on source requirement categories. For `Qualified`, mandatory document types applicable to the selected vendor category must be present and QA-marked Available. |
| `IMS.QA.004-F-02` qualification checklist | `/customers`, `/vendors` | 41 required QA questions must be answered before a qualification decision. Customer qualification data is based on `IMS.QA.019-F-01`; vendor record has category/type and tax/contact details. |
| `IMS.QA.019-F-01` customer qualification | `/customers` | Customer/health facility, APJ, STRA/SIPA and expiry, operational license and expiry, hospital class, accreditation/expiry, radiopharmaceutical license and tax fields. |
| `IMS.SC.002-F-02` asset mutation and `IMS.SC.002-F-08` disposal | `/assets` | Department mutation/change request, disposal reason, status/condition and K3LL checks; approval is separately recorded in the event/audit history. |
| `IMS.SC.006-F-01 Material Requisition Form` | `/material-requisition` | Requester, position, department, date, multi-line item name/specification/quantity/UoM/purpose, SCM item code and stock verification, availability, Process PR/Rejected, PR number and estimated arrival, Plant Manager sign-off. Purchase-order execution remains external. |

The content in `config/controlled-record-templates.json` preserves extracted table/row text from the supplied Word files. The browser-based forms and print views are **reconstructed electronic layouts**, not pixel-perfect copies of signed controlled forms. Document titles/revisions/effective status must be verified against the currently approved QA master copy before use.

## 3. Important lifecycle gates

1. A Work Order customer must exist in Customer Management. A rejected customer cannot be added to a new Work Order.
2. Production role must complete required Work Order parameters before drafting Production Execution.
3. Production enters positive concentration values in both `mCi/mL` and `MBq/mL` and selects material quantities from Material Master.
4. SCM verifies each required material and FEFO-issues available released lots in one database transaction. Quarantine, expired or unreleased lots are not issuable. Aggregate inventory and lot balances are both updated with movements.
5. Batch Execution can start only after all requested material lines are issued. That state makes the batch available for BMR/BPR live entry.
6. Exactly one BMR template may be selected per batch; one common BPR is used. Mandatory source rows must receive `PASS`, `FAIL`, or `N/A` before submission for review.
7. QA cannot release until BMR, BPR and CoA are submitted, the QA PIN is reauthenticated, and the QA reviewer differs from users who started/submitted that batch record.
8. Goods Receipt begins in quarantine with zero available quantity. QC records the inspection result; a different authorized supervisor uses PIN reauthentication to release passing material, and a CoA is required.
9. e-DO creation requires QA release and a Qualified/active customer. Dispatch requires internal product handover, passing vehicle/driver checklist, valid dosimeter date, verified radiation measurement, QA release signature, and an available shielding/leadpot asset.
10. Driver location sharing is per e-DO and browser Geolocation-based. Delivery acknowledgement and leadpot return are recorded in e-POD/reverse-logistics history.
11. Role changes and account deactivation are restricted to system administrators to prevent privilege escalation. Deactivation is soft (preserves historical attribution); it is not a database delete.

## 4. Private files, signatures and audit

Customer/vendor docs, batch CoA, Goods Receipt/CoA, technical MRP attachments, asset photos and profile signature images are stored outside `public/` and served only through an authenticated file route. Metadata contains owner/type, stored path identifier, upload user/time, MIME type, size and SHA-256 checksum. Activity routes write audit events where implemented. An uploaded signature image is a visual signature specimen; PIN-authenticated workflow approval and document hashing do not by themselves create a certified legal digital signature.

## 5. Local validation

From the project directory:

```bash
npm install
npm run check
npm start
```

`npm run check` syntax-checks `index.js`, `modules/erp-integrated.js`, `modules/roadmap-erp.js`, and compiles every EJS file under `views/`. It does not test SQL against a real database. Startup schema sync, route role behavior, transactions, file storage, print quality, concurrent dispatch and all fail/success paths must be tested against a disposable staging PostgreSQL database.

## 6. Go-live blockers / acceptance requirements

- QA must approve the form revision, form layout and all electronic field mappings against the effective controlled originals.
- Site QA/Production/PPR must review all BMR/BPR checklist rows and establish which rows require actual values, initials, timestamps, witness signatures and `N/A` justification. The current engine requires a status for all rows classified actionable in the extracted templates.
- Validate concentration units/conversion, batch yield calculations, product/activity calculations, transport index/radiation units and applicable packing classifications against approved SOPs and legal requirements. The system intentionally does not determine regulatory shipping classification on its own.
- UAT using actual accounts and role matrix, lot expiry/FEFO and rollback negative tests, two-person QA/QC sign-off, multi-customer batch allocation, parallel deliveries/routes, GPS behavior under phone lock/sleep, e-POD, asset disposal and role deactivation.
- Review database migration backup/restore, security controls (CSRF/rate limiting, persistent session store, DB least privilege, upload malware scanning, retention policy, backups/monitoring), electronic record retention and audit trail requirements.
- Complete controlled parallel run against existing approved paper forms and secure QA/IT release before production use.

The archive is a significant source-code integration build, not a claim of production readiness, GMP validation or regulatory compliance.
