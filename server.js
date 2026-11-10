const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/shop' });
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

app.use(express.json());
app.use(express.static('public'));

// ---------- helpers ----------
const wrap = f => (req, res, next) => f(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: 'Server error' }); });
const auth = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'Please log in first' }); }
};
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' });
const sign = u => jwt.sign({ id: u.id, role: u.role, name: u.name }, SECRET, { expiresIn: '7d' });

// ---------- auth ----------
app.post('/api/auth/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Name, email and a password of 6+ characters are required' });
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows: [u] } = await pool.query("INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,role", [name, email.toLowerCase(), hash]);
    res.json({ token: sign(u), user: u });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That email is already registered' });
    throw e;
  }
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE email=$1', [(req.body.email || '').toLowerCase()]);
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password_hash))) return res.status(401).json({ error: 'Wrong email or password' });
  res.json({ token: sign(u), user: { id: u.id, name: u.name, role: u.role } });
}));

// ---------- products ----------
app.get('/api/products', wrap(async (req, res) => {
  res.json((await pool.query('SELECT * FROM products ORDER BY id')).rows);
}));

app.post('/api/products', auth, admin, wrap(async (req, res) => {
  const { name, description = '', price, stock } = req.body;
  if (!name || !(price >= 0) || !(stock >= 0)) return res.status(400).json({ error: 'Name, price and stock are required' });
  res.json((await pool.query('INSERT INTO products(name,description,price,stock) VALUES($1,$2,$3,$4) RETURNING *', [name, description, price, stock])).rows[0]);
}));

app.put('/api/products/:id', auth, admin, wrap(async (req, res) => {
  const { name, description, price, stock } = req.body;
  const { rows: [p] } = await pool.query(
    'UPDATE products SET name=COALESCE($1,name),description=COALESCE($2,description),price=COALESCE($3,price),stock=COALESCE($4,stock) WHERE id=$5 RETURNING *',
    [name, description, price, stock, req.params.id]);
  p ? res.json(p) : res.status(404).json({ error: 'Product not found' });
}));

app.delete('/api/products/:id', auth, admin, wrap(async (req, res) => {
  try { await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) {
    if (e.code === '23503') return res.status(409).json({ error: 'This product is in past orders. Set its stock to 0 instead.' });
    throw e;
  }
}));

// ---------- orders ----------
app.post('/api/orders', auth, wrap(async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Your cart is empty' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let total = 0; const lines = [];
    for (const { productId, qty } of items) {
      const n = parseInt(qty);
      if (!(n > 0)) throw new Error('Invalid quantity');
      const { rows: [p] } = await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [productId]);
      if (!p || p.stock < n) throw new Error(`Not enough stock for ${p ? p.name : 'a product'}`);
      await c.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [n, p.id]);
      total += Number(p.price) * n; lines.push([p.id, n, p.price]);   // price always comes from the DB, never the client
    }
    const { rows: [o] } = await c.query('INSERT INTO orders(user_id,total) VALUES($1,$2) RETURNING *', [req.user.id, total.toFixed(2)]);
    for (const [pid, n, price] of lines) await c.query('INSERT INTO order_items(order_id,product_id,qty,price) VALUES($1,$2,$3,$4)', [o.id, pid, n, price]);
    await c.query('COMMIT');
    res.json(o);
  } catch (e) {
    await c.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { c.release(); }
}));

app.get('/api/orders', auth, wrap(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const { rows } = await pool.query(
    `SELECT o.*, u.email,
       (SELECT json_agg(json_build_object('name',p.name,'qty',i.qty,'price',i.price))
        FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=o.id) AS items
     FROM orders o JOIN users u ON u.id=o.user_id
     ${isAdmin ? '' : 'WHERE o.user_id=$1'} ORDER BY o.id DESC`, isAdmin ? [] : [req.user.id]);
  res.json(rows);
}));

app.patch('/api/orders/:id/status', auth, admin, wrap(async (req, res) => {
  try {
    const { rows: [o] } = await pool.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *', [req.body.status, req.params.id]);
    o ? res.json(o) : res.status(404).json({ error: 'Order not found' });
  } catch (e) { if (e.code === '23514') return res.status(400).json({ error: 'Invalid status' }); throw e; }
}));

// ---------- startup: create tables, seed admin + sample products ----------
(async () => {
  await pool.query(fs.readFileSync(__dirname + '/schema.sql', 'utf8'));
  if (!(await pool.query("SELECT 1 FROM users WHERE role='admin'")).rowCount) {
    await pool.query("INSERT INTO users(name,email,password_hash,role) VALUES('Admin','admin@shop.com',$1,'admin')", [await bcrypt.hash('admin123', 10)]);
    console.log('Seeded admin: admin@shop.com / admin123 (change it!)');
  }
  if (!(await pool.query('SELECT 1 FROM products')).rowCount)
    await pool.query(`INSERT INTO products(name,description,price,stock) VALUES
      ('Ceramic pour-over set','Dripper, server and two cups',48.00,25),
      ('Canvas tote','Heavy cotton, inside pocket',22.50,60),
      ('Desk lamp','Warm LED, adjustable arm',64.00,12)`);
  app.listen(process.env.PORT || 3000, () => console.log('Shop running on http://localhost:' + (process.env.PORT || 3000)));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
