/*
# NUCLEA ERP — Initial Seed Data

## Purpose
Populates the database with the minimum data needed for the app to boot and be usable:
- An administrator account (plaintext password, auto-upgraded to scrypt on first login by the app).
- Sample materials, assets, customers, vendors, and dispatch plans for the dashboard and lists.
- Built-in system roles and default LIVE_TRACKING view permission for all roles.

## Data Inserted
1. `users` — System Administrator (admin@ims.com / admin123)
2. `materials` — 4 sample radio-pharmaceutical materials with stock and pricing
3. `assets` — 4 sample assets (cyclotron + leadpots)
4. `customers` — 3 sample hospitals with contract pricing
5. `vendors` — 2 sample suppliers
6. `dispatch_plans` — 2 sample delivery plans
7. `erp_roles` — 16 built-in system roles + LIVE_TRACKING view permission for all

## Security
- The admin password is stored as plaintext 'admin123' — the application's first-login flow
  automatically upgrades it to a scrypt hash (see verifyPassword in index.js). This matches
  the existing seeder behavior in the codebase.

## Notes
- Uses ON CONFLICT DO NOTHING so re-running is safe.
- The role seeding mirrors the exact list in roadmap-erp.js installRoadmapSchema().
*/

INSERT INTO users (full_name, email, password, role, is_email_verified)
VALUES ('System Administrator', 'admin@ims.com', 'admin123', 'System Administrator', true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO materials (material_code, name, category, uom, current_stock, min_stock, moving_avg_price)
VALUES
    ('MAT-1.02.0003', 'Water For Injection (WFI)', 'Consumable', 'Pcs', 50, 100, 150000),
    ('MAT-1.02.0001', 'Cassette Fastlab 2 Single', 'Precursor & Reagent', 'Pcs', 25, 10, 4500000),
    ('MAT-1.02.0004', 'Mannose Triflate', 'Precursor', 'Vial', 15, 20, 2500000),
    ('MAT-1.02.0005', 'Sterile Vials 30ml', 'Consumable', 'Pcs', 150, 50, 15000)
ON CONFLICT (material_code) DO NOTHING;

INSERT INTO assets (asset_code, name, category, status)
VALUES
    ('AST-CYC-001', 'GE PETtrace 890', 'Production Machine', 'AVAILABLE'),
    ('LP-012', 'Tungsten Leadpot 30ml', 'Logistics Shielding', 'AVAILABLE'),
    ('LP-005', 'Tungsten Leadpot 30ml', 'Logistics Shielding', 'IN_TRANSIT'),
    ('LP-008', 'Tungsten Leadpot 30ml', 'Logistics Shielding', 'AVAILABLE')
ON CONFLICT (asset_code) DO NOTHING;

INSERT INTO customers (customer_code, name, category, status, contract_price)
VALUES
    ('C-RSMP-01', 'RS Mitra Plumbon', 'Private Hospital', 'ACTIVE', 800000),
    ('C-RSK-02', 'RS Kariadi Semarang', 'Government Hospital', 'ACTIVE', 750000),
    ('C-RSHS-03', 'RSUP Hasan Sadikin', 'Government Hospital', 'ACTIVE', 750000)
ON CONFLICT (customer_code) DO NOTHING;

INSERT INTO vendors (vendor_code, name, category, contact_person)
VALUES
    ('V-GE-01', 'PT GE Healthcare', 'Equipment & Reagents', 'Budi Hartono'),
    ('V-MERCK-02', 'PT Merck Indonesia', 'Chemicals', 'Siska Amelia')
ON CONFLICT (vendor_code) DO NOTHING;

INSERT INTO dispatch_plans (order_reference, hospital_name, production_batch_id, asset_code)
VALUES
    ('DO-2026-001', 'RS Mitra Plumbon', 'BATCH-260901', 'LP-012'),
    ('DO-2026-002', 'RS Kariadi Semarang', 'BATCH-260901', 'LP-005')
ON CONFLICT DO NOTHING;

-- Built-in system roles (mirrors roadmap-erp.js systemRoles list)
-- role_code is derived from role_name: uppercase, non-alnum → underscore
INSERT INTO erp_roles (role_name, role_code, description, is_system)
SELECT
    role_name,
    UPPER(regexp_replace(role_name, '[^A-Za-z0-9]+', '_', 'g')),
    'Built-in role mapped to legacy workflow guards',
    true
FROM (VALUES
    ('Pending User'),
    ('System Administrator'),
    ('Plant Manager'),
    ('SCM Supervisor'),
    ('SCM Staff'),
    ('Purchasing'),
    ('Finance Leader'),
    ('Production Supervisor'),
    ('Production Operator'),
    ('QC Analyst'),
    ('QC Supervisor'),
    ('QA Supervisor'),
    ('PPR'),
    ('PPR Kepala'),
    ('Driver'),
    ('Commercial Staff'),
    ('Maintenance')
) AS t(role_name)
ON CONFLICT (role_name) DO NOTHING;

-- All roles may view the Live Tracking monitor
INSERT INTO erp_role_permissions (role_id, module_code, can_view)
SELECT id, 'LIVE_TRACKING', true FROM erp_roles
ON CONFLICT (role_id, module_code) DO UPDATE SET can_view = true;

-- Operational Manager is a custom (administrator-managed) role
UPDATE erp_roles
SET is_system = false,
    description = COALESCE(description, 'Custom role — permission matrix is administrator-managed')
WHERE lower(role_name) = 'operational manager';
