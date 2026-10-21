
require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  connectionTimeoutMillis: 5000,
});

async function testConnection() {
  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        current_user AS username,
        now() AS server_time
    `);

    console.log('✅ Koneksi PostgreSQL berhasil!');
    console.log(result.rows[0]);
  } catch (error) {
    console.error('❌ Koneksi PostgreSQL gagal:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

testConnection();
