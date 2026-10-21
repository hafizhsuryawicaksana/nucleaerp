# UAT checklist — v6 UX & workflow

Mark each scenario PASS/FAIL in staging and record the tester, date, evidence and defect ID. This list is not proof of validation by itself.

## Shell, navigation and permissions
- [ ] Breadcrumb shown above title on each module and identifies the correct module/page.
- [ ] Header profile menu opens profile/account security; no Account & Security item appears in sidebar.
- [ ] Theme toggle persists; logo colors are correct in light and dark modes.
- [ ] Custom role only sees permitted modules; attempting a forbidden URL is denied server-side.
- [ ] Administrator can add a custom role (e.g. Operational Manager), save permission matrix, assign it to a test user, and delete an unused role.
- [ ] Every authenticated role can view Live Tracking; only the assigned driver can post GPS coordinates.

## Manufacturing
- [ ] Production Planning supports search/status filter, customer assignment, parameter completion and reasoned batch cancellation.
- [ ] Production saves parameters and material needs inside Open Execution.
- [ ] SCM can allocate one or more specific released lots per material; expired/quarantine/unrelated lots are rejected.
- [ ] Allocation mismatch, insufficient stock, or concurrent balance change rolls back all stock movements.
- [ ] Successful issue reduces each lot and master balance exactly once, writes movement ledger/audit, and records lot details.
- [ ] Batch appears in Batch Record after `Execution`; correct BMR type can be selected and BPR is available.
- [ ] QA cannot release a batch missing required BMR/BPR records or CoA; separation of duties is enforced.
- [ ] QA-released batch is the only eligible batch for distribution.
- [ ] Label links appear next to Open Execution; final artwork and printer layout are verified after artwork approval.

## Inventory and deletion
- [ ] Goods Receipt enters quarantine with batch, expiry and CoA.
- [ ] QC inspection and separate release work as configured; quarantined/expired lots cannot be issued.
- [ ] Clicking `Lihat batch` opens lot detail and ledger with signed movement history.
- [ ] Manual lot movement requires valid PIN, reason and sufficient balance; both lot/master balance update atomically.
- [ ] Delete trial succeeds for unused/unreferenced data; deletion is blocked for issued or controlled production history with a clear explanation.
- [ ] Reconcile totals of released lots, master stock and movement ledger for test materials.

## Customer, vendor, asset and requisition
- [ ] Customer/vendor registration documents upload and QA qualification status decisions function with required evidence.
- [ ] Registered customer/vendor is not treated as Qualified automatically.
- [ ] Asset catalog/detail/photo, mutation/disposal request and approval history display correctly.
- [ ] Material Requisition includes requester, items, stock verification, SCM decision, PR number and estimated arrival.
- [ ] Delete actions are visible to authorized users and server-side relationship constraints operate as intended.

## Distribution and Live Tracking
- [ ] DO creation blocked for unqualified customer, non-released batch or missing required data as configured.
- [ ] Vehicle checklist and radiation measurement verification use independent roles/persons as required.
- [ ] Dispatch blocked when QA release, checklist, verified measurement, internal handover, or valid leadpot is missing.
- [ ] Dispatch changes delivery to `IN_TRANSIT`; all roles see current delivery and latest available GPS.
- [ ] Assigned driver opens Live Tracking on a phone, taps Start Delivery and explicitly grants location permission.
- [ ] Map refresh, stale/no-GPS state, permissions denied, network loss, Stop GPS, delivery completed/POD and reverse logistics are tested.
- [ ] Test over the intended network using HTTPS; verify mobile background limits and location privacy policy.

## Security, audit and release
- [ ] Important master changes, stock movements, role/permission changes, QA decisions and delivery state changes appear in audit history.
- [ ] Backup and restore are tested on staging.
- [ ] BMR, BPR, CoA, e-DO, e-POD and digital signature semantics/layout are approved by QA/compliance before controlled use.
- [ ] Operators are trained and a go-live owner signs off every applicable scenario.

## Additional trial cleanup checks
- Confirm Work Orders in SCHEDULED/CANCELLED status show `Delete trial` for authorised SCM/admin users.
- Confirm a Work Order with no execution/history is deleted together with draft execution lines and scheduled/cancelled dispatch plans, with an audit entry.
- Confirm deletion is denied once materials have been issued, a Batch Record/controlled parameter/QC/signature/label job/Delivery Order exists, or a dispatch plan has moved beyond SCHEDULED/CANCELLED.
- Confirm failed deletion leaves the Work Order and linked rows unchanged (transaction rollback).
