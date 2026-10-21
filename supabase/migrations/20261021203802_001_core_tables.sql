/*
# NUCLEA ERP — Core Tables

## Purpose
Establishes the foundational schema for the NUCLEA radiopharmaceutical ERP.
This migration creates the core business tables that all other modules build upon.

## New Tables
1. `users` — System user accounts (staff). Uses the app's own scrypt password hashing (not Supabase auth). Columns cover identity, contact, preferences, security (PIN, 2FA), and account status.
2. `login_trails` — Login audit log (success / failure / 2FA) per user, device IP, browser.
3. `notifications` — In-app bell notifications targeted to a user (or broadcast when user_id is NULL).
4. `materials` — Raw material / consumable masterlist with stock, min-stock, pricing, storage.
5. `products` — Finished product master (radioisotope properties: half-life, decay constant, pH/purity limits, BOM text).
6. `productions` — Production batch runs (batch_id, environment, bombardment, yield, QC, status, QA disposition, schedule fields).
7. `assets` — Physical assets (cyclotron, leadpots, vehicles) with location and status.
8. `vendors` — Supplier master with qualification status and contact details.
9. `requisitions` — Material Store Requisition (MSR) requests.
10. `purchase_requisitions` — Purchase Requisitions (PR) with line details and finance approval status.
11. `customers` — Hospital / customer master with qualification, licensing, and accreditation fields.
12. `dispatch_plans` — Distribution dispatch plans linking a production batch to a customer/hospital and leadpot.
13. `material_batches` — Goods-receipt batches of a material (quarantine → unrestricted lifecycle, qty remaining, documents).

## Security
- RLS is NOT enabled on these tables. This application uses its own Express-session + scrypt authentication layer (not Supabase auth), and the Node.js server connects with the service-role key which bypasses RLS. The browser never talks to Postgres directly — all data flows through the Express backend. Enabling RLS here would block the service-role connection pool used by the app. RLS will remain disabled for all application tables in this project.

## Notes
- All tables use SERIAL/BIGSERIAL integer primary keys to match the existing Node.js code which references numeric IDs everywhere.
- `IF NOT EXISTS` guards make this migration safe to re-run.
*/

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(100) NOT NULL,
    profile_photo VARCHAR(255),
    department VARCHAR(100),
    phone VARCHAR(50),
    emergency_contact VARCHAR(100),
    is_email_verified BOOLEAN DEFAULT FALSE,
    language VARCHAR(10) DEFAULT 'en',
    timezone VARCHAR(50) DEFAULT 'Asia/Jakarta',
    email_notif BOOLEAN DEFAULT TRUE,
    push_notif BOOLEAN DEFAULT TRUE,
    pin VARCHAR(255),
    is_2fa_enabled BOOLEAN DEFAULT FALSE,
    account_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    digital_signature_file_id BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS login_trails (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    device_ip VARCHAR(50),
    browser_info VARCHAR(255),
    status VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(150),
    message TEXT,
    type VARCHAR(50) DEFAULT 'info',
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS materials (
    id SERIAL PRIMARY KEY,
    material_code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    uom VARCHAR(20),
    current_stock NUMERIC DEFAULT 0,
    min_stock NUMERIC DEFAULT 0,
    moving_avg_price NUMERIC DEFAULT 0,
    storage_condition VARCHAR(100),
    material_type VARCHAR(100),
    material_description TEXT,
    storage_location VARCHAR(150),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    half_life_min NUMERIC,
    decay_constant NUMERIC,
    ph_limit VARCHAR(50),
    purity_limit VARCHAR(50),
    bom_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS productions (
    id SERIAL PRIMARY KEY,
    batch_id VARCHAR(100) UNIQUE NOT NULL,
    env_temp NUMERIC,
    env_pressure NUMERIC,
    beam_current_ua NUMERIC,
    beam_duration_min NUMERIC,
    actual_eob TIMESTAMP,
    raw_yield_mci NUMERIC,
    qc_ph NUMERIC,
    qc_purity NUMERIC,
    qc_sterility VARCHAR(50),
    approved_by INTEGER,
    status VARCHAR(50) DEFAULT 'DRAFT',
    qa_disposition VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    batch_size NUMERIC,
    production_notes TEXT,
    production_date DATE,
    calib_time VARCHAR(50),
    item_code VARCHAR(100),
    leadpot VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    asset_code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    weight_kg NUMERIC,
    current_location VARCHAR(100) DEFAULT 'FACILITY',
    status VARCHAR(50) DEFAULT 'AVAILABLE',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    department VARCHAR(120),
    acquisition_date DATE,
    brand VARCHAR(120),
    asset_type VARCHAR(120),
    purpose TEXT,
    photo_file_id BIGINT,
    serial_number VARCHAR(120),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendors (
    id SERIAL PRIMARY KEY,
    vendor_code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    category VARCHAR(100),
    contact_person VARCHAR(100),
    email VARCHAR(100),
    phone VARCHAR(50),
    address TEXT,
    registration_status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    qualification_status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED',
    vendor_type VARCHAR(80),
    tax_id TEXT,
    qualification_expiry DATE
);

CREATE TABLE IF NOT EXISTS requisitions (
    id SERIAL PRIMARY KEY,
    req_number VARCHAR(50) UNIQUE NOT NULL,
    department VARCHAR(100),
    item_description VARCHAR(255) NOT NULL,
    quantity NUMERIC NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING_APPROVAL',
    uom VARCHAR(20),
    required_date DATE,
    justification TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_requisitions (
    id SERIAL PRIMARY KEY,
    pr_number VARCHAR(100) UNIQUE NOT NULL,
    request_date DATE,
    item_name VARCHAR(255) NOT NULL,
    total_price NUMERIC,
    vendor_id INTEGER REFERENCES vendors(id),
    status VARCHAR(50) DEFAULT 'WAITING_FINANCE_APPROVAL',
    department VARCHAR(100),
    specification TEXT,
    quantity NUMERIC,
    uom VARCHAR(50),
    est_unit_price NUMERIC,
    purpose TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    customer_code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    category VARCHAR(100),
    address TEXT,
    contact_person VARCHAR(100),
    phone VARCHAR(50),
    email VARCHAR(100),
    status VARCHAR(20) DEFAULT 'ACTIVE',
    contract_price NUMERIC DEFAULT 0,
    registration_status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    qualification_status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED',
    fax VARCHAR(80),
    apj_name TEXT,
    apj_address TEXT,
    apj_stra_no TEXT,
    apj_stra_expiry DATE,
    apj_sipa_no TEXT,
    apj_sipa_expiry DATE,
    operating_license_no TEXT,
    operating_license_expiry DATE,
    hospital_class VARCHAR(20),
    accreditation VARCHAR(40),
    accreditation_expiry DATE,
    radiopharmaceutical_license_no TEXT,
    tax_id TEXT,
    taxpayer_name TEXT
);

CREATE TABLE IF NOT EXISTS dispatch_plans (
    id SERIAL PRIMARY KEY,
    order_reference VARCHAR(100),
    hospital_name VARCHAR(255),
    production_batch_id VARCHAR(100),
    asset_code VARCHAR(50),
    allocated_mci NUMERIC,
    status VARCHAR(50) DEFAULT 'IN_TRANSIT',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS material_batches (
    id SERIAL PRIMARY KEY,
    material_id INTEGER REFERENCES materials(id) ON DELETE CASCADE,
    batch_number VARCHAR(100) NOT NULL,
    qty NUMERIC NOT NULL,
    qty_remaining NUMERIC,
    expiry_date DATE,
    status VARCHAR(50) DEFAULT 'QUARANTINE',
    gr_document VARCHAR(255),
    coa_document VARCHAR(255),
    released_by VARCHAR(100),
    released_at TIMESTAMP,
    analysis_no VARCHAR(100),
    storage_location VARCHAR(150),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

UPDATE material_batches SET qty_remaining = qty WHERE qty_remaining IS NULL;
