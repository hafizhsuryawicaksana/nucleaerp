'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const ROOT = path.join(__dirname, '..');
const PRIVATE_ROOT = path.join(ROOT, 'private_uploads');
const FILE_ROOT = path.join(PRIVATE_ROOT, 'files');
const SIGNATURE_ROOT = path.join(PRIVATE_ROOT, 'signatures');
const ASSET_ROOT = path.join(PRIVATE_ROOT, 'assets');
[PRIVATE_ROOT, FILE_ROOT, SIGNATURE_ROOT, ASSET_ROOT].forEach(p => fs.mkdirSync(p, { recursive: true }));

const recordConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'controlled-record-templates.json'), 'utf8'));
const qualificationConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'partner-qualification-checklist.json'), 'utf8'));
const recordTemplates = new Map(recordConfig.templates.map(t => [t.code, t]));

function makeUpload(folder, allowedExtensions, maxFileSize = 12 * 1024 * 1024) {
  const dirs = { files: FILE_ROOT, signatures: SIGNATURE_ROOT, assets: ASSET_ROOT };
  const dest = dirs[folder] || FILE_ROOT;
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dest),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
      }
    }),
    limits: { fileSize: maxFileSize, files: 4 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!allowedExtensions.includes(ext)) return cb(new Error(`Ekstensi file ${ext || '(tanpa ekstensi)'} tidak diizinkan.`));
      cb(null, true);
    }
  });
}
const uploadDoc = makeUpload('files', ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.txt', '.csv']);
const uploadAsset = makeUpload('assets', ['.png', '.jpg', '.jpeg', '.webp']);
const uploadSignature = makeUpload('signatures', ['.png', '.jpg', '.jpeg', '.webp'], 3 * 1024 * 1024);

function roleText(req) { return String(req.session?.user?.role || '').toLowerCase(); }
function moduleCodeForPath(pathname) {
  const p = String(pathname || '');
  if (/^\/manufacturing\/planning/.test(p)) return 'MANUFACTURING_PLANNING';
  if (/^\/manufacturing\/execution/.test(p) || /^\/erp\/labels/.test(p)) return 'MANUFACTURING_EXECUTION';
  if (/^\/manufacturing\/batch-records|^\/erp\/batch-records/.test(p)) return 'MANUFACTURING_BATCH_RECORD';
  if (/^\/manufacturing\/history/.test(p)) return 'MANUFACTURING_HISTORY';
  if (/^\/inventory|^\/erp\/inventory-adjustment|^\/scm\/inventory/.test(p)) return 'INVENTORY';
  if (/^\/assets|^\/scm\/assets/.test(p)) return 'ASSET';
  if (/^\/vendors/.test(p)) return 'VENDOR';
  if (/^\/customers/.test(p)) return 'CUSTOMER';
  if (/^\/material-requisition/.test(p)) return 'MATERIAL_REQUISITION';
  if (/^\/erp\/distribution|^\/scm\/distribution/.test(p)) return 'DISTRIBUTION';
  if (/^\/driver\/mobile|^\/api\/driver|^\/api\/live-tracking/.test(p)) return 'LIVE_TRACKING';
  if (/^\/security-control|^\/user-management|^\/erp\/audit|^\/erp\/access-control/.test(p)) return 'SECURITY_CONTROL';
  if (/^\/erp\/overview/.test(p)) return 'SECURITY_CONTROL';
  return null;
}
function requiredPermission(req) {
  if (['GET','HEAD','OPTIONS'].includes(String(req.method).toUpperCase())) return 'can_view';
  const p = String(req.path || '').toLowerCase();
  if (/delete|archive|restore|remove/.test(p)) return 'can_delete';
  if (/decision|release|review|approve|verify|dispatch|issue-materials|plant-approval|qualification.*decision/.test(p)) return 'can_approve';
  if (/create|goods-receipt|add|request-qualification|roles\/create/.test(p)) return 'can_create';
  return 'can_edit';
}
function allowedRole(req, patterns) {
  const role = roleText(req);
  if (/system administrator|administrator|admin/.test(role) || patterns.some(p => p.test(role))) return true;
  const user = req.session?.user || {};
  if (!user._erpCustomRole || !user._erpRolePermissions) return false;
  const moduleCode = moduleCodeForPath(req.path);
  const permission = moduleCode ? user._erpRolePermissions[moduleCode] : null;
  return !!(permission && permission[requiredPermission(req)] === true);
}
function guard(patterns, redirect = '/') {
  return (req, res, next) => allowedRole(req, patterns) ? next() : res.status(403).send('Akses ditolak. Role akun tidak memiliki kewenangan untuk tindakan ini.');
}
const SECURITY_MODULES = [
  ['MANUFACTURING_PLANNING','Manufacturing / Production Planning'],['MANUFACTURING_EXECUTION','Manufacturing / Production Execution'],
  ['MANUFACTURING_BATCH_RECORD','Manufacturing / Batch Record'],['MANUFACTURING_HISTORY','Manufacturing / Production History'],
  ['INVENTORY','Inventory'],['ASSET','Asset Management'],['VENDOR','Vendor Management'],['CUSTOMER','Customer Management'],
  ['MATERIAL_REQUISITION','Material Requisition'],['DISTRIBUTION','Distribution'],['LIVE_TRACKING','Live Tracking App'],
  ['SECURITY_CONTROL','Security Control']
];
const SCM = [/scm/, /supply chain/, /supply-chain/, /purchasing/];
const PD = [/production/, /prod operator/, /prod supervisor/, /cyclotron/, /hot lab/, /pd supervisor/, /manufacturing/];
const QCQA = [/qa/, /quality assurance/, /qc/, /quality control/, /plant manager/];
const ADMIN = [/system administrator/, /administrator/];
const ALL = [];
const str = v => (v === undefined || v === null ? '' : String(v)).trim();
const arr = v => v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
const num = v => { if (v === '' || v === undefined || v === null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const nullable = v => str(v) || null;
const bool = v => ['true', '1', 'yes', 'on'].includes(String(v || '').toLowerCase());
const escFileName = v => path.basename(String(v || 'document')).replace(/[\r\n"\\]/g, '_');
const code = prefix => `${prefix}-${new Date().toISOString().slice(2,10).replace(/-/g,'')}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

async function audit(db, req, action, entityType, entityId, reason, beforeData = null, afterData = null) {
  const u = req.session?.user || {};
  try {
    await db.query(`INSERT INTO erp_audit_events(actor_user_id,actor_name,actor_role,action,entity_type,entity_id,reason,before_data,after_data,source_ip,user_agent)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`, [u.id || null, u.full_name || 'Unknown', u.role || 'Unknown', action, entityType, String(entityId), reason || null, beforeData == null ? null : JSON.stringify(beforeData), afterData == null ? null : JSON.stringify(afterData), req.ip || null, req.get('user-agent') || null]);
  } catch (e) { console.error('Roadmap audit write failed:', e.message); }
}

async function installRoadmapSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roadmap_private_files (
      id BIGSERIAL PRIMARY KEY, owner_type VARCHAR(50) NOT NULL, owner_id TEXT NOT NULL, document_type VARCHAR(100) NOT NULL,
      original_name TEXT NOT NULL, stored_name TEXT NOT NULL, storage_area VARCHAR(20) NOT NULL DEFAULT 'files', mime_type TEXT,
      size_bytes BIGINT, uploaded_by INTEGER, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(), checksum_sha256 TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_files_owner ON roadmap_private_files(owner_type, owner_id, uploaded_at DESC);
    CREATE TABLE IF NOT EXISTS roadmap_material_inspections (
      id BIGSERIAL PRIMARY KEY, material_batch_id INTEGER NOT NULL REFERENCES material_batches(id), result VARCHAR(12) NOT NULL CHECK(result IN ('PASS','FAIL')),
      notes TEXT, inspector_user_id INTEGER NOT NULL, inspected_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digital_signature_file_id BIGINT REFERENCES roadmap_private_files(id);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS registration_status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED';
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS qualification_status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED';
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS fax VARCHAR(80);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS apj_name TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS apj_address TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS apj_stra_no TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS apj_stra_expiry DATE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS apj_sipa_no TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS apj_sipa_expiry DATE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS operating_license_no TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS operating_license_expiry DATE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS hospital_class VARCHAR(20);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS accreditation VARCHAR(40);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS accreditation_expiry DATE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS radiopharmaceutical_license_no TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_id TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS taxpayer_name TEXT;
    ALTER TABLE vendors ADD COLUMN IF NOT EXISTS registration_status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED';
    ALTER TABLE vendors ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE vendors ADD COLUMN IF NOT EXISTS qualification_status VARCHAR(20) NOT NULL DEFAULT 'REGISTERED';
    ALTER TABLE vendors ADD COLUMN IF NOT EXISTS vendor_type VARCHAR(80);
    ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tax_id TEXT;
    ALTER TABLE vendors ADD COLUMN IF NOT EXISTS qualification_expiry DATE;
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS material_type VARCHAR(100);
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS material_description TEXT;
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS storage_location VARCHAR(150);
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE material_batches ADD COLUMN IF NOT EXISTS analysis_no VARCHAR(100);
    ALTER TABLE material_batches ADD COLUMN IF NOT EXISTS storage_location VARCHAR(150);
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS department VARCHAR(120);
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS acquisition_date DATE;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS brand VARCHAR(120);
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS asset_type VARCHAR(120);
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS purpose TEXT;
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS photo_file_id BIGINT REFERENCES roadmap_private_files(id);
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS serial_number VARCHAR(120);
    ALTER TABLE assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    CREATE TABLE IF NOT EXISTS roadmap_work_orders (
      id BIGSERIAL PRIMARY KEY, work_order_no VARCHAR(100) NOT NULL UNIQUE, production_id INTEGER NOT NULL UNIQUE REFERENCES productions(id),
      batch_id VARCHAR(100) NOT NULL UNIQUE, product_code VARCHAR(100) NOT NULL, product_name TEXT NOT NULL,
      preparation_start TIMESTAMP, preparation_end TIMESTAMP, scm_parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
      production_parameters JSONB NOT NULL DEFAULT '{}'::jsonb, production_parameters_complete BOOLEAN NOT NULL DEFAULT FALSE,
      status VARCHAR(40) NOT NULL DEFAULT 'SCHEDULED', created_by INTEGER, production_parameters_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), cancel_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_wo_date_status ON roadmap_work_orders(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS roadmap_work_order_customers (
      id BIGSERIAL PRIMARY KEY, work_order_id BIGINT NOT NULL REFERENCES roadmap_work_orders(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES customers(id), calibration_time TIMESTAMP, activity_at_cal_mci NUMERIC(18,6),
      arrival_time TIMESTAMP, travel_time_min INTEGER, max_delay_time_min INTEGER, delivery_start_time TIMESTAMP,
      dispensing_start_time TIMESTAMP, lead_time_min INTEGER, vehicle_no VARCHAR(100), required_production_activity_mci NUMERIC(18,6),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_wo_customer ON roadmap_work_order_customers(work_order_id);
    CREATE TABLE IF NOT EXISTS roadmap_batch_executions (
      id BIGSERIAL PRIMARY KEY, work_order_id BIGINT NOT NULL UNIQUE REFERENCES roadmap_work_orders(id), production_id INTEGER NOT NULL UNIQUE REFERENCES productions(id),
      concentration_mci_ml NUMERIC(18,8), concentration_mbq_ml NUMERIC(18,8), parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(40) NOT NULL DEFAULT 'DRAFT', prepared_by INTEGER, scm_verified_by INTEGER, executed_by INTEGER,
      scm_verified_at TIMESTAMPTZ, executed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS roadmap_batch_materials (
      id BIGSERIAL PRIMARY KEY, execution_id BIGINT NOT NULL REFERENCES roadmap_batch_executions(id) ON DELETE CASCADE,
      material_id INTEGER NOT NULL REFERENCES materials(id), requested_qty NUMERIC(18,6) NOT NULL CHECK(requested_qty > 0),
      uom VARCHAR(30), notes TEXT, status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED', issued_qty NUMERIC(18,6) NOT NULL DEFAULT 0,
      lot_details JSONB NOT NULL DEFAULT '[]'::jsonb, verified_by INTEGER, verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_batch_materials_execution ON roadmap_batch_materials(execution_id);
    CREATE TABLE IF NOT EXISTS roadmap_batch_records (
      id BIGSERIAL PRIMARY KEY, batch_id VARCHAR(100) NOT NULL, record_type VARCHAR(10) NOT NULL CHECK(record_type IN ('BMR','BPR')),
      template_code VARCHAR(40) NOT NULL, template_revision VARCHAR(60), status VARCHAR(40) NOT NULL DEFAULT 'IN_PROGRESS',
      data JSONB NOT NULL DEFAULT '{}'::jsonb, started_by INTEGER, submitted_by INTEGER, reviewed_by INTEGER, review_note TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(), submitted_at TIMESTAMPTZ, reviewed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(batch_id, record_type)
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_records_status ON roadmap_batch_records(status, batch_id);
    CREATE TABLE IF NOT EXISTS roadmap_partner_qualifications (
      id BIGSERIAL PRIMARY KEY, partner_type VARCHAR(20) NOT NULL CHECK(partner_type IN ('CUSTOMER','VENDOR')), partner_id INTEGER NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING_QA', checklist JSONB NOT NULL DEFAULT '{}'::jsonb, document_checklist JSONB NOT NULL DEFAULT '{}'::jsonb,
      requested_by INTEGER, requested_at TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed_by INTEGER, reviewed_at TIMESTAMPTZ,
      decision_note TEXT, UNIQUE(partner_type, partner_id, status)
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_qual_pending ON roadmap_partner_qualifications(status, partner_type);
    CREATE TABLE IF NOT EXISTS roadmap_asset_requests (
      id BIGSERIAL PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), request_type VARCHAR(20) NOT NULL CHECK(request_type IN ('MUTATION','DISPOSAL')),
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING_APPROVAL', requested_by INTEGER, requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      current_department TEXT, target_department TEXT, handover_to TEXT, purpose TEXT, reason TEXT, condition_status TEXT,
      k3ll_assessment JSONB NOT NULL DEFAULT '{}'::jsonb, waste_classification VARCHAR(80), approval_note TEXT, approved_by INTEGER, approved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_asset_requests ON roadmap_asset_requests(status, request_type);
    CREATE TABLE IF NOT EXISTS roadmap_asset_events (
      id BIGSERIAL PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES assets(id), event_type VARCHAR(40) NOT NULL,
      event_data JSONB NOT NULL DEFAULT '{}'::jsonb, actor_user_id INTEGER, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS roadmap_material_requisitions (
      id BIGSERIAL PRIMARY KEY, request_no VARCHAR(80) NOT NULL UNIQUE, requester_user_id INTEGER NOT NULL,
      requester_name TEXT NOT NULL, position TEXT, department TEXT NOT NULL, request_date DATE NOT NULL DEFAULT CURRENT_DATE,
      status VARCHAR(40) NOT NULL DEFAULT 'SUBMITTED', scm_verification JSONB NOT NULL DEFAULT '{}'::jsonb,
      pr_number VARCHAR(100), estimated_arrival DATE, scm_note TEXT, plant_manager_user_id INTEGER, approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS roadmap_material_requisition_items (
      id BIGSERIAL PRIMARY KEY, requisition_id BIGINT NOT NULL REFERENCES roadmap_material_requisitions(id) ON DELETE CASCADE,
      item_code VARCHAR(100), item_name TEXT NOT NULL, specification TEXT, quantity NUMERIC(18,6) NOT NULL CHECK(quantity > 0),
      uom VARCHAR(30) NOT NULL, purpose TEXT NOT NULL, available BOOLEAN, storage_location VARCHAR(150), current_stock NUMERIC(18,6),
      min_stock NUMERIC(18,6), scm_action VARCHAR(40), scm_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_roadmap_mr_status ON roadmap_material_requisitions(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS roadmap_batch_attachments (
      id BIGSERIAL PRIMARY KEY, batch_id VARCHAR(100) NOT NULL, attachment_type VARCHAR(40) NOT NULL,
      private_file_id BIGINT NOT NULL REFERENCES roadmap_private_files(id), uploaded_by INTEGER, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(batch_id, attachment_type, private_file_id)
    );
    CREATE TABLE IF NOT EXISTS erp_roles (
      id BIGSERIAL PRIMARY KEY, role_name VARCHAR(120) NOT NULL UNIQUE, role_code VARCHAR(140) NOT NULL UNIQUE,
      description TEXT, is_system BOOLEAN NOT NULL DEFAULT FALSE, created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS erp_role_permissions (
      role_id BIGINT NOT NULL REFERENCES erp_roles(id) ON DELETE CASCADE, module_code VARCHAR(60) NOT NULL,
      can_view BOOLEAN NOT NULL DEFAULT FALSE, can_create BOOLEAN NOT NULL DEFAULT FALSE, can_edit BOOLEAN NOT NULL DEFAULT FALSE,
      can_delete BOOLEAN NOT NULL DEFAULT FALSE, can_approve BOOLEAN NOT NULL DEFAULT FALSE, updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(role_id,module_code)
    );
  `);
  const systemRoles = ['Pending User','System Administrator','Plant Manager','SCM Supervisor','SCM Staff','Purchasing','Finance Leader','Production Supervisor','Production Operator','QC Analyst','QC Supervisor','QA Supervisor','PPR','PPR Kepala','Driver','Commercial Staff','Maintenance'];
  for (const roleName of systemRoles) {
    const roleCode = roleName.toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,140);
    await pool.query(`INSERT INTO erp_roles(role_name,role_code,description,is_system) VALUES($1,$2,$3,true) ON CONFLICT(role_name) DO NOTHING`,[roleName,roleCode,'Built-in role mapped to legacy workflow guards']);
  }
  const existing = await pool.query("SELECT DISTINCT role FROM users WHERE role IS NOT NULL AND trim(role)<>''");
  for (const row of existing.rows) {
    const roleName = str(row.role); if (!roleName) continue;
    const roleCode = roleName.toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,140);
    await pool.query(`INSERT INTO erp_roles(role_name,role_code,description,is_system) VALUES($1,$2,$3,true) ON CONFLICT(role_name) DO NOTHING`,[roleName,roleCode,'Existing role imported during Security Control migration']).catch(e=>{ if(e.code!=='23505') throw e; });
  }
  // Operational Manager is intentionally a custom role so administrators can define its own permission matrix.
  await pool.query("UPDATE erp_roles SET is_system=false,description=COALESCE(description,'Custom role — permission matrix is administrator-managed') WHERE lower(role_name)='operational manager'");
  // All authenticated roles may view the tracking monitor; location submissions remain assignment/role-gated.
  await pool.query(`INSERT INTO erp_role_permissions(role_id,module_code,can_view) SELECT id,'LIVE_TRACKING',true FROM erp_roles ON CONFLICT(role_id,module_code) DO UPDATE SET can_view=true`);
}

async function storePrivateFile(pool, file, { ownerType, ownerId, documentType, area = 'files', userId }) {
  if (!file) return null;
  const storedName = path.basename(file.filename || file.path && path.basename(file.path));
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');
  const rel = area === 'signatures' ? path.join('signatures', storedName) : area === 'assets' ? path.join('assets', storedName) : path.join('files', storedName);
  const result = await pool.query(`INSERT INTO roadmap_private_files(owner_type,owner_id,document_type,original_name,stored_name,storage_area,mime_type,size_bytes,uploaded_by,checksum_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [ownerType, String(ownerId), documentType, escFileName(file.originalname), storedName, area, file.mimetype || null, file.size || null, userId || null, checksum]);
  return result.rows[0];
}
function fullPrivatePath(row) {
  const base = row.storage_area === 'signatures' ? SIGNATURE_ROOT : row.storage_area === 'assets' ? ASSET_ROOT : FILE_ROOT;
  const p = path.resolve(base, row.stored_name);
  if (!p.startsWith(path.resolve(base) + path.sep)) throw new Error('Invalid file path');
  return p;
}
function attachmentUploadRoute(pool, ownerTypeResolver, documentTypeResolver = req => str(req.body.document_type) || 'ATTACHMENT') {
  return [uploadDoc.single('document'), async (req, res) => {
    try {
      const { ownerType, ownerId } = ownerTypeResolver(req);
      if (!req.file) throw new Error('Pilih file terlebih dahulu.');
      const f = await storePrivateFile(pool, req.file, { ownerType, ownerId, documentType: documentTypeResolver(req), userId: req.session.user.id });
      await audit(pool, req, 'PRIVATE_DOCUMENT_UPLOADED', ownerType, ownerId, f.document_type, null, { file_id: f.id, name: f.original_name });
      res.redirect(req.get('referer') || '/');
    } catch (e) { res.redirect((req.get('referer') || '/') + (String(req.get('referer') || '').includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(e.message)); }
  }];
}

async function installCustomerFromForm(client, b) {
  const c = await client.query(`INSERT INTO customers(customer_code,name,category,address,contact_person,phone,email,status,registration_status,qualification_status,fax,apj_name,apj_address,apj_stra_no,apj_stra_expiry,apj_sipa_no,apj_sipa_expiry,operating_license_no,operating_license_expiry,hospital_class,accreditation,accreditation_expiry,radiopharmaceutical_license_no,tax_id,taxpayer_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE','REGISTERED','REGISTERED',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`, [str(b.customer_code) || code('CUS'), str(b.name), nullable(b.category), nullable(b.address), nullable(b.contact_person), nullable(b.phone), nullable(b.email), nullable(b.fax), nullable(b.apj_name), nullable(b.apj_address), nullable(b.apj_stra_no), nullable(b.apj_stra_expiry), nullable(b.apj_sipa_no), nullable(b.apj_sipa_expiry), nullable(b.operating_license_no), nullable(b.operating_license_expiry), nullable(b.hospital_class), nullable(b.accreditation), nullable(b.accreditation_expiry), nullable(b.radiopharmaceutical_license_no), nullable(b.tax_id), nullable(b.taxpayer_name)]);
  return c.rows[0];
}

function registerRoadmapRoutes(app, pool, isAuthenticated, verifyCredential) {
  // private authorized file serving: file bytes are never exposed as static assets.
  app.get('/roadmap/files/:id', isAuthenticated, async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM roadmap_private_files WHERE id=$1', [req.params.id]);
      if (!r.rows.length) return res.status(404).send('Dokumen tidak ditemukan.');
      const f = r.rows[0]; const full = fullPrivatePath(f);
      if (!fs.existsSync(full)) return res.status(404).send('Berkas fisik tidak ditemukan di storage.');
      await audit(pool, req, 'PRIVATE_DOCUMENT_ACCESSED', f.owner_type, f.owner_id, f.document_type, null, { file_id: f.id });
      res.setHeader('Content-Type', f.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${escFileName(f.original_name)}"`);
      res.sendFile(full);
    } catch (e) { console.error(e); res.status(500).send('Tidak dapat membuka dokumen.'); }
  });

  // Digital signature image stored outside public/ and shown only to authenticated ERP sessions.
  app.post('/account/digital-signature', isAuthenticated, uploadSignature.single('digital_signature'), async (req, res) => {
    try {
      if (!req.file) throw new Error('File tanda tangan belum dipilih.');
      const f = await storePrivateFile(pool, req.file, { ownerType: 'USER', ownerId: req.session.user.id, documentType: 'DIGITAL_SIGNATURE_IMAGE', area: 'signatures', userId: req.session.user.id });
      await pool.query('UPDATE users SET digital_signature_file_id=$1 WHERE id=$2', [f.id, req.session.user.id]);
      await audit(pool, req, 'DIGITAL_SIGNATURE_IMAGE_UPDATED', 'USER', req.session.user.id, 'User profile signature image uploaded', null, { file_id: f.id });
      res.redirect('/profile?tab=profile&success=Tanda+tangan+digital+visual+berhasil+diunggah');
    } catch (e) { res.redirect('/profile?tab=profile&error=' + encodeURIComponent(e.message)); }
  });
  app.get('/account/digital-signature/:userId', isAuthenticated, async (req, res) => {
    try {
      const r = await pool.query(`SELECT f.* FROM users u LEFT JOIN roadmap_private_files f ON f.id=u.digital_signature_file_id WHERE u.id=$1`, [req.params.userId]);
      if (!r.rows.length || !r.rows[0].id) return res.status(404).send('Tanda tangan belum diunggah.');
      const f = r.rows[0]; const full = fullPrivatePath(f);
      if (!fs.existsSync(full)) return res.status(404).send('Berkas tanda tangan tidak ditemukan.');
      res.setHeader('Content-Type', f.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${escFileName(f.original_name)}"`); res.sendFile(full);
    } catch (e) { res.status(500).send('Gagal membuka tanda tangan.'); }
  });

  // 1. Production Planning / Work Order (SCM-originated; Production fills its own parameter section).
  app.get('/manufacturing/planning', isAuthenticated, async (req, res) => {
    try {
      const [workOrders, customers, products] = await Promise.all([
        pool.query(`SELECT wo.*, p.status production_status, p.production_date, p.calib_time,
          COALESCE(string_agg(DISTINCT c.name, ', '), '') customer_names,
          COALESCE(sum(wc.activity_at_cal_mci),0) ordered_activity,
          COALESCE(sum(wc.required_production_activity_mci),0) required_activity,
          count(DISTINCT wc.id)::int customer_count
          FROM roadmap_work_orders wo JOIN productions p ON p.id=wo.production_id
          LEFT JOIN roadmap_work_order_customers wc ON wc.work_order_id=wo.id LEFT JOIN customers c ON c.id=wc.customer_id
          GROUP BY wo.id,p.status,p.production_date,p.calib_time ORDER BY p.production_date DESC NULLS LAST, wo.created_at DESC LIMIT 200`),
        pool.query(`SELECT id,customer_code,name,qualification_status FROM customers WHERE COALESCE(is_active,true)=true AND COALESCE(registration_status,'REGISTERED') <> 'DELETED' ORDER BY name`),
        pool.query('SELECT code,name FROM products ORDER BY code')
      ]);
      res.render('roadmap/planning', { page: 'roadmap-planning', workOrders: workOrders.rows, customers: customers.rows, products: products.rows, query: req.query, canPlan: allowedRole(req, SCM), canEnterProduction: allowedRole(req, PD) });
    } catch (e) { console.error('roadmap planning', e); res.status(500).send('Production Planning gagal dimuat. Pastikan migrasi ERP roadmap telah berjalan.'); }
  });
  app.post('/manufacturing/planning', isAuthenticated, guard(SCM), async (req, res) => {
    const client = await pool.connect();
    try {
      const b = req.body;
      await client.query('BEGIN');
      const productName = str(b.product_name || b.product_code);
      if (!productName || !str(b.production_date)) throw new Error('Nama produk dan tanggal rencana produksi wajib diisi.');
      let p = await client.query('SELECT code,name FROM products WHERE lower(name)=lower($1) OR lower(code)=lower($1) ORDER BY CASE WHEN lower(name)=lower($1) THEN 0 ELSE 1 END LIMIT 1', [productName]);
      if (!p.rows.length) {
        const base = productName.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,35) || 'PRODUCT';
        let productCode = base; let suffix = 2;
        while ((await client.query('SELECT 1 FROM products WHERE code=$1',[productCode])).rows.length) productCode = `${base.slice(0, Math.max(1, 35-String(suffix).length-1))}-${suffix++}`;
        p = await client.query('INSERT INTO products(code,name) VALUES($1,$2) RETURNING code,name',[productCode,productName]);
        await audit(client,req,'PRODUCT_MASTER_AUTO_CREATED','PRODUCT',p.rows[0].code,'Product master created from Production Planning free-text input',null,{code:p.rows[0].code,name:p.rows[0].name});
      }
      const customerIds = arr(b.customer_id).map(Number).filter(x => Number.isInteger(x) && x > 0);
      if (!customerIds.length) throw new Error('Work Order minimal harus memiliki satu customer.');
      const custRes = await client.query('SELECT id,name,qualification_status,registration_status FROM customers WHERE id=ANY($1::int[])', [customerIds]);
      if (custRes.rows.length !== new Set(customerIds).size) throw new Error('Salah satu customer tidak terdaftar di Customer Management.');
      if (custRes.rows.some(c => c.qualification_status === 'REJECTED' || c.registration_status === 'REJECTED')) throw new Error('Customer berstatus Rejected tidak dapat dimasukkan ke Work Order.');
      const batchId = str(b.batch_id) || code('FDG');
      const woNo = str(b.work_order_no) || code('WO');
      const prepStart = nullable(b.preparation_start);
      const prod = await client.query(`INSERT INTO productions(batch_id,production_date,calib_time,item_code,status,production_notes)
        VALUES($1,$2,$3,$4,'SCHEDULED',$5) RETURNING id`, [batchId, b.production_date, nullable(arr(b.calibration_time)[0] || b.calibration_time), p.rows[0].code, nullable(b.scm_notes)]);
      const w = await client.query(`INSERT INTO roadmap_work_orders(work_order_no,production_id,batch_id,product_code,product_name,preparation_start,scm_parameters,created_by,status)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'SCHEDULED') RETURNING id`, [woNo, prod.rows[0].id, batchId, p.rows[0].code, p.rows[0].name, prepStart, JSON.stringify({ customer_po_no: str(b.customer_po_no), sales_order_no: str(b.sales_order_no), requested_by: req.session.user.full_name, scm_notes: str(b.scm_notes) }), req.session.user.id]);
      const fields = ['calibration_time','activity_at_cal_mci','arrival_time','travel_time_min','max_delay_time_min','delivery_start_time','dispensing_start_time','vehicle_no','required_production_activity_mci'];
      for (let i=0;i<customerIds.length;i++) {
        const values = {}; for (const f of fields) values[f] = arr(b[f])[i] ?? (customerIds.length===1 ? b[f] : null);
        const requiredText=['calibration_time','arrival_time','delivery_start_time','dispensing_start_time','vehicle_no'];
        const missingText=requiredText.filter(f=>!str(values[f]));
        if(missingText.length)throw new Error(`Work Order customer baris ${i+1}: field wajib belum diisi (${missingText.join(', ')}).`);
        if(num(values.activity_at_cal_mci)===null||num(values.activity_at_cal_mci)<=0)throw new Error(`Activity @ Calibration harus lebih besar dari nol untuk customer baris ${i+1}.`);
        if(num(values.required_production_activity_mci)===null||num(values.required_production_activity_mci)<=0)throw new Error(`Required Production Activity harus lebih besar dari nol untuk customer baris ${i+1}.`);
        if(num(values.travel_time_min)===null||num(values.travel_time_min)<0||num(values.max_delay_time_min)===null||num(values.max_delay_time_min)<0)throw new Error(`Travel Time dan Maximum Delay harus diisi dengan nilai nol atau lebih untuk customer baris ${i+1}.`);
        const minutes = values.calibration_time && values.dispensing_start_time ? Math.round((new Date(values.calibration_time)-new Date(values.dispensing_start_time))/60000) : null;
        await client.query(`INSERT INTO roadmap_work_order_customers(work_order_id,customer_id,calibration_time,activity_at_cal_mci,arrival_time,travel_time_min,max_delay_time_min,delivery_start_time,dispensing_start_time,lead_time_min,vehicle_no,required_production_activity_mci)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [w.rows[0].id, customerIds[i], nullable(values.calibration_time), num(values.activity_at_cal_mci), nullable(values.arrival_time), num(values.travel_time_min), num(values.max_delay_time_min), nullable(values.delivery_start_time), nullable(values.dispensing_start_time), Number.isFinite(minutes) ? minutes : null, nullable(values.vehicle_no), num(values.required_production_activity_mci)]);
        const cust = custRes.rows.find(x => x.id===customerIds[i]);
        await client.query(`INSERT INTO dispatch_plans(order_reference,hospital_name,production_batch_id,allocated_mci,status) VALUES($1,$2,$3,$4,'SCHEDULED')`, [`${woNo}-${i+1}`, cust.name, batchId, num(values.required_production_activity_mci) ?? num(values.activity_at_cal_mci) ?? 0]);
      }
      await audit(client, req, 'WORK_ORDER_CREATED', 'WORK_ORDER', w.rows[0].id, 'SCM created Work Order from IMS.PD.005-F-01', null, { work_order_no: woNo, batch_id: batchId, product_code: p.rows[0].code, customer_count: customerIds.length });
      await client.query('COMMIT');
      res.redirect('/manufacturing/planning?success=Work+Order+dan+batch+planning+berhasil+dibuat');
    } catch (e) { await client.query('ROLLBACK'); res.redirect('/manufacturing/planning?error=' + encodeURIComponent(e.message)); }
    finally { client.release(); }
  });
  app.post('/manufacturing/planning/:id/production-parameters', isAuthenticated, guard(PD), async (req, res) => {
    try {
      const r = await pool.query('SELECT * FROM roadmap_work_orders WHERE id=$1', [req.params.id]);
      if (!r.rows.length) throw new Error('Work Order tidak ditemukan.');
      const wo = r.rows[0];
      if (['CANCELLED','EXECUTED'].includes(wo.status)) throw new Error('Work Order yang dibatalkan atau sudah dieksekusi tidak dapat diedit.');
      const parameters = {
        synthesis_activity_buffer_percent: num(req.body.synthesis_activity_buffer_percent) ?? 20,
        target_total_production_activity_mci: num(req.body.target_total_production_activity_mci),
        target_eob_activity_mci: num(req.body.target_eob_activity_mci),
        equipment_id: str(req.body.equipment_id), beam_current_ua: num(req.body.beam_current_ua), beam_duration_min: num(req.body.beam_duration_min),
        room_temperature_c: num(req.body.room_temperature_c), room_pressure_pa: num(req.body.room_pressure_pa), production_notes: str(req.body.production_notes),
        prepared_by: req.session.user.full_name, prepared_at: new Date().toISOString()
      };
      if(!(parameters.target_total_production_activity_mci>0)||!(parameters.target_eob_activity_mci>0))throw new Error('Target total production activity dan target EOB activity wajib lebih besar dari nol.');
      if(!(parameters.synthesis_activity_buffer_percent>=0))throw new Error('Synthesis activity buffer tidak valid.');
      await pool.query('UPDATE roadmap_work_orders SET production_parameters=$1::jsonb,production_parameters_complete=true,production_parameters_by=$2,updated_at=now() WHERE id=$3', [JSON.stringify(parameters), req.session.user.id, wo.id]);
      await pool.query('UPDATE productions SET batch_size=$1,production_notes=$2 WHERE id=$3', [parameters.target_total_production_activity_mci, parameters.production_notes, wo.production_id]);
      await audit(pool, req, 'WORK_ORDER_PRODUCTION_PARAMETERS_SAVED', 'WORK_ORDER', wo.id, 'Production role completed production parameter section', null, parameters);
      res.redirect('/manufacturing/planning?success=Parameter+Production+tersimpan');
    } catch (e) { res.redirect('/manufacturing/planning?error=' + encodeURIComponent(e.message)); }
  });
  app.post('/manufacturing/planning/:id/cancel', isAuthenticated, guard(SCM), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT * FROM roadmap_work_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!r.rows.length) throw new Error('Work Order tidak ditemukan.');
      if (['EXECUTED','CANCELLED'].includes(r.rows[0].status)) throw new Error('Batch yang sudah dieksekusi/dibatalkan tidak dapat dibatalkan kembali.');
      await client.query(`UPDATE roadmap_work_orders SET status='CANCELLED',cancel_reason=$1,updated_at=now() WHERE id=$2`, [str(req.body.reason) || 'Cancelled by SCM', r.rows[0].id]);
      await client.query(`UPDATE productions SET status='CANCELLED' WHERE id=$1`, [r.rows[0].production_id]);
      await client.query(`UPDATE dispatch_plans SET status='CANCELLED' WHERE production_batch_id=$1 AND status='SCHEDULED'`, [r.rows[0].batch_id]);
      await audit(client, req, 'WORK_ORDER_CANCELLED', 'WORK_ORDER', r.rows[0].id, str(req.body.reason), { status: r.rows[0].status }, { status: 'CANCELLED' });
      await client.query('COMMIT'); res.redirect('/manufacturing/planning?success=Batch+dibatalkan');
    } catch (e) { await client.query('ROLLBACK'); res.redirect('/manufacturing/planning?error=' + encodeURIComponent(e.message)); }
    finally { client.release(); }
  });

  // Permanent removal is intentionally limited to unexecuted trial Work Orders without controlled/dispatch history.
  app.post('/manufacturing/planning/:id/delete-trial', isAuthenticated, guard(SCM), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(`SELECT wo.*,p.status production_status FROM roadmap_work_orders wo
        JOIN productions p ON p.id=wo.production_id WHERE wo.id=$1 FOR UPDATE OF wo,p`, [req.params.id]);
      if (!found.rows.length) throw new Error('Work Order tidak ditemukan.');
      const wo = found.rows[0];
      if (!['SCHEDULED','CANCELLED'].includes(String(wo.status).toUpperCase())) {
        throw new Error('Delete trial hanya tersedia untuk Work Order SCHEDULED/CANCELLED yang belum dieksekusi.');
      }
      if (!['SCHEDULED','CANCELLED','DRAFT'].includes(String(wo.production_status).toUpperCase())) {
        throw new Error('Production record sudah melewati tahap draft/terjadwal; penghapusan diblokir.');
      }
      const [execRows, records, controlled, deliveries, labelJobs, plans] = await Promise.all([
        client.query('SELECT * FROM roadmap_batch_executions WHERE work_order_id=$1 FOR UPDATE', [wo.id]),
        client.query('SELECT count(*)::int n FROM roadmap_batch_records WHERE batch_id=$1', [wo.batch_id]),
        client.query(`SELECT
          (SELECT count(*)::int FROM erp_batch_steps WHERE batch_id=$1) +
          (SELECT count(*)::int FROM erp_batch_parameters WHERE batch_id=$1) +
          (SELECT count(*)::int FROM erp_qc_results WHERE batch_id=$1) +
          (SELECT count(*)::int FROM erp_signatures WHERE document_id=$1) AS n`, [wo.batch_id]),
        client.query('SELECT count(*)::int n FROM erp_delivery_orders WHERE batch_id=$1', [wo.batch_id]),
        client.query('SELECT count(*)::int n FROM erp_label_jobs WHERE batch_id=$1', [wo.batch_id]),
        client.query('SELECT id,status FROM dispatch_plans WHERE production_batch_id=$1 FOR UPDATE', [wo.batch_id])
      ]);
      if (execRows.rows.some(x => !['DRAFT','PARAMETERS_DRAFTED'].includes(String(x.status).toUpperCase()))) {
        throw new Error('Execution sudah mengeluarkan material atau dimulai; Work Order tidak bisa dihapus.');
      }
      if (Number(records.rows[0].n) > 0 || Number(controlled.rows[0].n) > 0 || Number(deliveries.rows[0].n) > 0 || Number(labelJobs.rows[0].n) > 0) {
        throw new Error('Work Order mempunyai rekaman batch, parameter, QC, tanda tangan, label, atau Delivery Order. Penghapusan permanen diblokir untuk melindungi ketertelusuran.');
      }
      if (plans.rows.some(x => !['SCHEDULED','CANCELLED'].includes(String(x.status).toUpperCase()))) {
        throw new Error('Dispatch plan sudah bergerak melewati status SCHEDULED/CANCELLED; penghapusan diblokir.');
      }
      await audit(client, req, 'WORK_ORDER_TRIAL_DELETED', 'WORK_ORDER', wo.id,
        str(req.body.reason) || 'Trial cleanup requested by SCM',
        { work_order_no: wo.work_order_no, batch_id: wo.batch_id, status: wo.status },
        { deleted: true, trial_cleanup: true });
      if (execRows.rows.length) {
        const execIds = execRows.rows.map(x => Number(x.id));
        await client.query('DELETE FROM roadmap_batch_materials WHERE execution_id=ANY($1::bigint[])', [execIds]);
        await client.query('DELETE FROM roadmap_batch_executions WHERE id=ANY($1::bigint[])', [execIds]);
      }
      if (plans.rows.length) await client.query("DELETE FROM dispatch_plans WHERE production_batch_id=$1 AND status IN ('SCHEDULED','CANCELLED')", [wo.batch_id]);
      await client.query('DELETE FROM roadmap_work_orders WHERE id=$1', [wo.id]);
      await client.query('DELETE FROM productions WHERE id=$1', [wo.production_id]);
      await client.query('COMMIT');
      res.redirect('/manufacturing/planning?success=' + encodeURIComponent(`Work Order trial ${wo.work_order_no} berhasil dihapus.`));
    } catch (e) {
      await client.query('ROLLBACK');
      res.redirect('/manufacturing/planning?error=' + encodeURIComponent(e.message));
    } finally { client.release(); }
  });

  // 2. Production Execution: Production defines concentration/material needs; SCM verifies and issues stock atomically.
  app.get('/manufacturing/execution', isAuthenticated, async (req, res) => {
    try {
      const r = await pool.query(`SELECT wo.id,wo.work_order_no,wo.batch_id,wo.product_name,wo.product_code,wo.status wo_status,wo.production_parameters_complete,
        p.production_date,COALESCE(sum(wc.activity_at_cal_mci),0) ordered_activity,COALESCE(sum(wc.required_production_activity_mci),0) required_activity,
        min(wc.calibration_time) calibration_time,COALESCE(string_agg(DISTINCT c.name, ', '),'') customer_names,
        be.id execution_id,be.status execution_status,be.concentration_mci_ml,be.concentration_mbq_ml
        FROM roadmap_work_orders wo JOIN productions p ON p.id=wo.production_id LEFT JOIN roadmap_work_order_customers wc ON wc.work_order_id=wo.id
        LEFT JOIN customers c ON c.id=wc.customer_id LEFT JOIN roadmap_batch_executions be ON be.work_order_id=wo.id
        WHERE wo.status NOT IN ('CANCELLED') GROUP BY wo.id,p.production_date,be.id ORDER BY p.production_date DESC NULLS LAST,wo.created_at DESC`);
      res.render('roadmap/execution', { page: 'roadmap-execution', batches: r.rows, query: req.query, canProduce: allowedRole(req, PD), canSCM: allowedRole(req, SCM) });
    } catch (e) { console.error(e); res.status(500).send('Production Execution gagal dimuat.'); }
  });
  app.get('/manufacturing/execution/:id', isAuthenticated, async (req, res) => {
    try {
      const w = await pool.query(`SELECT wo.*,p.production_date,p.status production_status FROM roadmap_work_orders wo JOIN productions p ON p.id=wo.production_id WHERE wo.id=$1`, [req.params.id]);
      if (!w.rows.length) return res.status(404).send('Work Order tidak ditemukan.');
      const wo = w.rows[0];
      const [customers, materials, execution, lineRows, eligibleLots] = await Promise.all([
        pool.query(`SELECT wc.*,c.name customer_name,c.customer_code,c.qualification_status FROM roadmap_work_order_customers wc JOIN customers c ON c.id=wc.customer_id WHERE wc.work_order_id=$1 ORDER BY wc.id`, [wo.id]),
        pool.query(`SELECT m.id,m.material_code,m.name,m.uom,m.category,m.current_stock,m.min_stock,
          COALESCE((SELECT sum(mb.qty_remaining) FROM material_batches mb WHERE mb.material_id=m.id AND mb.status IN ('UNRESTRICTED','RELEASED') AND (mb.expiry_date IS NULL OR mb.expiry_date>=CURRENT_DATE)),0) released_lot_stock
          FROM materials m WHERE COALESCE(m.is_active,true)=true ORDER BY m.name`),
        pool.query('SELECT * FROM roadmap_batch_executions WHERE work_order_id=$1', [wo.id]),
        pool.query(`SELECT bm.*,m.material_code,m.name material_name,m.uom material_uom FROM roadmap_batch_materials bm JOIN materials m ON m.id=bm.material_id WHERE bm.execution_id=(SELECT id FROM roadmap_batch_executions WHERE work_order_id=$1) ORDER BY bm.id`, [wo.id]),
        pool.query(`SELECT mb.id,mb.material_id,mb.batch_number,mb.analysis_no,mb.expiry_date,mb.status,COALESCE(mb.qty_remaining,mb.qty) qty_available,m.uom FROM material_batches mb JOIN materials m ON m.id=mb.material_id WHERE mb.status IN ('UNRESTRICTED','RELEASED') AND (mb.expiry_date IS NULL OR mb.expiry_date>=CURRENT_DATE) AND COALESCE(mb.qty_remaining,mb.qty)>0 AND COALESCE(m.is_active,true)=true ORDER BY mb.expiry_date NULLS LAST,mb.created_at`)
      ]);
      res.render('roadmap/execution-detail', { page: 'roadmap-execution', workOrder: wo, customers: customers.rows, materials: materials.rows, execution: execution.rows[0] || null, materialLines: lineRows.rows, eligibleLots: eligibleLots.rows, query: req.query, canProduce: allowedRole(req, PD), canSCM: allowedRole(req, SCM) });
    } catch (e) { console.error(e); res.status(500).send('Detail execution gagal dimuat.'); }
  });
  app.post('/manufacturing/execution/:id/draft', isAuthenticated, guard(PD), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await client.query('SELECT * FROM roadmap_work_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!w.rows.length) throw new Error('Work Order tidak ditemukan.');
      const wo = w.rows[0];
      if (wo.status !== 'SCHEDULED' || !wo.production_parameters_complete) throw new Error('Work Order harus dijadwalkan dan parameter Production harus lengkap terlebih dahulu.');
      const concentrationMci=num(req.body.concentration_mci_ml),concentrationMbq=num(req.body.concentration_mbq_ml);
      if(!(concentrationMci>0)||!(concentrationMbq>0))throw new Error('Concentration mCi/mL dan MBq/mL wajib diisi dengan nilai lebih besar dari nol.');
      const customerCheck = await client.query(`SELECT count(*)::int n FROM roadmap_work_order_customers wc JOIN customers c ON c.id=wc.customer_id WHERE wc.work_order_id=$1 AND c.qualification_status<>'QUALIFIED'`, [wo.id]);
      // allow recording the draft, but prevent the issue/execution step below until customer qualification is completed.
      let e = await client.query('SELECT * FROM roadmap_batch_executions WHERE work_order_id=$1 FOR UPDATE', [wo.id]);
      let execId;
      if (!e.rows.length) {
        const inserted = await client.query(`INSERT INTO roadmap_batch_executions(work_order_id,production_id,concentration_mci_ml,concentration_mbq_ml,parameters,status,prepared_by)
          VALUES($1,$2,$3,$4,$5::jsonb,'PARAMETERS_DRAFTED',$6) RETURNING id`, [wo.id, wo.production_id, concentrationMci, concentrationMbq, JSON.stringify({ notes: str(req.body.execution_notes), prepared_by: req.session.user.full_name }), req.session.user.id]);
        execId = inserted.rows[0].id;
      } else {
        if (['MATERIALS_ISSUED','EXECUTED'].includes(e.rows[0].status)) throw new Error('Material sudah dikeluarkan atau batch sudah dieksekusi; parameter tidak dapat diubah.');
        execId = e.rows[0].id;
        await client.query(`UPDATE roadmap_batch_executions SET concentration_mci_ml=$1,concentration_mbq_ml=$2,parameters=$3::jsonb,status='PARAMETERS_DRAFTED',prepared_by=$4,updated_at=now() WHERE id=$5`, [concentrationMci, concentrationMbq, JSON.stringify({ notes: str(req.body.execution_notes), prepared_by: req.session.user.full_name }), req.session.user.id, execId]);
        await client.query('DELETE FROM roadmap_batch_materials WHERE execution_id=$1', [execId]);
      }
      const mids = arr(req.body.material_id); const qtys = arr(req.body.required_qty); const uoms = arr(req.body.material_uom); const notes = arr(req.body.material_note);
      let lineCount=0;
      for (let i=0;i<mids.length;i++) {
        const materialId=Number(mids[i]); const qty=num(qtys[i]);
        if (!materialId && (qty === null || qty === 0)) continue;
        if (!Number.isInteger(materialId) || materialId<1 || !qty || qty<=0) throw new Error('Setiap material yang dipilih harus memiliki jumlah lebih besar dari nol.');
        const m=await client.query('SELECT id,uom,is_active FROM materials WHERE id=$1', [materialId]);
        if (!m.rows.length || !m.rows[0].is_active) throw new Error('Material tidak ada di Master List atau sudah dinonaktifkan.');
        await client.query(`INSERT INTO roadmap_batch_materials(execution_id,material_id,requested_qty,uom,notes) VALUES($1,$2,$3,$4,$5)`, [execId,materialId,qty,nullable(uoms[i]) || m.rows[0].uom,nullable(notes[i])]); lineCount++;
      }
      if (!lineCount) throw new Error('Production harus mengisi setidaknya satu kebutuhan material.');
      await audit(client, req, 'BATCH_EXECUTION_DRAFT_SAVED', 'BATCH', wo.batch_id, 'Production entered concentration and material requirements', null, { concentration_mci_ml: concentrationMci, concentration_mbq_ml: concentrationMbq, material_line_count: lineCount, unqualified_customer_count: customerCheck.rows[0].n });
      await client.query('COMMIT'); res.redirect(`/manufacturing/execution/${wo.id}?success=Parameter+dan+kebutuhan+material+tersimpan`);
    } catch (e) { await client.query('ROLLBACK'); res.redirect(`/manufacturing/execution/${req.params.id}?error=` + encodeURIComponent(e.message)); }
    finally { client.release(); }
  });
  app.post('/manufacturing/execution/:id/issue-materials', isAuthenticated, guard(SCM), async (req, res) => {
    // The stock issue crosses Manufacturing and Inventory controls for custom roles.
    // Require explicit approval rights in Execution and edit rights in Inventory.
    if (req.session.user?._erpCustomRole) {
      const rp = req.session.user._erpRolePermissions || {};
      if (rp.MANUFACTURING_EXECUTION?.can_approve !== true || rp.INVENTORY?.can_edit !== true) {
        return res.status(403).send('Akses ditolak: role custom memerlukan Approve pada Manufacturing / Production Execution dan Edit pada Inventory untuk mengeluarkan stok.');
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await client.query('SELECT * FROM roadmap_work_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!w.rows.length) throw new Error('Work Order tidak ditemukan.');
      const wo=w.rows[0];
      const qc = await client.query(`SELECT c.name,c.qualification_status FROM roadmap_work_order_customers wc JOIN customers c ON c.id=wc.customer_id WHERE wc.work_order_id=$1`, [wo.id]);
      const notQualified = qc.rows.filter(c=>c.qualification_status!=='QUALIFIED');
      if (notQualified.length) throw new Error(`Customer belum Qualified oleh QA: ${notQualified.map(x=>x.name).join(', ')}.`);
      const e = await client.query('SELECT * FROM roadmap_batch_executions WHERE work_order_id=$1 FOR UPDATE', [wo.id]);
      if (!e.rows.length || e.rows[0].status!=='PARAMETERS_DRAFTED') throw new Error('Parameter Production harus disimpan sebelum verifikasi SCM.');
      const lines = await client.query('SELECT bm.*,m.current_stock,m.name material_name FROM roadmap_batch_materials bm JOIN materials m ON m.id=bm.material_id WHERE bm.execution_id=$1 ORDER BY bm.id FOR UPDATE OF bm', [e.rows[0].id]);
      if (!lines.rows.length) throw new Error('Tidak ada kebutuhan material yang perlu diverifikasi.');
      for (const line of lines.rows) {
        // SCM explicitly selects one or more physical lots for each Production material requirement.
        // Repeated same-name fields are parsed as arrays by the Express extended URL-encoded parser.
        const rawLotIds = arr(req.body[`lot_id_${line.id}`]);
        const rawLotQtys = arr(req.body[`lot_qty_${line.id}`]);
        if (!rawLotIds.length || rawLotIds.length !== rawLotQtys.length) {
          throw new Error(`SCM harus memilih lot dan jumlah alokasi untuk ${line.material_name}.`);
        }
        const allocations = new Map();
        for (let i = 0; i < rawLotIds.length; i++) {
          const lotId = Number(rawLotIds[i]);
          const qty = num(rawLotQtys[i]);
          if (!Number.isSafeInteger(lotId) || lotId < 1 || qty === null || qty <= 0) {
            throw new Error(`Lot atau kuantitas alokasi untuk ${line.material_name} tidak valid.`);
          }
          allocations.set(lotId, (allocations.get(lotId) || 0) + qty);
        }
        const allocated = [...allocations.values()].reduce((sum, qty) => sum + qty, 0);
        if (Math.abs(allocated - Number(line.requested_qty)) > 0.000001) {
          throw new Error(`Total alokasi lot untuk ${line.material_name} harus sama dengan kebutuhan Production (${line.requested_qty} ${line.uom || ''}).`);
        }
        if (Number(line.current_stock) + 1e-8 < Number(line.requested_qty)) {
          throw new Error(`Saldo agregat material ${line.material_name} tidak cukup / tidak konsisten.`);
        }
        const issuedLots = [];
        for (const [lotId, take] of [...allocations.entries()].sort((a, b) => a[0] - b[0])) {
          const lr = await client.query(`SELECT mb.*,m.id AS joined_material_id,m.name AS joined_material_name
              FROM material_batches mb JOIN materials m ON m.id=mb.material_id
              WHERE mb.id=$1 FOR UPDATE OF mb`, [lotId]);
          if (!lr.rows.length) throw new Error(`Lot ID ${lotId} tidak ditemukan.`);
          const lot = lr.rows[0];
          if (Number(lot.material_id) !== Number(line.material_id)) {
            throw new Error(`Lot ${lot.batch_number} bukan lot untuk material ${line.material_name}.`);
          }
          if (!['UNRESTRICTED','RELEASED'].includes(String(lot.status).toUpperCase())) {
            throw new Error(`Lot ${lot.batch_number} belum berstatus RELEASED/UNRESTRICTED.`);
          }
          if (lot.expiry_date && new Date(lot.expiry_date) < new Date(new Date().toISOString().slice(0,10))) {
            throw new Error(`Lot ${lot.batch_number} telah kedaluwarsa.`);
          }
          const beforeQty = Number(lot.qty_remaining ?? lot.qty ?? 0);
          if (beforeQty + 1e-8 < take) throw new Error(`Stok lot ${lot.batch_number} tidak cukup. Tersedia ${beforeQty}, dialokasikan ${take}.`);
          const lotUpdate = await client.query(`UPDATE material_batches
            SET qty_remaining=COALESCE(qty_remaining,qty)-$1
            WHERE id=$2 AND COALESCE(qty_remaining,qty)-$1 >= -0.000001
            RETURNING qty_remaining`, [take, lotId]);
          if (!lotUpdate.rows.length) throw new Error(`Saldo lot ${lot.batch_number} berubah saat transaksi. Refresh dan verifikasi kembali.`);
          await client.query(`INSERT INTO erp_inventory_movements(material_id,material_batch_id,movement_type,quantity,uom,source_type,source_id,reason,actor_user_id,actor_name,metadata)
            VALUES($1,$2,'PRODUCTION_ISSUE',$3,$4,'ROADMAP_BATCH',$5,'SCM selected and verified production lot',$6,$7,$8::jsonb)`, [line.material_id, lotId, -take, line.uom, wo.batch_id, req.session.user.id, req.session.user.full_name, JSON.stringify({work_order_no:wo.work_order_no,material_batch_no:lot.batch_number,requested_qty:Number(line.requested_qty),allocated_qty:take})]);
          issuedLots.push({ lot_id: lot.id, batch_number: lot.batch_number, analysis_no: lot.analysis_no || null, quantity: take, expiry_date: lot.expiry_date });
        }
        const masterUpdate = await client.query('UPDATE materials SET current_stock=current_stock-$1 WHERE id=$2 AND current_stock-$1 >= -0.000001 RETURNING current_stock', [line.requested_qty, line.material_id]);
        if (!masterUpdate.rows.length) throw new Error(`Saldo master material ${line.material_name} tidak cukup; seluruh transaksi dibatalkan.`);
        await client.query(`UPDATE roadmap_batch_materials SET status='ISSUED',issued_qty=requested_qty,lot_details=$1::jsonb,verified_by=$2,verified_at=now() WHERE id=$3`, [JSON.stringify(issuedLots), req.session.user.id, line.id]);
      }
      await client.query(`UPDATE roadmap_batch_executions SET status='MATERIALS_ISSUED',scm_verified_by=$1,scm_verified_at=now(),updated_at=now() WHERE id=$2`, [req.session.user.id,e.rows[0].id]);
      await audit(client, req, 'BATCH_MATERIALS_ISSUED', 'BATCH', wo.batch_id, 'SCM selected and issued verified released material lots', { status: e.rows[0].status }, { status: 'MATERIALS_ISSUED', lines: lines.rows.length });
      await client.query('COMMIT'); res.redirect(`/manufacturing/execution/${wo.id}?success=Material+terverifikasi+dan+stok+terpotong+secara+atomik`);
    } catch (e) { await client.query('ROLLBACK'); res.redirect(`/manufacturing/execution/${req.params.id}?error=` + encodeURIComponent(e.message)); }
    finally { client.release(); }
  });
  app.post('/manufacturing/execution/:id/execute', isAuthenticated, guard(PD), async (req, res) => {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const w=await client.query('SELECT * FROM roadmap_work_orders WHERE id=$1 FOR UPDATE',[req.params.id]); if(!w.rows.length) throw new Error('Work Order tidak ditemukan.');
      const wo=w.rows[0]; const e=await client.query('SELECT * FROM roadmap_batch_executions WHERE work_order_id=$1 FOR UPDATE',[wo.id]);
      if (!e.rows.length || e.rows[0].status!=='MATERIALS_ISSUED') throw new Error('SCM harus memverifikasi seluruh kebutuhan material terlebih dahulu.');
      await client.query(`UPDATE roadmap_batch_executions SET status='EXECUTED',executed_by=$1,executed_at=now(),updated_at=now() WHERE id=$2`,[req.session.user.id,e.rows[0].id]);
      await client.query(`UPDATE roadmap_work_orders SET status='EXECUTED',updated_at=now() WHERE id=$1`,[wo.id]);
      await client.query(`UPDATE productions SET status='IN_PROGRESS' WHERE id=$1`,[wo.production_id]);
      await audit(client, req, 'BATCH_EXECUTED', 'BATCH', wo.batch_id, 'Execution launched after SCM material issue', { status: e.rows[0].status }, { status: 'EXECUTED' });
      await client.query('COMMIT'); res.redirect('/manufacturing/batch-records?success=Batch+siap+untuk+Batch+Record+live+tracking');
    } catch(e) { await client.query('ROLLBACK'); res.redirect(`/manufacturing/execution/${req.params.id}?error=`+encodeURIComponent(e.message)); }
    finally { client.release(); }
  });

  // 3. Batch Record, 4 source-derived controlled templates, BPR same for all runs.
  app.get('/manufacturing/batch-records', isAuthenticated, async (req,res) => {
    try {
      const r=await pool.query(`SELECT wo.id work_order_id,wo.work_order_no,wo.batch_id,wo.product_name,p.production_date,
        COALESCE(string_agg(DISTINCT c.name, ', '),'') customer_names,COALESCE(sum(wc.activity_at_cal_mci),0) ordered_activity,
        min(wc.calibration_time) calibration_time,be.concentration_mci_ml,be.concentration_mbq_ml,be.status execution_status,
        brm.id bmr_id,brm.template_code bmr_template,brm.status bmr_status,brp.id bpr_id,brp.status bpr_status,
        (SELECT count(*) FROM roadmap_batch_records brx WHERE brx.batch_id=wo.batch_id AND brx.status IN ('SUBMITTED_FOR_REVIEW','COMPLETE'))::int completed_record_count
        FROM roadmap_work_orders wo JOIN productions p ON p.id=wo.production_id JOIN roadmap_batch_executions be ON be.work_order_id=wo.id
        LEFT JOIN roadmap_work_order_customers wc ON wc.work_order_id=wo.id LEFT JOIN customers c ON c.id=wc.customer_id
        LEFT JOIN roadmap_batch_records brm ON brm.batch_id=wo.batch_id AND brm.record_type='BMR'
        LEFT JOIN roadmap_batch_records brp ON brp.batch_id=wo.batch_id AND brp.record_type='BPR'
        WHERE be.status='EXECUTED' OR brm.id IS NOT NULL OR brp.id IS NOT NULL
        GROUP BY wo.id,p.production_date,be.concentration_mci_ml,be.concentration_mbq_ml,be.status,brm.id,brm.template_code,brm.status,brp.id,brp.status
        ORDER BY p.production_date DESC NULLS LAST,wo.created_at DESC`);
      res.render('roadmap/batch-records',{page:'roadmap-batch-records',batches:r.rows,templates:recordConfig.templates.filter(t=>t.record_type==='BMR'),query:req.query,canFill:allowedRole(req,PD),canQA:allowedRole(req,QCQA)});
    } catch(e) { console.error(e); res.status(500).send('Batch Record tidak dapat dimuat.'); }
  });
  app.post('/manufacturing/batch-records/:batchId/start', isAuthenticated, guard(PD), async (req,res) => {
    try {
      const b=await pool.query(`SELECT wo.batch_id,be.status FROM roadmap_work_orders wo JOIN roadmap_batch_executions be ON be.work_order_id=wo.id WHERE wo.batch_id=$1`,[req.params.batchId]);
      if(!b.rows.length || b.rows[0].status!=='EXECUTED') throw new Error('Batch belum berhasil dieksekusi di Production Execution.');
      const type=str(req.body.record_type).toUpperCase(); let tpl;
      if(type==='BMR') tpl=recordTemplates.get(str(req.body.template_code)); else if(type==='BPR') tpl=recordTemplates.get('BPR_CITRATE');
      if(!tpl || tpl.record_type!==type) throw new Error('Pilih template record yang valid.');
      const r=await pool.query(`INSERT INTO roadmap_batch_records(batch_id,record_type,template_code,template_revision,status,started_by)
        VALUES($1,$2,$3,$4,'IN_PROGRESS',$5) ON CONFLICT(batch_id,record_type) DO NOTHING RETURNING id`,[req.params.batchId,type,tpl.code,tpl.revision,req.session.user.id]);
      let instanceId=r.rows[0]?.id;
      if(!instanceId){const old=await pool.query('SELECT id,template_code FROM roadmap_batch_records WHERE batch_id=$1 AND record_type=$2',[req.params.batchId,type]); if(!old.rows.length) throw new Error('Record tidak dapat dibuat.'); if(old.rows[0].template_code!==tpl.code) throw new Error('Template sudah dipilih dan tidak dapat diganti setelah pengisian dimulai; minta QA membuka revisi baru.'); instanceId=old.rows[0].id;}
      await audit(pool,req,'BATCH_RECORD_STARTED','BATCH_RECORD',instanceId,`Started ${type} using ${tpl.code}`,null,{batch_id:req.params.batchId,template_code:tpl.code});
      res.redirect(`/manufacturing/batch-records/${encodeURIComponent(req.params.batchId)}/fill/${instanceId}`);
    } catch(e) { res.redirect('/manufacturing/batch-records?error='+encodeURIComponent(e.message)); }
  });
  app.get('/manufacturing/batch-records/:batchId/fill/:recordId', isAuthenticated, async (req,res) => {
    try {
      const [b,r]=await Promise.all([
        pool.query(`SELECT wo.*,p.production_date,p.calib_time FROM roadmap_work_orders wo JOIN productions p ON p.id=wo.production_id WHERE wo.batch_id=$1`,[req.params.batchId]),
        pool.query('SELECT * FROM roadmap_batch_records WHERE id=$1 AND batch_id=$2',[req.params.recordId,req.params.batchId])
      ]);
      if(!b.rows.length||!r.rows.length) return res.status(404).send('Batch atau instance record tidak ditemukan.');
      const record=r.rows[0];const tpl=recordTemplates.get(record.template_code);if(!tpl)return res.status(500).send('Template record tidak tersedia.');
      const sections=tpl.sections.filter(s=>s.actionable && s.rows.length>0);
      const detail=await pool.query(`SELECT c.name customer_name,wc.* FROM roadmap_work_order_customers wc JOIN customers c ON c.id=wc.customer_id WHERE wc.work_order_id=$1 ORDER BY wc.id`,[b.rows[0].id]);
      res.render('roadmap/batch-record-detail',{page:'roadmap-batch-records',batch:b.rows[0],record,template:tpl,sections,customers:detail.rows,query:req.query,canQA:allowedRole(req,QCQA)});
    } catch(e) { console.error(e); res.status(500).send('Form Batch Record gagal dimuat.'); }
  });
  app.post('/manufacturing/batch-records/:batchId/save/:recordId', isAuthenticated, guard(PD), async (req,res) => {
    try {
      const r=await pool.query('SELECT * FROM roadmap_batch_records WHERE id=$1 AND batch_id=$2',[req.params.recordId,req.params.batchId]);
      if(!r.rows.length) throw new Error('Record tidak ditemukan.'); const record=r.rows[0];
      if(!['IN_PROGRESS','REWORK_REQUIRED'].includes(record.status)) throw new Error('Record sudah dikirim untuk review dan terkunci dari edit.');
      const data={...(record.data||{})};
      for (const [key,value] of Object.entries(req.body)) {
        const m=key.match(/^f_(\d+)_(\d+)_(actual|status|time|initial|notes)$/); if(!m) continue;
        const k=`${m[1]}_${m[2]}`; data[k]=data[k]||{}; data[k][m[3]]=str(value);
      }
      const submitted = str(req.body.record_action)==='submit';
      let status='IN_PROGRESS';
      if(submitted){
        const tpl=recordTemplates.get(record.template_code); const actionable=tpl.sections.filter(s=>s.actionable && s.rows.length>0); const missing=[];
        for(const sec of actionable){ for(const row of sec.rows){const v=data[`${sec.index}_${row.row}`]||{}; if(!v.status || v.status==='PENDING') missing.push(`${sec.title} — ${(row.cells||[]).slice(0,2).join(' / ')}`);}}
        if(missing.length){const small=missing.slice(0,5).join('; ');throw new Error(`Belum lengkap: ${missing.length} item belum memiliki status PASS/FAIL/N/A. Contoh: ${small}`);}
        status='SUBMITTED_FOR_REVIEW';
      }
      await pool.query(`UPDATE roadmap_batch_records SET data=$1::jsonb,status=$2,submitted_by=CASE WHEN $2='SUBMITTED_FOR_REVIEW' THEN $3 ELSE submitted_by END,
        submitted_at=CASE WHEN $2='SUBMITTED_FOR_REVIEW' THEN now() ELSE submitted_at END,updated_at=now() WHERE id=$4`,[JSON.stringify(data),status,req.session.user.id,record.id]);
      await audit(pool,req,submitted?'BATCH_RECORD_SUBMITTED':'BATCH_RECORD_SAVED','BATCH_RECORD',record.id,`${record.record_type} ${submitted?'submitted for review':'autosaved by form submission'}`,{status:record.status},{status,field_count:Object.keys(data).length});
      if(submitted){
        const count=await pool.query(`SELECT count(*)::int n FROM roadmap_batch_records WHERE batch_id=$1 AND status='SUBMITTED_FOR_REVIEW'`,[req.params.batchId]);
        if(count.rows[0].n===2) await pool.query(`UPDATE productions SET status='COMPLETED',qa_disposition='PENDING' WHERE batch_id=$1`,[req.params.batchId]);
        res.redirect('/manufacturing/batch-records?success=Batch+Record+dikirim+untuk+review+QA');
      } else res.redirect(`/manufacturing/batch-records/${encodeURIComponent(req.params.batchId)}/fill/${record.id}?success=Draft+tersimpan`);
    } catch(e) { res.redirect(`/manufacturing/batch-records/${encodeURIComponent(req.params.batchId)}/fill/${req.params.recordId}?error=`+encodeURIComponent(e.message)); }
  });
  app.get('/manufacturing/batch-records/:batchId/print/:recordId', isAuthenticated, async (req,res) => {
    try {
      const r=await pool.query('SELECT * FROM roadmap_batch_records WHERE id=$1 AND batch_id=$2',[req.params.recordId,req.params.batchId]);
      if(!r.rows.length)return res.status(404).send('Record tidak ditemukan.');
      const b=await pool.query(`SELECT wo.*,p.production_date,p.calib_time FROM roadmap_work_orders wo JOIN productions p ON p.id=wo.production_id WHERE wo.batch_id=$1`,[req.params.batchId]);
      const tpl=recordTemplates.get(r.rows[0].template_code);
      const cust=await pool.query(`SELECT c.name,wc.* FROM roadmap_work_order_customers wc JOIN customers c ON c.id=wc.customer_id JOIN roadmap_work_orders wo ON wo.id=wc.work_order_id WHERE wo.batch_id=$1 ORDER BY wc.id`,[req.params.batchId]);
      const signerIds=[r.rows[0].started_by,r.rows[0].submitted_by,r.rows[0].reviewed_by].filter(Boolean).map(Number);
      const userRows=signerIds.length ? await pool.query(`SELECT id,full_name,role,digital_signature_file_id AS signature_file_id FROM users WHERE id=ANY($1::int[])`,[signerIds]) : {rows:[]};
      const signerMap=new Map(userRows.rows.map(u=>[Number(u.id),u]));
      res.render('roadmap/record-print',{layoutless:true,batch:b.rows[0],record:r.rows[0],template:tpl,customers:cust.rows,user:req.session.user,sections:tpl.sections,signers:{started:signerMap.get(Number(r.rows[0].started_by))||null,submitted:signerMap.get(Number(r.rows[0].submitted_by))||null,reviewed:signerMap.get(Number(r.rows[0].reviewed_by))||null}});
    } catch(e) { console.error(e); res.status(500).send('Cetak Batch Record gagal.'); }
  });

  // 4. Production History + CoA + QA review/release gate.
  app.get('/manufacturing/history', isAuthenticated, async (req,res) => {
    try {
      const r=await pool.query(`SELECT wo.id work_order_id,wo.work_order_no,wo.batch_id,wo.product_name,wo.product_code,p.production_date,p.status production_status,p.qa_disposition,
        coalesce(string_agg(DISTINCT c.name,', '),'') customer_names,
        brm.id bmr_id,brm.template_code bmr_template,brm.status bmr_status,brp.id bpr_id,brp.status bpr_status,
        (SELECT count(*)::int FROM roadmap_batch_attachments a WHERE a.batch_id=wo.batch_id AND a.attachment_type='COA') coa_count,
        (SELECT string_agg(f.id::text,',') FROM roadmap_batch_attachments a JOIN roadmap_private_files f ON f.id=a.private_file_id WHERE a.batch_id=wo.batch_id AND a.attachment_type='COA') coa_file_ids
        FROM roadmap_work_orders wo JOIN productions p ON p.id=wo.production_id LEFT JOIN roadmap_work_order_customers wc ON wc.work_order_id=wo.id LEFT JOIN customers c ON c.id=wc.customer_id
        LEFT JOIN roadmap_batch_records brm ON brm.batch_id=wo.batch_id AND brm.record_type='BMR' LEFT JOIN roadmap_batch_records brp ON brp.batch_id=wo.batch_id AND brp.record_type='BPR'
        WHERE wo.status IN ('EXECUTED','COMPLETED') OR p.status IN ('COMPLETED','QA_RELEASED','REJECTED')
        GROUP BY wo.id,p.production_date,p.status,p.qa_disposition,brm.id,brm.template_code,brm.status,brp.id,brp.status ORDER BY p.production_date DESC NULLS LAST,wo.created_at DESC`);
      res.render('roadmap/history',{page:'roadmap-history',batches:r.rows,query:req.query,canQA:allowedRole(req,QCQA)});
    } catch(e) { console.error(e); res.status(500).send('Production History gagal dimuat.'); }
  });
  app.post('/manufacturing/history/:batchId/coa', isAuthenticated, guard(SCM.concat(PD)), uploadDoc.single('coa_document'), async (req,res) => {
    try {
      if(!req.file) throw new Error('Upload CoA wajib dipilih.');
      const knownBatch=await pool.query('SELECT id FROM roadmap_work_orders WHERE batch_id=$1',[req.params.batchId]);
      if(!knownBatch.rows.length)throw new Error('Batch tidak ditemukan di Work Order register.');
      const file=await storePrivateFile(pool,req.file,{ownerType:'BATCH',ownerId:req.params.batchId,documentType:'COA',userId:req.session.user.id});
      await pool.query(`INSERT INTO roadmap_batch_attachments(batch_id,attachment_type,private_file_id,uploaded_by) VALUES($1,'COA',$2,$3)`,[req.params.batchId,file.id,req.session.user.id]);
      await audit(pool,req,'BATCH_COA_UPLOADED','BATCH',req.params.batchId,'Certificate of Analysis attached',null,{file_id:file.id});
      res.redirect('/manufacturing/history?success=CoA+batch+berhasil+diunggah');
    } catch(e) { res.redirect('/manufacturing/history?error='+encodeURIComponent(e.message)); }
  });
  app.post('/manufacturing/history/:batchId/review', isAuthenticated, guard(QCQA), async (req,res) => {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const b=await client.query(`SELECT wo.*,p.id production_id FROM roadmap_work_orders wo JOIN productions p ON p.id=wo.production_id WHERE wo.batch_id=$1 FOR UPDATE OF wo,p`,[req.params.batchId]);
      if(!b.rows.length)throw new Error('Batch tidak ditemukan.');
      const records=await client.query('SELECT * FROM roadmap_batch_records WHERE batch_id=$1 ORDER BY record_type',[req.params.batchId]);
      if(records.rows.length!==2 || records.rows.some(r=>r.status!=='SUBMITTED_FOR_REVIEW'))throw new Error('BMR dan BPR harus sama-sama dikirim untuk QA review.');
      if(records.some(r=>Number(r.started_by)===Number(req.session.user.id)||Number(r.submitted_by)===Number(req.session.user.id)))throw new Error('Separation of duties: QA reviewer tidak boleh menjadi user yang memulai atau mengirim BMR/BPR batch ini.');
      const coa=await client.query(`SELECT 1 FROM roadmap_batch_attachments WHERE batch_id=$1 AND attachment_type='COA' LIMIT 1`,[req.params.batchId]);
      if(!coa.rows.length)throw new Error('QA release diblokir: CoA belum diunggah di Production History.');
      const decision=str(req.body.decision).toUpperCase(); const note=str(req.body.review_note); const pin=str(req.body.pin);
      if(!['APPROVE','REJECT'].includes(decision))throw new Error('Keputusan QA tidak valid.');
      if(!pin)throw new Error('PIN re-authentication QA wajib diisi untuk keputusan review.');
      if(!note && decision==='REJECT')throw new Error('Alasan penolakan/rework wajib diisi.');
      const signer=await client.query('SELECT id,full_name,role,pin FROM users WHERE id=$1 AND account_status=$2',[req.session.user.id,'ACTIVE']);
      if(!signer.rows.length || !signer.rows[0].pin || !verifyCredential(pin,signer.rows[0].pin))throw new Error('PIN QA tidak valid atau belum disetel.');
      if(!/(qa|quality assurance|quality|plant manager|administrator)/i.test(signer.rows[0].role||''))throw new Error('Role tidak berwenang melakukan QA review/release.');
      const next=decision==='APPROVE'?'COMPLETE':'REWORK_REQUIRED';
      await client.query('UPDATE roadmap_batch_records SET status=$1,reviewed_by=$2,reviewed_at=now(),review_note=$3,updated_at=now() WHERE batch_id=$4',[next,req.session.user.id,note,req.params.batchId]);
      if(decision==='APPROVE') {
        await client.query(`UPDATE productions SET status='QA_RELEASED',qa_disposition='RELEASED',approved_by=$1 WHERE id=$2`,[req.session.user.id,b.rows[0].production_id]);
        const signVersion=await client.query(`SELECT COALESCE(MAX(document_version),0)+1 AS v FROM erp_signatures WHERE document_type='BATCH' AND document_id=$1 AND sign_type='QA_RELEASE'`,[req.params.batchId]);
        const sigPayload={batch_id:req.params.batchId,work_order_id:b.rows[0].id,review_note:note,bmr_bpr_status:next,coa_attached:true,signer_id:req.session.user.id,version:Number(signVersion.rows[0].v)};
        const signHash=crypto.createHash('sha256').update(JSON.stringify(sigPayload)).digest('hex');
        await client.query(`INSERT INTO erp_signatures(signer_user_id,signer_name,signer_role,sign_type,document_type,document_id,document_version,auth_method,decision,reason,document_hash) VALUES($1,$2,$3,'QA_RELEASE','BATCH',$4,$5,'PIN_REAUTH','APPROVED',$6,$7)`,[req.session.user.id,signer.rows[0].full_name,signer.rows[0].role,req.params.batchId,Number(signVersion.rows[0].v),note,signHash]);
      } else await client.query(`UPDATE productions SET status='IN_PROGRESS',qa_disposition='REJECTED' WHERE id=$1`,[b.rows[0].production_id]);
      await audit(client,req,decision==='APPROVE'?'BATCH_QA_RELEASED':'BATCH_QA_REJECTED','BATCH',req.params.batchId,note,{record_status:'SUBMITTED_FOR_REVIEW'},{record_status:next,qa_disposition:decision==='APPROVE'?'RELEASED':'REJECTED',signed_by:req.session.user.id});
      await client.query('COMMIT'); res.redirect('/manufacturing/history?success='+encodeURIComponent(decision==='APPROVE'?'BMR/BPR dan CoA disetujui QA; batch siap distribusi.':'Batch ditolak QA dan dikembalikan untuk rework.'));
    } catch(e) { await client.query('ROLLBACK'); res.redirect('/manufacturing/history?error='+encodeURIComponent(e.message)); }
    finally { client.release(); }
  });

  // 5. Inventory master, goods receipt to quarantine, separate inspection and QC release.
  app.get('/inventory', isAuthenticated, async (req,res) => {
    try {
      const [materials,lots,files,movements]=await Promise.all([
        pool.query(`SELECT m.*,COALESCE((SELECT sum(mb.qty_remaining) FROM material_batches mb WHERE mb.material_id=m.id AND mb.status IN ('UNRESTRICTED','RELEASED')),0) released_stock,
          (SELECT count(*)::int FROM material_batches mb WHERE mb.material_id=m.id AND mb.status='QUARANTINE') quarantine_lots FROM materials m ORDER BY m.name`),
        pool.query(`SELECT mb.*,m.material_code,m.name material_name,m.uom FROM material_batches mb JOIN materials m ON m.id=mb.material_id ORDER BY mb.created_at DESC`),
        pool.query(`SELECT * FROM roadmap_private_files WHERE owner_type='MATERIAL_BATCH' ORDER BY uploaded_at DESC`),
        pool.query(`SELECT * FROM erp_inventory_movements ORDER BY occurred_at DESC LIMIT 1200`)
      ]);
      res.render('roadmap/inventory',{page:'roadmap-inventory',materials:materials.rows,lots:lots.rows,files:files.rows,movements:movements.rows,query:req.query,canSCM:allowedRole(req,SCM),canQC:allowedRole(req,[/qc analyst/,/quality control/,/qc staff/,/qa analyst/]),canRelease:allowedRole(req,[/qc supervisor/,/qa supervisor/,/quality assurance/,/plant manager/])});
    } catch(e) { console.error(e); res.status(500).send('Inventory Management gagal dimuat.'); }
  });
  app.post('/inventory/materials', isAuthenticated, guard(SCM), async (req,res) => {
    try {
      const b=req.body;if(!str(b.material_code)||!str(b.name)||!str(b.uom)||!str(b.category)||!str(b.material_type))throw new Error('Kode material, nama, kategori, tipe material, dan satuan wajib diisi.');
      if(num(b.min_stock)!==null&&num(b.min_stock)<0)throw new Error('Minimum stock tidak boleh negatif.');
      const r=await pool.query(`INSERT INTO materials(material_code,name,category,uom,min_stock,current_stock,material_type,material_description,storage_location,is_active)
        VALUES($1,$2,$3,$4,$5,0,$6,$7,$8,true) RETURNING id`,[str(b.material_code),str(b.name),str(b.category),str(b.uom),num(b.min_stock)||0,nullable(b.material_type),nullable(b.material_description),nullable(b.storage_location)]);
      await audit(pool,req,'MATERIAL_MASTER_CREATED','MATERIAL',r.rows[0].id,'Created master material',null,{material_code:b.material_code,name:b.name});
      res.redirect('/inventory?success=Master+material+dibuat');
    } catch(e) { res.redirect('/inventory?error='+encodeURIComponent(e.message)); }
  });
  // Master material deletion is implemented as reversible archive to preserve linked batch/production/audit history.
  app.post('/inventory/materials/:id/archive', isAuthenticated, guard(SCM), async (req,res) => {
    try {
      const old=await pool.query('SELECT id,material_code,name,is_active FROM materials WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!old.rows.length) throw new Error('Master material tidak ditemukan.');
      await pool.query('UPDATE materials SET is_active=false WHERE id=$1',[req.params.id]);
      await audit(pool,req,'MATERIAL_MASTER_ARCHIVED','MATERIAL',req.params.id,'Master material archived to preserve referential/audit history',old.rows[0],{is_active:false});
      res.redirect('/inventory?success='+encodeURIComponent('Master material diarsipkan; histori lot tetap tersimpan.'));
    } catch(e) { res.redirect('/inventory?error='+encodeURIComponent(e.message)); }
  });
  app.post('/inventory/materials/:id/restore', isAuthenticated, guard(SCM), async (req,res) => {
    try {
      const old=await pool.query('SELECT id,material_code,name,is_active FROM materials WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!old.rows.length) throw new Error('Master material tidak ditemukan.');
      await pool.query('UPDATE materials SET is_active=true WHERE id=$1',[req.params.id]);
      await audit(pool,req,'MATERIAL_MASTER_REACTIVATED','MATERIAL',req.params.id,'Master material reactivated',old.rows[0],{is_active:true});
      res.redirect('/inventory?success='+encodeURIComponent('Master material diaktifkan kembali.'));
    } catch(e) { res.redirect('/inventory?error='+encodeURIComponent(e.message)); }
  });
  // Permanent trial-data deletion. Downstream production/BOM references are protected; unused trial lots and their QC/ledger metadata can be removed together.
  app.post('/inventory/materials/:id/delete', isAuthenticated, guard(SCM), async (req,res) => {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      const r=await client.query('SELECT * FROM materials WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!r.rows.length) throw new Error('Master material tidak ditemukan.');
      const materialId=Number(req.params.id);
      const [bomRows,linkedLines,issued,activeLegacyUse]=await Promise.all([
        client.query('SELECT * FROM erp_product_bom WHERE material_id=$1 FOR UPDATE',[materialId]),
        client.query(`SELECT bm.id,bm.status material_line_status,be.status execution_status,wo.status work_order_status,p.status production_status,p.qa_disposition,
          (SELECT count(*)::int FROM roadmap_batch_records br WHERE br.batch_id=wo.batch_id) record_count
          FROM roadmap_batch_materials bm JOIN roadmap_batch_executions be ON be.id=bm.execution_id
          JOIN roadmap_work_orders wo ON wo.id=be.work_order_id JOIN productions p ON p.id=wo.production_id
          WHERE bm.material_id=$1 FOR UPDATE OF bm,be,wo,p`,[materialId]),
        client.query("SELECT count(*)::int n FROM erp_inventory_movements WHERE material_id=$1 AND movement_type='PRODUCTION_ISSUE'",[materialId]),
        client.query(`SELECT count(*)::int n FROM erp_product_bom b JOIN productions p ON upper(p.item_code)=upper(b.product_code)
          WHERE b.material_id=$1 AND (upper(p.status) IN ('IN_PROGRESS','COMPLETED','RELEASED') OR upper(COALESCE(p.qa_disposition,''))='RELEASED')`,[materialId])
      ]);
      if(Number(issued.rows[0].n)>0 || Number(activeLegacyUse.rows[0].n)>0) throw new Error('Material sudah digunakan pada produksi atau memiliki movement PRODUCTION_ISSUE. Hapus permanen diblokir untuk menjaga ketertelusuran batch.');
      const unsafeLine=linkedLines.rows.find(x=>String(x.material_line_status).toUpperCase()==='ISSUED'||['MATERIALS_ISSUED','EXECUTED'].includes(String(x.execution_status).toUpperCase())||String(x.work_order_status).toUpperCase()==='EXECUTED'||['IN_PROGRESS','COMPLETED','RELEASED'].includes(String(x.production_status).toUpperCase())||String(x.qa_disposition||'').toUpperCase()==='RELEASED'||Number(x.record_count)>0);
      if(unsafeLine) throw new Error('Material sudah terhubung ke batch yang mulai dieksekusi atau memiliki Batch Record. Hapus permanen diblokir; gunakan nonaktifkan sesuai SOP.');
      const lots=await client.query('SELECT id FROM material_batches WHERE material_id=$1 FOR UPDATE',[materialId]);
      const lotIds=lots.rows.map(x=>String(x.id));
      const fileRows=lotIds.length?await client.query("SELECT * FROM roadmap_private_files WHERE owner_type='MATERIAL_BATCH' AND owner_id=ANY($1::text[]) FOR UPDATE",[lotIds]):{rows:[]};
      await audit(client,req,'MATERIAL_MASTER_DELETED','MATERIAL',materialId,'Permanent cleanup of trial material; unused BOM and unissued draft requirements removed',r.rows[0],{deleted:true,reason:str(req.body.reason),deleted_lot_count:lotIds.length,deleted_bom_lines:bomRows.rows.length,deleted_unissued_requirement_lines:linkedLines.rows.length});
      if(linkedLines.rows.length) await client.query('DELETE FROM roadmap_batch_materials WHERE id=ANY($1::bigint[])',[linkedLines.rows.map(x=>Number(x.id))]);
      if(bomRows.rows.length) await client.query('DELETE FROM erp_product_bom WHERE material_id=$1',[materialId]);
      if(lotIds.length){
        await client.query('DELETE FROM roadmap_material_inspections WHERE material_batch_id=ANY($1::bigint[])',[lotIds.map(Number)]);
        await client.query('DELETE FROM erp_inventory_movements WHERE material_batch_id=ANY($1::bigint[])',[lotIds.map(Number)]);
        await client.query("DELETE FROM roadmap_private_files WHERE owner_type='MATERIAL_BATCH' AND owner_id=ANY($1::text[])",[lotIds]);
        await client.query('DELETE FROM material_batches WHERE id=ANY($1::bigint[])',[lotIds.map(Number)]);
      }
      await client.query('DELETE FROM erp_inventory_movements WHERE material_id=$1',[materialId]);
      await client.query('DELETE FROM materials WHERE id=$1',[materialId]);
      await client.query('COMMIT');
      for(const f of fileRows.rows){try{const full=fullPrivatePath(f);if(fs.existsSync(full))fs.unlinkSync(full);}catch(e){console.warn('Trial material file cleanup warning:',e.message);}}
      res.redirect('/inventory?success='+encodeURIComponent(`Material trial dan ${lotIds.length} lot tanpa referensi produksi berhasil dihapus.`));
    } catch(e) { await client.query('ROLLBACK'); res.redirect('/inventory?error='+encodeURIComponent(e.message)); }
    finally { client.release(); }
  });

  // Audited stock movement adjustment from the material -> lot detail popup. Positive quantity is directionless; movement_type determines sign.
  app.post('/inventory/lots/:id/adjust', isAuthenticated, guard(SCM), async (req,res) => {
    const client=await pool.connect();
    try {
      const qty=num(req.body.quantity), reason=str(req.body.reason), pin=str(req.body.pin);
      const movementType=str(req.body.movement_type||'MANUAL_ISSUE').toUpperCase();
      const inbound=movementType==='ADJUSTMENT_IN';
      const movementTypes=['MANUAL_ISSUE','ADJUSTMENT_OUT','DAMAGE','SAMPLE_USE','WRITE_OFF','ADJUSTMENT_IN'];
      if(!(qty>0)||!Number.isFinite(qty)||!reason) throw new Error('Jumlah movement dan alasan wajib diisi dengan benar.');
      if(!movementTypes.includes(movementType)) throw new Error('Movement type tidak valid.');
      if(reason.length<8) throw new Error('Alasan minimal 8 karakter agar koreksi stok dapat diaudit.');
      await client.query('BEGIN');
      const user=await client.query('SELECT id,pin,full_name FROM users WHERE id=$1 AND account_status=$2',[req.session.user.id,'ACTIVE']);
      if(!user.rows.length||!user.rows[0].pin||!verifyCredential(pin,user.rows[0].pin)) throw new Error('PIN salah atau belum disetel.');
      const q=await client.query(`SELECT mb.*,m.current_stock,m.uom,m.name material_name,m.material_code FROM material_batches mb JOIN materials m ON m.id=mb.material_id WHERE mb.id=$1 FOR UPDATE OF mb,m`,[req.params.id]);
      if(!q.rows.length) throw new Error('Lot tidak ditemukan.');
      const lot=q.rows[0];
      if(!['UNRESTRICTED','RELEASED'].includes(lot.status)) throw new Error('Movement manual hanya boleh pada lot yang sudah released/unrestricted.');
      if(lot.expiry_date && String(lot.expiry_date).slice(0,10)<new Date().toISOString().slice(0,10)) throw new Error('Lot sudah kedaluwarsa; jangan melakukan koreksi normal. Gunakan prosedur QA/nonconformance.');
      const remaining=Number(lot.qty_remaining ?? lot.qty), master=Number(lot.current_stock||0);
      if(!inbound && (qty>remaining || qty>master)) throw new Error(`Qty melebihi saldo: lot ${remaining}, material total ${master}.`);
      const delta=inbound?qty:-qty;
      const lotUpdate=await client.query('UPDATE material_batches SET qty_remaining=COALESCE(qty_remaining,qty)+$1 WHERE id=$2 RETURNING qty_remaining',[delta,lot.id]);
      const matUpdate=await client.query('UPDATE materials SET current_stock=current_stock+$1 WHERE id=$2 AND current_stock+$1 >= 0 RETURNING current_stock',[delta,lot.material_id]);
      if(!matUpdate.rows.length) throw new Error('Saldo master material tidak mencukupi atau berubah saat transaksi; koreksi dibatalkan.');
      const movement=await client.query(`INSERT INTO erp_inventory_movements(material_id,material_batch_id,movement_type,quantity,uom,source_type,source_id,reason,actor_user_id,actor_name,metadata) VALUES($1,$2,$3,$4,$5,'MANUAL_ADJUSTMENT',$6,$7,$8,$9,$10::jsonb) RETURNING id`,[lot.material_id,lot.id,movementType,delta,lot.uom||null,`MANUAL-${Date.now()}`,reason,user.rows[0].id,user.rows[0].full_name,JSON.stringify({material_code:lot.material_code,batch_number:lot.batch_number,ui_source:'inventory_lot_detail',direction:inbound?'IN':'OUT'})]);
      await audit(client,req,'INVENTORY_STOCK_MOVEMENT','INVENTORY_MOVEMENT',movement.rows[0].id,reason,{qty_remaining:remaining,current_stock:master},{qty_remaining:lotUpdate.rows[0].qty_remaining,current_stock:matUpdate.rows[0].current_stock,lot_id:lot.id,quantity_delta:delta,movement_type:movementType});
      await client.query('COMMIT');
      res.redirect('/inventory?success='+encodeURIComponent(`Movement ${movementType} untuk lot ${lot.batch_number} tercatat di ledger.`));
    } catch(e) { await client.query('ROLLBACK'); res.redirect('/inventory?error='+encodeURIComponent(e.message)); }
    finally { client.release(); }
  });

  app.post('/inventory/goods-receipt', isAuthenticated, guard(SCM), uploadDoc.fields([{name:'gr_document',maxCount:1},{name:'coa_document',maxCount:1}]), async (req,res) => {
    const client=await pool.connect();
    try {
      const b=req.body;if(!b.material_id||!str(b.batch_number)||!(num(b.quantity)>0)||!str(b.expiry_date))throw new Error('Material, batch number, jumlah diterima, dan expired date wajib diisi.');
      if(!req.files?.coa_document?.[0])throw new Error('CoA wajib diunggah saat Goods Receipt.');
      await client.query('BEGIN');
      const m=await client.query('SELECT id FROM materials WHERE id=$1 AND COALESCE(is_active,true)=true',[b.material_id]);if(!m.rows.length)throw new Error('Material tidak valid.');
      const batch=await client.query(`INSERT INTO material_batches(material_id,batch_number,qty,qty_remaining,expiry_date,status,gr_document,coa_document,analysis_no,storage_location)
        VALUES($1,$2,$3,0,$4,'QUARANTINE',NULL,NULL,$5,$6) RETURNING id`,[b.material_id,str(b.batch_number),num(b.quantity),b.expiry_date,nullable(b.analysis_no),nullable(b.storage_location)]);
      const grFile=req.files?.gr_document?.[0]; const coaFile=req.files?.coa_document?.[0];
      for(const [f,type] of [[grFile,'GOODS_RECEIPT'],[coaFile,'COA']]) if(f){const x=await storePrivateFile(client,f,{ownerType:'MATERIAL_BATCH',ownerId:batch.rows[0].id,documentType:type,userId:req.session.user.id});}
      await audit(client,req,'GOODS_RECEIPT_QUARANTINED','MATERIAL_BATCH',batch.rows[0].id,'Goods Receipt created, inventory remains in quarantine',null,{material_id:Number(b.material_id),batch_number:b.batch_number,qty:num(b.quantity)});
      await client.query(`INSERT INTO notifications(user_id,title,message,type) VALUES(NULL,'QC: Goods Receipt Karantina',$1,'warning')`,[`Lot ${b.batch_number} menunggu inspeksi QC dan release terpisah.`]);
      await client.query('COMMIT');res.redirect('/inventory?success=Goods+Receipt+tercatat+di+Karantina');
    } catch(e) { await client.query('ROLLBACK');res.redirect('/inventory?error='+encodeURIComponent(e.message)); }
    finally {client.release();}
  });
  app.post('/inventory/quarantine/:id/inspect', isAuthenticated, guard([/qc analyst/,/quality control/,/qc staff/,/qa analyst/]), async (req,res) => {
    const client=await pool.connect();
    try {
      const decision=str(req.body.inspection_result).toUpperCase();if(!['PASS','FAIL'].includes(decision))throw new Error('Hasil inspeksi harus PASS atau FAIL.');
      await client.query('BEGIN');
      const r=await client.query(`UPDATE material_batches SET status=$1 WHERE id=$2 AND status='QUARANTINE' RETURNING *`,[decision==='PASS'?'QC_INSPECTED_PASS':'QC_INSPECTED_FAIL',req.params.id]);
      if(!r.rows.length)throw new Error('Lot tidak berada pada status Karantina.');
      await client.query(`INSERT INTO roadmap_material_inspections(material_batch_id,result,notes,inspector_user_id) VALUES($1,$2,$3,$4)`,[req.params.id,decision,nullable(req.body.notes),req.session.user.id]);
      await audit(client,req,'MATERIAL_QC_INSPECTED','MATERIAL_BATCH',req.params.id,str(req.body.notes),{status:'QUARANTINE'},{status:r.rows[0].status,inspector:req.session.user.full_name});
      await client.query('COMMIT');res.redirect('/inventory?success=Hasil+inspeksi+QC+tercatat');
    } catch(e) {await client.query('ROLLBACK');res.redirect('/inventory?error='+encodeURIComponent(e.message));}
    finally {client.release();}
  });
  app.post('/inventory/quarantine/:id/release', isAuthenticated, guard([/qc supervisor/,/qa supervisor/,/quality assurance/,/plant manager/]), async (req,res) => {
    const client=await pool.connect();
    try {
      await client.query('BEGIN');const user=await client.query('SELECT * FROM users WHERE id=$1',[req.session.user.id]);if(!user.rows[0]?.pin||!verifyCredential(str(req.body.pin),user.rows[0].pin))throw new Error('PIN tanda tangan digital salah atau belum disetel.');
      const b=await client.query(`SELECT * FROM material_batches WHERE id=$1 AND status='QC_INSPECTED_PASS' FOR UPDATE`,[req.params.id]);if(!b.rows.length)throw new Error('Hanya lot yang lulus inspeksi QC yang dapat direlease.');
      const inspection=await client.query(`SELECT inspector_user_id,inspected_at FROM roadmap_material_inspections WHERE material_batch_id=$1 AND result='PASS' ORDER BY inspected_at DESC,id DESC LIMIT 1`,[req.params.id]);
      if(!inspection.rows.length)throw new Error('Bukti inspeksi PASS tidak ditemukan; release diblokir.');
      if(Number(inspection.rows[0].inspector_user_id)===Number(req.session.user.id))throw new Error('Pemisahan tugas: pemeriksa QC tidak boleh melakukan release lot yang sama. Gunakan QC/QA Supervisor lain.');
      if(!b.rows[0].coa_document){const f=await client.query(`SELECT 1 FROM roadmap_private_files WHERE owner_type='MATERIAL_BATCH' AND owner_id=$1 AND document_type='COA' LIMIT 1`,[String(req.params.id)]);if(!f.rows.length)throw new Error('CoA lot belum diunggah; release diblokir.');}
      const batch=b.rows[0];
      if(batch.expiry_date&&String(batch.expiry_date).slice(0,10)<new Date().toISOString().slice(0,10))throw new Error('Lot telah kedaluwarsa dan tidak dapat direlease ke available inventory.');
      await client.query(`UPDATE material_batches SET status='UNRESTRICTED',qty_remaining=qty,released_by=$1,released_at=now() WHERE id=$2`,[user.rows[0].full_name,batch.id]);
      await client.query('UPDATE materials SET current_stock=current_stock+$1 WHERE id=$2',[batch.qty,batch.material_id]);
      await client.query(`INSERT INTO erp_inventory_movements(material_id,material_batch_id,movement_type,quantity,uom,source_type,source_id,reason,actor_user_id,actor_name)
        SELECT $1,$2,'QC_RELEASE_RECEIPT',$3,m.uom,'GOODS_RECEIPT',$4,'QC release after inspection', $5,$6 FROM materials m WHERE m.id=$1`,[batch.material_id,batch.id,batch.qty,batch.batch_number,user.rows[0].id,user.rows[0].full_name]);
      await audit(client,req,'MATERIAL_QC_RELEASED','MATERIAL_BATCH',batch.id,str(req.body.notes),{status:'QC_INSPECTED_PASS'},{status:'UNRESTRICTED',qty:batch.qty});
      await client.query('COMMIT');res.redirect('/inventory?success=Lot+dirilis+ke+inventory+available');
    } catch(e) {await client.query('ROLLBACK');res.redirect('/inventory?error='+encodeURIComponent(e.message));}
    finally {client.release();}
  });

  // 6. Customer / Vendor Management, document matrix and QA qualification flow.
  const partnerRoute = (type) => {
    const isCustomer=type==='CUSTOMER'; const base=isCustomer?'/customers':'/vendors'; const table=isCustomer?'customers':'vendors';
    const view='roadmap/partners';
    app.get(base,isAuthenticated,async(req,res)=>{
      try {
        const [p,files,qs]=await Promise.all([
          pool.query(`SELECT p.*,(SELECT count(*)::int FROM roadmap_private_files f WHERE f.owner_type=$1 AND f.owner_id=p.id::text) document_count FROM ${table} p ORDER BY COALESCE(p.is_active,true) DESC,p.name`,[type]),
          pool.query(`SELECT * FROM roadmap_private_files WHERE owner_type=$1 ORDER BY uploaded_at DESC LIMIT 500`,[type]),
          pool.query(`SELECT * FROM roadmap_partner_qualifications WHERE partner_type=$1 AND status='PENDING_QA' ORDER BY requested_at`,[type])
        ]);
        let customerPricing=[], customerTransactions=[], salesProducts=[];
        if(isCustomer){
          [customerPricing,customerTransactions,salesProducts]=await Promise.all([
            pool.query(`SELECT cp.*,c.name customer_name FROM erp_customer_product_pricing cp JOIN customers c ON c.id=cp.customer_id ORDER BY cp.customer_id,cp.product_name`),
            pool.query(`SELECT t.*,c.name customer_name,d.delivered_at FROM erp_sales_transactions t JOIN customers c ON c.id=t.customer_id LEFT JOIN erp_delivery_orders d ON d.id=t.delivery_order_id ORDER BY t.occurred_at DESC,t.id DESC LIMIT 1000`),
            pool.query('SELECT code,name FROM products ORDER BY name')
          ]).then(rows=>[rows[0].rows,rows[1].rows,rows[2].rows]);
        }
        res.render(view,{page:isCustomer?'roadmap-customers':'roadmap-vendors',partners:p.rows,files:files.rows,qualifications:qs.rows,
          customerPricing,customerTransactions,salesProducts,
          checklist:qualificationConfig.qualification_checklist,documentRequirements:qualificationConfig.document_requirements,query:req.query,canEdit:allowedRole(req,isCustomer?SCM.concat([/commercial/]):SCM.concat([/purchasing/])),canQA:allowedRole(req,QCQA),partnerType:type});
      }catch(e){console.error(e);res.status(500).send('Partner Management gagal dimuat.');}
    });
    app.post(`${base}/create`,isAuthenticated,guard(isCustomer?SCM.concat([/commercial/]):SCM.concat([/purchasing/])),async(req,res)=>{
      try{
        let id;
        if(isCustomer){const r=await installCustomerFromForm(pool,req.body);id=r.id;}
        else{
          const b=req.body;if(!str(b.name)||!str(b.vendor_code))throw new Error('Vendor code dan nama vendor wajib diisi.');
          const r=await pool.query(`INSERT INTO vendors(vendor_code,name,category,contact_person,email,phone,address,status,registration_status,qualification_status,vendor_type,tax_id) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE','REGISTERED','REGISTERED',$8,$9) RETURNING id`,[str(b.vendor_code),str(b.name),nullable(b.category),nullable(b.contact_person),nullable(b.email),nullable(b.phone),nullable(b.address),nullable(b.vendor_type),nullable(b.tax_id)]);id=r.rows[0].id;
        }
        await audit(pool,req,`${type}_REGISTERED`,type,id,'Partner registered',null,{name:req.body.name,registration_status:'REGISTERED'});
        res.redirect(base+'?success='+encodeURIComponent(`${isCustomer?'Customer':'Vendor'} terdaftar dengan status Registered`));
      }catch(e){res.redirect(base+'?error='+encodeURIComponent(e.message));}
    });
    if(isCustomer){
      app.post(`${base}/:id/pricing`,isAuthenticated,guard(SCM.concat([/commercial/])),async(req,res)=>{
        try{
          const customerId=Number(req.params.id),productCode=str(req.body.product_code),uom=str(req.body.uom),quantity=num(req.body.quantity),price=num(req.body.price);
          if(!Number.isInteger(customerId)||!productCode||!uom||quantity===null||quantity<=0||price===null||price<0)throw new Error('Enter a product, quantity, UoM, and a valid price.');
          const customer=await pool.query('SELECT id FROM customers WHERE id=$1',[customerId]);if(!customer.rows.length)throw new Error('Customer not found.');
          const product=await pool.query('SELECT code,name FROM products WHERE code=$1',[productCode]);if(!product.rows.length)throw new Error('Product not found in Product Master.');
          const priceRow=await pool.query(`INSERT INTO erp_customer_product_pricing(customer_id,product_code,product_name,pricing_quantity,uom,price,created_by,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())
            ON CONFLICT(customer_id,product_code,uom) DO UPDATE SET product_name=EXCLUDED.product_name,pricing_quantity=EXCLUDED.pricing_quantity,
              price=EXCLUDED.price,updated_at=clock_timestamp() RETURNING *`,[customerId,product.rows[0].code,product.rows[0].name,quantity,uom,price,req.session.user.id]);
          const pr=priceRow.rows[0];
          if(uom.toLowerCase()==='mci'){
            await pool.query(`UPDATE erp_sales_transactions SET pricing_id=$1,unit_price=$2,total_amount=quantity*$2,status='RECOGNIZED',updated_at=clock_timestamp()
              WHERE customer_id=$3 AND lower(product_code)=lower($4) AND lower(uom)='mci' AND status='PENDING_PRICING'`,[pr.id,Number(pr.price)/Number(pr.pricing_quantity),customerId,productCode]);
          }
          await audit(pool,req,'CUSTOMER_PRODUCT_PRICE_UPDATED','CUSTOMER_PRICING',pr.id,'Customer product price list updated',null,{customer_id:customerId,product_code:productCode,uom,quantity,price});
          res.redirect(`${base}?success=${encodeURIComponent('Customer pricing saved.')}`);
        }catch(e){res.redirect(`${base}?error=`+encodeURIComponent(e.message));}
      });
    }

    app.post(`${base}/:id/documents`,isAuthenticated,guard(SCM),uploadDoc.single('document'),async(req,res)=>{
      try{if(!req.file)throw new Error('Dokumen wajib dipilih.');const check=await pool.query(`SELECT id FROM ${table} WHERE id=$1`,[req.params.id]);if(!check.rows.length)throw new Error('Partner tidak ditemukan.');
        const f=await storePrivateFile(pool,req.file,{ownerType:type,ownerId:req.params.id,documentType:str(req.body.document_type)||'SUPPORTING_DOCUMENT',userId:req.session.user.id});
        await audit(pool,req,'PARTNER_DOCUMENT_UPLOADED',type,req.params.id,f.document_type,null,{file_id:f.id,name:f.original_name});res.redirect(base+'?success=Dokumen+partner+berhasil+diunggah');
      }catch(e){res.redirect(base+'?error='+encodeURIComponent(e.message));}
    });
    app.post(`${base}/:id/request-qualification`,isAuthenticated,guard(SCM.concat([/commercial/])),async(req,res)=>{
      try{
        const partner=await pool.query(`SELECT id,qualification_status FROM ${table} WHERE id=$1`,[req.params.id]);if(!partner.rows.length)throw new Error('Partner tidak ditemukan.');
        if(partner.rows[0].qualification_status==='REJECTED')throw new Error('Partner Rejected; perubahan status harus melalui re-registration resmi.');
        const existing=await pool.query(`SELECT id FROM roadmap_partner_qualifications WHERE partner_type=$1 AND partner_id=$2 AND status='PENDING_QA'`,[type,req.params.id]);if(existing.rows.length)throw new Error('Permintaan kualifikasi masih menunggu QA.');
        await pool.query(`INSERT INTO roadmap_partner_qualifications(partner_type,partner_id,status,requested_by) VALUES($1,$2,'PENDING_QA',$3)`,[type,req.params.id,req.session.user.id]);
        await audit(pool,req,'PARTNER_QUALIFICATION_REQUESTED',type,req.params.id,'Requested QA evaluation',null,{status:'PENDING_QA'});res.redirect(base+'?success=Permintaan+evaluasi+QA+dikirim');
      }catch(e){res.redirect(base+'?error='+encodeURIComponent(e.message));}
    });
    app.post(`${base}/:id/qualification/:qualificationId/decision`,isAuthenticated,guard(QCQA),async(req,res)=>{
      try{
        const decision=str(req.body.decision).toUpperCase();if(!['QUALIFIED','REJECTED'].includes(decision))throw new Error('Keputusan harus Qualified atau Rejected.');
        const pending=await pool.query(`SELECT * FROM roadmap_partner_qualifications WHERE id=$1 AND partner_id=$2 AND partner_type=$3 AND status='PENDING_QA'`,[req.params.qualificationId,req.params.id,type]);if(!pending.rows.length)throw new Error('Permintaan QA tidak ditemukan atau sudah ditutup.');
        const answers={};let missing=[];for(let i=0;i<qualificationConfig.qualification_checklist.length;i++){const val=str(req.body[`q_${i}`]).toUpperCase();if(!['YES','NO','NA'].includes(val))missing.push(i+1);answers[String(i)]={answer:val,remark:str(req.body[`remark_${i}`])};}
        if(missing.length)throw new Error(`Checklist QA belum lengkap; ${missing.length} pertanyaan perlu dijawab.`);
        const docs=await pool.query(`SELECT id,document_type,original_name FROM roadmap_private_files WHERE owner_type=$1 AND owner_id=$2`,[type,String(req.params.id)]);
        if(!docs.rows.length && decision==='QUALIFIED')throw new Error('Kualifikasi tidak dapat disetujui tanpa dokumen pendukung partner.');
        const uploadedTypes=new Set(docs.rows.map(d=>String(d.document_type||'').toUpperCase()));
        const documentChecklist={partner_type:type,reviewed_at:new Date().toISOString(),uploaded_types:[...uploadedTypes],items:{}};
        if(type==='VENDOR'){
          const vr=await pool.query('SELECT vendor_type FROM vendors WHERE id=$1',[req.params.id]);
          const vendorType=String(vr.rows[0]?.vendor_type||'').toLowerCase();
          const colIndex=vendorType.includes('raw')?2:vendorType.includes('pack')?3:vendorType.includes('support')?4:5;
          const map=['COMPANY_PROFILE','COMPANY_REGISTRATION','COMPANY_AMENDMENT','BUSINESS_LICENSE','OWNER_ID','OWNER_TAX_ID','TAX_DOCUMENT','SPPKP','QUALITY_CERTIFICATE','COA','PRODUCT_SPECIFICATION','MSDS_TDS','PROCESS_FLOW','SYNTHESIS_ROUTE','CUSTOMER_COMPLAINT_TRENDS','PQR','STABILITY_DATA','RECALL_TRENDS','CCP','STABILITY_DATA','ANNUAL_INTERNAL_AUDIT','REGULATORY_AUDIT_HISTORY','CUSTOMER_LIST'];
          for(let i=2;i<qualificationConfig.document_requirements.length;i++){
            const cells=qualificationConfig.document_requirements[i].cells||[];const sourceReq=String(cells[colIndex]||'').trim();
            const applicable=!!sourceReq && sourceReq!=='-' && !/^n\/a$/i.test(sourceReq);
            const optional=/if needed|bila perlu|jika ada/i.test(sourceReq);const required=applicable&&!optional&&sourceReq.includes('✓');
            const docType=map[i-2]||'OTHER';const uploaded=uploadedTypes.has(docType);
            const review=str(req.body[`doc_${i}`]).toUpperCase();
            if(applicable&&!['AVAILABLE','MISSING','NA'].includes(review))throw new Error(`Review dokumen QA belum dipilih pada baris ${cells[0]||i-1}.`);
            documentChecklist.items[String(i)]={number:cells[0]||String(i-1),name:cells[1]||'',source_requirement:sourceReq,applicable,required,document_type:docType,uploaded,review:review||'NOT_REVIEWED',remark:str(req.body[`doc_remark_${i}`])};
            if(decision==='QUALIFIED'&&required&&(!uploaded||review!=='AVAILABLE'))throw new Error(`Tidak dapat menetapkan vendor QUALIFIED: dokumen wajib ${cells[1]||docType} belum diunggah dengan tipe dokumen yang sesuai dan ditandai Available.`);
            if(decision==='QUALIFIED'&&required&&review==='MISSING')throw new Error(`Dokumen wajib ${cells[1]||docType} ditandai Missing.`);
          }
        }else{
          documentChecklist.items={customer_license:{uploaded:uploadedTypes.has('LICENSE')||uploadedTypes.has('OPERATING_LICENSE')},apj_license:{uploaded:uploadedTypes.has('APJ_STRA_SIPA')},radiopharmaceutical_license:{uploaded:uploadedTypes.has('RADIOPHARMACEUTICAL_LICENSE')}};
        }
        await pool.query(`UPDATE roadmap_partner_qualifications SET status=$1,checklist=$2::jsonb,document_checklist=$3::jsonb,reviewed_by=$4,reviewed_at=now(),decision_note=$5 WHERE id=$6`,[decision,JSON.stringify(answers),JSON.stringify(documentChecklist),req.session.user.id,str(req.body.decision_note),pending.rows[0].id]);
        if(type==='CUSTOMER') await pool.query(`UPDATE customers SET qualification_status=$1,registration_status='REGISTERED' WHERE id=$2`,[decision,req.params.id]);
        else await pool.query(`UPDATE vendors SET qualification_status=$1,registration_status='REGISTERED' WHERE id=$2`,[decision,req.params.id]);
        await audit(pool,req,'PARTNER_QUALIFICATION_DECIDED',type,req.params.id,str(req.body.decision_note),{status:'PENDING_QA'},{status:decision,checklist_count:Object.keys(answers).length});
        res.redirect(base+'?success='+encodeURIComponent(`${isCustomer?'Customer':'Vendor'} status ${decision}`));
      }catch(e){res.redirect(base+'?error='+encodeURIComponent(e.message));}
    });
    app.post(`${base}/:id/archive`,isAuthenticated,guard(isCustomer?SCM.concat([/commercial/]):SCM.concat([/purchasing/])),async(req,res)=>{
      try {
        const old=await pool.query(`SELECT id,name,is_active,qualification_status FROM ${table} WHERE id=$1 FOR UPDATE`,[req.params.id]);
        if(!old.rows.length) throw new Error(`${isCustomer?'Customer':'Vendor'} tidak ditemukan.`);
        const active=old.rows[0].is_active!==false;
        await pool.query(`UPDATE ${table} SET is_active=$1 WHERE id=$2`,[!active,req.params.id]);
        await audit(pool,req,active?'PARTNER_ARCHIVED':'PARTNER_REACTIVATED',type,req.params.id,active?'Archived from master data':'Reactivated from master data',old.rows[0],{is_active:!active});
        res.redirect(base+'?success='+encodeURIComponent(active?'Partner dinonaktifkan; histori tetap tersimpan.':'Partner diaktifkan kembali.'));
      } catch(e) { res.redirect(base+'?error='+encodeURIComponent(e.message)); }
    });
    app.post(`${base}/:id/delete`,isAuthenticated,guard(isCustomer?SCM.concat([/commercial/]):SCM.concat([/purchasing/])),async(req,res)=>{
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const old=await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[req.params.id]);
        if(!old.rows.length) throw new Error(`${isCustomer?'Customer':'Vendor'} tidak ditemukan.`);
        const id=Number(req.params.id);
        if(isCustomer){
          const refs=await client.query('SELECT count(*)::int n FROM roadmap_work_order_customers WHERE customer_id=$1',[id]);
          if(Number(refs.rows[0].n)>0) throw new Error('Customer sudah dipakai pada Work Order. Data tidak dapat dihapus permanen; gunakan arsip.');
        } else {
          const refs=await client.query('SELECT count(*)::int n FROM purchase_requisitions WHERE vendor_id=$1',[id]).catch(()=>({rows:[{n:0}]}));
          if(Number(refs.rows[0].n)>0) throw new Error('Vendor sudah dipakai pada PR. Data tidak dapat dihapus permanen; gunakan arsip.');
        }
        const quals=await client.query('SELECT id FROM roadmap_partner_qualifications WHERE partner_type=$1 AND partner_id=$2 FOR UPDATE',[type,id]);
        const docs=await client.query('SELECT * FROM roadmap_private_files WHERE owner_type=$1 AND owner_id=$2 FOR UPDATE',[type,String(id)]).catch(()=>({rows:[]}));
        await audit(client,req,'PARTNER_DELETED',type,req.params.id,'Permanently deleted trial partner with no operational references',old.rows[0],{deleted:true,reason:str(req.body.reason),qualification_count:quals.rows.length,document_count:docs.rows.length});
        for(const f of docs.rows){try{const full=fullPrivatePath(f);if(fs.existsSync(full))fs.unlinkSync(full);}catch(e){console.warn('Trial partner file cleanup warning:',e.message);}}
        await client.query('DELETE FROM roadmap_private_files WHERE owner_type=$1 AND owner_id=$2',[type,String(id)]);
        await client.query('DELETE FROM roadmap_partner_qualifications WHERE partner_type=$1 AND partner_id=$2',[type,id]);
        await client.query(`DELETE FROM ${table} WHERE id=$1`,[id]); await client.query('COMMIT');
        res.redirect(base+'?success='+encodeURIComponent('Data trial berhasil dihapus permanen.'));
      }catch(e){await client.query('ROLLBACK');res.redirect(base+'?error='+encodeURIComponent(e.message));}finally{client.release();}
    });
  };
  partnerRoute('CUSTOMER'); partnerRoute('VENDOR');

  // 7. Asset catalog and asset change-control requests based on the attached SCM forms.
  app.get('/assets',isAuthenticated,async(req,res)=>{
    try{
      const [assets,requests,files,assetEvents,departmentSummary]=await Promise.all([
        pool.query(`SELECT a.*,f.id photo_doc_id FROM assets a LEFT JOIN roadmap_private_files f ON f.id=a.photo_file_id ORDER BY COALESCE(a.is_active,true) DESC,a.name`),
        pool.query(`SELECT r.*,a.asset_code,a.name asset_name,a.department asset_department FROM roadmap_asset_requests r JOIN assets a ON a.id=r.asset_id ORDER BY r.requested_at DESC LIMIT 200`),
        pool.query(`SELECT * FROM roadmap_private_files WHERE owner_type='ASSET' ORDER BY uploaded_at DESC LIMIT 200`),
        pool.query(`SELECT e.*,u.full_name actor_name FROM roadmap_asset_events e LEFT JOIN users u ON u.id=e.actor_user_id ORDER BY e.occurred_at DESC`),
        pool.query(`SELECT COALESCE(NULLIF(trim(department),''),'Unassigned') department,COUNT(*)::int asset_count FROM assets WHERE COALESCE(is_active,true)=true AND COALESCE(status,'AVAILABLE')<>'DISPOSED' GROUP BY 1 ORDER BY asset_count DESC,department`)
      ]);
      res.render('roadmap/assets',{page:'roadmap-assets',assets:assets.rows,requests:requests.rows,files:files.rows,assetEvents:assetEvents.rows,departmentSummary:departmentSummary.rows,query:req.query,canSCM:allowedRole(req,SCM),canApprove:allowedRole(req,SCM.concat(QCQA))});
    }catch(e){console.error(e);res.status(500).send('Asset Management gagal dimuat.');}
  });
  app.post('/assets/create',isAuthenticated,guard(SCM),uploadAsset.single('asset_photo'),async(req,res)=>{
    try{
      const b=req.body;if(!str(b.asset_code)||!str(b.name)||!str(b.department)||!str(b.acquisition_date)||!str(b.brand)||!str(b.asset_type)||!str(b.purpose))throw new Error('Kode, nama, departemen, acquisition date, brand, tipe, dan purpose aset wajib diisi.');
      if(!req.file)throw new Error('Foto aset wajib diunggah.');
      const r=await pool.query(`INSERT INTO assets(asset_code,name,category,department,acquisition_date,brand,asset_type,purpose,serial_number,current_location,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$4,'AVAILABLE') RETURNING id`,[str(b.asset_code),str(b.name),nullable(b.category),str(b.department),b.acquisition_date,nullable(b.brand),str(b.asset_type),str(b.purpose),nullable(b.serial_number)]);
      if(req.file){const f=await storePrivateFile(pool,req.file,{ownerType:'ASSET',ownerId:r.rows[0].id,documentType:'ASSET_PHOTO',area:'assets',userId:req.session.user.id});await pool.query('UPDATE assets SET photo_file_id=$1 WHERE id=$2',[f.id,r.rows[0].id]);}
      await pool.query(`INSERT INTO roadmap_asset_events(asset_id,event_type,event_data,actor_user_id) VALUES($1,'CREATED',$2::jsonb,$3)`,[r.rows[0].id,JSON.stringify({department:b.department,asset_code:b.asset_code}),req.session.user.id]);
      await audit(pool,req,'ASSET_CREATED','ASSET',r.rows[0].id,'Asset added to catalog',null,{asset_code:b.asset_code,name:b.name});res.redirect('/assets?success=Aset+berhasil+ditambahkan');
    }catch(e){res.redirect('/assets?error='+encodeURIComponent(e.message));}
  });
  app.post('/assets/:id/archive',isAuthenticated,guard(SCM),async(req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query('SELECT id,asset_code,name,status,is_active FROM assets WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!r.rows.length)throw new Error('Aset tidak ditemukan.');
      if(r.rows[0].status==='DISPOSED')throw new Error('Aset disposed tidak perlu diarsipkan; histori disposal harus dipertahankan.');
      if(r.rows[0].status==='ARCHIVED'||r.rows[0].is_active===false)throw new Error('Aset sudah diarsipkan.');
      await client.query("UPDATE assets SET status='ARCHIVED',is_active=false,updated_at=now() WHERE id=$1",[req.params.id]);
      await client.query(`INSERT INTO roadmap_asset_events(asset_id,event_type,event_data,actor_user_id) VALUES($1,'ARCHIVED',$2::jsonb,$3)`,[req.params.id,JSON.stringify({previous_status:r.rows[0].status}),req.session.user.id]);
      await audit(client,req,'ASSET_ARCHIVED','ASSET',req.params.id,'Asset archived from active catalog',r.rows[0],{status:'ARCHIVED',is_active:false});
      await client.query('COMMIT');
      res.redirect('/assets?success='+encodeURIComponent('Aset diarsipkan; histori tetap tersedia.'));
    }catch(e){await client.query('ROLLBACK');res.redirect('/assets?error='+encodeURIComponent(e.message));}
    finally{client.release();}
  });
  app.post('/assets/:id/delete',isAuthenticated,guard(SCM),async(req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!r.rows.length)throw new Error('Aset tidak ditemukan.');
      if(['DISPOSED'].includes(r.rows[0].status))throw new Error('Aset disposed tidak boleh dihapus karena bukti disposal harus dipertahankan.');
      const reqs=await client.query('SELECT count(*)::int n FROM roadmap_asset_requests WHERE asset_id=$1',[req.params.id]);
      const evs=await client.query('SELECT event_type FROM roadmap_asset_events WHERE asset_id=$1',[req.params.id]);
      const files=await client.query("SELECT * FROM roadmap_private_files WHERE owner_type='ASSET' AND owner_id=$1 FOR UPDATE",[String(req.params.id)]);
      const nonPhotoFiles=files.rows.filter(f=>f.document_type!=='ASSET_PHOTO');
      const lifecycleEvents=new Set(['CREATED','ARCHIVED','REACTIVATED']);
      const hasOperationalEvents=evs.rows.some(e=>!lifecycleEvents.has(String(e.event_type||'').toUpperCase()));
      if(Number(reqs.rows[0].n)>0||hasOperationalEvents||nonPhotoFiles.length>0)throw new Error('This asset has transfer/disposal requests, operational history, or additional documents. Keep it archived to preserve its audit trail.');
      await audit(client,req,'ASSET_DELETED','ASSET',req.params.id,'Permanently deleted asset record',r.rows[0],{deleted:true,reason:str(req.body.reason)});
      // Break the photo foreign key before deleting its private-file record.
      const filesToRemove=files.rows.map(f=>({id:f.id,fullPath:fullPrivatePath(f)}));
      await client.query('UPDATE assets SET photo_file_id=NULL WHERE id=$1',[req.params.id]);
      await client.query('DELETE FROM roadmap_asset_events WHERE asset_id=$1',[req.params.id]);
      await client.query('DELETE FROM assets WHERE id=$1',[req.params.id]);
      for(const f of files.rows){await client.query('DELETE FROM roadmap_private_files WHERE id=$1',[f.id]);}
      await client.query('COMMIT');
      // Remove physical files only after the database transaction succeeds.
      for(const f of filesToRemove){try{if(fs.existsSync(f.fullPath))fs.unlinkSync(f.fullPath);}catch(fileErr){console.warn('Asset file cleanup warning:',fileErr.message);}}
      res.redirect('/assets?success='+encodeURIComponent('Asset permanently deleted.'));
    }catch(e){await client.query('ROLLBACK');res.redirect('/assets?error='+encodeURIComponent(e.message));}finally{client.release();}
  });

  app.post('/assets/:id/restore',isAuthenticated,guard(SCM),async(req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query("SELECT id,asset_code,name,status,is_active FROM assets WHERE id=$1 AND status='ARCHIVED' FOR UPDATE",[req.params.id]);
      if(!r.rows.length)throw new Error('Aset tidak ditemukan atau tidak berstatus ARCHIVED.');
      const ev=await client.query(`SELECT event_data->>'previous_status' AS previous_status FROM roadmap_asset_events WHERE asset_id=$1 AND event_type='ARCHIVED' ORDER BY occurred_at DESC,id DESC LIMIT 1`,[req.params.id]);
      const previousStatus=ev.rows[0]?.previous_status;
      const restoredStatus=previousStatus&&previousStatus!=='ARCHIVED'&&previousStatus!=='DISPOSED'?previousStatus:'AVAILABLE';
      await client.query('UPDATE assets SET status=$1,is_active=true,updated_at=now() WHERE id=$2',[restoredStatus,req.params.id]);
      await client.query(`INSERT INTO roadmap_asset_events(asset_id,event_type,event_data,actor_user_id) VALUES($1,'REACTIVATED',$2::jsonb,$3)`,[req.params.id,JSON.stringify({status:restoredStatus,restored_previous_status:previousStatus||null}),req.session.user.id]);
      await audit(client,req,'ASSET_REACTIVATED','ASSET',req.params.id,'Asset restored to active catalog',r.rows[0],{status:restoredStatus,is_active:true});
      await client.query('COMMIT');
      res.redirect('/assets?success='+encodeURIComponent(`Aset diaktifkan kembali dengan status ${restoredStatus}.`));
    }catch(e){await client.query('ROLLBACK');res.redirect('/assets?error='+encodeURIComponent(e.message));}
    finally{client.release();}
  });

  app.post('/assets/:id/request',isAuthenticated,guard(SCM),async(req,res)=>{
    try{
      const type=str(req.body.request_type).toUpperCase();if(!['MUTATION','DISPOSAL'].includes(type))throw new Error('Jenis permohonan tidak valid.');
      const a=await pool.query('SELECT * FROM assets WHERE id=$1',[req.params.id]);if(!a.rows.length)throw new Error('Aset tidak ditemukan.');if(a.rows[0].status==='ARCHIVED'||a.rows[0].status==='DISPOSED'||a.rows[0].is_active===false)throw new Error('Aset nonaktif atau disposed tidak dapat mengajukan mutasi/disposal baru.');
      const b=req.body; const assessment={
        free_from_hazardous_substances:str(b.free_from_b3),surface_dose_measured:str(b.surface_dose_measured),surface_dose_rate:num(b.surface_dose_rate),free_from_contamination:str(b.free_from_contamination),
        free_from_oil_fuel_chemicals:str(b.free_from_oil_fuel_chemicals),free_from_pressurized_gas:str(b.free_from_pressurized_gas),data_storage_destroyed:str(b.data_storage_destroyed),heavy_metals:str(b.heavy_metals),company_identity_removed:str(b.company_identity_removed)
      };
      if(type==='MUTATION' && (!str(b.target_department)||!str(b.handover_to)||!str(b.reason)))throw new Error('Departemen tujuan, penerima/PIC, dan alasan mutasi wajib diisi.');
      if(type==='DISPOSAL' && Object.values(assessment).some(v=>v===''||v===null))throw new Error('Seluruh checklist evaluasi K3LL disposal harus diisi.');
      if(type==='DISPOSAL' && !['NON_B3','B3','RADIOACTIVE'].includes(str(b.waste_classification)))throw new Error('Klasifikasi limbah disposal wajib dipilih.');
      if(type==='DISPOSAL' && !str(b.reason))throw new Error('Alasan disposal wajib diisi.');
      const ins=await pool.query(`INSERT INTO roadmap_asset_requests(asset_id,request_type,requested_by,current_department,target_department,handover_to,purpose,reason,condition_status,k3ll_assessment,waste_classification)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING id`,[a.rows[0].id,type,req.session.user.id,a.rows[0].department,nullable(b.target_department),nullable(b.handover_to),nullable(b.purpose),nullable(b.reason),nullable(b.condition_status),JSON.stringify(assessment),nullable(b.waste_classification)]);
      await pool.query(`INSERT INTO roadmap_asset_events(asset_id,event_type,event_data,actor_user_id) VALUES($1,$2,$3::jsonb,$4)`,[a.rows[0].id,`${type}_REQUESTED`,JSON.stringify({request_id:ins.rows[0].id,reason:b.reason,target_department:b.target_department||null,waste_classification:b.waste_classification||null}),req.session.user.id]);await audit(pool,req,'ASSET_REQUEST_SUBMITTED','ASSET_REQUEST',ins.rows[0].id,`${type} request`,null,{asset_id:a.rows[0].id,request_type:type});res.redirect('/assets?success=Permohonan+aset+dikirim+untuk+persetujuan');
    }catch(e){res.redirect('/assets?error='+encodeURIComponent(e.message));}
  });
  app.post('/assets/requests/:id/decision',isAuthenticated,guard(SCM.concat(QCQA)),async(req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');const r=await client.query('SELECT r.*,a.department asset_department FROM roadmap_asset_requests r JOIN assets a ON a.id=r.asset_id WHERE r.id=$1 AND r.status=$2 FOR UPDATE',[req.params.id,'PENDING_APPROVAL']);if(!r.rows.length)throw new Error('Permohonan aset tidak ditemukan atau sudah diputus.');
      const approve=str(req.body.decision)==='APPROVE';if(!approve&&!str(req.body.approval_note))throw new Error('Alasan penolakan wajib diisi.');
      const next=approve?'APPROVED':'REJECTED';await client.query(`UPDATE roadmap_asset_requests SET status=$1,approval_note=$2,approved_by=$3,approved_at=now() WHERE id=$4`,[next,str(req.body.approval_note),req.session.user.id,r.rows[0].id]);
      if(approve&&r.rows[0].request_type==='MUTATION'){
        await client.query('UPDATE assets SET department=$1,current_location=$1,updated_at=now() WHERE id=$2',[r.rows[0].target_department||r.rows[0].asset_department,r.rows[0].asset_id]);
        await client.query(`INSERT INTO roadmap_asset_events(asset_id,event_type,event_data,actor_user_id) VALUES($1,'MUTATION',$2::jsonb,$3)`,[r.rows[0].asset_id,JSON.stringify({from:r.rows[0].asset_department,to:r.rows[0].target_department,request_id:r.rows[0].id}),req.session.user.id]);
      } else if(approve&&r.rows[0].request_type==='DISPOSAL'){
        await client.query(`UPDATE assets SET status='DISPOSED',updated_at=now() WHERE id=$1`,[r.rows[0].asset_id]);
        await client.query(`INSERT INTO roadmap_asset_events(asset_id,event_type,event_data,actor_user_id) VALUES($1,'DISPOSAL',$2::jsonb,$3)`,[r.rows[0].asset_id,JSON.stringify({request_id:r.rows[0].id,waste_classification:r.rows[0].waste_classification}),req.session.user.id]);
      }
      await client.query(`INSERT INTO roadmap_asset_events(asset_id,event_type,event_data,actor_user_id) VALUES($1,$2,$3::jsonb,$4)`,[r.rows[0].asset_id,approve?'REQUEST_APPROVED':'REQUEST_REJECTED',JSON.stringify({request_id:r.rows[0].id,request_type:r.rows[0].request_type,note:str(req.body.approval_note)}),req.session.user.id]);await audit(client,req,'ASSET_REQUEST_DECIDED','ASSET_REQUEST',r.rows[0].id,str(req.body.approval_note),{status:'PENDING_APPROVAL'},{status:next});await client.query('COMMIT');res.redirect('/assets?success=Permohonan+aset+diproses');
    }catch(e){await client.query('ROLLBACK');res.redirect('/assets?error='+encodeURIComponent(e.message));}finally{client.release();}
  });

  // 8. Material Requisition, based on IMS.SC.006-F-01. Buying itself remains in the external purchasing system.
  app.get('/material-requisition',isAuthenticated,async(req,res)=>{
    try{
      const [mr,materials,users]=await Promise.all([
        pool.query(`SELECT r.*,count(i.id)::int item_count FROM roadmap_material_requisitions r LEFT JOIN roadmap_material_requisition_items i ON i.requisition_id=r.id GROUP BY r.id ORDER BY r.created_at DESC LIMIT 200`),
        pool.query('SELECT id,material_code,name,uom,current_stock,min_stock,storage_location FROM materials WHERE COALESCE(is_active,true)=true ORDER BY name'),
        pool.query('SELECT id,full_name,role FROM users WHERE account_status=\'ACTIVE\' ORDER BY full_name')
      ]);
      res.render('roadmap/material-requisition',{page:'roadmap-material-requisition',requisitions:mr.rows,materials:materials.rows,users:users.rows,query:req.query,canSCM:allowedRole(req,SCM),canSupervisor:allowedRole(req,[/scm supervisor/,/plant manager/])});
    }catch(e){console.error(e);res.status(500).send('Material Requisition gagal dimuat.');}
  });
  app.post('/material-requisition',isAuthenticated,uploadDoc.array('supporting_documents',3),async(req,res)=>{
    const client=await pool.connect();
    try{
      const b=req.body;const names=arr(b.item_name),qtys=arr(b.quantity),uoms=arr(b.uom),specs=arr(b.specification),purposes=arr(b.purpose),codes=arr(b.item_code);
      if(!str(b.department)||!names.length||names.every(v=>!str(v)))throw new Error('Departemen dan minimal satu detail material wajib diisi.');
      await client.query('BEGIN');const requestNo=code('MR');
      const r=await client.query(`INSERT INTO roadmap_material_requisitions(request_no,requester_user_id,requester_name,position,department,request_date,status) VALUES($1,$2,$3,$4,$5,$6,'SUBMITTED') RETURNING id`,[requestNo,req.session.user.id,req.session.user.full_name,nullable(b.position),str(b.department),nullable(b.request_date)||new Date().toISOString().slice(0,10)]);
      for(let i=0;i<names.length;i++){
        if(!str(names[i]))continue;const qty=num(qtys[i]);if(!qty||qty<=0||!str(uoms[i])||!str(purposes[i]))throw new Error(`Detail item baris ${i+1}: jumlah, UoM dan justifikasi wajib diisi.`);
        await client.query(`INSERT INTO roadmap_material_requisition_items(requisition_id,item_code,item_name,specification,quantity,uom,purpose) VALUES($1,$2,$3,$4,$5,$6,$7)`,[r.rows[0].id,nullable(codes[i]),str(names[i]),nullable(specs[i]),qty,str(uoms[i]),str(purposes[i])]);
      }
      for(const file of req.files||[])await storePrivateFile(client,file,{ownerType:'MATERIAL_REQUISITION',ownerId:r.rows[0].id,documentType:'TECHNICAL_SUPPORT',userId:req.session.user.id});
      await audit(client,req,'MATERIAL_REQUISITION_CREATED','MATERIAL_REQUISITION',r.rows[0].id,'Submitted using IMS.SC.006-F-01',null,{request_no:requestNo,department:b.department});await client.query('COMMIT');res.redirect('/material-requisition?success=Material+Requisition+terkirim+ke+SCM');
    }catch(e){await client.query('ROLLBACK');res.redirect('/material-requisition?error='+encodeURIComponent(e.message));}finally{client.release();}
  });
  app.post('/material-requisition/:id/delete',isAuthenticated,async(req,res)=>{
    const client=await pool.connect();let filesToRemove=[];
    try{
      await client.query('BEGIN');
      const r=await client.query('SELECT * FROM roadmap_material_requisitions WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!r.rows.length)throw new Error('Material Requisition tidak ditemukan.');
      const mr=r.rows[0];
      if(!allowedRole(req,SCM.concat([/plant manager/,/department head/,/commercial/])) && Number(req.session.user.id)!==Number(mr.requester_user_id)) throw new Error('Akses hapus trial ditolak. Hanya requester atau SCM/Plant Manager yang dapat menghapus MR yang belum diproses.');
      if(mr.pr_number||['WAITING_EXTERNAL_PURCHASING','APPROVED','CLOSED'].includes(String(mr.status).toUpperCase()))throw new Error('MR sudah memiliki nomor PR atau sudah dilanjutkan ke Purchasing. Penghapusan permanen ditolak agar referensi eksternal tetap dapat ditelusuri.');
      const fsq=await client.query("SELECT * FROM roadmap_private_files WHERE owner_type='MATERIAL_REQUISITION' AND owner_id=$1 FOR UPDATE",[String(req.params.id)]);filesToRemove=fsq.rows;
      await audit(client,req,'MATERIAL_REQUISITION_DELETED','MATERIAL_REQUISITION',req.params.id,'Permanent deletion of unprocessed trial/request record',mr,{deleted:true,reason:str(req.body.reason)});
      await client.query("DELETE FROM roadmap_private_files WHERE owner_type='MATERIAL_REQUISITION' AND owner_id=$1",[String(req.params.id)]);
      await client.query('DELETE FROM roadmap_material_requisitions WHERE id=$1',[req.params.id]);
      await client.query('COMMIT');
      for(const f of filesToRemove){try{const full=fullPrivatePath(f);if(fs.existsSync(full))fs.unlinkSync(full);}catch(e){console.warn('MR file cleanup warning:',e.message);}}
      res.redirect('/material-requisition?success='+encodeURIComponent('Material Requisition trial berhasil dihapus.'));
    }catch(e){await client.query('ROLLBACK');res.redirect('/material-requisition?error='+encodeURIComponent(e.message));}finally{client.release();}
  });

  app.get('/material-requisition/:id',isAuthenticated,async(req,res)=>{
    try{
      const [r,items,files]=await Promise.all([
        pool.query('SELECT * FROM roadmap_material_requisitions WHERE id=$1',[req.params.id]),pool.query('SELECT * FROM roadmap_material_requisition_items WHERE requisition_id=$1 ORDER BY id',[req.params.id]),pool.query(`SELECT * FROM roadmap_private_files WHERE owner_type='MATERIAL_REQUISITION' AND owner_id=$1 ORDER BY uploaded_at`,[String(req.params.id)])
      ]);if(!r.rows.length)return res.status(404).send('Material Requisition tidak ditemukan.');res.render('roadmap/material-requisition-detail',{page:'roadmap-material-requisition',request:r.rows[0],items:items.rows,files:files.rows,query:req.query,canSCM:allowedRole(req,SCM),canSupervisor:allowedRole(req,[/scm supervisor/,/plant manager/])});
    }catch(e){res.status(500).send('Detail Material Requisition gagal dimuat.');}
  });
  app.post('/material-requisition/:id/verify-stock',isAuthenticated,guard(SCM),async(req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');const r=await client.query('SELECT * FROM roadmap_material_requisitions WHERE id=$1 FOR UPDATE',[req.params.id]);if(!r.rows.length)throw new Error('MR tidak ditemukan.');if(['REJECTED','APPROVED','CLOSED'].includes(r.rows[0].status))throw new Error('MR sudah selesai dan tidak dapat diedit.');
      const items=await client.query('SELECT * FROM roadmap_material_requisition_items WHERE requisition_id=$1 ORDER BY id',[req.params.id]);const summary=[];
      for(const item of items.rows){
        const codeEntered=str(req.body[`item_code_${item.id}`])||item.item_code;
        const match=codeEntered?await client.query('SELECT * FROM materials WHERE material_code=$1',[codeEntered]):await client.query('SELECT * FROM materials WHERE lower(name)=lower($1) LIMIT 1',[item.item_name]);
        const m=match.rows[0];const stock=m?Number(m.current_stock)||0:0;const min=m?Number(m.min_stock)||0:0;const available=!!m&&stock>=Number(item.quantity);
        const action=str(req.body[`action_${item.id}`])||(!available?'PROCESS_PR':'PROCESS_PR');if(!['PROCESS_PR','REJECTED'].includes(action))throw new Error('Tindakan SCM tidak valid.');
        await client.query(`UPDATE roadmap_material_requisition_items SET item_code=$1,available=$2,storage_location=$3,current_stock=$4,min_stock=$5,scm_action=$6,scm_note=$7 WHERE id=$8`,[m?m.material_code:nullable(codeEntered),available,m?.storage_location||null,stock,min,action,nullable(req.body[`note_${item.id}`]),item.id]);
        summary.push({item_id:item.id,material_id:m?.id||null,available,current_stock:stock,min_stock:min,action});
      }
      await client.query(`UPDATE roadmap_material_requisitions SET scm_verification=$1::jsonb,status='SCM_VERIFIED',updated_at=now() WHERE id=$2`,[JSON.stringify({lines:summary,verified_by:req.session.user.full_name,verified_at:new Date().toISOString()}),req.params.id]);
      await audit(client,req,'MR_STOCK_VERIFIED','MATERIAL_REQUISITION',req.params.id,'SCM verified stock and action per IMS.SC.006-F-01',null,{lines:summary.length});await client.query('COMMIT');res.redirect(`/material-requisition/${req.params.id}?success=Verifikasi+stok+SCM+tersimpan`);
    }catch(e){await client.query('ROLLBACK');res.redirect(`/material-requisition/${req.params.id}?error=`+encodeURIComponent(e.message));}finally{client.release();}
  });
  app.post('/material-requisition/:id/decision',isAuthenticated,guard([/scm supervisor/,/plant manager/]),async(req,res)=>{
    try{
      const dec=str(req.body.decision).toUpperCase();const pr=nullable(req.body.pr_number);const eta=nullable(req.body.estimated_arrival);if(!['PROCESS_PR','REJECTED'].includes(dec))throw new Error('Keputusan supervisor tidak valid.');
      const r=await pool.query('SELECT * FROM roadmap_material_requisitions WHERE id=$1',[req.params.id]);if(!r.rows.length)throw new Error('MR tidak ditemukan.');if(r.rows[0].status!=='SCM_VERIFIED')throw new Error('SCM Staff harus mengisi Stock Verification terlebih dahulu.');
      if(dec==='PROCESS_PR'&&(!pr||!eta))throw new Error('Nomor PR dan estimasi kedatangan wajib diisi untuk Process PR.');
      await pool.query(`UPDATE roadmap_material_requisitions SET status=$1,pr_number=$2,estimated_arrival=$3,scm_note=$4,updated_at=now() WHERE id=$5`,[dec==='REJECTED'?'REJECTED':'WAITING_EXTERNAL_PURCHASING',pr,eta,nullable(req.body.scm_note),req.params.id]);
      await audit(pool,req,'MR_SCM_DECISION','MATERIAL_REQUISITION',req.params.id,str(req.body.scm_note),{status:r.rows[0].status},{status:dec==='REJECTED'?'REJECTED':'WAITING_EXTERNAL_PURCHASING',pr_number:pr,estimated_arrival:eta});res.redirect(`/material-requisition/${req.params.id}?success=Keputusan+SCM+tersimpan`);
    }catch(e){res.redirect(`/material-requisition/${req.params.id}?error=`+encodeURIComponent(e.message));}
  });
  app.post('/material-requisition/:id/plant-approval',isAuthenticated,guard([/plant manager/]),async(req,res)=>{
    try{const r=await pool.query(`UPDATE roadmap_material_requisitions SET status='APPROVED',plant_manager_user_id=$1,approved_at=now(),updated_at=now() WHERE id=$2 AND status='WAITING_EXTERNAL_PURCHASING' RETURNING *`,[req.session.user.id,req.params.id]);if(!r.rows.length)throw new Error('MR harus sudah diverifikasi SCM dan nomor PR disimpan sebelum approval Plant Manager.');await audit(pool,req,'MR_PLANT_MANAGER_APPROVED','MATERIAL_REQUISITION',req.params.id,str(req.body.note),{status:'WAITING_EXTERNAL_PURCHASING'},{status:'APPROVED'});res.redirect(`/material-requisition/${req.params.id}?success=MR+disetujui+Plant+Manager`);}catch(e){res.redirect(`/material-requisition/${req.params.id}?error=`+encodeURIComponent(e.message));}
  });

  // 9. Security Control consolidates user, role-permission and audit-trail administration.
  app.get('/security-control',isAuthenticated,guard(ADMIN),async(req,res)=>{
    try{
      const [users,roles,permissions,events]=await Promise.all([
        pool.query(`SELECT id,full_name,email,role,department,account_status,created_at,digital_signature_file_id FROM users ORDER BY full_name`),
        pool.query(`SELECT r.*,count(DISTINCT u.id)::int assigned_users FROM erp_roles r LEFT JOIN users u ON u.role=r.role_name GROUP BY r.id ORDER BY r.is_system DESC,r.role_name`),
        pool.query(`SELECT rp.* FROM erp_role_permissions rp`),
        pool.query(`SELECT * FROM erp_audit_events ORDER BY occurred_at DESC LIMIT 250`)
      ]);
      res.render('roadmap/security-control',{page:'security-control',users:users.rows,roles:roles.rows,permissions:permissions.rows,modules:SECURITY_MODULES,events:events.rows,query:req.query});
    }catch(e){console.error(e);res.status(500).send('Security Control gagal dimuat. Pastikan skema Security Control telah terpasang.');}
  });
  app.post('/security-control/roles/create',isAuthenticated,guard(ADMIN),async(req,res)=>{
    try{
      const name=str(req.body.role_name),description=str(req.body.description);
      if(name.length<3||name.length>120)throw new Error('Nama role harus terdiri dari 3–120 karakter.');
      if(!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(name))throw new Error('Nama role hanya boleh berisi huruf, angka, spasi, titik, strip dan underscore.');
      const exists=await pool.query('SELECT 1 FROM erp_roles WHERE lower(role_name)=lower($1)',[name]);if(exists.rows.length)throw new Error('Role dengan nama tersebut sudah tersedia.');
      const roleCode=name.toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,120)+'_'+crypto.randomBytes(2).toString('hex').toUpperCase();
      const r=await pool.query('INSERT INTO erp_roles(role_name,role_code,description,is_system,created_by) VALUES($1,$2,$3,false,$4) RETURNING id',[name,roleCode,nullable(description),req.session.user.id]);
      for(const [moduleCode] of SECURITY_MODULES){const canView=moduleCode==='LIVE_TRACKING';await pool.query('INSERT INTO erp_role_permissions(role_id,module_code,can_view) VALUES($1,$2,$3) ON CONFLICT(role_id,module_code) DO NOTHING',[r.rows[0].id,moduleCode,canView]);}
      await audit(pool,req,'SECURITY_ROLE_CREATED','ERP_ROLE',r.rows[0].id,'Custom role created with no permissions by default',null,{role_name:name,role_code:roleCode});
      res.redirect('/security-control?tab=roles&success='+encodeURIComponent(`Role ${name} dibuat. Berikan izin modul sebelum akun ditetapkan.`));
    }catch(e){res.redirect('/security-control?tab=roles&error='+encodeURIComponent(e.message));}
  });
  app.post('/security-control/roles/:id/permissions',isAuthenticated,guard(ADMIN),async(req,res)=>{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');const r=await client.query('SELECT * FROM erp_roles WHERE id=$1 FOR UPDATE',[req.params.id]);if(!r.rows.length)throw new Error('Role tidak ditemukan.');if(r.rows[0].is_system)throw new Error('Role bawaan tidak dapat diedit dari editor custom; gunakan role custom baru untuk variasi akses.');
      for(const [moduleCode] of SECURITY_MODULES){
        const view=bool(req.body[`perm_${moduleCode}_view`]);
        const create=bool(req.body[`perm_${moduleCode}_create`]);
        const edit=bool(req.body[`perm_${moduleCode}_edit`]);
        const del=bool(req.body[`perm_${moduleCode}_delete`]);
        const approve=bool(req.body[`perm_${moduleCode}_approve`]);
        const canView=moduleCode==='LIVE_TRACKING'?true:(view||create||edit||del||approve);
        await client.query(`INSERT INTO erp_role_permissions(role_id,module_code,can_view,can_create,can_edit,can_delete,can_approve,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(role_id,module_code) DO UPDATE SET can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_delete=EXCLUDED.can_delete,can_approve=EXCLUDED.can_approve,updated_by=EXCLUDED.updated_by,updated_at=now()`,[r.rows[0].id,moduleCode,canView,create,edit,del,approve,req.session.user.id]);
      }
      await audit(client,req,'SECURITY_ROLE_PERMISSIONS_UPDATED','ERP_ROLE',req.params.id,'Custom role permission matrix saved',null,{role_name:r.rows[0].role_name,modules:SECURITY_MODULES.length});await client.query('COMMIT');
      res.redirect('/security-control?tab=roles&success='+encodeURIComponent(`Permission role ${r.rows[0].role_name} diperbarui.`));
    }catch(e){await client.query('ROLLBACK');res.redirect('/security-control?tab=roles&error='+encodeURIComponent(e.message));}finally{client.release();}
  });
  app.post('/security-control/roles/:id/delete',isAuthenticated,guard(ADMIN),async(req,res)=>{
    try{const r=await pool.query('SELECT * FROM erp_roles WHERE id=$1',[req.params.id]);if(!r.rows.length)throw new Error('Role tidak ditemukan.');if(r.rows[0].is_system)throw new Error('Role bawaan sistem tidak boleh dihapus.');const assigned=await pool.query('SELECT count(*)::int n FROM users WHERE role=$1',[r.rows[0].role_name]);if(Number(assigned.rows[0].n)>0)throw new Error('Role masih digunakan akun. Pindahkan akun ke role lain sebelum menghapus.');await audit(pool,req,'SECURITY_ROLE_DELETED','ERP_ROLE',req.params.id,'Custom role deleted',r.rows[0],{deleted:true,reason:str(req.body.reason)});await pool.query('DELETE FROM erp_roles WHERE id=$1',[req.params.id]);res.redirect('/security-control?tab=roles&success=Role+custom+dihapus.');}catch(e){res.redirect('/security-control?tab=roles&error='+encodeURIComponent(e.message));}
  });
  app.post('/security-control/users/:id/role',isAuthenticated,guard(ADMIN),async(req,res)=>{
    try{if(Number(req.params.id)===Number(req.session.user.id))throw new Error('Role akun yang sedang digunakan tidak dapat diubah dari sesi yang sama.');const role=str(req.body.role);const valid=await pool.query('SELECT role_name FROM erp_roles WHERE role_name=$1',[role]);if(!valid.rows.length)throw new Error('Pilih role yang tersedia di Security Control.');const old=await pool.query('SELECT role FROM users WHERE id=$1',[req.params.id]);if(!old.rows.length)throw new Error('User tidak ditemukan.');await pool.query('UPDATE users SET role=$1 WHERE id=$2',[role,req.params.id]);await audit(pool,req,'USER_ROLE_CHANGED','USER',req.params.id,'Role assigned from Security Control',{role:old.rows[0].role},{role});res.redirect('/security-control?tab=users&success=Role+user+diperbarui.');}catch(e){res.redirect('/security-control?tab=users&error='+encodeURIComponent(e.message));}
  });
  app.post('/security-control/users/:id/status',isAuthenticated,guard(ADMIN),async(req,res)=>{
    try{if(Number(req.params.id)===Number(req.session.user.id))throw new Error('Akun aktif tidak dapat menonaktifkan dirinya sendiri.');const status=str(req.body.account_status).toUpperCase();if(!['ACTIVE','INACTIVE'].includes(status))throw new Error('Status akun tidak valid.');const old=await pool.query('SELECT account_status FROM users WHERE id=$1',[req.params.id]);if(!old.rows.length)throw new Error('User tidak ditemukan.');await pool.query('UPDATE users SET account_status=$1 WHERE id=$2',[status,req.params.id]);await audit(pool,req,'USER_ACCOUNT_STATUS_CHANGED','USER',req.params.id,'Account status changed in Security Control',{status:old.rows[0].account_status},{status});res.redirect('/security-control?tab=users&success=Status+akun+diperbarui.');}catch(e){res.redirect('/security-control?tab=users&error='+encodeURIComponent(e.message));}
  });
  app.get('/user-management',isAuthenticated,guard(ADMIN),(req,res)=>res.redirect('/security-control?tab=users'));
  app.post('/user-management/:id/role',isAuthenticated,guard(ADMIN),(req,res)=>res.redirect('/security-control?tab=users'));
  app.post('/user-management/:id/status',isAuthenticated,guard(ADMIN),(req,res)=>res.redirect('/security-control?tab=users'));

}

module.exports = { installRoadmapSchema, registerRoadmapRoutes, recordConfig, qualificationConfig };
