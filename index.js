require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const port = Number(process.env.PORT || 3000);
const integratedERP = require('./modules/erp-integrated');
const roadmapERP = require('./modules/roadmap-erp');

// ==========================================
// 1. DATABASE CONNECTION (ENTERPRISE CONFIG)
// ==========================================
const pool = new Pool(process.env.DATABASE_URL ? {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
} : {
    user: process.env.PGUSER || 'postgres',
    host: process.env.PGHOST || 'localhost',
    database: process.env.PGDATABASE || 'nuclea_erp',
    password: process.env.PGPASSWORD || '', // Required in .env; do not ship a hard-coded database password
    port: Number(process.env.PGPORT || 5432),
    connectionTimeoutMillis: 7000,
    idleTimeoutMillis: 30000,
    max: 10
});
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
    throw new Error('SESSION_SECRET wajib diset dengan minimal 32 karakter saat NODE_ENV=production.');
}
const sessionSecret = process.env.SESSION_SECRET || 'development-only-change-this-session-secret-before-deployment';

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(password), salt, 64);
    return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function verifyPassword(password, stored) {
    if (typeof stored !== 'string') return false;
    if (stored.startsWith('scrypt$')) {
        const parts = stored.split('$');
        if (parts.length !== 3) return false;
        try {
            const salt = Buffer.from(parts[1], 'hex');
            const expected = Buffer.from(parts[2], 'hex');
            const actual = crypto.scryptSync(String(password), salt, expected.length);
            return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
        } catch (_) { return false; }
    }
    // Backward compatibility: the first successful login upgrades an existing plaintext legacy password.
    return stored === String(password);
}

// ==========================================
// 2. MIDDLEWARE & SYSTEM CONFIGURATION
// ==========================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

// Tingkatkan batas payload untuk base64 image (Cropper.js) dan dokumen
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'))); 

// Manajemen Sesi (Session) yang aman
app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' } // HTTPS-only in production
}));

// Setup Multer untuk Upload Profil dan Dokumen
const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'public/uploads/profiles');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, 'user_' + req.session.user.id + '_' + Date.now() + path.extname(file.originalname));
    }
});
const uploadProfile = multer({ storage: profileStorage });

const scmStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'public/uploads/scm');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, 'SCM_' + Date.now() + '_' + file.originalname.replace(/\s+/g, '_'));
    }
});
const uploadSCM = multer({ storage: scmStorage });

// Custom-role ACL for Security Control. Built-in roles continue to use existing route guards.
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
function requiredRolePermission(req) {
    if (['GET','HEAD','OPTIONS'].includes(String(req.method).toUpperCase())) return 'can_view';
    const p = String(req.path || '').toLowerCase();
    if (/delete|archive|restore|remove/.test(p)) return 'can_delete';
    if (/decision|release|review|approve|verify|dispatch|issue-materials|plant-approval/.test(p)) return 'can_approve';
    if (/create|goods-receipt|add|request-qualification/.test(p)) return 'can_create';
    return 'can_edit';
}

// Global Security & Notification Middleware
const isAuthenticated = async (req, res, next) => {
    if (!req.session.user) return res.redirect('/auth/login');
    
    try {
        const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
        if(userRes.rows.length === 0) {
            req.session.destroy();
            return res.redirect('/auth/login');
        }
        
        if (String(userRes.rows[0].account_status || 'ACTIVE').toUpperCase() !== 'ACTIVE') {
            req.session.destroy(() => {});
            return res.redirect('/auth/login?error=Akun+dinonaktifkan.+Hubungi+administrator.');
        }
        req.session.user = userRes.rows[0];
        // Load custom role permissions each request to reflect admin changes immediately.
        const roleResult = await pool.query('SELECT id,is_system FROM erp_roles WHERE role_name=$1 LIMIT 1',[String(req.session.user.role || '')]).catch(()=>({rows:[]}));
        req.session.user._erpCustomRole = !!(roleResult.rows[0] && roleResult.rows[0].is_system === false);
        req.session.user._erpRolePermissions = {};
        if (roleResult.rows[0] && req.session.user._erpCustomRole) {
            const permResult = await pool.query('SELECT module_code,can_view,can_create,can_edit,can_delete,can_approve FROM erp_role_permissions WHERE role_id=$1',[roleResult.rows[0].id]);
            for (const perm of permResult.rows) req.session.user._erpRolePermissions[perm.module_code] = perm;
        }
        const customModule = req.session.user._erpCustomRole ? moduleCodeForPath(req.path) : null;
        if (customModule) {
            const perms = req.session.user._erpRolePermissions[customModule] || {};
            const required = requiredRolePermission(req);
            if (perms[required] !== true) {
                if (req.path.startsWith('/api/')) return res.status(403).json({ok:false,error:'Role Anda tidak memiliki izin untuk modul atau tindakan ini.'});
                return res.status(403).send('Akses ditolak: permission role custom belum mengizinkan tindakan ini. Hubungi administrator melalui Security Control.');
            }
        }
        res.locals.user = req.session.user;

        // Tarik notifikasi untuk user (Push Notification Engine)
        if (req.session.user.push_notif) {
            const notifRes = await pool.query('SELECT * FROM notifications WHERE is_read = false AND (user_id = $1 OR user_id IS NULL) ORDER BY created_at DESC LIMIT 5', [req.session.user.id]);
            res.locals.notifications = notifRes.rows;
            res.locals.unreadCount = notifRes.rows.length;
        } else {
            res.locals.notifications = [];
            res.locals.unreadCount = 0;
        }
        
        next();
    } catch (err) {
        console.error("Auth Middleware Error:", err);
        res.redirect('/auth/login');
    }
};

// ==========================================
// 3. INTERNAL ALERT ENGINE (SYSTEM SIMULATOR)
// ==========================================
const sendSystemAlert = async (userId, title, message, type = 'info') => {
    try {
        const uRes = await pool.query('SELECT email, email_notif, push_notif FROM users WHERE id = $1', [userId]);
        if (uRes.rows.length > 0) {
            const prefs = uRes.rows[0];
            
            // Simpan ke DB untuk notif lonceng
            if (prefs.push_notif) {
                await pool.query('INSERT INTO notifications (user_id, title, message, type) VALUES ($1, $2, $3, $4)', [userId, title, message, type]);
            }
            
            // Log ke Terminal sebagai simulasi pengiriman Email/SMTP
            if (prefs.email_notif) {
                console.log(`\n=================================================`);
                console.log(`✉️  [SMTP SERVER SIMULATOR] MENGIRIM EMAIL KE: ${prefs.email}`);
                console.log(`   [SUBJECT] ${title}`);
                console.log(`   [MESSAGE] ${message}`);
                console.log(`=================================================\n`);
            }
        }
    } catch (error) { console.error("Notification Engine Error:", error); }
};

// Register integrated NUCLEA workflows: e-BMR/e-BPR, BOM issue, QC, signatures, labels, e-DO, GPS and audit.
integratedERP.registerIntegratedRoutes(app, pool, isAuthenticated, verifyPassword);
roadmapERP.registerRoadmapRoutes(app, pool, isAuthenticated, verifyPassword);

// ==========================================
// 4. AUTHENTICATION & SECURITY ROUTES
// ==========================================

app.get('/auth/login', (req, res) => { 
    res.render('login', { error: req.query.error, query: req.query }); 
});

app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    if (ip === '::1') ip = '127.0.0.1 (Localhost)';
    const browser = req.headers['user-agent'] || 'Unknown Device';

    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];

        // Verifikasi Kredensial
        if (user && String(user.account_status || 'ACTIVE').toUpperCase() === 'ACTIVE' && verifyPassword(password, user.password)) {
            if (!String(user.password || '').startsWith('scrypt$')) {
                const upgradedHash = hashPassword(password);
                await pool.query('UPDATE users SET password = $1 WHERE id = $2', [upgradedHash, user.id]);
                user.password = upgradedHash;
            }
            // Cek 2FA
            if (user.is_2fa_enabled) {
                const otp = Math.floor(100000 + Math.random() * 900000).toString();
                req.session.pending_2fa_user = user;
                req.session.login_otp = otp;
                
                console.log(`\n🔒 [2FA AUTHENTICATOR SIMULATOR]`);
                console.log(`   Kode OTP Login untuk ${user.email} adalah: [ ${otp} ]\n`);
                
                return res.redirect('/auth/verify-2fa');
            }

            // Catat Audit Trail
            await pool.query('INSERT INTO login_trails (user_id, device_ip, browser_info, status) VALUES ($1, $2, $3, $4)', [user.id, ip, browser, 'SUCCESS']);
            req.session.user = user;
            res.redirect('/');
        } else {
            if(user) await pool.query('INSERT INTO login_trails (user_id, device_ip, browser_info, status) VALUES ($1, $2, $3, $4)', [user.id, ip, browser, 'FAILED']);
            res.redirect('/auth/login?error=Kredensial tidak valid atau akun tidak ditemukan.');
        }
    } catch (err) { 
        res.status(500).send("Auth Error: " + err.message); 
    }
});

// Form Verifikasi 2FA Sementara
app.get('/auth/verify-2fa', (req, res) => {
    if (!req.session.pending_2fa_user) return res.redirect('/auth/login');
    res.send(`
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; margin-top: 15vh; background-color:#111827; color: white; height: 100vh; padding-top: 50px;">
            <h2 style="color: #60a5fa;">🔒 Authenticator Security Gate</h2>
            <p style="color: #9ca3af;">Masukkan 6-digit OTP dari Authenticator App Anda.<br><small style="color:#f59e0b;">(Cek Terminal / Console VS Code Anda untuk melihat kodenya!)</small></p>
            <form method="POST" action="/auth/verify-2fa">
                <input type="text" name="otp" maxlength="6" style="padding: 15px; font-size: 24px; letter-spacing: 10px; text-align: center; width: 250px; border-radius: 8px; border: 2px solid #374151; background: #1f2937; color: white;" autofocus autocomplete="off">
                <br><br><button type="submit" style="padding: 12px 30px; font-size: 16px; font-weight: bold; background: #2563eb; color: white; border: none; border-radius: 8px; cursor: pointer;">VERIFIKASI AKSES</button>
            </form>
        </div>
    `);
});

app.post('/auth/verify-2fa', async (req, res) => {
    const { otp } = req.body;
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    if (ip === '::1') ip = '127.0.0.1 (Localhost)';
    const browser = req.headers['user-agent'];

    if (otp === req.session.login_otp) {
        const user = req.session.pending_2fa_user;
        await pool.query('INSERT INTO login_trails (user_id, device_ip, browser_info, status) VALUES ($1, $2, $3, $4)', [user.id, ip, browser, 'SUCCESS (2FA)']);
        req.session.user = user;
        delete req.session.pending_2fa_user;
        delete req.session.login_otp;
        res.redirect('/');
    } else {
        await pool.query('INSERT INTO login_trails (user_id, device_ip, browser_info, status) VALUES ($1, $2, $3, $4)', [req.session.pending_2fa_user.id, ip, browser, 'FAILED (2FA)']);
        res.send(`<div style="text-align:center; margin-top:20vh; font-family:sans-serif;"><h2>❌ Autentikasi Gagal! Kode Salah.</h2><a href="/auth/login" style="padding: 10px 20px; background:#dc3545; color:white; text-decoration:none; border-radius:5px;">Kembali ke Login</a></div>`);
    }
});

app.get('/auth/signup', (req, res) => { res.render('signup', { error: null, query: req.query }); });

app.post('/auth/signup', async (req, res) => {
    const { first_name, last_name, email, password, role } = req.body;
    const full_name = last_name ? `${first_name} ${last_name}` : first_name;
    try {
        await pool.query("INSERT INTO users (full_name, email, password, role) VALUES ($1, $2, $3, 'Pending User')", [full_name, email, hashPassword(password)]);
        res.redirect('/auth/login?status=success');
    } catch (err) { 
        res.render('signup', { error: "Registrasi gagal. Email mungkin sudah terdaftar.", query: req.query }); 
    }
});

app.get('/auth/logout', (req, res) => { 
    req.session.destroy(); 
    res.redirect('/auth/login'); 
});

// ==========================================
// 5. PROFILE & PREFERENCES ROUTES
// ==========================================

app.get('/profile', isAuthenticated, async (req, res) => {
    const tab = req.query.tab || 'profile';
    let trails = [];
    try {
        if (tab === 'security') {
            const trailRes = await pool.query('SELECT * FROM login_trails WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [req.session.user.id]);
            trails = trailRes.rows;
        }
        res.render('profile', { tab, page: 'profile', success: req.query.success, error: req.query.error, trails });
    } catch(err) { res.status(500).send(err.message); }
});

app.post('/profile/update-info', isAuthenticated, async (req, res) => {
    const { full_name, department, phone, emergency_contact } = req.body;
    try {
        // Users cannot grant themselves a privileged role through profile editing.
        await pool.query(
            'UPDATE users SET full_name = $1, department = $2, phone = $3, emergency_contact = $4 WHERE id = $5',
            [full_name, department, phone, emergency_contact, req.session.user.id]
        );
        sendSystemAlert(req.session.user.id, "Profil Diperbarui", "Data identitas profesional Anda telah disinkronisasi dengan HR Database.");
        res.redirect('/profile?tab=profile&success=Profil+Berhasil+Diperbarui');
    } catch(err) { res.redirect('/profile?tab=profile&error=' + encodeURIComponent(err.message)); }
});

app.post('/profile/update-preferences', isAuthenticated, async (req, res) => {
    const { language, timezone, email_notif, push_notif } = req.body;
    try {
        await pool.query(
            'UPDATE users SET language = $1, timezone = $2, email_notif = $3, push_notif = $4 WHERE id = $5',
            [language, timezone, (email_notif === 'on'), (push_notif === 'on'), req.session.user.id]
        );
        res.redirect('/profile?tab=account&success=Preferensi+Sistem+Disimpan');
    } catch(err) { res.redirect('/profile?tab=account&error=' + encodeURIComponent(err.message)); }
});

app.post('/profile/set-pin', isAuthenticated, async (req, res) => {
    const { pin } = req.body;
    try {
        if (!/^\d{4,10}$/.test(String(pin || ''))) throw new Error('PIN harus 4–10 digit angka.');
        await pool.query('UPDATE users SET pin = $1 WHERE id = $2', [hashPassword(pin), req.session.user.id]);
        res.redirect('/profile?tab=security&success=PIN+Tanda+Tangan+Elektronik+Disimpan');
    } catch(err) { res.redirect('/profile?tab=security&error=' + encodeURIComponent(err.message)); }
});

app.post('/profile/toggle-2fa', isAuthenticated, async (req, res) => {
    try {
        const userRes = await pool.query('SELECT is_2fa_enabled FROM users WHERE id = $1', [req.session.user.id]);
        const currentStatus = userRes.rows[0].is_2fa_enabled;
        await pool.query('UPDATE users SET is_2fa_enabled = $1 WHERE id = $2', [!currentStatus, req.session.user.id]);
        res.redirect(`/profile?tab=security&success=Autentikasi+2-Faktor+telah+${!currentStatus ? 'Diaktifkan' : 'Dinonaktifkan'}`);
    } catch(err) { res.redirect('/profile?tab=security&error=' + encodeURIComponent(err.message)); }
});

app.post('/profile/upload-photo', isAuthenticated, async (req, res) => {
    const { cropped_image } = req.body;
    if (!cropped_image) return res.redirect('/profile?tab=profile&error=Gambar+Tidak+Valid');
    
    try {
        const base64Data = cropped_image.replace(/^data:image\/\w+;base64,/, "");
        const filename = 'user_' + req.session.user.id + '_' + Date.now() + '.jpg';
        const dirPath = path.join(__dirname, 'public/uploads/profiles');
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        
        fs.writeFileSync(path.join(dirPath, filename), base64Data, 'base64');
        await pool.query('UPDATE users SET profile_photo = $1 WHERE id = $2', ['/uploads/profiles/' + filename, req.session.user.id]);
        res.redirect('/profile?tab=profile&success=Foto+Profil+Diperbarui');
    } catch (err) { res.redirect('/profile?tab=profile&error=' + encodeURIComponent(err.message)); }
});

// ==========================================
// 6. DASHBOARD & GLOBAL SEARCH
// ==========================================

app.get('/', isAuthenticated, async (req, res) => {
    const currentYear = new Date().getFullYear();
    try {
        const [productionOutput, annualRevenue, annualExpenses, customerCount, lowStock, batchTrendMonth, batchTrendYear, revenueGrowth, activeUsers, oldestRequests] = await Promise.all([
            pool.query('SELECT COUNT(*)::int AS n FROM productions'),
            pool.query("SELECT COALESCE(SUM(total_amount),0)::numeric AS amount FROM erp_sales_transactions WHERE status='RECOGNIZED' AND EXTRACT(YEAR FROM occurred_at)=$1", [currentYear]),
            pool.query("SELECT COALESCE(SUM(total_price),0)::numeric AS amount FROM purchase_requisitions WHERE EXTRACT(YEAR FROM COALESCE(request_date,created_at::date))=$1 AND upper(COALESCE(status,'')) NOT IN ('REJECTED','CANCELLED')", [currentYear]),
            pool.query("SELECT COUNT(*)::int AS n FROM customers WHERE COALESCE(is_active,true)=true AND COALESCE(registration_status,'REGISTERED') <> 'DELETED'"),
            pool.query("SELECT id,material_code,name,current_stock,min_stock,uom,storage_location FROM materials WHERE COALESCE(is_active,true)=true AND COALESCE(current_stock,0)<=COALESCE(min_stock,0) ORDER BY (COALESCE(current_stock,0)-COALESCE(min_stock,0)) ASC,name LIMIT 5"),
            pool.query(`SELECT to_char(d.day,'YYYY-MM-DD') AS label,COUNT(p.id)::int AS value
                FROM generate_series(CURRENT_DATE-INTERVAL '29 days',CURRENT_DATE,INTERVAL '1 day') AS d(day)
                LEFT JOIN productions p ON p.production_date=d.day::date
                GROUP BY d.day ORDER BY d.day`),
            pool.query(`SELECT to_char(m.month,'YYYY-MM') AS label,COUNT(p.id)::int AS value
                FROM generate_series(date_trunc('month',CURRENT_DATE)-INTERVAL '11 months',date_trunc('month',CURRENT_DATE),INTERVAL '1 month') AS m(month)
                LEFT JOIN productions p ON date_trunc('month',p.production_date::timestamp)=m.month
                GROUP BY m.month ORDER BY m.month`),
            pool.query(`SELECT y.year::int AS year,COALESCE(SUM(t.total_amount),0)::numeric AS revenue
                FROM generate_series($1::int-4,$1::int) AS y(year)
                LEFT JOIN erp_sales_transactions t ON t.status='RECOGNIZED' AND EXTRACT(YEAR FROM t.occurred_at)=y.year
                GROUP BY y.year ORDER BY y.year`, [currentYear]),
            pool.query(`SELECT u.full_name,u.role,COALESCE(a.active_seconds,0)::bigint AS active_seconds
                FROM users u LEFT JOIN erp_user_activity a ON a.user_id=u.id
                WHERE upper(COALESCE(u.account_status,'ACTIVE'))='ACTIVE'
                ORDER BY COALESCE(a.active_seconds,0) DESC,u.full_name ASC LIMIT 5`),
            pool.query(`SELECT i.item_name,r.requester_name,r.department,r.created_at,r.status
                FROM roadmap_material_requisitions r JOIN roadmap_material_requisition_items i ON i.requisition_id=r.id
                ORDER BY r.created_at ASC,i.id ASC LIMIT 5`)
        ]);
        const activeUsersRows = activeUsers.rows.map(u => ({
            ...u,
            active_minutes: Math.floor(Number(u.active_seconds || 0) / 60),
            active_hours: Math.floor(Number(u.active_seconds || 0) / 3600)
        }));
        res.render('dashboard', {
            page: 'dashboard', query: req.query, dashboardYear: currentYear,
            productionOutput: Number(productionOutput.rows[0]?.n || 0),
            annualRevenue: Number(annualRevenue.rows[0]?.amount || 0),
            annualExpenses: Number(annualExpenses.rows[0]?.amount || 0),
            totalCustomers: Number(customerCount.rows[0]?.n || 0),
            inventory: lowStock.rows, batchTrendMonth: batchTrendMonth.rows, batchTrendYear: batchTrendYear.rows,
            revenueGrowth: revenueGrowth.rows, activeUsers: activeUsersRows, oldestRequests: oldestRequests.rows
        });
    } catch (err) {
        console.error('Dashboard summary failed:', err.message);
        res.render('dashboard', {
            page: 'dashboard', query: req.query, dashboardYear: currentYear, productionOutput: 0,
            annualRevenue: 0, annualExpenses: 0, totalCustomers: 0, inventory: [], batchTrendMonth: [],
            batchTrendYear: [], revenueGrowth: Array.from({length:5},(_,i)=>({year:currentYear-4+i,revenue:0})), activeUsers: [], oldestRequests: []
        });
    }
});

app.get('/search', isAuthenticated, async (req, res) => {
    const q = req.query.q;
    if (!q) return res.redirect('/');
    try {
        const matSearch = await pool.query("SELECT * FROM materials WHERE name ILIKE $1 OR material_code ILIKE $1", [`%${q}%`]);
        const assetSearch = await pool.query("SELECT * FROM assets WHERE name ILIKE $1 OR asset_code ILIKE $1", [`%${q}%`]);
        res.render('search_results', { query: q, materials: matSearch.rows, assets: assetSearch.rows, page: 'search' });
    } catch (err) { res.status(500).send("Search Error: " + err.message); }
});

// ==========================================
// 7. PRODUCTION MODULE (Manufacturing)
// ==========================================

app.get('/production/masterlist', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
        res.render('production/masterlist', { products: result.rows, page: 'masterlist' });
    } catch (err) { res.render('production/masterlist', { products: [], page: 'masterlist' }); }
});

app.post('/production/masterlist/add', isAuthenticated, async (req, res) => {
    const { code, name, description, half_life_min, decay_constant, ph_limit, purity_limit } = req.body;
    try {
        await pool.query(
            `INSERT INTO products (code, name, description, half_life_min, decay_constant, ph_limit, purity_limit) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [code, name, description, half_life_min, decay_constant, ph_limit, purity_limit]
        );
        res.redirect('/production/masterlist?success=Master+Product+Created');
    } catch (err) { res.redirect('/production/masterlist?error=' + encodeURIComponent(err.message)); }
});

app.post('/production/masterlist/edit/:id', isAuthenticated, async (req, res) => {
    const { name, description, half_life_min, decay_constant, ph_limit, purity_limit } = req.body;
    try {
        await pool.query(
            `UPDATE products SET name=$1, description=$2, half_life_min=$3, decay_constant=$4, ph_limit=$5, purity_limit=$6 WHERE id=$7`,
            [name, description, half_life_min, decay_constant, ph_limit, purity_limit, req.params.id]
        );
        res.redirect('/production/masterlist?success=Master+Product+Updated');
    } catch (err) { res.redirect('/production/masterlist?error=' + encodeURIComponent(err.message)); }
});

app.post('/production/masterlist/delete/:id', isAuthenticated, async (req, res) => {
    try {
        await pool.query(`DELETE FROM products WHERE id=$1`, [req.params.id]);
        res.redirect('/production/masterlist?success=Product+Deleted');
    } catch (err) { res.redirect('/production/masterlist?error=' + encodeURIComponent(err.message)); }
});

app.get('/production/calculation', isAuthenticated, (req, res) => {
    res.render('production/calculation', { page: 'calculation' });
});

// GET SCHEDULE & FETCH REAL DATA
app.get('/production/schedule', isAuthenticated, async (req, res) => {
    try {
        // Ambil batch produksi dari DB yang statusnya SCHEDULED / IN_PROGRESS
        const runsQuery = await pool.query("SELECT * FROM productions WHERE status = 'SCHEDULED' OR status = 'IN_PROGRESS' ORDER BY production_date ASC, calib_time ASC");
        const runs = [];

        for (let row of runsQuery.rows) {
            // Ambil alokasi multi-customer untuk dirender ke Timeline/Accordion
            const allocQuery = await pool.query("SELECT hospital_name, allocated_mci FROM dispatch_plans WHERE production_batch_id = $1", [row.batch_id]);
            runs.push({
                batch_number: row.batch_id,
                production_date: row.production_date, 
                calib_time: row.calib_time,
                item_code: row.item_code,
                leadpot: row.leadpot,
                allocations: allocQuery.rows.map(a => ({ customer_name: a.hospital_name, activity: a.allocated_mci }))
            });
        }
        res.render('production/schedule', { runs: runs, page: 'schedule', query: req.query });
    } catch (err) {
        console.error("Schedule GET Error:", err);
        res.render('production/schedule', { runs: [], page: 'schedule', query: req.query });
    }
});

// POST SCHEDULE: INTEGRASI KE TABEL PRODUCTIONS & DISPATCH_PLANS
app.post('/production/schedule/add', isAuthenticated, async (req, res) => {
    let { production_date, batch_number, calib_time, item_code_select, item_code_custom, leadpot, customers, activities } = req.body;
    let item_code = (item_code_select === 'Add New...') ? item_code_custom : item_code_select;

    try {
        await pool.query('BEGIN'); // Transaksi Aman
        
        // 1. Simpan ke modul Execution (Productions)
        await pool.query(
            `INSERT INTO productions (batch_id, production_date, calib_time, item_code, leadpot, status) 
             VALUES ($1, $2, $3, $4, $5, 'SCHEDULED')
             ON CONFLICT (batch_id) DO UPDATE 
             SET production_date = EXCLUDED.production_date, calib_time = EXCLUDED.calib_time, item_code = EXCLUDED.item_code, leadpot = EXCLUDED.leadpot`,
            [batch_number, production_date, calib_time, item_code, leadpot]
        );

        // 2. Bersihkan alokasi lama jika ini Update Batch
        await pool.query('DELETE FROM dispatch_plans WHERE production_batch_id = $1 AND status = $2', [batch_number, 'SCHEDULED']);

        // 3. Simpan Multi-Customer ke modul Distribusi (Dispatch Plans)
        let custArray = Array.isArray(customers) ? customers : [customers];
        let actArray = Array.isArray(activities) ? activities : [activities];

        for (let i = 0; i < custArray.length; i++) {
            if (custArray[i] && actArray[i]) {
                const orderRef = 'DO-' + Date.now().toString().slice(-6) + '-' + (i+1);
                await pool.query(
                    `INSERT INTO dispatch_plans (order_reference, hospital_name, production_batch_id, asset_code, allocated_mci, status)
                     VALUES ($1, $2, $3, $4, $5, 'SCHEDULED')`,
                    [orderRef, custArray[i], batch_number, leadpot, actArray[i]]
                );
            }
        }

        await pool.query('COMMIT');
        res.redirect('/production/schedule?success=Batch+Berhasil+Dijadwalkan+dan+Tersimpan+ke+Database');
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error("Schedule POST Error:", err);
        res.redirect('/production/schedule?error=' + encodeURIComponent(err.message));
    }
});

app.get('/production/order', isAuthenticated, async (req, res) => {
    try {
        const batches = await pool.query("SELECT * FROM productions ORDER BY created_at DESC LIMIT 10");
        res.render('production/order', { batches: batches.rows, page: 'order' });
    } catch (err) { res.render('production/order', { batches: [], page: 'order' }); }
});

app.post('/execute-production', isAuthenticated, async (req, res) => {
    // Legacy BOM/FEFO issue endpoint is intentionally retired to avoid bypassing
    // SCM's explicit lot allocation and verification in the unified Execution workflow.
    res.redirect('/manufacturing/execution?error=' + encodeURIComponent('Legacy production start dinonaktifkan. Gunakan Open Execution agar Production memasukkan kebutuhan, SCM memilih lot yang sesuai, dan Inventory dipotong secara tercatat.'));
});

app.post('/complete-production/:id', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    const { actual_eob, raw_yield_mci, qc_ph, qc_purity, qc_sterility } = req.body;
    try {
        await pool.query(
            `UPDATE productions SET actual_eob = $1, raw_yield_mci = $2, qc_ph = $3, qc_purity = $4, qc_sterility = $5, status = 'COMPLETED' WHERE id = $6`,
            [actual_eob, raw_yield_mci, qc_ph, qc_purity, qc_sterility, id]
        );
        res.redirect('/production/order?success=Batch+Completed+and+Yield+Recorded');
    } catch (err) { res.redirect('/production/order?error=' + encodeURIComponent(err.message)); }
});

app.get('/production/history', isAuthenticated, async (req, res) => {
    try {
        const history = await pool.query("SELECT * FROM productions WHERE status = 'COMPLETED' ORDER BY actual_eob DESC");
        res.render('production/history', { historyBatches: history.rows, page: 'history' });
    } catch (err) { res.render('production/history', { historyBatches: [], page: 'history' }); }
});

// ==========================================
// 8. SCM MODULE (Inventory, Assets, Distribution)
// ==========================================

app.get('/scm/inventory', isAuthenticated, async (req, res) => {
    try {
        // Ambil Masterlist Material
        const inventory = await pool.query('SELECT * FROM materials ORDER BY name ASC');
        // Ambil Data Penerimaan Barang (Goods Receipt) yang masih Karantina atau sudah Unrestricted
        const grBatches = await pool.query(`
            SELECT mb.*, m.name as material_name, m.material_code, m.uom 
            FROM material_batches mb 
            JOIN materials m ON mb.material_id = m.id 
            ORDER BY mb.created_at DESC
        `);
        res.render('scm/inventory', { inventory: inventory.rows, grBatches: grBatches.rows, page: 'inventory' });
    } catch (err) { res.render('scm/inventory', { inventory: [], grBatches: [], page: 'inventory' }); }
});

app.post('/scm/inventory/add-master', isAuthenticated, async (req, res) => {
    const { material_code, name, category, uom, min_stock } = req.body;
    try {
        await pool.query(
            'INSERT INTO materials (material_code, name, category, uom, min_stock, current_stock) VALUES ($1, $2, $3, $4, $5, 0)',
            [material_code, name, category, uom, min_stock]
        );
        res.redirect('/scm/inventory?success=Master+Barang+Berhasil+Dibuat');
    } catch (err) { res.redirect('/scm/inventory?error=' + encodeURIComponent(err.message)); }
});

app.post('/scm/inventory/goods-receipt', isAuthenticated, uploadSCM.fields([{name: 'gr_doc', maxCount: 1}, {name: 'coa_doc', maxCount: 1}]), async (req, res) => {
    const { material_id, batch_number, quantity, expiry_date } = req.body;
    const grFile = req.files['gr_doc'] ? '/uploads/scm/' + req.files['gr_doc'][0].filename : null;
    const coaFile = req.files['coa_doc'] ? '/uploads/scm/' + req.files['coa_doc'][0].filename : null;

    try {
        // Masuk sebagai KARANTINA, tidak langsung menambah stok utama
        await pool.query(
            `INSERT INTO material_batches (material_id, batch_number, qty, expiry_date, status, gr_document, coa_document) 
             VALUES ($1, $2, $3, $4, 'QUARANTINE', $5, $6)`,
            [material_id, batch_number, quantity, expiry_date, grFile, coaFile]
        );
        
        // Notify QC
        await pool.query(
            `INSERT INTO notifications (user_id, title, message, type) VALUES (NULL, $1, $2, 'warning')`,
            ['QC Alert: Material Baru Karantina', `Batch ${batch_number} menunggu inspeksi QA/QC.`]
        );

        res.redirect('/scm/inventory?success=Goods+Receipt+Disimpan+(Status:+Karantina)');
    } catch (err) { res.redirect('/scm/inventory?error=' + encodeURIComponent(err.message)); }
});

app.post('/scm/inventory/qa-release/:id', isAuthenticated, async (req, res) => {
    const batchId = req.params.id;
    const pin = String(req.body.pin || '');
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userResult = await client.query('SELECT * FROM users WHERE id=$1', [req.session.user.id]);
        const user = userResult.rows[0];
        if (!user || !user.pin || !verifyPassword(pin, user.pin)) throw new Error('Electronic Signature PIN Salah atau belum disetel.');
        const result = await client.query('SELECT * FROM material_batches WHERE id=$1 AND status=$2 FOR UPDATE', [batchId, 'QUARANTINE']);
        if (!result.rows.length) throw new Error('Batch tidak valid atau sudah diproses.');
        const batch = result.rows[0];
        await client.query("UPDATE material_batches SET status='UNRESTRICTED', qty_remaining=qty, released_by=$1, released_at=CURRENT_TIMESTAMP WHERE id=$2", [user.full_name, batchId]);
        await client.query('UPDATE materials SET current_stock=current_stock+$1 WHERE id=$2', [batch.qty, batch.material_id]);
        await client.query(`INSERT INTO erp_inventory_movements(material_id,material_batch_id,movement_type,quantity,source_type,source_id,reason,actor_user_id,actor_name)
            VALUES($1,$2,'QC_RELEASE_RECEIPT',$3,'MATERIAL_BATCH',$4,'Stock recognized after QC release',$5,$6)`, [batch.material_id, batch.id, batch.qty, batch.batch_number, user.id, user.full_name]);
        await integratedERP.audit(client, req, 'MATERIAL_QA_RELEASED', 'MATERIAL_BATCH', batchId, 'QC release after PIN re-authentication', {status:'QUARANTINE'}, {status:'UNRESTRICTED', quantity:batch.qty});
        await client.query('COMMIT');
        res.redirect('/scm/inventory?success=Batch+dirilis+ke+stock+terkendali');
    } catch (err) {
        await client.query('ROLLBACK');
        res.redirect('/scm/inventory?error=' + encodeURIComponent(err.message));
    } finally { client.release(); }
});

app.get('/scm/assets', isAuthenticated, async (req, res) => {
    try {
        const assets = await pool.query('SELECT * FROM assets ORDER BY id ASC');
        res.render('scm/assets', { assets: assets.rows, page: 'assets' });
    } catch (err) { res.render('scm/assets', { assets: [], page: 'assets' }); }
});

app.get('/scm/distribution', isAuthenticated, async (req, res) => {
    try {
        const deliveries = await pool.query("SELECT * FROM dispatch_plans ORDER BY id DESC");
        res.render('scm/distribution', { deliveries: deliveries.rows, page: 'distribution' });
    } catch (err) { res.render('scm/distribution', { deliveries: [], page: 'distribution' }); }
});

app.post('/scm/distribution/add-leadpot', isAuthenticated, async (req, res) => {
    res.redirect('/scm/distribution?success=Leadpot+Registered');
});

app.post('/scm/distribution/complete', isAuthenticated, async (req, res) => {
    res.redirect('/scm/distribution?success=Delivery+and+Calibration+Completed');
});

app.post('/scm/tracking/update/:id', isAuthenticated, async (req, res) => {
    const { next_status } = req.body;
    try {
        await pool.query(`UPDATE dispatch_plans SET status = $1 WHERE id = $2`, [next_status, req.params.id]);
        res.redirect('/scm/distribution?success=Fleet+Status+Updated');
    } catch (err) { res.redirect('/scm/distribution?error=' + encodeURIComponent(err.message)); }
});

// ==========================================
// 9. PROCUREMENT & COMMERCIAL MODULES
// ==========================================

app.get('/procurement/pr', isAuthenticated, async (req, res) => {
    try {
        const prs = await pool.query("SELECT pr.*, v.name as vendor_name FROM purchase_requisitions pr LEFT JOIN vendors v ON pr.vendor_id = v.id ORDER BY pr.created_at DESC");
        const vendors = await pool.query("SELECT * FROM vendors WHERE status = 'ACTIVE'");
        res.render('procurement/pr', { prs: prs.rows, vendors: vendors.rows, page: 'pr' });
    } catch (err) { res.render('procurement/pr', { prs: [], vendors: [], page: 'pr' }); }
});

app.post('/procurement/pr/add', isAuthenticated, async (req, res) => {
    const { pr_number, request_date, department, item_name, specification, quantity, uom, est_unit_price, vendor_id, purpose } = req.body;
    const totalPrice = parseFloat(quantity) * parseFloat(est_unit_price);
    const vId = vendor_id ? vendor_id : null;
    try {
        await pool.query(
            `INSERT INTO purchase_requisitions (pr_number, request_date, department, item_name, specification, quantity, uom, est_unit_price, total_price, vendor_id, purpose, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'WAITING_FINANCE_APPROVAL')`,
            [pr_number, request_date, department, item_name, specification, quantity, uom, est_unit_price, totalPrice, vId, purpose]
        );
        res.redirect('/procurement/pr?success=Purchase+Requisition+Submitted+for+Approval');
    } catch (err) { res.redirect('/procurement/pr?error=' + encodeURIComponent(err.message)); }
});

app.post('/procurement/pr/approve/:id', isAuthenticated, async (req, res) => {
    try {
        await pool.query(`UPDATE purchase_requisitions SET status = 'APPROVED_BY_DIRECTOR' WHERE id = $1`, [req.params.id]);
        res.redirect('/procurement/pr?success=PR+Successfully+Approved');
    } catch (err) { res.redirect('/procurement/pr?error=' + encodeURIComponent(err.message)); }
});

app.get('/procurement/msr', isAuthenticated, async (req, res) => {
    try {
        const reqs = await pool.query("SELECT * FROM requisitions ORDER BY created_at DESC");
        res.render('procurement/msr', { requisitions: reqs.rows, page: 'msr' });
    } catch (err) { res.render('procurement/msr', { requisitions: [], page: 'msr' }); }
});

app.post('/procurement/msr/add', isAuthenticated, async (req, res) => {
    const { req_number, department, item_description, quantity, uom, required_date, justification } = req.body;
    try {
        await pool.query(
            `INSERT INTO requisitions (req_number, department, item_description, quantity, uom, required_date, justification, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING_APPROVAL')`,
            [req_number, department, item_description, quantity, uom, required_date, justification]
        );
        res.redirect('/procurement/msr?success=Material+Requisition+Created');
    } catch (err) { res.redirect('/procurement/msr?error=' + encodeURIComponent(err.message)); }
});

app.post('/procurement/msr/approve/:id', isAuthenticated, async (req, res) => {
    try {
        await pool.query(`UPDATE requisitions SET status = 'APPROVED' WHERE id = $1`, [req.params.id]);
        res.redirect('/procurement/msr?success=MSR+Approved');
    } catch (err) { res.redirect('/procurement/msr?error=' + encodeURIComponent(err.message)); }
});

app.get('/procurement/vendor', isAuthenticated, async (req, res) => {
    res.render('procurement/vendor', { page: 'vendor' });
});

app.get('/commercial/customer', isAuthenticated, async (req, res) => {
    try {
        const customers = await pool.query("SELECT * FROM customers ORDER BY name ASC");
        res.render('commercial/customer', { customers: customers.rows, page: 'customer' });
    } catch (err) { res.render('commercial/customer', { customers: [], page: 'customer' }); }
});

// ==========================================
// 10. DATABASE AUTO-SYNC, MIGRATION & SEEDER
// ==========================================
const syncDatabase = async () => {
    try {
        // 1. Create Core Tables
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, full_name VARCHAR(255) NOT NULL, email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(100) NOT NULL, role VARCHAR(100) NOT NULL, profile_photo VARCHAR(255), 
                department VARCHAR(100), phone VARCHAR(50), emergency_contact VARCHAR(100), 
                is_email_verified BOOLEAN DEFAULT FALSE, language VARCHAR(10) DEFAULT 'en', 
                timezone VARCHAR(50) DEFAULT 'Asia/Jakarta', email_notif BOOLEAN DEFAULT TRUE, 
                push_notif BOOLEAN DEFAULT TRUE, pin VARCHAR(10), is_2fa_enabled BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS login_trails (
                id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), device_ip VARCHAR(50), 
                browser_info VARCHAR(255), status VARCHAR(50), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), title VARCHAR(150), 
                message TEXT, type VARCHAR(50) DEFAULT 'info', is_read BOOLEAN DEFAULT FALSE, 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS materials (
                id SERIAL PRIMARY KEY, material_code VARCHAR(50) UNIQUE NOT NULL, name VARCHAR(255) NOT NULL, 
                category VARCHAR(100), uom VARCHAR(20), current_stock NUMERIC DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY, code VARCHAR(50) UNIQUE NOT NULL, name VARCHAR(255) NOT NULL, 
                description TEXT, half_life_min NUMERIC, decay_constant NUMERIC, ph_limit VARCHAR(50), 
                purity_limit VARCHAR(50), bom_text TEXT
            );
            CREATE TABLE IF NOT EXISTS productions (
                id SERIAL PRIMARY KEY, batch_id VARCHAR(100) UNIQUE NOT NULL, env_temp NUMERIC, 
                env_pressure NUMERIC, beam_current_ua NUMERIC, beam_duration_min NUMERIC, actual_eob TIMESTAMP, 
                raw_yield_mci NUMERIC, qc_ph NUMERIC, qc_purity NUMERIC, qc_sterility VARCHAR(50), 
                approved_by INTEGER, status VARCHAR(50) DEFAULT 'DRAFT', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS assets (
                id SERIAL PRIMARY KEY, asset_code VARCHAR(50) UNIQUE NOT NULL, name VARCHAR(255) NOT NULL, 
                category VARCHAR(100), weight_kg NUMERIC, current_location VARCHAR(100) DEFAULT 'FACILITY', 
                status VARCHAR(50) DEFAULT 'AVAILABLE'
            );
            CREATE TABLE IF NOT EXISTS vendors (
                id SERIAL PRIMARY KEY, vendor_code VARCHAR(50) UNIQUE NOT NULL, name VARCHAR(255) NOT NULL, 
                status VARCHAR(50) DEFAULT 'ACTIVE', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
                category VARCHAR(100), contact_person VARCHAR(100), email VARCHAR(100), phone VARCHAR(50), address TEXT
            );
            CREATE TABLE IF NOT EXISTS requisitions (
                id SERIAL PRIMARY KEY, req_number VARCHAR(50) UNIQUE NOT NULL, department VARCHAR(100), 
                item_description VARCHAR(255) NOT NULL, quantity NUMERIC NOT NULL, status VARCHAR(50) DEFAULT 'PENDING_APPROVAL', 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS purchase_requisitions (
                id SERIAL PRIMARY KEY, pr_number VARCHAR(100) UNIQUE NOT NULL, request_date DATE, 
                item_name VARCHAR(255) NOT NULL, total_price NUMERIC, vendor_id INTEGER REFERENCES vendors(id), 
                status VARCHAR(50) DEFAULT 'WAITING_FINANCE_APPROVAL', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS customers (
                id SERIAL PRIMARY KEY, customer_code VARCHAR(50) UNIQUE NOT NULL, name VARCHAR(255) NOT NULL, 
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, category VARCHAR(100), 
                address TEXT, contact_person VARCHAR(100), phone VARCHAR(50), email VARCHAR(100), status VARCHAR(20) DEFAULT 'ACTIVE'
            );
            CREATE TABLE IF NOT EXISTS dispatch_plans (
                id SERIAL PRIMARY KEY, order_reference VARCHAR(100), hospital_name VARCHAR(255), 
                production_batch_id VARCHAR(100), asset_code VARCHAR(50), allocated_mci NUMERIC, 
                status VARCHAR(50) DEFAULT 'IN_TRANSIT', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS material_batches (
                id SERIAL PRIMARY KEY,
                material_id INTEGER REFERENCES materials(id),
                batch_number VARCHAR(100) NOT NULL,
                qty NUMERIC NOT NULL,
                expiry_date DATE,
                status VARCHAR(50) DEFAULT 'QUARANTINE',
                gr_document VARCHAR(255),
                coa_document VARCHAR(255),
                released_by VARCHAR(100),
                released_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // =========================================================================================
        // PENTING: AUTO-MIGRATION ENTERPRISE SCHEMA (Menambal tabel lama dengan kolom baru)
        // =========================================================================================
        await pool.query(`
            ALTER TABLE users ALTER COLUMN password TYPE VARCHAR(255);
            ALTER TABLE users ALTER COLUMN pin TYPE VARCHAR(255);
            ALTER TABLE materials ADD COLUMN IF NOT EXISTS min_stock NUMERIC DEFAULT 0;
            ALTER TABLE materials ADD COLUMN IF NOT EXISTS moving_avg_price NUMERIC DEFAULT 0;
            ALTER TABLE materials ADD COLUMN IF NOT EXISTS storage_condition VARCHAR(100);
            
            ALTER TABLE customers ADD COLUMN IF NOT EXISTS contract_price NUMERIC DEFAULT 0;
            
            ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS department VARCHAR(100);
            ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS specification TEXT;
            ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS quantity NUMERIC;
            ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS uom VARCHAR(50);
            ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS est_unit_price NUMERIC;
            ALTER TABLE purchase_requisitions ADD COLUMN IF NOT EXISTS purpose TEXT;
            
            ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS uom VARCHAR(20);
            ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS required_date DATE;
            ALTER TABLE requisitions ADD COLUMN IF NOT EXISTS justification TEXT;

            -- MIGRATION KHUSUS MENU SCHEDULE --
            ALTER TABLE productions ADD COLUMN IF NOT EXISTS production_date DATE;
            ALTER TABLE productions ADD COLUMN IF NOT EXISTS calib_time VARCHAR(50);
            ALTER TABLE productions ADD COLUMN IF NOT EXISTS item_code VARCHAR(100);
            ALTER TABLE productions ADD COLUMN IF NOT EXISTS leadpot VARCHAR(100);

            -- FIX ERROR DISPATCH_PLANS ASSET_CODE --
            ALTER TABLE dispatch_plans ADD COLUMN IF NOT EXISTS production_batch_id VARCHAR(100);
            ALTER TABLE dispatch_plans ADD COLUMN IF NOT EXISTS asset_code VARCHAR(50);
            ALTER TABLE dispatch_plans ADD COLUMN IF NOT EXISTS allocated_mci NUMERIC;
        `);

        // Integrated tables for BOM-driven inventory, digital batch records, signatures, QA/QC, labels and delivery telemetry.
        await integratedERP.installIntegratedSchema(pool);
        // Roadmap modules: controlled-record templates, customer/vendor qualification, inventory quarantine, assets and material requisition.
        await roadmapERP.installRoadmapSchema(pool);

        // 3. Data Seeding (Masukkan Dummy Data Lengkap agar UI langsung terisi)
        const adminCheck = await pool.query("SELECT * FROM users WHERE email = 'admin@ims.com'");
        if(adminCheck.rows.length === 0 && process.env.NODE_ENV !== 'production') {
            console.log("⚙️  Menyuntikkan Dummy Data Pertama Kali (Seeding)...");
            
            // Insert Admin
            await pool.query(`INSERT INTO users (full_name, email, password, role, is_email_verified) VALUES ('System Administrator', 'admin@ims.com', 'admin123', 'System Administrator', true)`);
            
            // Insert Materials
            await pool.query(`INSERT INTO materials (material_code, name, category, uom, current_stock, min_stock, moving_avg_price) VALUES 
                ('MAT-1.02.0003', 'Water For Injection (WFI)', 'Consumable', 'Pcs', 50, 100, 150000),
                ('MAT-1.02.0001', 'Cassette Fastlab 2 Single', 'Precursor & Reagent', 'Pcs', 25, 10, 4500000),
                ('MAT-1.02.0004', 'Mannose Triflate', 'Precursor', 'Vial', 15, 20, 2500000),
                ('MAT-1.02.0005', 'Sterile Vials 30ml', 'Consumable', 'Pcs', 150, 50, 15000)`);
                
            // Insert Assets
            await pool.query(`INSERT INTO assets (asset_code, name, category, status) VALUES 
                ('AST-CYC-001', 'GE PETtrace 890', 'Production Machine', 'AVAILABLE'),
                ('LP-012', 'Tungsten Leadpot 30ml', 'Logistics Shielding', 'AVAILABLE'),
                ('LP-005', 'Tungsten Leadpot 30ml', 'Logistics Shielding', 'IN_TRANSIT'),
                ('LP-008', 'Tungsten Leadpot 30ml', 'Logistics Shielding', 'AVAILABLE')`);
                
            // Insert Customers
            await pool.query(`INSERT INTO customers (customer_code, name, category, status, contract_price) VALUES 
                ('C-RSMP-01', 'RS Mitra Plumbon', 'Private Hospital', 'ACTIVE', 800000),
                ('C-RSK-02', 'RS Kariadi Semarang', 'Government Hospital', 'ACTIVE', 750000),
                ('C-RSHS-03', 'RSUP Hasan Sadikin', 'Government Hospital', 'ACTIVE', 750000)`);

            // Insert Vendors
            await pool.query(`INSERT INTO vendors (vendor_code, name, category, contact_person) VALUES 
                ('V-GE-01', 'PT GE Healthcare', 'Equipment & Reagents', 'Budi Hartono'),
                ('V-MERCK-02', 'PT Merck Indonesia', 'Chemicals', 'Siska Amelia')`);
                
            // Insert Dispatch
            await pool.query(`INSERT INTO dispatch_plans (order_reference, hospital_name, production_batch_id, asset_code) VALUES 
                ('DO-2026-001', 'RS Mitra Plumbon', 'BATCH-260901', 'LP-012'),
                ('DO-2026-002', 'RS Kariadi Semarang', 'BATCH-260901', 'LP-005')`);

            console.log("✅ SYSTEM: Auto-Seed Data Berhasil!");
        }

        console.log("✅ Connected.");
    } catch (err) { 
        console.error("❌ SYSTEM ERROR - DB Sync Failed:", err.message);
        throw err;
    }
};
// ==========================================
// 11. SERVER LISTENER (wait for schema bootstrap)
// ==========================================
syncDatabase().then(() => {
    app.listen(port, () => {
        console.log(`\n======================================================`);
        console.log(`🚀 NUCLEA ERP INTEGRATED EDITION IS RUNNING`);
        console.log(`🌐 Local URL : http://localhost:${port}`);
        console.log(`======================================================\n`);
    });
}).catch(err => {
    console.error('NUCLEA ERP startup blocked because database/schema initialization failed:', err.message);
    process.exitCode = 1;
});