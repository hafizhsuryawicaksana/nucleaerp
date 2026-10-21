'use strict';
const crypto = require('crypto');

async function installIntegratedSchema(pool) {
  await pool.query(`
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS qa_disposition VARCHAR(30) NOT NULL DEFAULT 'PENDING';
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS batch_size NUMERIC;
    ALTER TABLE productions ADD COLUMN IF NOT EXISTS production_notes TEXT;
    ALTER TABLE material_batches ADD COLUMN IF NOT EXISTS qty_remaining NUMERIC;
    UPDATE material_batches SET qty_remaining = qty WHERE qty_remaining IS NULL;
    CREATE TABLE IF NOT EXISTS erp_audit_events (
      id BIGSERIAL PRIMARY KEY, occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), actor_user_id INTEGER,
      actor_name TEXT, actor_role TEXT, action VARCHAR(80) NOT NULL, entity_type VARCHAR(80) NOT NULL,
      entity_id TEXT NOT NULL, reason TEXT, before_data JSONB, after_data JSONB, source_ip TEXT, user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_erp_audit_entity ON erp_audit_events(entity_type, entity_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_erp_audit_time ON erp_audit_events(occurred_at DESC);
    CREATE TABLE IF NOT EXISTS erp_signatures (
      id BIGSERIAL PRIMARY KEY, signer_user_id INTEGER NOT NULL, signer_name TEXT NOT NULL, signer_role TEXT NOT NULL,
      sign_type VARCHAR(80) NOT NULL, document_type VARCHAR(80) NOT NULL, document_id TEXT NOT NULL,
      document_version INTEGER NOT NULL DEFAULT 1, signed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      auth_method VARCHAR(40) NOT NULL DEFAULT 'PIN_REAUTH', decision VARCHAR(30) NOT NULL, reason TEXT,
      document_hash TEXT NOT NULL, audit_event_id BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_erp_signatures_doc ON erp_signatures(document_type, document_id, signed_at DESC);
    CREATE TABLE IF NOT EXISTS erp_product_bom (
      id BIGSERIAL PRIMARY KEY, product_code VARCHAR(100) NOT NULL, material_id INTEGER NOT NULL REFERENCES materials(id),
      quantity_per_batch NUMERIC(18,6) NOT NULL CHECK(quantity_per_batch > 0), uom VARCHAR(30), version INTEGER NOT NULL DEFAULT 1,
      is_active BOOLEAN NOT NULL DEFAULT TRUE, created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(product_code, material_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_erp_bom_product ON erp_product_bom(product_code, is_active);
    CREATE TABLE IF NOT EXISTS erp_inventory_movements (
      id BIGSERIAL PRIMARY KEY, material_id INTEGER NOT NULL REFERENCES materials(id), material_batch_id INTEGER,
      movement_type VARCHAR(40) NOT NULL, quantity NUMERIC(18,6) NOT NULL CHECK(quantity <> 0), uom VARCHAR(30),
      source_type VARCHAR(80), source_id TEXT, reason TEXT, actor_user_id INTEGER, actor_name TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), idempotency_key TEXT UNIQUE, metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_erp_movements_mat ON erp_inventory_movements(material_id, occurred_at DESC);
    CREATE TABLE IF NOT EXISTS erp_batch_steps (
      id BIGSERIAL PRIMARY KEY, batch_id VARCHAR(100) NOT NULL, record_type VARCHAR(20) NOT NULL CHECK(record_type IN ('BMR','BPR')),
      step_code VARCHAR(80) NOT NULL, step_name TEXT NOT NULL, sequence_no INTEGER NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, performed_by INTEGER, verified_by INTEGER, notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(batch_id, record_type, step_code)
    );
    CREATE INDEX IF NOT EXISTS idx_erp_steps_batch ON erp_batch_steps(batch_id, record_type, sequence_no);
    CREATE TABLE IF NOT EXISTS erp_batch_parameters (
      id BIGSERIAL PRIMARY KEY, batch_id VARCHAR(100) NOT NULL, step_id BIGINT REFERENCES erp_batch_steps(id),
      record_type VARCHAR(20) NOT NULL DEFAULT 'BMR', parameter_code VARCHAR(100), parameter_name TEXT NOT NULL,
      actual_numeric NUMERIC, actual_text TEXT, unit VARCHAR(40), target_value TEXT, lower_limit NUMERIC, upper_limit NUMERIC,
      result_status VARCHAR(30) NOT NULL DEFAULT 'RECORDED', entered_by INTEGER NOT NULL,
      entered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), reason TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_erp_params_batch ON erp_batch_parameters(batch_id, entered_at DESC);
    CREATE TABLE IF NOT EXISTS erp_qc_results (
      id BIGSERIAL PRIMARY KEY, batch_id VARCHAR(100) NOT NULL, test_code VARCHAR(100) NOT NULL, test_name TEXT NOT NULL,
      result_numeric NUMERIC, result_text TEXT, unit VARCHAR(40), lower_limit NUMERIC, upper_limit NUMERIC,
      acceptance_criteria TEXT, outcome VARCHAR(30) NOT NULL, specification_version TEXT NOT NULL DEFAULT 'UNCONTROLLED-PENDING-QA',
      analyst_user_id INTEGER NOT NULL, performed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), instrument_id TEXT,
      verified_by INTEGER, verified_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_erp_qc_batch ON erp_qc_results(batch_id, performed_at DESC);
    CREATE TABLE IF NOT EXISTS erp_label_jobs (
      id BIGSERIAL PRIMARY KEY, label_type VARCHAR(30) NOT NULL CHECK(label_type IN ('VIAL','LEADPOT','CONTAINER','MATERIAL')),
      entity_type VARCHAR(60) NOT NULL, entity_id TEXT NOT NULL, batch_id TEXT, template_version TEXT NOT NULL DEFAULT '1.0',
      payload JSONB NOT NULL, payload_hash TEXT NOT NULL, printed_by INTEGER NOT NULL, printed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reprint_of BIGINT REFERENCES erp_label_jobs(id), invalidated_at TIMESTAMPTZ, reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_erp_label_entity ON erp_label_jobs(entity_type, entity_id, printed_at DESC);
    CREATE TABLE IF NOT EXISTS erp_delivery_orders (
      id BIGSERIAL PRIMARY KEY, do_number VARCHAR(100) NOT NULL UNIQUE, dispatch_plan_id INTEGER UNIQUE,
      batch_id VARCHAR(100) NOT NULL, hospital_name TEXT NOT NULL, leadpot_code TEXT NOT NULL, driver_user_id INTEGER,
      vehicle_code TEXT, route_code TEXT, seal_number TEXT, status VARCHAR(40) NOT NULL DEFAULT 'DRAFT', created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), dispatched_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_erp_do_status ON erp_delivery_orders(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS erp_fleet_readiness (
      id BIGSERIAL PRIMARY KEY, delivery_order_id BIGINT NOT NULL UNIQUE REFERENCES erp_delivery_orders(id),
      driver_user_id INTEGER NOT NULL, vehicle_code TEXT NOT NULL, dosimeter_id TEXT NOT NULL,
      dosimeter_calibration_due DATE NOT NULL, checklist JSONB NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'FAILED',
      checked_by INTEGER NOT NULL, checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      review_note TEXT
    );
    CREATE TABLE IF NOT EXISTS erp_radiation_measurements (
      id BIGSERIAL PRIMARY KEY, delivery_order_id BIGINT NOT NULL REFERENCES erp_delivery_orders(id), measured_by INTEGER NOT NULL,
      measured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), instrument_id TEXT NOT NULL, calibration_due DATE,
      background_rate NUMERIC, surface_front NUMERIC, surface_back NUMERIC, surface_left NUMERIC, surface_right NUMERIC,
      rate_at_one_meter NUMERIC, unit VARCHAR(30) NOT NULL, notes TEXT, status VARCHAR(30) NOT NULL DEFAULT 'PENDING_VERIFICATION',
      verified_by INTEGER, verified_at TIMESTAMPTZ, record_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_erp_rad_do ON erp_radiation_measurements(delivery_order_id, measured_at DESC);
    CREATE TABLE IF NOT EXISTS erp_driver_locations (
      id BIGSERIAL PRIMARY KEY, delivery_order_id BIGINT NOT NULL REFERENCES erp_delivery_orders(id), driver_user_id INTEGER NOT NULL,
      latitude NUMERIC(10,7) NOT NULL CHECK(latitude BETWEEN -90 AND 90), longitude NUMERIC(10,7) NOT NULL CHECK(longitude BETWEEN -180 AND 180),
      accuracy_m NUMERIC, device_recorded_at TIMESTAMPTZ, server_received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      event_type VARCHAR(30) NOT NULL DEFAULT 'LOCATION', notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_erp_location_latest ON erp_driver_locations(delivery_order_id, server_received_at DESC);
    CREATE TABLE IF NOT EXISTS erp_proof_of_delivery (
      id BIGSERIAL PRIMARY KEY, delivery_order_id BIGINT NOT NULL UNIQUE REFERENCES erp_delivery_orders(id), receiver_name TEXT NOT NULL,
      receiver_role TEXT, received_at TIMESTAMPTZ NOT NULL, outcome VARCHAR(40) NOT NULL, notes TEXT, receiver_signature_text TEXT,
      created_by INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS erp_reverse_logistics (
      id BIGSERIAL PRIMARY KEY, delivery_order_id BIGINT NOT NULL REFERENCES erp_delivery_orders(id), item_code TEXT NOT NULL,
      item_type VARCHAR(40) NOT NULL DEFAULT 'LEADPOT', condition_status VARCHAR(40) NOT NULL, returned_by INTEGER NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(), notes TEXT
    );
    CREATE TABLE IF NOT EXISTS erp_customer_product_pricing (
      id BIGSERIAL PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      product_code VARCHAR(100) NOT NULL, product_name TEXT NOT NULL, pricing_quantity NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK(pricing_quantity > 0),
      uom VARCHAR(30) NOT NULL, price NUMERIC(18,2) NOT NULL CHECK(price >= 0),
      created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(customer_id, product_code, uom)
    );
    CREATE INDEX IF NOT EXISTS idx_customer_pricing_product ON erp_customer_product_pricing(customer_id, product_code);
    CREATE TABLE IF NOT EXISTS erp_sales_transactions (
      id BIGSERIAL PRIMARY KEY, delivery_order_id BIGINT NOT NULL UNIQUE REFERENCES erp_delivery_orders(id),
      dispatch_plan_id INTEGER UNIQUE REFERENCES dispatch_plans(id), customer_id INTEGER NOT NULL REFERENCES customers(id),
      batch_id VARCHAR(100) NOT NULL, product_code VARCHAR(100), product_name TEXT NOT NULL,
      quantity NUMERIC(18,6) NOT NULL DEFAULT 0, uom VARCHAR(30) NOT NULL DEFAULT 'mCi',
      pricing_id BIGINT REFERENCES erp_customer_product_pricing(id), unit_price NUMERIC(18,4), total_amount NUMERIC(18,2),
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING_PRICING', occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_sales_revenue_time ON erp_sales_transactions(status, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sales_customer ON erp_sales_transactions(customer_id, occurred_at DESC);
    CREATE TABLE IF NOT EXISTS erp_user_activity (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      active_seconds BIGINT NOT NULL DEFAULT 0, last_heartbeat TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function userInfo(req) {
  return { id:req.session?.user?.id||null, name:req.session?.user?.full_name||'Unknown', role:req.session?.user?.role||'Unknown', ip:req.ip||null, agent:req.get('user-agent')||null };
}
async function audit(db, req, action, entityType, entityId, reason, beforeData=null, afterData=null) {
  const u=userInfo(req);
  await db.query(`INSERT INTO erp_audit_events(actor_user_id,actor_name,actor_role,action,entity_type,entity_id,reason,before_data,after_data,source_ip,user_agent)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`,[u.id,u.name,u.role,action,entityType,String(entityId),reason||null,beforeData==null?null:JSON.stringify(beforeData),afterData==null?null:JSON.stringify(afterData),u.ip,u.agent]);
}
function code39Svg(value) {
  const p={'0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn','A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn','K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn','U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','$':'nwnwnwnnn','/':'nwnwnnnwn','+':'nwnnnwnwn','%':'nnnwnwnwn'};
  const raw=String(value||'NUCLEA').toUpperCase().replace(/[^0-9A-Z. $/+%-]/g,'-').slice(0,64); const text=`*${raw}*`; let x=4,rects='';
  for(const ch of text){for(let i=0;i<(p[ch]||p['-']).length;i++){const w=(p[ch]||p['-'])[i]==='w'?3:1;if(i%2===0)rects+=`<rect x="${x}" y="0" width="${w}" height="48" fill="#111827"/>`;x+=w;}x+=1;}
  const safe=raw.replace(/&/g,'&amp;').replace(/</g,'&lt;');return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x+4} 62" width="100%" height="62" aria-label="Code 39 ${safe}">${rects}<text x="${(x+4)/2}" y="59" font-size="9" text-anchor="middle" fill="#111827">${safe}</text></svg>`;
}

// Legacy automatic BOM/FEFO production-start helper removed. Stock issue is now performed only by SCM's explicit lot allocation in Open Execution.

function registerIntegratedRoutes(app,pool,isAuthenticated,verifyCredential){
  app.get('/erp/overview',isAuthenticated,(req,res)=>res.redirect('/security-control'));

  // Product BOM editor is retired from navigation. Per-batch Production material needs and SCM lot selection now live inside Open Execution. Historical BOM records remain untouched for traceability.
  app.get('/erp/bom',isAuthenticated,(req,res)=>res.redirect('/manufacturing/execution?notice='+encodeURIComponent('Material requirement dan lot terpilih dikelola pada Open Execution.')));
  app.post('/erp/bom/save',isAuthenticated,(req,res)=>res.redirect('/manufacturing/execution?error='+encodeURIComponent('BOM editor terpisah sudah dipensiunkan. Gunakan Open Execution untuk kebutuhan material per batch.')));
  app.post('/erp/bom/deactivate/:id',isAuthenticated,(req,res)=>res.redirect('/manufacturing/execution?error='+encodeURIComponent('BOM editor terpisah sudah dipensiunkan. Gunakan Open Execution untuk kebutuhan material per batch.')));

  app.get('/erp/batch-records',isAuthenticated,async(req,res)=>{try{const r=await pool.query(`SELECT p.*,(SELECT COUNT(*) FROM erp_batch_parameters x WHERE x.batch_id=p.batch_id)::int parameter_count,(SELECT COUNT(*) FROM erp_qc_results q WHERE q.batch_id=p.batch_id)::int qc_count,(SELECT COUNT(*) FROM erp_signatures s WHERE s.document_type='BATCH' AND s.document_id=p.batch_id AND s.sign_type='QA_RELEASE')::int qa_signed FROM productions p ORDER BY p.created_at DESC`);res.render('erp/batch-records',{page:'erp-batch-records',batches:r.rows,query:req.query});}catch(e){console.error(e);res.status(500).send('Gagal memuat Batch Record.');}});
  app.get('/erp/batch-records/:batchId',isAuthenticated,async(req,res)=>{const id=String(req.params.batchId);try{const pr=await pool.query('SELECT * FROM productions WHERE batch_id=$1',[id]);if(!pr.rows.length)return res.status(404).send('Batch tidak ditemukan.');const p=pr.rows[0];const defs=[['BMR','READINESS','Readiness Verification',10],['BMR','LINE_CLEARANCE','Line Clearance',20],['BMR','BOMBARDMENT','Cyclotron Bombardment',30],['BMR','SYNTHESIS','Synthesis & Transfer',40],['BMR','IPC','In-Process Control',50],['BPR','DISPENSING','Dispensing / Filling',60],['BPR','PACKING','Packaging & Label Reconciliation',70],['BPR','RECONCILIATION','Yield / Batch Reconciliation',80]];for(const [t,c,n,s]of defs)await pool.query('INSERT INTO erp_batch_steps(batch_id,record_type,step_code,step_name,sequence_no) VALUES($1,$2,$3,$4,$5) ON CONFLICT(batch_id,record_type,step_code) DO NOTHING',[id,t,c,n,s]);const [steps,params,qc,sigs,bom]=await Promise.all([pool.query('SELECT s.*,u.full_name performer_name FROM erp_batch_steps s LEFT JOIN users u ON u.id=s.performed_by WHERE batch_id=$1 ORDER BY sequence_no',[id]),pool.query('SELECT x.*,u.full_name entered_name FROM erp_batch_parameters x LEFT JOIN users u ON u.id=x.entered_by WHERE batch_id=$1 ORDER BY entered_at DESC,id DESC',[id]),pool.query('SELECT q.*,u.full_name analyst_name FROM erp_qc_results q LEFT JOIN users u ON u.id=q.analyst_user_id WHERE batch_id=$1 ORDER BY performed_at DESC,id DESC',[id]),pool.query("SELECT * FROM erp_signatures WHERE document_type='BATCH' AND document_id=$1 ORDER BY signed_at DESC",[id]),pool.query('SELECT b.*,m.name material_name,m.uom FROM erp_product_bom b JOIN materials m ON m.id=b.material_id WHERE upper(b.product_code)=upper($1) AND b.is_active=true',[p.item_code||''])]);res.render('erp/batch-record-detail',{page:'erp-batch-records',production:p,steps:steps.rows,params:params.rows,qc:qc.rows,signatures:sigs.rows,bom:bom.rows,query:req.query});}catch(e){console.error(e);res.status(500).send('Gagal membuka detail Batch Record.');}});

  app.post('/erp/batch-records/:batchId/step/:stepCode',isAuthenticated,async(req,res)=>{
    const id=String(req.params.batchId),code=String(req.params.stepCode),action=req.body.action,notes=String(req.body.notes||'').slice(0,2000),c=await pool.connect();
    try{await c.query('BEGIN');const r=await c.query('SELECT * FROM erp_batch_steps WHERE batch_id=$1 AND step_code=$2 FOR UPDATE',[id,code]);if(!r.rows.length)throw new Error('Step tidak ditemukan.');const s=r.rows[0];
      if(action==='start'){if(s.status!=='PENDING')throw new Error('Step hanya dapat dimulai dari status PENDING.');const batchStatus=await c.query('SELECT status,qa_disposition FROM productions WHERE batch_id=$1 FOR UPDATE',[id]);if(!batchStatus.rows.length||batchStatus.rows[0].status==='RELEASED'||batchStatus.rows[0].qa_disposition==='RELEASED')throw new Error('Batch sudah QA RELEASED; perubahan langsung diblokir. Gunakan deviation/amendment yang disetujui QA.');const prev=await c.query("SELECT step_name FROM erp_batch_steps WHERE batch_id=$1 AND sequence_no<$2 AND status<>'COMPLETED' ORDER BY sequence_no LIMIT 1",[id,s.sequence_no]);if(prev.rows.length)throw new Error(`Urutan proses terkunci. Selesaikan step sebelumnya: ${prev.rows[0].step_name}.`);await c.query("UPDATE erp_batch_steps SET status='IN_PROGRESS',started_at=clock_timestamp(),performed_by=$1,notes=$2 WHERE id=$3",[req.session.user.id,notes,s.id]);}
      else if(action==='complete'){if(s.status!=='IN_PROGRESS')throw new Error('Step harus IN_PROGRESS sebelum diselesaikan.');await c.query("UPDATE erp_batch_steps SET status='COMPLETED',completed_at=clock_timestamp(),notes=COALESCE(NULLIF($1,''),notes) WHERE id=$2",[notes,s.id]);}else throw new Error('Aksi tidak dikenali.');
      await audit(c,req,`BATCH_STEP_${String(action).toUpperCase()}`,'BATCH_STEP',s.id,notes||null,{status:s.status},{status:action==='start'?'IN_PROGRESS':'COMPLETED'});await c.query('COMMIT');res.redirect('/erp/batch-records/'+encodeURIComponent(id)+'?success=Step+tercatat.');
    }catch(e){await c.query('ROLLBACK');res.redirect('/erp/batch-records/'+encodeURIComponent(id)+'?error='+encodeURIComponent(e.message));}finally{c.release();}
  });

  app.post('/erp/batch-records/:batchId/parameter',isAuthenticated,async(req,res)=>{
    const id=String(req.params.batchId),name=String(req.body.parameter_name||'').trim(),type=req.body.record_type==='BPR'?'BPR':'BMR';const num=req.body.actual_numeric===''||req.body.actual_numeric==null?null:Number(req.body.actual_numeric),txt=String(req.body.actual_text||'').trim(),lo=req.body.lower_limit===''||req.body.lower_limit==null?null:Number(req.body.lower_limit),hi=req.body.upper_limit===''||req.body.upper_limit==null?null:Number(req.body.upper_limit);
    if(!name||(num===null&&!txt))return res.redirect(`/erp/batch-records/${encodeURIComponent(id)}?error=`+encodeURIComponent('Nama parameter dan nilai aktual wajib diisi.'));if(num!==null&&!Number.isFinite(num))return res.redirect(`/erp/batch-records/${encodeURIComponent(id)}?error=Nilai+numerik+tidak+valid`);let outcome='RECORDED';if(num!==null&&(lo!==null||hi!==null))outcome=(lo!==null&&num<lo)||(hi!==null&&num>hi)?'OUT_OF_RANGE':'WITHIN_RANGE';
    const c=await pool.connect();try{await c.query('BEGIN');const prodLock=await c.query('SELECT status,qa_disposition FROM productions WHERE batch_id=$1 FOR UPDATE',[id]);if(!prodLock.rows.length)throw new Error('Batch tidak ditemukan.');if(prodLock.rows[0].status==='RELEASED'||prodLock.rows[0].qa_disposition==='RELEASED')throw new Error('Batch sudah QA RELEASED; penambahan parameter langsung diblokir. Gunakan amendment/deviation yang disetujui QA.');const stepId=req.body.step_id?Number(req.body.step_id):null;if(stepId && !(await c.query('SELECT id FROM erp_batch_steps WHERE id=$1 AND batch_id=$2',[stepId,id])).rows.length)throw new Error('Step tidak terkait dengan batch ini.');const r=await c.query(`INSERT INTO erp_batch_parameters(batch_id,step_id,record_type,parameter_code,parameter_name,actual_numeric,actual_text,unit,target_value,lower_limit,upper_limit,result_status,entered_by,reason,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) RETURNING id`,[id,stepId,type,String(req.body.parameter_code||'').slice(0,100)||null,name,num,txt||null,String(req.body.unit||'').slice(0,40)||null,String(req.body.target_value||'').slice(0,100)||null,lo,hi,outcome,req.session.user.id,String(req.body.reason||'').slice(0,1000)||null,JSON.stringify({data_origin:'manual-entry',record_version:1})]);await audit(c,req,'BATCH_PARAMETER_RECORDED','BATCH_PARAMETER',r.rows[0].id,req.body.reason||null,null,{batch_id:id,parameter_name:name,actual_numeric:num,actual_text:txt,unit:req.body.unit,outcome});await c.query('COMMIT');res.redirect(`/erp/batch-records/${encodeURIComponent(id)}?success=Parameter+disimpan+sebagai+rekaman+baru`);}catch(e){await c.query('ROLLBACK');res.redirect(`/erp/batch-records/${encodeURIComponent(id)}?error=`+encodeURIComponent(e.message));}finally{c.release();}
  });

  app.post('/erp/batch-records/:batchId/qc',isAuthenticated,async(req,res)=>{
    const id=String(req.params.batchId),test=String(req.body.test_name||'').trim(),num=req.body.result_numeric===''||req.body.result_numeric==null?null:Number(req.body.result_numeric),txt=String(req.body.result_text||'').trim(),lo=req.body.lower_limit===''||req.body.lower_limit==null?null:Number(req.body.lower_limit),hi=req.body.upper_limit===''||req.body.upper_limit==null?null:Number(req.body.upper_limit);
    if(!test||(num===null&&!txt))return res.redirect(`/erp/batch-records/${encodeURIComponent(id)}?error=`+encodeURIComponent('Nama pengujian dan hasil wajib diisi.'));let outcome='PENDING_REVIEW';if(num!==null&&(lo!==null||hi!==null))outcome=(lo!==null&&num<lo)||(hi!==null&&num>hi)?'FAIL':'PASS';else if(['PASS','FAIL'].includes(req.body.outcome))outcome=req.body.outcome;
    const c=await pool.connect();try{await c.query('BEGIN');const prodLock=await c.query('SELECT status,qa_disposition FROM productions WHERE batch_id=$1 FOR UPDATE',[id]);if(!prodLock.rows.length)throw new Error('Batch tidak ditemukan.');if(prodLock.rows[0].status==='RELEASED'||prodLock.rows[0].qa_disposition==='RELEASED')throw new Error('Batch sudah QA RELEASED; penambahan hasil QC langsung diblokir. Gunakan amendment/deviation yang disetujui QA.');const r=await c.query(`INSERT INTO erp_qc_results(batch_id,test_code,test_name,result_numeric,result_text,unit,lower_limit,upper_limit,acceptance_criteria,outcome,specification_version,analyst_user_id,instrument_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[id,String(req.body.test_code||test.toUpperCase().replace(/[^A-Z0-9]+/g,'_')).slice(0,100),test,num,txt||null,String(req.body.unit||'').slice(0,40)||null,lo,hi,String(req.body.acceptance_criteria||'').slice(0,1000)||null,outcome,String(req.body.specification_version||'UNCONTROLLED-PENDING-QA').slice(0,100),req.session.user.id,String(req.body.instrument_id||'').slice(0,100)||null]);if(outcome==='FAIL')await c.query("UPDATE productions SET qa_disposition='ON_HOLD' WHERE batch_id=$1",[id]);await audit(c,req,'QC_RESULT_RECORDED','QC_RESULT',r.rows[0].id,req.body.reason||null,null,{batch_id:id,test_name:test,result_numeric:num,result_text:txt,outcome,specification_version:req.body.specification_version||'UNCONTROLLED-PENDING-QA'});await c.query('COMMIT');res.redirect(`/erp/batch-records/${encodeURIComponent(id)}?success=`+encodeURIComponent(`Hasil QC disimpan: ${outcome}`));}catch(e){await c.query('ROLLBACK');res.redirect(`/erp/batch-records/${encodeURIComponent(id)}?error=`+encodeURIComponent(e.message));}finally{c.release();}
  });

  app.post('/erp/batch-records/:batchId/sign',isAuthenticated,async(req,res)=>{
    const id=String(req.params.batchId),type=String(req.body.sign_type||'').toUpperCase(),pin=String(req.body.pin||''),reason=String(req.body.reason||'').slice(0,2000);if(!['PRODUCTION_REVIEW','QC_VERIFICATION','QA_RELEASE'].includes(type))return res.redirect(`/erp/batch-records/${encodeURIComponent(id)}?error=Jenis+approval+tidak+valid`);const c=await pool.connect();
    try{await c.query('BEGIN');const u=await c.query('SELECT * FROM users WHERE id=$1',[req.session.user.id]);if(!u.rows[0]?.pin||!verifyCredential(pin,u.rows[0].pin))throw new Error('PIN tanda tangan tidak valid. Set PIN di Profile/Security terlebih dahulu.');const pR=await c.query('SELECT * FROM productions WHERE batch_id=$1 FOR UPDATE',[id]);if(!pR.rows.length)throw new Error('Batch tidak ditemukan.');const p=pR.rows[0];
      if(type==='PRODUCTION_REVIEW'){const pending=await c.query("SELECT COUNT(*)::int n FROM erp_batch_steps WHERE batch_id=$1 AND status<>'COMPLETED'",[id]);if(pending.rows[0].n>0)throw new Error('Semua step e-BMR/e-BPR harus selesai sebelum Production Review.');}
      if(type==='QC_VERIFICATION'||type==='QA_RELEASE'){const q=await c.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE outcome<>'PASS')::int not_pass FROM erp_qc_results WHERE batch_id=$1",[id]);if(!q.rows[0].total)throw new Error('Belum ada hasil QC.');if(Number(q.rows[0].not_pass)>0)throw new Error('Masih ada hasil QC selain PASS; approval diblokir.');}
      if(type==='QA_RELEASE'&&!['COMPLETED','PENDING_QA','ON_HOLD','RELEASED'].includes(p.status))throw new Error('QA Release hanya setelah proses produksi selesai.');if(type==='QA_RELEASE'&&p.qa_disposition==='ON_HOLD')throw new Error('Batch ON_HOLD; selesaikan investigasi terkendali terlebih dahulu.');if(type==='QA_RELEASE'&&p.status==='ON_HOLD')throw new Error('Batch status ON_HOLD; selesaikan investigasi terkendali terlebih dahulu.');if(type==='QA_RELEASE'){const out=await c.query("SELECT COUNT(*)::int n FROM erp_batch_parameters WHERE batch_id=$1 AND result_status='OUT_OF_RANGE'",[id]);if(out.rows[0].n>0)throw new Error('Ada parameter proses OUT_OF_RANGE. QA Release diblokir sampai disposition terkendali tersedia.');}
      const role=String(u.rows[0].role||'');
      if(type==='QC_VERIFICATION'&&!/(qc|quality|supervisor|administrator)/i.test(role))throw new Error('Role akun tidak berwenang melakukan QC Verification.');
      if(type==='QA_RELEASE'&&!/(qa|quality|supervisor|administrator)/i.test(role))throw new Error('Role akun tidak berwenang melakukan QA Release.');
      if(type==='PRODUCTION_REVIEW'&&!/(production|manufacturing|supervisor|administrator)/i.test(role))throw new Error('Role akun tidak berwenang melakukan Production Review.');
      if(type==='QC_VERIFICATION'){const same=await c.query('SELECT COUNT(*)::int n FROM erp_qc_results WHERE batch_id=$1 AND analyst_user_id=$2',[id,u.rows[0].id]);if(same.rows[0].n>0)throw new Error('Pemisahan tugas: analis QC tidak boleh memverifikasi hasil QC yang ia input sendiri.');}
      if(type==='QA_RELEASE'){const review=await c.query("SELECT COUNT(*)::int n FROM erp_signatures WHERE document_type='BATCH' AND document_id=$1 AND sign_type='PRODUCTION_REVIEW' AND decision='APPROVED'",[id]);if(!review.rows[0].n)throw new Error('Production Review e-signature wajib ada sebelum QA Release.');const verified=await c.query("SELECT * FROM erp_signatures WHERE document_type='BATCH' AND document_id=$1 AND sign_type='QC_VERIFICATION' AND decision='APPROVED' ORDER BY signed_at DESC LIMIT 1",[id]);if(!verified.rows.length)throw new Error('QC Verification e-signature wajib ada sebelum QA Release.');if(Number(verified.rows[0].signer_user_id)===Number(u.rows[0].id))throw new Error('Pemisahan tugas: QA Release harus ditandatangani oleh user berbeda dari QC verifier.');}
      const prev=await c.query("SELECT document_version FROM erp_signatures WHERE document_type='BATCH' AND document_id=$1 AND sign_type=$2 ORDER BY signed_at DESC LIMIT 1",[id,type]);const version=prev.rows.length?Number(prev.rows[0].document_version)+1:1;const snap=await c.query(`SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.sequence_no),'[]'::jsonb) FROM erp_batch_steps x WHERE x.batch_id=$1) steps,(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb) FROM erp_batch_parameters x WHERE x.batch_id=$1) parameters,(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb) FROM erp_qc_results x WHERE x.batch_id=$1) qc_results,(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb) FROM erp_product_bom x WHERE upper(x.product_code)=upper($2) AND x.is_active=true) active_bom`,[id,p.item_code||'']);const signedSnapshot={batch_id:id,sign_type:type,version,production:p,record:snap.rows[0],reason};const hash=crypto.createHash('sha256').update(JSON.stringify(signedSnapshot)).digest('hex');const s=await c.query(`INSERT INTO erp_signatures(signer_user_id,signer_name,signer_role,sign_type,document_type,document_id,document_version,auth_method,decision,reason,document_hash) VALUES($1,$2,$3,$4,'BATCH',$5,$6,'PIN_REAUTH','APPROVED',$7,$8) RETURNING id`,[u.rows[0].id,u.rows[0].full_name,u.rows[0].role,type,id,version,reason,hash]);if(type==='QA_RELEASE')await c.query("UPDATE productions SET qa_disposition='RELEASED',status='RELEASED',approved_by=$1 WHERE batch_id=$2",[u.rows[0].id,id]);else if(type==='PRODUCTION_REVIEW')await c.query("UPDATE productions SET status=CASE WHEN status='ON_HOLD' THEN status ELSE 'PENDING_QA' END, qa_disposition=CASE WHEN qa_disposition='ON_HOLD' THEN qa_disposition ELSE 'PENDING_QA' END WHERE batch_id=$1",[id]);await audit(c,req,'ELECTRONIC_SIGNOFF','BATCH',id,reason,{qa_disposition:p.qa_disposition,status:p.status},{sign_type:type,signature_id:s.rows[0].id,version,decision:'APPROVED',document_hash:hash});await c.query('COMMIT');res.redirect(`/erp/batch-records/${encodeURIComponent(id)}?success=`+encodeURIComponent(`${type} tercatat dengan timestamp server.`));
    }catch(e){await c.query('ROLLBACK');res.redirect(`/erp/batch-records/${encodeURIComponent(id)}?error=`+encodeURIComponent(e.message));}finally{c.release();}
  });

  app.get('/erp/inventory-adjustment',isAuthenticated,(req,res)=>res.redirect('/inventory'));
  app.post('/erp/inventory-adjustment/issue',isAuthenticated,(req,res)=>res.redirect('/inventory?error=Use+View+Batch+to+record+stock+issues'));

  app.post('/api/user-activity/heartbeat',isAuthenticated,async(req,res)=>{
    const seconds=Math.max(0,Math.min(90,Math.floor(Number(req.body?.active_seconds)||0)));
    try{
      await pool.query(`INSERT INTO erp_user_activity(user_id,active_seconds,last_heartbeat,updated_at)
        VALUES($1,$2,clock_timestamp(),clock_timestamp())
        ON CONFLICT(user_id) DO UPDATE SET active_seconds=erp_user_activity.active_seconds+EXCLUDED.active_seconds,
        last_heartbeat=clock_timestamp(),updated_at=clock_timestamp()`,[req.session.user.id,seconds]);
      res.set('Cache-Control','no-store');res.json({ok:true});
    }catch(e){console.error('User activity heartbeat',e.message);res.status(500).json({ok:false});}
  });

  app.get('/erp/labels',isAuthenticated,async(req,res)=>{try{const [batches,assets,jobs]=await Promise.all([pool.query('SELECT batch_id,item_code,production_date,calib_time,raw_yield_mci,status,qa_disposition FROM productions ORDER BY created_at DESC LIMIT 100'),pool.query("SELECT asset_code,name,status FROM assets WHERE category ILIKE '%leadpot%' OR asset_code ILIKE 'LP-%' ORDER BY asset_code"),pool.query('SELECT * FROM erp_label_jobs ORDER BY printed_at DESC LIMIT 30')]);res.render('erp/labels',{page:'erp-labels',batches:batches.rows,assets:assets.rows,jobs:jobs.rows,query:req.query});}catch(e){console.error(e);res.status(500).send('Gagal memuat Label Station.');}});
  app.post('/erp/labels/create',isAuthenticated,async(req,res)=>{
    const type=String(req.body.label_type||'').toUpperCase(),batchId=String(req.body.batch_id||'').trim(),entityCode=String(req.body.entity_id||'').trim();
    if(!['VIAL','LEADPOT','CONTAINER'].includes(type)||!batchId||!entityCode)return res.redirect('/erp/labels?error='+encodeURIComponent('Select a label type, batch, and label code.'));
    try{
      const result=await pool.query(`SELECT p.*,COALESCE(wo.product_name,pr.name,'IMSCan-GluTrace') product_name,COALESCE(wo.product_code,p.item_code,'') resolved_product_code,
        COALESCE(cc.customer_names,'') customer_names
        FROM productions p LEFT JOIN products pr ON pr.code=p.item_code LEFT JOIN roadmap_work_orders wo ON wo.batch_id=p.batch_id
        LEFT JOIN LATERAL(SELECT string_agg(c.name,', ' ORDER BY c.name) customer_names FROM roadmap_work_order_customers wc JOIN customers c ON c.id=wc.customer_id WHERE wc.work_order_id=wo.id) cc ON true
        WHERE p.batch_id=$1`,[batchId]);
      if(!result.rows.length)throw new Error('Production batch was not found.');
      const production=result.rows[0];
      if(type==='LEADPOT'||type==='CONTAINER'){
        const a=await pool.query('SELECT id,asset_code,status FROM assets WHERE asset_code=$1',[entityCode]);
        if(!a.rows.length)throw new Error('Leadpot Code must exist in Asset Management.');
        if(a.rows[0].status==='DISPOSED')throw new Error('A disposed asset cannot be used for a label.');
      }
      const body=req.body||{};
      const payload={
        label_type:type,entity_id:entityCode,batch_id:batchId,
        product_code:production.resolved_product_code||'',product_name:String(body.product_name||production.product_name||'IMSCan-GluTrace').trim(),
        isotope_name:String(body.isotope_name||'¹⁸F-Fludeoxyglucose').trim(),
        production_date:production.production_date||null,qa_disposition:production.qa_disposition||'PENDING',
        customer_name:String(body.customer_name||production.customer_names||'').trim(),
        activity_concentration:body.activity_concentration===''?null:Number(body.activity_concentration),
        activity_mci:body.activity_mci===''?null:Number(body.activity_mci),volume_ml:body.volume_ml===''?null:Number(body.volume_ml),
        manufacture_datetime:body.manufacture_datetime||null,expiry_datetime:body.expiry_datetime||null,
        synthesis_route:String(body.synthesis_route||'').trim(),marketing_authorization_no:String(body.marketing_authorization_no||'').trim(),
        time_reference:String(body.time_reference||'WIB / UTC+7').trim(),
        pharmaceutical_form:String(body.pharmaceutical_form||'Injection').trim(),composition:String(body.composition||'').trim(),
        pig_lead_statement:String(body.pig_lead_statement||'').trim(),storage_instruction:String(body.storage_instruction||'Store upright in a lead-shield container below 30°C. Use within 12 hours after dispensing starts.').trim(),
        het_price_per_vial:body.het_price_per_vial===''||body.het_price_per_vial==null?null:Number(body.het_price_per_vial),
        registered_by_name:String(body.registered_by_name||'PT Interskala Medika Solusindo').trim(),
        registered_address:String(body.registered_address||'Rukan Crown, Greenlake City B06 Tangerang - Indonesia').trim(),
        manufacturer_name:String(body.manufacturer_name||'PT Interskala Medika Solusindo').trim(),
        manufacturing_address:String(body.manufacturing_address||'KEK Industri Batang - Indonesia').trim(),
        calibration_time:production.calib_time||null
      };
      if(type==='VIAL'){
        if(!payload.customer_name||!payload.marketing_authorization_no||!payload.synthesis_route||!payload.manufacture_datetime||!payload.expiry_datetime||!(payload.activity_concentration>0)||!(payload.activity_mci>=0)||!(payload.volume_ml>0))throw new Error('Complete all required vial label fields.');
      }else{
        if(!payload.customer_name||!payload.manufacture_datetime||!payload.expiry_datetime||!(payload.activity_concentration>0)||!(payload.activity_mci>=0)||!(payload.volume_ml>0))throw new Error('Complete all required leadpot label fields.');
      }
      if(payload.het_price_per_vial!==null&&(!Number.isFinite(payload.het_price_per_vial)||payload.het_price_per_vial<0))throw new Error('HET price must be zero or greater.');
      const hash=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const r=await pool.query('INSERT INTO erp_label_jobs(label_type,entity_type,entity_id,batch_id,payload,payload_hash,printed_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id',[type,type,entityCode,batchId,JSON.stringify(payload),hash,req.session.user.id]);
      await audit(pool,req,'LABEL_PRINT_JOB_CREATED','LABEL_JOB',r.rows[0].id,'Label generated from batch and user-entered label fields',null,payload);
      res.redirect('/erp/labels/print/'+r.rows[0].id);
    }catch(e){res.redirect('/erp/labels?error='+encodeURIComponent(e.message));}
  });
  app.get('/erp/labels/print/:id',isAuthenticated,async(req,res)=>{
    try{
      const r=await pool.query('SELECT * FROM erp_label_jobs WHERE id=$1',[req.params.id]);
      if(!r.rows.length)return res.status(404).send('Label was not found.');
      const qrSvg='';
      res.render('labels/print',{job:r.rows[0],payload:r.rows[0].payload,barcodeSvg:code39Svg(r.rows[0].entity_id),qrSvg});
    }catch(e){res.status(500).send('Unable to prepare label.');}
  });

  app.get('/erp/distribution',isAuthenticated,async(req,res)=>{try{const [plans,dos,users,measurements,locations,pod,returns,assets]=await Promise.all([pool.query('SELECT * FROM dispatch_plans ORDER BY id DESC LIMIT 100'),pool.query('SELECT d.*,fr.status AS readiness_status,fr.dosimeter_id,fr.dosimeter_calibration_due FROM erp_delivery_orders d LEFT JOIN erp_fleet_readiness fr ON fr.delivery_order_id=d.id ORDER BY d.created_at DESC LIMIT 100'),pool.query("SELECT id,full_name,role FROM users WHERE lower(role) LIKE '%driver%' OR lower(role) LIKE '%kurir%' OR lower(role) LIKE '%logistic%' OR lower(role) LIKE '%admin%' OR lower(role) LIKE '%scm%' ORDER BY full_name"),pool.query('SELECT m.*,d.do_number,d.batch_id,d.hospital_name FROM erp_radiation_measurements m JOIN erp_delivery_orders d ON d.id=m.delivery_order_id ORDER BY m.measured_at DESC LIMIT 30'),pool.query('SELECT DISTINCT ON(delivery_order_id) l.*,d.do_number,d.batch_id,d.hospital_name FROM erp_driver_locations l JOIN erp_delivery_orders d ON d.id=l.delivery_order_id ORDER BY delivery_order_id,server_received_at DESC'),pool.query('SELECT * FROM erp_proof_of_delivery ORDER BY created_at DESC LIMIT 30'),pool.query('SELECT * FROM erp_reverse_logistics ORDER BY received_at DESC LIMIT 30'),pool.query("SELECT id,asset_code,name,category,status FROM assets WHERE status='AVAILABLE' AND (category ILIKE '%leadpot%' OR category ILIKE '%shield%' OR category ILIKE '%container%' OR asset_code ILIKE 'LP-%' OR name ILIKE '%leadpot%' OR name ILIKE '%shield%' OR name ILIKE '%container%') ORDER BY asset_code")]);res.render('erp/distribution',{page:'erp-distribution',plans:plans.rows,deliveries:dos.rows,users:users.rows,measurements:measurements.rows,locations:locations.rows,pod:pod.rows,returns:returns.rows,assets:assets.rows,query:req.query});}catch(e){console.error(e);res.status(500).send('Gagal memuat distribusi terintegrasi.');}});

  app.get('/erp/distribution/:id/print',isAuthenticated,async(req,res)=>{
    try{
      const q=await pool.query(`SELECT d.*,dp.order_reference,dp.allocated_mci,dp.hospital_name dispatch_customer,p.production_date,p.calib_time,p.item_code,
        COALESCE(wo.product_name,pr.name,'18F-FDG Injection') product_name,COALESCE(wo.product_code,p.item_code,'') product_code,
        c.customer_code customer_code,c.id customer_id,u.full_name driver_name
        FROM erp_delivery_orders d LEFT JOIN dispatch_plans dp ON dp.id=d.dispatch_plan_id
        LEFT JOIN productions p ON p.batch_id=d.batch_id LEFT JOIN products pr ON pr.code=p.item_code
        LEFT JOIN roadmap_work_orders wo ON wo.batch_id=d.batch_id
        LEFT JOIN customers c ON lower(trim(c.name))=lower(trim(d.hospital_name)) LEFT JOIN users u ON u.id=d.driver_user_id
        WHERE d.id=$1`,[req.params.id]);
      if(!q.rows.length)return res.status(404).send('Delivery Order tidak ditemukan.');
      const d=q.rows[0];
      const mr=await pool.query('SELECT * FROM erp_radiation_measurements WHERE delivery_order_id=$1 ORDER BY measured_at DESC LIMIT 1',[d.id]);
      const m=mr.rows[0]||null;
      const rates=m?[m.surface_front,m.surface_back,m.surface_left,m.surface_right].map(Number).filter(Number.isFinite):[];
      d.surface_dose_rate=rates.length?Math.max(...rates):((d.payload||{}).surface_dose_rate_input||'');
      res.render('erp/delivery-order-print',{delivery:d,measurement:m,layoutless:true});
    }catch(e){console.error(e);res.status(500).send('Print Delivery Order gagal dibuat.');}
  });

  app.post('/erp/distribution/:id/handover',isAuthenticated,async(req,res)=>{
    const keys=['product_in_primary_shield','shield_condition_good','shielding_lid_secure'];
    const checks=Object.fromEntries(keys.map(k=>[k,req.body[k]==='on']));
    if(!keys.every(k=>checks[k]))return res.redirect('/erp/distribution?error=Serah+terima+internal+belum+lulus%3A+seluruh+3+butir+checklist+wajib+dicentang.');
    try{
      const d=await pool.query('SELECT * FROM erp_delivery_orders WHERE id=$1',[req.params.id]);
      if(!d.rows.length)throw new Error('Delivery not found.');
      if(!['DRAFT','RADIATION_CHECK'].includes(d.rows[0].status))throw new Error('Serah-terima internal hanya sebelum dispatch.');
      const payload={...(d.rows[0].payload||{}),internal_handover:{...checks,checked_by:req.session.user.full_name,checked_at:new Date().toISOString()}};
      await pool.query('UPDATE erp_delivery_orders SET payload=$1::jsonb WHERE id=$2',[JSON.stringify(payload),d.rows[0].id]);
      await audit(pool,req,'INTERNAL_PRODUCT_HANDOVER_RECORDED','DELIVERY_ORDER',d.rows[0].id,'IMS.SC.007-F-02 internal product handover',null,payload.internal_handover);
      res.redirect('/erp/distribution?success=Checklist+serah+terima+internal+tersimpan.');
    }catch(e){res.redirect('/erp/distribution?error='+encodeURIComponent(e.message));}
  });

  app.post('/erp/distribution/create-do',isAuthenticated,async(req,res)=>{const dispatchId=Number(req.body.dispatch_plan_id),driverId=req.body.driver_user_id?Number(req.body.driver_user_id):null,vehicle=String(req.body.vehicle_code||'').trim(),route=String(req.body.route_code||'').trim(),c=await pool.connect();try{await c.query('BEGIN');const pR=await c.query('SELECT * FROM dispatch_plans WHERE id=$1 FOR UPDATE',[dispatchId]);if(!pR.rows.length)throw new Error('Dispatch plan tidak ditemukan.');const p=pR.rows[0],prod=await c.query('SELECT * FROM productions WHERE batch_id=$1',[p.production_batch_id]);if(!prod.rows.length)throw new Error('Batch terkait tidak ditemukan.');if(prod.rows[0].qa_disposition!=='RELEASED')throw new Error('e-DO diblokir: batch belum QA RELEASED.');const cust=await c.query("SELECT id,status,qualification_status,customer_code,COALESCE(is_active,true) is_active FROM customers WHERE lower(trim(name))=lower(trim($1))",[p.hospital_name]);if(!cust.rows.length||cust.rows[0].status!=='ACTIVE'||cust.rows[0].is_active===false)throw new Error('Customer tidak terdaftar/aktif di master customer. Verifikasi status master dan izin sebelum distribusi.');if(cust.rows[0].qualification_status&&cust.rows[0].qualification_status!=='QUALIFIED')throw new Error('Distribusi diblokir: status customer belum QUALIFIED oleh QA.');const leadpot=String(req.body.leadpot_code||p.asset_code||'').trim();if(!leadpot)throw new Error('Pilih leadpot/container pada daftar aset yang available.');const asset=await c.query("SELECT * FROM assets WHERE asset_code=$1 AND status='AVAILABLE' AND (category ILIKE '%leadpot%' OR category ILIKE '%shield%' OR category ILIKE '%container%' OR asset_code ILIKE 'LP-%' OR name ILIKE '%leadpot%' OR name ILIKE '%shield%' OR name ILIKE '%container%') FOR UPDATE",[leadpot]);if(!asset.rows.length)throw new Error('Leadpot/container tidak tersedia atau tidak terdaftar sebagai aset pelindung yang eligible.');if(driverId&&!(await c.query("SELECT id FROM users WHERE id=$1 AND COALESCE(account_status,'ACTIVE')='ACTIVE'",[driverId])).rows.length)throw new Error('Driver tidak ditemukan/akun tidak aktif.');const num=`DO-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(Date.now()).slice(-6)}`;const r=await c.query(`INSERT INTO erp_delivery_orders(do_number,dispatch_plan_id,batch_id,hospital_name,leadpot_code,driver_user_id,vehicle_code,route_code,status,created_by,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10::jsonb) RETURNING *`,[num,p.id,p.production_batch_id,p.hospital_name,leadpot,driverId,vehicle||null,route||null,req.session.user.id,JSON.stringify({allocated_mci:p.allocated_mci,order_reference:p.order_reference,customer_id:cust.rows[0].customer_code||cust.rows[0].id,leadpot_code:leadpot,customer_po_no:String(req.body.customer_po_no||'').trim(),sales_order_no:String(req.body.sales_order_no||'').trim(),calibration_datetime:String(req.body.calibration_datetime||'').trim(),expiry_datetime:String(req.body.expiry_datetime||'').trim(),packaging_category:String(req.body.packaging_category||'II-Yellow').trim(),transport_index:String(req.body.transport_index||'').trim(),surface_dose_rate_input:String(req.body.surface_dose_rate||'').trim()})]);await audit(c,req,'DELIVERY_ORDER_CREATED','DELIVERY_ORDER',r.rows[0].id,'Created from dispatch plan',null,r.rows[0]);await c.query('COMMIT');res.redirect('/erp/distribution?success='+encodeURIComponent(`Draft e-DO ${num} dibuat.`));}catch(e){await c.query('ROLLBACK');res.redirect('/erp/distribution?error='+encodeURIComponent(e.message));}finally{c.release();}});

  app.post('/erp/distribution/:id/readiness',isAuthenticated,async(req,res)=>{
    const id=Number(req.params.id),role=String(req.session.user.role||'');
    if(!/(administrator|system admin|scm|logistic|supervisor|driver)/i.test(role))return res.status(403).send('Akses ditolak: pre-departure checklist membutuhkan role operasional berwenang.');
    const driverId=Number(req.body.driver_user_id),vehicle=String(req.body.vehicle_code||'').trim(),route=String(req.body.route_code||'').trim(),dosimeter=String(req.body.dosimeter_id||'').trim(),due=String(req.body.dosimeter_calibration_due||'').trim();
    const checks=['brakes','tire_pressure','lights','fuel','ac_cargo','cargo_cleanliness','double_lock','cargo_seatbelt','gps','apar','first_aid','spill_kit','dosimeter'];
    const checklist=Object.fromEntries(checks.map(k=>[k,req.body['check_'+k]==='on']));
    const allPass=checks.every(k=>checklist[k]);
    if(!Number.isInteger(driverId)||!vehicle||!route||!dosimeter||!due)return res.redirect('/erp/distribution?error=Driver,+vehicle,+route,+dosimeter,+dan+masa+kalibrasi+wajib+diisi');
    if(new Date(due)<new Date(new Date().toISOString().slice(0,10)))return res.redirect('/erp/distribution?error=Kalibrasi+personal+dosimeter+sudah+kedaluwarsa');
    const c=await pool.connect();try{await c.query('BEGIN');const d=await c.query('SELECT * FROM erp_delivery_orders WHERE id=$1 FOR UPDATE',[id]);if(!d.rows.length)throw new Error('Delivery not found.');if(!['DRAFT','RADIATION_CHECK'].includes(d.rows[0].status))throw new Error('Checklist hanya boleh diperbarui sebelum dispatch.');const driver=await c.query('SELECT id,role FROM users WHERE id=$1',[driverId]);if(!driver.rows.length)throw new Error('Driver tidak ditemukan.');if(!/driver|courier|kurir|logistic|supervisor|administrator/i.test(driver.rows[0].role||''))throw new Error('Akun yang ditugaskan belum memiliki role driver/kurir/logistik yang sesuai.');const status=allPass?'PASS':'FAILED';const r=await c.query(`INSERT INTO erp_fleet_readiness(delivery_order_id,driver_user_id,vehicle_code,dosimeter_id,dosimeter_calibration_due,checklist,status,checked_by,review_note) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ON CONFLICT(delivery_order_id) DO UPDATE SET driver_user_id=EXCLUDED.driver_user_id,vehicle_code=EXCLUDED.vehicle_code,dosimeter_id=EXCLUDED.dosimeter_id,dosimeter_calibration_due=EXCLUDED.dosimeter_calibration_due,checklist=EXCLUDED.checklist,status=EXCLUDED.status,checked_by=EXCLUDED.checked_by,checked_at=clock_timestamp(),review_note=EXCLUDED.review_note RETURNING id,status`,[id,driverId,vehicle,dosimeter,due,JSON.stringify(checklist),status,req.session.user.id,String(req.body.review_note||'').slice(0,1000)||null]);await c.query("UPDATE erp_delivery_orders SET driver_user_id=$1,vehicle_code=$2,route_code=$3,status=CASE WHEN status='DRAFT' THEN 'RADIATION_CHECK' ELSE status END WHERE id=$4",[driverId,vehicle,route,id]);await audit(c,req,'FLEET_READINESS_RECORDED','DELIVERY_ORDER',id,'Pre-departure vehicle/driver checklist',{status:d.rows[0].status},{readiness_status:status,checklist,driver_user_id:driverId,vehicle_code:vehicle,dosimeter_id:dosimeter,dosimeter_calibration_due:due});await c.query('COMMIT');res.redirect('/erp/distribution?'+(allPass?'success=Pre-departure+checklist+lulus':'error=Pre-departure+checklist+gagal.+Lengkapi+semua+pemeriksaan+sebelum+dispatch'));
    }catch(e){await c.query('ROLLBACK');res.redirect('/erp/distribution?error='+encodeURIComponent(e.message));}finally{c.release();}
  });

  app.post('/erp/distribution/:id/measurement',isAuthenticated,async(req,res)=>{const id=Number(req.params.id),instrument=String(req.body.instrument_id||'').trim(),unit=String(req.body.unit||'').trim(),due=req.body.calibration_due||null,fs=['background_rate','surface_front','surface_back','surface_left','surface_right','rate_at_one_meter'],v={};for(const f of fs)v[f]=req.body[f]===''||req.body[f]==null?null:Number(req.body[f]);if(!instrument||!unit||!due||fs.some(f=>v[f]===null||!Number.isFinite(v[f])||v[f]<0))return res.redirect('/erp/distribution?error=ID+instrumen,+unit,+tanggal+kalibrasi,+dan+nilai+pengukuran+wajib+valid');try{const d=await pool.query('SELECT * FROM erp_delivery_orders WHERE id=$1',[id]);if(!d.rows.length)throw new Error('Delivery not found.');if(!['DRAFT','RADIATION_CHECK'].includes(d.rows[0].status))throw new Error('Measurements can only be recorded before dispatch.');if(!due)throw new Error('Survey meter calibration date is required.');if(new Date(due)<new Date(new Date().toISOString().slice(0,10)))throw new Error('Instrument calibration has expired.');const hash=crypto.createHash('sha256').update(JSON.stringify({id,instrument,due,unit,v,actor:req.session.user.id})).digest('hex');const m=await pool.query(`INSERT INTO erp_radiation_measurements(delivery_order_id,measured_by,instrument_id,calibration_due,background_rate,surface_front,surface_back,surface_left,surface_right,rate_at_one_meter,unit,notes,record_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[id,req.session.user.id,instrument,due,v.background_rate,v.surface_front,v.surface_back,v.surface_left,v.surface_right,v.rate_at_one_meter,unit,String(req.body.notes||'').slice(0,1000)||null,hash]);await pool.query("UPDATE erp_delivery_orders SET status='RADIATION_CHECK' WHERE id=$1",[id]);await audit(pool,req,'RADIATION_MEASUREMENT_RECORDED','DELIVERY_ORDER',id,'Measurement waits for independent verification',null,{measurement_id:m.rows[0].id,instrument,unit,values:v,calibration_due:due});res.redirect('/erp/distribution?success=Pengukuran+tersimpan,+menunggu+verifikasi+independen.');}catch(e){res.redirect('/erp/distribution?error='+encodeURIComponent(e.message));}});

  app.post('/erp/distribution/:id/verify-measurement',isAuthenticated,async(req,res)=>{const id=Number(req.params.id),pin=String(req.body.pin||''),c=await pool.connect();try{await c.query('BEGIN');const u=await c.query('SELECT * FROM users WHERE id=$1',[req.session.user.id]);if(!u.rows[0]?.pin||!verifyCredential(pin,u.rows[0].pin))throw new Error('Invalid verifier PIN.');if(!/(ppr|radiation|safety|supervisor|administrator)/i.test(String(u.rows[0].role||'')))throw new Error('This role is not authorized to verify radiation measurements.');const m=await c.query('SELECT * FROM erp_radiation_measurements WHERE delivery_order_id=$1 ORDER BY measured_at DESC LIMIT 1 FOR UPDATE',[id]);if(!m.rows.length)throw new Error('No measurement recorded.');if(m.rows[0].measured_by===req.session.user.id)throw new Error('Separation of duties: the person who measured cannot verify their own result.');if(m.rows[0].calibration_due&&new Date(m.rows[0].calibration_due)<new Date(new Date().toISOString().slice(0,10)))throw new Error('Instrument calibration has expired.');await c.query("UPDATE erp_radiation_measurements SET status='VERIFIED',verified_by=$1,verified_at=clock_timestamp() WHERE id=$2",[req.session.user.id,m.rows[0].id]);const hash=crypto.createHash('sha256').update(JSON.stringify({measurement_id:m.rows[0].id,record_hash:m.rows[0].record_hash,verifier:req.session.user.id})).digest('hex');await c.query(`INSERT INTO erp_signatures(signer_user_id,signer_name,signer_role,sign_type,document_type,document_id,auth_method,decision,reason,document_hash) VALUES($1,$2,$3,'RADIATION_MEASUREMENT_APPROVAL','DELIVERY_ORDER',$4,'PIN_REAUTH','APPROVED','Independent radiation measurement verification',$5)`,[req.session.user.id,req.session.user.full_name,req.session.user.role,String(id),hash]);await audit(c,req,'RADIATION_MEASUREMENT_VERIFIED','DELIVERY_ORDER',id,'Independent measurement verification',{status:m.rows[0].status},{status:'VERIFIED',measurement_id:m.rows[0].id});await c.query('COMMIT');res.redirect('/erp/distribution?success=Pengukuran+diverifikasi.');}catch(e){await c.query('ROLLBACK');res.redirect('/erp/distribution?error='+encodeURIComponent(e.message));}finally{c.release();}});

  app.post('/erp/distribution/:id/dispatch',isAuthenticated,async(req,res)=>{const id=Number(req.params.id),seal=String(req.body.seal_number||'').trim(),c=await pool.connect();try{await c.query('BEGIN');const dr=await c.query('SELECT * FROM erp_delivery_orders WHERE id=$1 FOR UPDATE',[id]);if(!dr.rows.length)throw new Error('Delivery not found.');const d=dr.rows[0];if(!['DRAFT','RADIATION_CHECK'].includes(d.status))throw new Error('Dispatch requires DRAFT or RADIATION_CHECK status.');if(!seal)throw new Error('Seal number is required.');const handover=(d.payload||{}).internal_handover;if(!handover||!handover.product_in_primary_shield||!handover.shield_condition_good||!handover.shielding_lid_secure)throw new Error('Dispatch blocked: internal product handover is incomplete.');const fr=await c.query('SELECT * FROM erp_fleet_readiness WHERE delivery_order_id=$1 FOR UPDATE',[id]);if(!fr.rows.length||fr.rows[0].status!=='PASS')throw new Error('Dispatch blocked: the pre-departure checklist has not passed.');if(Number(fr.rows[0].driver_user_id)!==Number(d.driver_user_id)||String(fr.rows[0].vehicle_code)!==String(d.vehicle_code))throw new Error('The delivery driver or vehicle differs from the approved checklist. Update the checklist.');if(new Date(fr.rows[0].dosimeter_calibration_due)<new Date(new Date().toISOString().slice(0,10)))throw new Error('Personal dosimeter calibration has expired.');const sig=await c.query("SELECT id FROM erp_signatures WHERE document_type='BATCH' AND document_id=$1 AND sign_type='QA_RELEASE' AND decision='APPROVED' LIMIT 1",[d.batch_id]);if(!sig.rows.length)throw new Error('Dispatch blocked: QA release signature not found.');const m=await c.query("SELECT * FROM erp_radiation_measurements WHERE delivery_order_id=$1 AND status='VERIFIED' ORDER BY measured_at DESC LIMIT 1",[id]);if(!m.rows.length)throw new Error('Dispatch blocked: no verified radiation measurement exists.');const p=await c.query('SELECT qa_disposition FROM productions WHERE batch_id=$1',[d.batch_id]);if(p.rows[0]?.qa_disposition!=='RELEASED')throw new Error('The batch is no longer QA released.');const a=await c.query('SELECT status FROM assets WHERE asset_code=$1 FOR UPDATE',[d.leadpot_code]);if(!a.rows.length||a.rows[0].status!=='AVAILABLE')throw new Error('The leadpot is not available.');await c.query("UPDATE erp_delivery_orders SET status='IN_TRANSIT',seal_number=$1,dispatched_at=clock_timestamp() WHERE id=$2",[seal,id]);await c.query("UPDATE dispatch_plans SET status='IN_TRANSIT' WHERE id=$1",[d.dispatch_plan_id]);await c.query('UPDATE assets SET status=$1,current_location=$2 WHERE asset_code=$3',['IN_TRANSIT',d.hospital_name,d.leadpot_code]);await audit(c,req,'DELIVERY_DISPATCHED','DELIVERY_ORDER',id,'Passed batch QA and radiation verification',{status:d.status},{status:'IN_TRANSIT',seal_number:seal,measurement_id:m.rows[0].id});await c.query('COMMIT');res.redirect('/erp/distribution?success=e-DO+dispatch+tercatat.');}catch(e){await c.query('ROLLBACK');res.redirect('/erp/distribution?error='+encodeURIComponent(e.message));}finally{c.release();}});

  // Live Tracking App: every authenticated role can monitor all in-transit deliveries; only the assigned driver/logistics admin can send GPS.
  app.get('/driver/mobile',isAuthenticated,async(req,res)=>{
    try{
      const d=await pool.query(`SELECT d.id,d.do_number,d.batch_id,d.hospital_name,d.route_code,d.status,d.driver_user_id,d.vehicle_code,d.dispatched_at,
        u.full_name driver_name,loc.latitude latest_latitude,loc.longitude latest_longitude,loc.server_received_at last_location_at,loc.accuracy_m
        FROM erp_delivery_orders d LEFT JOIN users u ON u.id=d.driver_user_id
        LEFT JOIN LATERAL (SELECT latitude,longitude,server_received_at,accuracy_m FROM erp_driver_locations WHERE delivery_order_id=d.id ORDER BY server_received_at DESC LIMIT 1) loc ON true
        WHERE d.status='IN_TRANSIT' ORDER BY d.dispatched_at DESC NULLS LAST,d.id DESC`);
      const role=String(req.session.user.role||'');
      res.render('driver/mobile',{page:'driver-mobile',deliveries:d.rows,query:req.query,isTrackingManager:/admin|scm|logistic|distribution|supervisor/i.test(role),userId:Number(req.session.user.id)});
    }catch(e){console.error(e);res.status(500).send('Live Tracking App gagal dibuka.');}
  });
  app.get('/api/live-tracking/active',isAuthenticated,async(req,res)=>{
    try{
      const r=await pool.query(`SELECT d.id delivery_order_id,d.do_number,d.batch_id,d.hospital_name,d.route_code,d.status,d.vehicle_code,d.dispatched_at,
        d.driver_user_id,u.full_name driver_name,loc.latitude,loc.longitude,loc.accuracy_m,loc.device_recorded_at,loc.server_received_at
        FROM erp_delivery_orders d LEFT JOIN users u ON u.id=d.driver_user_id
        LEFT JOIN LATERAL (SELECT latitude,longitude,accuracy_m,device_recorded_at,server_received_at FROM erp_driver_locations WHERE delivery_order_id=d.id ORDER BY server_received_at DESC LIMIT 1) loc ON true
        WHERE d.status='IN_TRANSIT' ORDER BY d.dispatched_at DESC NULLS LAST,d.id DESC`);
      res.set('Cache-Control','no-store');res.json({ok:true,server_time:new Date().toISOString(),deliveries:r.rows});
    }catch(e){console.error(e);res.status(500).json({ok:false,error:'Unable to load Live Tracking data.'});}
  });
  app.post('/api/driver/location',isAuthenticated,async(req,res)=>{const id=Number(req.body.delivery_order_id),lat=Number(req.body.latitude),lon=Number(req.body.longitude),accuracy=req.body.accuracy_m==null?null:Number(req.body.accuracy_m);if(!Number.isInteger(id)||!Number.isFinite(lat)||!Number.isFinite(lon)||lat < -90||lat>90||lon < -180||lon>180)return res.status(400).json({ok:false,error:'Invalid coordinates or delivery ID.'});try{const r=await pool.query('SELECT * FROM erp_delivery_orders WHERE id=$1',[id]);if(!r.rows.length)return res.status(404).json({ok:false,error:'Delivery not found.'});const delivery=r.rows[0];if(delivery.status!=='IN_TRANSIT')return res.status(409).json({ok:false,error:'GPS updates are accepted only for deliveries in transit.'});if(!delivery.driver_user_id)return res.status(409).json({ok:false,error:'No driver is assigned to this delivery.'});if(Number(delivery.driver_user_id)!==Number(req.session.user.id))return res.status(403).json({ok:false,error:'Only the assigned driver can send coordinates. Other users can view Live Tracking.'});const recorded=req.body.device_recorded_at?new Date(req.body.device_recorded_at):null;if(recorded&&!Number.isFinite(recorded.getTime()))return res.status(400).json({ok:false,error:'Invalid device timestamp.'});await pool.query("INSERT INTO erp_driver_locations(delivery_order_id,driver_user_id,latitude,longitude,accuracy_m,device_recorded_at,event_type) VALUES($1,$2,$3,$4,$5,$6,'LOCATION')",[id,req.session.user.id,lat,lon,Number.isFinite(accuracy)?accuracy:null,recorded]);await audit(pool,req,'DRIVER_GPS_RECORDED','DELIVERY_ORDER',id,'Driver browser GPS update',null,{latitude:lat,longitude:lon,accuracy_m:accuracy});res.set('Cache-Control','no-store');res.json({ok:true,received_at:new Date().toISOString()});}catch(e){console.error(e);res.status(500).json({ok:false,error:'Unable to save location.'});}});

  app.post('/erp/distribution/:id/pod',isAuthenticated,async(req,res)=>{const id=Number(req.params.id),receiver=String(req.body.receiver_name||'').trim(),outcome=String(req.body.outcome||'DELIVERED'),notes=String(req.body.notes||'').slice(0,2000),signature=String(req.body.receiver_signature_text||'').trim();if(!receiver||!signature)return res.redirect('/erp/distribution?error=Nama+penerima+dan+konfirmasi+penerimaan+wajib+diisi');const c=await pool.connect();try{await c.query('BEGIN');const r=await c.query('SELECT * FROM erp_delivery_orders WHERE id=$1 FOR UPDATE',[id]);if(!r.rows.length)throw new Error('Delivery not found.');if(r.rows[0].status!=='IN_TRANSIT')throw new Error('Proof of delivery is only available for deliveries in transit.');await c.query('INSERT INTO erp_proof_of_delivery(delivery_order_id,receiver_name,receiver_role,received_at,outcome,notes,receiver_signature_text,created_by) VALUES($1,$2,$3,clock_timestamp(),$4,$5,$6,$7)',[id,receiver,String(req.body.receiver_role||'').slice(0,100)||null,outcome,notes,signature,req.session.user.id]);const deliveredStatus=outcome==='DELIVERED'?'DELIVERED':'DELIVERY_EXCEPTION';await c.query('UPDATE erp_delivery_orders SET status=$1,delivered_at=clock_timestamp() WHERE id=$2',[deliveredStatus,id]);if(deliveredStatus==='DELIVERED'){
      await c.query("UPDATE dispatch_plans SET status='DELIVERED' WHERE id=$1",[r.rows[0].dispatch_plan_id]);
      const sale=await c.query(`SELECT d.id delivery_order_id,d.dispatch_plan_id,d.batch_id,c.id customer_id,
        COALESCE(wo.product_code,p.item_code) product_code,COALESCE(wo.product_name,pr.name,p.item_code,'Product') product_name,
        COALESCE(dp.allocated_mci,0)::numeric quantity,pricing.id pricing_id,
        CASE WHEN lower(COALESCE(pricing.uom,''))='mci' THEN pricing.price/NULLIF(pricing.pricing_quantity,0) ELSE NULL END unit_price,
        'mCi'::text sales_uom,
        COALESCE(d.delivered_at,clock_timestamp()) occurred_at
        FROM erp_delivery_orders d JOIN dispatch_plans dp ON dp.id=d.dispatch_plan_id
        JOIN productions p ON p.batch_id=d.batch_id
        LEFT JOIN roadmap_work_orders wo ON wo.batch_id=d.batch_id
        LEFT JOIN products pr ON pr.code=COALESCE(wo.product_code,p.item_code)
        JOIN customers c ON lower(trim(c.name))=lower(trim(d.hospital_name))
        LEFT JOIN LATERAL (SELECT cp.* FROM erp_customer_product_pricing cp
          WHERE cp.customer_id=c.id AND lower(cp.product_code)=lower(COALESCE(wo.product_code,p.item_code,''))
          ORDER BY CASE WHEN lower(cp.uom)='mci' THEN 0 ELSE 1 END,cp.updated_at DESC LIMIT 1) pricing ON true
        WHERE d.id=$1`,[id]);
      if(sale.rows.length){const x=sale.rows[0],recognized=x.unit_price!==null&&Number(x.quantity)>=0;
        await c.query(`INSERT INTO erp_sales_transactions(delivery_order_id,dispatch_plan_id,customer_id,batch_id,product_code,product_name,quantity,uom,pricing_id,unit_price,total_amount,status,occurred_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10::numeric IS NULL THEN NULL ELSE $7::numeric*$10::numeric END,$11,$12)
          ON CONFLICT(delivery_order_id) DO UPDATE SET customer_id=EXCLUDED.customer_id,batch_id=EXCLUDED.batch_id,product_code=EXCLUDED.product_code,
            product_name=EXCLUDED.product_name,quantity=EXCLUDED.quantity,uom=EXCLUDED.uom,pricing_id=EXCLUDED.pricing_id,unit_price=EXCLUDED.unit_price,
            total_amount=EXCLUDED.total_amount,status=EXCLUDED.status,occurred_at=EXCLUDED.occurred_at,updated_at=clock_timestamp()`,
          [x.delivery_order_id,x.dispatch_plan_id,x.customer_id,x.batch_id,x.product_code,x.product_name,x.quantity,x.sales_uom,x.pricing_id,x.unit_price,recognized?'RECOGNIZED':'PENDING_PRICING',x.occurred_at]);
      }
    }
    await audit(c,req,'PROOF_OF_DELIVERY_RECORDED','DELIVERY_ORDER',id,'Receiver acknowledgement',{status:'IN_TRANSIT'},{status:deliveredStatus,receiver,outcome});await c.query('COMMIT');res.redirect('/erp/distribution?success=e-POD+disimpan.+Lanjutkan+reverse+logistics.');}catch(e){await c.query('ROLLBACK');res.redirect('/erp/distribution?error='+encodeURIComponent(e.message));}finally{c.release();}});
  app.post('/erp/distribution/:id/return',isAuthenticated,async(req,res)=>{const id=Number(req.params.id),code=String(req.body.item_code||'').trim(),condition=String(req.body.condition_status||'').trim(),notes=String(req.body.notes||'').slice(0,1000);if(!code||!['GOOD','INSPECT','DAMAGED','QUARANTINE'].includes(condition))return res.redirect('/erp/distribution?error=Kode+kontainer+dan+kondisi+return+wajib+valid');const c=await pool.connect();try{await c.query('BEGIN');const d=await c.query('SELECT * FROM erp_delivery_orders WHERE id=$1 FOR UPDATE',[id]);if(!d.rows.length)throw new Error('Delivery not found.');if(!['DELIVERED','DELIVERY_EXCEPTION','RETURN_PENDING','CLOSED'].includes(d.rows[0].status))throw new Error('Reverse logistics is available only after proof of delivery.');await c.query('INSERT INTO erp_reverse_logistics(delivery_order_id,item_code,condition_status,returned_by,notes) VALUES($1,$2,$3,$4,$5)',[id,code,condition,req.session.user.id,notes]);const exists=await c.query('SELECT id FROM assets WHERE asset_code=$1',[code]);if(exists.rows.length)await c.query('UPDATE assets SET status=$1,current_location=$2 WHERE asset_code=$3',[condition==='GOOD'?'AVAILABLE':condition==='INSPECT'?'MAINTENANCE':'QUARANTINE','FACILITY',code]);const complete=code===d.rows[0].leadpot_code;await c.query('UPDATE erp_delivery_orders SET status=$1 WHERE id=$2',[complete?'CLOSED':'RETURN_PENDING',id]);await audit(c,req,'REVERSE_LOGISTICS_RECEIVED','DELIVERY_ORDER',id,notes,{status:d.rows[0].status},{returned_item:code,condition,status:complete?'CLOSED':'RETURN_PENDING'});await c.query('COMMIT');res.redirect('/erp/distribution?success=Reverse+logistics+tercatat.');}catch(e){await c.query('ROLLBACK');res.redirect('/erp/distribution?error='+encodeURIComponent(e.message));}finally{c.release();}});
  app.get('/erp/audit',isAuthenticated,async(req,res)=>res.redirect('/security-control?tab=audit'));

  app.get('/erp/access-control',isAuthenticated,async(req,res)=>res.redirect('/security-control?tab=roles'));
  app.post('/erp/access-control/:id/role',isAuthenticated,async(req,res)=>res.redirect('/security-control?tab=roles&error='+encodeURIComponent('Legacy Access Control sudah dipindahkan. Gunakan tab Roles & Permissions pada Security Control.')));
}

module.exports = { installIntegratedSchema, registerIntegratedRoutes, audit };
