/*
# NUCLEA ERP — Roadmap Module Tables (Planning, Execution, Qualification, Roles)

## Purpose
Creates the roadmap workflow tables: controlled-record templates, work orders with multi-customer
allocation, batch execution with material lot allocation, digital batch records, partner (customer/vendor)
qualification, asset lifecycle requests, material requisitions, private document storage, and the
custom role-based access control system.

## New Tables
1. `roadmap_private_files` — Private document storage metadata (signatures, asset photos, batch attachments) — files served only to authenticated sessions.
2. `roadmap_material_inspections` — QC inspection results for material batches (pass/fail).
3. `roadmap_work_orders` — Production work orders linking a production run to a product and schedule.
4. `roadmap_work_order_customers` — Multi-customer allocation per work order (calibration time, activity, travel time, vehicle).
5. `roadmap_batch_executions` — Execution details for a work order (concentration, SCM/production parameters, status).
6. `roadmap_batch_materials` — Material lot allocation requests per execution (requested vs issued qty, lot details, verification).
7. `roadmap_batch_records` — Controlled digital batch records (BMR/BPR) with template reference and JSON data.
8. `roadmap_partner_qualifications` — Customer/vendor qualification workflow (checklist, documents, QA decision).
9. `roadmap_asset_requests` — Asset mutation/disposal requests with K3LL assessment and approval.
10. `roadmap_asset_events` — Asset lifecycle event log (movements, status changes).
11. `roadmap_material_requisitions` — Inter-department material requisitions with SCM verification and plant-manager approval.
12. `roadmap_material_requisition_items` — Line items for a material requisition (code, spec, qty, stock info, SCM action).
13. `roadmap_batch_attachments` — Links between batch records and private files (attachment type scoped).
14. `erp_roles` — Role definitions (system vs custom) for the Security Control access matrix.
15. `erp_role_permissions` — Per-role, per-module permission flags (view/create/edit/delete/approve).

## Security
- RLS is NOT enabled. The Express backend uses the service-role key and enforces access control in the route layer.
- The `users.digital_signature_file_id` and `assets.photo_file_id` columns (added in migration 001 as plain BIGINT)
  reference `roadmap_private_files.id`. They are declared without FK constraints here to avoid circular dependency;
  the application layer enforces file ownership and serving.

## Notes
- Work orders, executions, and requisitions use BIGSERIAL.
- ON DELETE CASCADE is set on child tables (work order customers, batch materials, requisition items) so deleting
  a parent cleans up its children.
- System roles are seeded in the data migration (004).
*/

CREATE TABLE IF NOT EXISTS roadmap_private_files (
    id BIGSERIAL PRIMARY KEY,
    owner_type VARCHAR(50) NOT NULL,
    owner_id TEXT NOT NULL,
    document_type VARCHAR(100) NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    storage_area VARCHAR(20) NOT NULL DEFAULT 'files',
    mime_type TEXT,
    size_bytes BIGINT,
    uploaded_by INTEGER,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum_sha256 TEXT
);
CREATE INDEX IF NOT EXISTS idx_roadmap_files_owner ON roadmap_private_files(owner_type, owner_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS roadmap_material_inspections (
    id BIGSERIAL PRIMARY KEY,
    material_batch_id INTEGER NOT NULL REFERENCES material_batches(id) ON DELETE CASCADE,
    result VARCHAR(12) NOT NULL CHECK(result IN ('PASS','FAIL')),
    notes TEXT,
    inspector_user_id INTEGER NOT NULL,
    inspected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap_work_orders (
    id BIGSERIAL PRIMARY KEY,
    work_order_no VARCHAR(100) NOT NULL UNIQUE,
    production_id INTEGER NOT NULL UNIQUE REFERENCES productions(id) ON DELETE CASCADE,
    batch_id VARCHAR(100) NOT NULL UNIQUE,
    product_code VARCHAR(100) NOT NULL,
    product_name TEXT NOT NULL,
    preparation_start TIMESTAMP,
    preparation_end TIMESTAMP,
    scm_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    production_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    production_parameters_complete BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(40) NOT NULL DEFAULT 'SCHEDULED',
    created_by INTEGER,
    production_parameters_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_roadmap_wo_date_status ON roadmap_work_orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS roadmap_work_order_customers (
    id BIGSERIAL PRIMARY KEY,
    work_order_id BIGINT NOT NULL REFERENCES roadmap_work_orders(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    calibration_time TIMESTAMP,
    activity_at_cal_mci NUMERIC(18,6),
    arrival_time TIMESTAMP,
    travel_time_min INTEGER,
    max_delay_time_min INTEGER,
    delivery_start_time TIMESTAMP,
    dispensing_start_time TIMESTAMP,
    lead_time_min INTEGER,
    vehicle_no VARCHAR(100),
    required_production_activity_mci NUMERIC(18,6),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_roadmap_wo_customer ON roadmap_work_order_customers(work_order_id);

CREATE TABLE IF NOT EXISTS roadmap_batch_executions (
    id BIGSERIAL PRIMARY KEY,
    work_order_id BIGINT NOT NULL UNIQUE REFERENCES roadmap_work_orders(id) ON DELETE CASCADE,
    production_id INTEGER NOT NULL UNIQUE REFERENCES productions(id),
    concentration_mci_ml NUMERIC(18,8),
    concentration_mbq_ml NUMERIC(18,8),
    parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    prepared_by INTEGER,
    scm_verified_by INTEGER,
    executed_by INTEGER,
    scm_verified_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap_batch_materials (
    id BIGSERIAL PRIMARY KEY,
    execution_id BIGINT NOT NULL REFERENCES roadmap_batch_executions(id) ON DELETE CASCADE,
    material_id INTEGER NOT NULL REFERENCES materials(id),
    requested_qty NUMERIC(18,6) NOT NULL CHECK(requested_qty > 0),
    uom VARCHAR(30),
    notes TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED',
    issued_qty NUMERIC(18,6) NOT NULL DEFAULT 0,
    lot_details JSONB NOT NULL DEFAULT '[]'::jsonb,
    verified_by INTEGER,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_roadmap_batch_materials_execution ON roadmap_batch_materials(execution_id);

CREATE TABLE IF NOT EXISTS roadmap_batch_records (
    id BIGSERIAL PRIMARY KEY,
    batch_id VARCHAR(100) NOT NULL,
    record_type VARCHAR(10) NOT NULL CHECK(record_type IN ('BMR','BPR')),
    template_code VARCHAR(40) NOT NULL,
    template_revision VARCHAR(60),
    status VARCHAR(40) NOT NULL DEFAULT 'IN_PROGRESS',
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_by INTEGER,
    submitted_by INTEGER,
    reviewed_by INTEGER,
    review_note TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_at TIMESTAMPTZ,
    reviewed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(batch_id, record_type)
);
CREATE INDEX IF NOT EXISTS idx_roadmap_records_status ON roadmap_batch_records(status, batch_id);

CREATE TABLE IF NOT EXISTS roadmap_partner_qualifications (
    id BIGSERIAL PRIMARY KEY,
    partner_type VARCHAR(20) NOT NULL CHECK(partner_type IN ('CUSTOMER','VENDOR')),
    partner_id INTEGER NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING_QA',
    checklist JSONB NOT NULL DEFAULT '{}'::jsonb,
    document_checklist JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by INTEGER,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by INTEGER,
    reviewed_at TIMESTAMPTZ,
    decision_note TEXT,
    UNIQUE(partner_type, partner_id, status)
);
CREATE INDEX IF NOT EXISTS idx_roadmap_qual_pending ON roadmap_partner_qualifications(status, partner_type);

CREATE TABLE IF NOT EXISTS roadmap_asset_requests (
    id BIGSERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    request_type VARCHAR(20) NOT NULL CHECK(request_type IN ('MUTATION','DISPOSAL')),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING_APPROVAL',
    requested_by INTEGER,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    current_department TEXT,
    target_department TEXT,
    handover_to TEXT,
    purpose TEXT,
    reason TEXT,
    condition_status TEXT,
    k3ll_assessment JSONB NOT NULL DEFAULT '{}'::jsonb,
    waste_classification VARCHAR(80),
    approval_note TEXT,
    approved_by INTEGER,
    approved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_roadmap_asset_requests ON roadmap_asset_requests(status, request_type);

CREATE TABLE IF NOT EXISTS roadmap_asset_events (
    id BIGSERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    event_type VARCHAR(40) NOT NULL,
    event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_user_id INTEGER,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap_material_requisitions (
    id BIGSERIAL PRIMARY KEY,
    request_no VARCHAR(80) NOT NULL UNIQUE,
    requester_user_id INTEGER NOT NULL,
    requester_name TEXT NOT NULL,
    position TEXT,
    department TEXT NOT NULL,
    request_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(40) NOT NULL DEFAULT 'SUBMITTED',
    scm_verification JSONB NOT NULL DEFAULT '{}'::jsonb,
    pr_number VARCHAR(100),
    estimated_arrival DATE,
    scm_note TEXT,
    plant_manager_user_id INTEGER,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap_material_requisition_items (
    id BIGSERIAL PRIMARY KEY,
    requisition_id BIGINT NOT NULL REFERENCES roadmap_material_requisitions(id) ON DELETE CASCADE,
    item_code VARCHAR(100),
    item_name TEXT NOT NULL,
    specification TEXT,
    quantity NUMERIC(18,6) NOT NULL CHECK(quantity > 0),
    uom VARCHAR(30) NOT NULL,
    purpose TEXT NOT NULL,
    available BOOLEAN,
    storage_location VARCHAR(150),
    current_stock NUMERIC(18,6),
    min_stock NUMERIC(18,6),
    scm_action VARCHAR(40),
    scm_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_roadmap_mr_status ON roadmap_material_requisitions(status, created_at DESC);

CREATE TABLE IF NOT EXISTS roadmap_batch_attachments (
    id BIGSERIAL PRIMARY KEY,
    batch_id VARCHAR(100) NOT NULL,
    attachment_type VARCHAR(40) NOT NULL,
    private_file_id BIGINT NOT NULL REFERENCES roadmap_private_files(id) ON DELETE CASCADE,
    uploaded_by INTEGER,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(batch_id, attachment_type, private_file_id)
);

CREATE TABLE IF NOT EXISTS erp_roles (
    id BIGSERIAL PRIMARY KEY,
    role_name VARCHAR(120) NOT NULL UNIQUE,
    role_code VARCHAR(140) NOT NULL UNIQUE,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp_role_permissions (
    role_id BIGINT NOT NULL REFERENCES erp_roles(id) ON DELETE CASCADE,
    module_code VARCHAR(60) NOT NULL,
    can_view BOOLEAN NOT NULL DEFAULT FALSE,
    can_create BOOLEAN NOT NULL DEFAULT FALSE,
    can_edit BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete BOOLEAN NOT NULL DEFAULT FALSE,
    can_approve BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(role_id, module_code)
);
