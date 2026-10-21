/*
# NUCLEA ERP — Integrated ERP Tables (e-BMR/e-BPR, QC, Labels, Delivery, Telemetry, Sales)

## Purpose
Creates the regulated-manufacturing and distribution tables for digital batch records,
electronic signatures, inventory movements, label printing, delivery orders with radiation
safety, live GPS tracking, proof of delivery, reverse logistics, customer pricing, sales
recognition, and user activity tracking.

## New Tables
1. `erp_audit_events` — Immutable audit trail (actor, action, entity, before/after JSON, IP, user-agent).
2. `erp_signatures` — Electronic signatures (PIN-reauth, document hash, decision, version).
3. `erp_product_bom` — Bill of materials linking a product code to materials with per-batch quantity.
4. `erp_inventory_movements` — Material stock movements (receipt, issue, adjustment) with idempotency keys.
5. `erp_batch_steps` — e-BMR/e-BPR step definitions per batch (sequence, status, performer/verifier).
6. `erp_batch_parameters` — Recorded process parameters per batch step (numeric/text, limits, outcome).
7. `erp_qc_results` — QC test results per batch (pass/fail, specification version, analyst, verifier).
8. `erp_label_jobs` — Print jobs for vial/leadpot/container labels with payload hash and reprint chain.
9. `erp_delivery_orders` — Electronic delivery orders (e-DO) linking dispatch plan, batch, driver, leadpot.
10. `erp_fleet_readiness` — Pre-departure checklist (vehicle, dosimeter calibration, 13-item checklist).
11. `erp_radiation_measurements` — Radiation surface/1m dose-rate measurements with independent verification.
12. `erp_driver_locations` — GPS pings from driver mobile app (lat/lon, accuracy, device timestamp).
13. `erp_proof_of_delivery` — Receiver acknowledgement (name, role, signature text, outcome).
14. `erp_reverse_logistics` — Return of leadpots/containers with condition assessment.
15. `erp_customer_product_pricing` — Per-customer product pricing (quantity, UoM, unit price).
16. `erp_sales_transactions` — Revenue recognition from delivered orders (links DO → customer → pricing).
17. `erp_user_activity` — Per-user active-seconds accumulator for dashboard activity tracking.

## Security
- RLS is NOT enabled. The Express backend connects with the service-role key (bypasses RLS) and the browser
  never connects to Postgres directly. All access control is enforced in the Node.js route layer.

## Notes
- Uses BIGSERIAL for high-volume tables (audit, movements, parameters, QC, locations).
- Foreign keys reference the core tables created in migration 001.
- Indexes target the common query patterns (entity lookups, time-descending scans).
*/

CREATE TABLE IF NOT EXISTS erp_audit_events (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    actor_user_id INTEGER,
    actor_name TEXT,
    actor_role TEXT,
    action VARCHAR(80) NOT NULL,
    entity_type VARCHAR(80) NOT NULL,
    entity_id TEXT NOT NULL,
    reason TEXT,
    before_data JSONB,
    after_data JSONB,
    source_ip TEXT,
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_erp_audit_entity ON erp_audit_events(entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_erp_audit_time ON erp_audit_events(occurred_at DESC);

CREATE TABLE IF NOT EXISTS erp_signatures (
    id BIGSERIAL PRIMARY KEY,
    signer_user_id INTEGER NOT NULL,
    signer_name TEXT NOT NULL,
    signer_role TEXT NOT NULL,
    sign_type VARCHAR(80) NOT NULL,
    document_type VARCHAR(80) NOT NULL,
    document_id TEXT NOT NULL,
    document_version INTEGER NOT NULL DEFAULT 1,
    signed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    auth_method VARCHAR(40) NOT NULL DEFAULT 'PIN_REAUTH',
    decision VARCHAR(30) NOT NULL,
    reason TEXT,
    document_hash TEXT NOT NULL,
    audit_event_id BIGINT
);
CREATE INDEX IF NOT EXISTS idx_erp_signatures_doc ON erp_signatures(document_type, document_id, signed_at DESC);

CREATE TABLE IF NOT EXISTS erp_product_bom (
    id BIGSERIAL PRIMARY KEY,
    product_code VARCHAR(100) NOT NULL,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    quantity_per_batch NUMERIC(18,6) NOT NULL CHECK(quantity_per_batch > 0),
    uom VARCHAR(30),
    version INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(product_code, material_id, version)
);
CREATE INDEX IF NOT EXISTS idx_erp_bom_product ON erp_product_bom(product_code, is_active);

CREATE TABLE IF NOT EXISTS erp_inventory_movements (
    id BIGSERIAL PRIMARY KEY,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    material_batch_id INTEGER,
    movement_type VARCHAR(40) NOT NULL,
    quantity NUMERIC(18,6) NOT NULL CHECK(quantity <> 0),
    uom VARCHAR(30),
    source_type VARCHAR(80),
    source_id TEXT,
    reason TEXT,
    actor_user_id INTEGER,
    actor_name TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    idempotency_key TEXT UNIQUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_erp_movements_mat ON erp_inventory_movements(material_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS erp_batch_steps (
    id BIGSERIAL PRIMARY KEY,
    batch_id VARCHAR(100) NOT NULL,
    record_type VARCHAR(20) NOT NULL CHECK(record_type IN ('BMR','BPR')),
    step_code VARCHAR(80) NOT NULL,
    step_name TEXT NOT NULL,
    sequence_no INTEGER NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    performed_by INTEGER,
    verified_by INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(batch_id, record_type, step_code)
);
CREATE INDEX IF NOT EXISTS idx_erp_steps_batch ON erp_batch_steps(batch_id, record_type, sequence_no);

CREATE TABLE IF NOT EXISTS erp_batch_parameters (
    id BIGSERIAL PRIMARY KEY,
    batch_id VARCHAR(100) NOT NULL,
    step_id BIGINT REFERENCES erp_batch_steps(id) ON DELETE SET NULL,
    record_type VARCHAR(20) NOT NULL DEFAULT 'BMR',
    parameter_code VARCHAR(100),
    parameter_name TEXT NOT NULL,
    actual_numeric NUMERIC,
    actual_text TEXT,
    unit VARCHAR(40),
    target_value TEXT,
    lower_limit NUMERIC,
    upper_limit NUMERIC,
    result_status VARCHAR(30) NOT NULL DEFAULT 'RECORDED',
    entered_by INTEGER NOT NULL,
    entered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_erp_params_batch ON erp_batch_parameters(batch_id, entered_at DESC);

CREATE TABLE IF NOT EXISTS erp_qc_results (
    id BIGSERIAL PRIMARY KEY,
    batch_id VARCHAR(100) NOT NULL,
    test_code VARCHAR(100) NOT NULL,
    test_name TEXT NOT NULL,
    result_numeric NUMERIC,
    result_text TEXT,
    unit VARCHAR(40),
    lower_limit NUMERIC,
    upper_limit NUMERIC,
    acceptance_criteria TEXT,
    outcome VARCHAR(30) NOT NULL,
    specification_version TEXT NOT NULL DEFAULT 'UNCONTROLLED-PENDING-QA',
    analyst_user_id INTEGER NOT NULL,
    performed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    instrument_id TEXT,
    verified_by INTEGER,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_qc_batch ON erp_qc_results(batch_id, performed_at DESC);

CREATE TABLE IF NOT EXISTS erp_label_jobs (
    id BIGSERIAL PRIMARY KEY,
    label_type VARCHAR(30) NOT NULL CHECK(label_type IN ('VIAL','LEADPOT','CONTAINER','MATERIAL')),
    entity_type VARCHAR(60) NOT NULL,
    entity_id TEXT NOT NULL,
    batch_id TEXT,
    template_version TEXT NOT NULL DEFAULT '1.0',
    payload JSONB NOT NULL,
    payload_hash TEXT NOT NULL,
    printed_by INTEGER NOT NULL,
    printed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reprint_of BIGINT REFERENCES erp_label_jobs(id),
    invalidated_at TIMESTAMPTZ,
    reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_erp_label_entity ON erp_label_jobs(entity_type, entity_id, printed_at DESC);

CREATE TABLE IF NOT EXISTS erp_delivery_orders (
    id BIGSERIAL PRIMARY KEY,
    do_number VARCHAR(100) NOT NULL UNIQUE,
    dispatch_plan_id INTEGER UNIQUE,
    batch_id VARCHAR(100) NOT NULL,
    hospital_name TEXT NOT NULL,
    leadpot_code TEXT NOT NULL,
    driver_user_id INTEGER,
    vehicle_code TEXT,
    route_code TEXT,
    seal_number TEXT,
    status VARCHAR(40) NOT NULL DEFAULT 'DRAFT',
    created_by INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_erp_do_status ON erp_delivery_orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS erp_fleet_readiness (
    id BIGSERIAL PRIMARY KEY,
    delivery_order_id BIGINT NOT NULL UNIQUE REFERENCES erp_delivery_orders(id) ON DELETE CASCADE,
    driver_user_id INTEGER NOT NULL,
    vehicle_code TEXT NOT NULL,
    dosimeter_id TEXT NOT NULL,
    dosimeter_calibration_due DATE NOT NULL,
    checklist JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'FAILED',
    checked_by INTEGER NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    review_note TEXT
);

CREATE TABLE IF NOT EXISTS erp_radiation_measurements (
    id BIGSERIAL PRIMARY KEY,
    delivery_order_id BIGINT NOT NULL REFERENCES erp_delivery_orders(id) ON DELETE CASCADE,
    measured_by INTEGER NOT NULL,
    measured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    instrument_id TEXT NOT NULL,
    calibration_due DATE,
    background_rate NUMERIC,
    surface_front NUMERIC,
    surface_back NUMERIC,
    surface_left NUMERIC,
    surface_right NUMERIC,
    rate_at_one_meter NUMERIC,
    unit VARCHAR(30) NOT NULL,
    notes TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING_VERIFICATION',
    verified_by INTEGER,
    verified_at TIMESTAMPTZ,
    record_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_erp_rad_do ON erp_radiation_measurements(delivery_order_id, measured_at DESC);

CREATE TABLE IF NOT EXISTS erp_driver_locations (
    id BIGSERIAL PRIMARY KEY,
    delivery_order_id BIGINT NOT NULL REFERENCES erp_delivery_orders(id) ON DELETE CASCADE,
    driver_user_id INTEGER NOT NULL,
    latitude NUMERIC(10,7) NOT NULL CHECK(latitude BETWEEN -90 AND 90),
    longitude NUMERIC(10,7) NOT NULL CHECK(longitude BETWEEN -180 AND 180),
    accuracy_m NUMERIC,
    device_recorded_at TIMESTAMPTZ,
    server_received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    event_type VARCHAR(30) NOT NULL DEFAULT 'LOCATION',
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_erp_location_latest ON erp_driver_locations(delivery_order_id, server_received_at DESC);

CREATE TABLE IF NOT EXISTS erp_proof_of_delivery (
    id BIGSERIAL PRIMARY KEY,
    delivery_order_id BIGINT NOT NULL UNIQUE REFERENCES erp_delivery_orders(id) ON DELETE CASCADE,
    receiver_name TEXT NOT NULL,
    receiver_role TEXT,
    received_at TIMESTAMPTZ NOT NULL,
    outcome VARCHAR(40) NOT NULL,
    notes TEXT,
    receiver_signature_text TEXT,
    created_by INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp_reverse_logistics (
    id BIGSERIAL PRIMARY KEY,
    delivery_order_id BIGINT NOT NULL REFERENCES erp_delivery_orders(id) ON DELETE CASCADE,
    item_code TEXT NOT NULL,
    item_type VARCHAR(40) NOT NULL DEFAULT 'LEADPOT',
    condition_status VARCHAR(40) NOT NULL,
    returned_by INTEGER NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes TEXT
);

CREATE TABLE IF NOT EXISTS erp_customer_product_pricing (
    id BIGSERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    product_code VARCHAR(100) NOT NULL,
    product_name TEXT NOT NULL,
    pricing_quantity NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK(pricing_quantity > 0),
    uom VARCHAR(30) NOT NULL,
    price NUMERIC(18,2) NOT NULL CHECK(price >= 0),
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(customer_id, product_code, uom)
);
CREATE INDEX IF NOT EXISTS idx_customer_pricing_product ON erp_customer_product_pricing(customer_id, product_code);

CREATE TABLE IF NOT EXISTS erp_sales_transactions (
    id BIGSERIAL PRIMARY KEY,
    delivery_order_id BIGINT NOT NULL UNIQUE REFERENCES erp_delivery_orders(id) ON DELETE CASCADE,
    dispatch_plan_id INTEGER UNIQUE REFERENCES dispatch_plans(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    batch_id VARCHAR(100) NOT NULL,
    product_code VARCHAR(100),
    product_name TEXT NOT NULL,
    quantity NUMERIC(18,6) NOT NULL DEFAULT 0,
    uom VARCHAR(30) NOT NULL DEFAULT 'mCi',
    pricing_id BIGINT REFERENCES erp_customer_product_pricing(id),
    unit_price NUMERIC(18,4),
    total_amount NUMERIC(18,2),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING_PRICING',
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_revenue_time ON erp_sales_transactions(status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON erp_sales_transactions(customer_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS erp_user_activity (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    active_seconds BIGINT NOT NULL DEFAULT 0,
    last_heartbeat TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
