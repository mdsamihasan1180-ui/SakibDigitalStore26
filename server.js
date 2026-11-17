// Sakib Digital Store - secure Express + Firebase Admin backend
// Never commit the Firebase service-account key to GitHub.
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PANEL_ROLE = process.env.PANEL_ROLE || 'user';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(x => x.trim()).filter(Boolean);

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: (origin, cb) => {
  if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
  return cb(new Error('Origin not allowed by CORS'));
}, methods: ['GET','POST','PATCH','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '2mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));

const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountText) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT environment variable.');
  process.exit(1);
}
let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountText);
  if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT must contain valid service-account JSON.');
  process.exit(1);
}
const databaseURL = process.env.FIREBASE_DATABASE_URL;
if (!databaseURL) { console.error('Missing FIREBASE_DATABASE_URL.'); process.exit(1); }
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || undefined;
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL, ...(storageBucket ? { storageBucket } : {}) });
const db = admin.database();
const bucket = storageBucket ? admin.storage().bucket() : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = value => String(value ?? '').trim();
const asNumber = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const isAdminEmail = email => (process.env.ADMIN_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(String(email || '').toLowerCase());

const requireAuth = asyncRoute(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Please sign in first.' });
  try {
    req.user = await admin.auth().verifyIdToken(token, true);
    return next();
  } catch { return res.status(401).json({ error: 'Your session expired. Please sign in again.' }); }
});
const requireAdmin = (req, res, next) => {
  if (!req.user || !req.user.email_verified || !isAdminEmail(req.user.email)) return res.status(403).json({ error: 'Admin access requires a verified email listed in ADMIN_EMAILS.' });
  next();
};
const adminAuth = [requireAuth, requireAdmin];
const safeProduct = (id, p) => ({
  id, name: clean(p.name), description: clean(p.description), category: clean(p.category || 'Other'),
  price: asNumber(p.price), currency: 'BDT', imageUrl: clean(p.imageUrl), stock: p.stock === undefined ? -1 : asNumber(p.stock, -1),
  active: p.active !== false, createdAt: p.createdAt || null, updatedAt: p.updatedAt || null
});
const adminProduct = (id, p) => ({ ...safeProduct(id, p), storagePath: clean(p.storagePath) });

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'sakib-digital-store', panel: PANEL_ROLE }));
app.get('/api/store-settings', asyncRoute(async (_req, res) => {
  const snap = await db.ref('storeSettings').get();
  const s = snap.val() || {};
  const methods = s.paymentMethods && typeof s.paymentMethods === 'object' ? s.paymentMethods : {};
  const safeMethods = {};
  for (const [key, value] of Object.entries(methods)) safeMethods[key] = { enabled: value.enabled !== false, label: clean(value.label || key), account: clean(value.account), accountType: clean(value.accountType), instructions: clean(value.instructions) };
  res.json({ storeName: clean(s.storeName || 'Sakib Digital Store'), supportContact: clean(s.supportContact), announcement: clean(s.announcement), paymentMethods: safeMethods });
}));

app.get('/api/products', asyncRoute(async (_req, res) => {
  const snap = await db.ref('products').get();
  const products = [];
  snap.forEach(child => { const p = child.val() || {}; if (p.active !== false) products.push(safeProduct(child.key, p)); });
  products.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ products });
}));

app.post('/api/orders', requireAuth, asyncRoute(async (req, res) => {
  const productId = clean(req.body.productId);
  const quantity = Math.max(1, Math.min(10, Math.floor(asNumber(req.body.quantity, 1))));
  const paymentMethod = clean(req.body.paymentMethod || 'manual');
  const transactionId = clean(req.body.transactionId).slice(0, 100);
  if (!productId) return res.status(400).json({ error: 'Product is required.' });
  const productRef = db.ref(`products/${productId}`);
  let productForOrder = null;
  const reserve = await productRef.transaction(current => {
    if (!current || current.active === false) return;
    const stock = current.stock === undefined ? -1 : asNumber(current.stock, -1);
    if (stock >= 0 && stock < quantity) return;
    if (stock >= 0) current.stock = stock - quantity;
    productForOrder = current;
    return current;
  });
  if (!reserve.committed || !reserve.snapshot.exists()) return res.status(409).json({ error: 'This product is unavailable or there is not enough stock.' });
  productForOrder = reserve.snapshot.val();
  const price = Math.max(0, asNumber(productForOrder.price));
  const total = price * quantity;
  const orderRef = db.ref('orders').push();
  const freeOrder = total === 0;
  const order = {
    uid: req.user.uid, email: req.user.email || '', productId, productName: clean(productForOrder.name),
    price, quantity, total, currency: 'BDT', paymentMethod, transactionId,
    paymentStatus: freeOrder ? 'paid' : 'unpaid', status: freeOrder ? 'processing' : 'pending',
    storagePath: clean(productForOrder.storagePath), stockReserved: asNumber(productForOrder.stock, -1) >= 0, createdAt: Date.now(), updatedAt: Date.now(), stockRestored: false
  };
  try { await orderRef.set(order); }
  catch (e) {
    if (asNumber(productForOrder.stock, -1) >= 0) await productRef.transaction(p => { if (!p) return p; p.stock = asNumber(p.stock) + quantity; return p; });
    throw e;
  }
  await db.ref(`users/${req.user.uid}`).update({ email: req.user.email || '', lastOrderAt: Date.now() }).catch(() => {});
  res.status(201).json({ order: { id: orderRef.key, ...order, storagePath: undefined } });
}));

app.get('/api/orders/mine', requireAuth, asyncRoute(async (req, res) => {
  const snap = await db.ref('orders').orderByChild('uid').equalTo(req.user.uid).get();
  const orders = [];
  snap.forEach(child => {
    const o = child.val() || {};
    orders.push({ id: child.key, productId: o.productId, productName: o.productName, price: o.price, quantity: o.quantity, total: o.total, currency: o.currency || 'BDT', paymentMethod: o.paymentMethod, transactionId: o.transactionId, paymentStatus: o.paymentStatus, status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt, downloadAvailable: o.paymentStatus === 'paid' && !['cancelled','rejected'].includes(o.status) && !!o.storagePath });
  });
  orders.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ orders: orders.slice(0, 100) });
}));

app.get('/api/orders/:id/download', requireAuth, asyncRoute(async (req, res) => {
  const snap = await db.ref(`orders/${req.params.id}`).get();
  if (!snap.exists()) return res.status(404).json({ error: 'Order not found.' });
  const order = snap.val();
  if (order.uid !== req.user.uid) return res.status(403).json({ error: 'This order does not belong to your account.' });
  if (order.paymentStatus !== 'paid' || ['cancelled','rejected'].includes(order.status)) return res.status(403).json({ error: 'Download unlocks only for a verified, active order.' });
  if (!bucket || !order.storagePath) return res.status(404).json({ error: 'The digital file has not been attached by the store yet.' });
  const file = bucket.file(order.storagePath);
  const [exists] = await file.exists();
  if (!exists) return res.status(404).json({ error: 'The digital file is currently unavailable. Contact support.' });
  const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 10 * 60 * 1000, responseDisposition: `attachment; filename="${path.basename(order.storagePath).replace(/[^a-zA-Z0-9._-]/g, '_')}"` });
  res.json({ downloadUrl: url, expiresInSeconds: 600 });
}));

// All routes below are protected by verified Firebase ID token + ADMIN_EMAILS allowlist.
app.get('/api/admin/summary', ...adminAuth, asyncRoute(async (_req, res) => {
  const [ps, os, us] = await Promise.all([db.ref('products').get(), db.ref('orders').get(), admin.auth().listUsers(1000)]);
  let products = 0, activeProducts = 0, orders = 0, pendingOrders = 0, paidOrders = 0, revenue = 0;
  os.forEach(c => { const o = c.val() || {}; orders++; if (o.status === 'pending') pendingOrders++; if (o.paymentStatus === 'paid') { paidOrders++; revenue += asNumber(o.total); } });
  ps.forEach(c => { products++; if ((c.val() || {}).active !== false) activeProducts++; });
  res.json({ products, activeProducts, orders, pendingOrders, paidOrders, revenue, users: us.users.length });
}));
app.get('/api/admin/products', ...adminAuth, asyncRoute(async (_req, res) => {
  const snap = await db.ref('products').get(); const products = [];
  snap.forEach(c => products.push(adminProduct(c.key, c.val() || {})));
  products.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0)); res.json({ products });
}));
app.post('/api/admin/products', ...adminAuth, asyncRoute(async (req, res) => {
  const body = req.body || {}; const name = clean(body.name);
  if (!name) return res.status(400).json({ error: 'Product name is required.' });
  const price = asNumber(body.price, -1), stock = asNumber(body.stock, -1);
  if (price < 0 || stock < -1) return res.status(400).json({ error: 'Price must be 0 or more; stock must be -1 (unlimited) or 0 or more.' });
  const id = clean(body.id); const ref = id ? db.ref(`products/${id}`) : db.ref('products').push();
  const old = (await ref.get()).val() || {};
  const product = { name, description: clean(body.description).slice(0, 5000), category: clean(body.category || 'Other').slice(0, 60), price, imageUrl: clean(body.imageUrl).slice(0, 2000), storagePath: clean(body.storagePath).slice(0, 500), stock, active: body.active !== false, createdAt: old.createdAt || Date.now(), updatedAt: Date.now() };
  await ref.set(product); res.status(id ? 200 : 201).json({ product: adminProduct(ref.key, product) });
}));
app.delete('/api/admin/products/:id', ...adminAuth, asyncRoute(async (req, res) => {
  await db.ref(`products/${req.params.id}`).remove(); res.json({ ok: true });
}));
app.post('/api/admin/upload', ...adminAuth, upload.single('file'), asyncRoute(async (req, res) => {
  if (!bucket) return res.status(503).json({ error: 'Firebase Storage bucket is not configured. Set FIREBASE_STORAGE_BUCKET.' });
  if (!req.file) return res.status(400).json({ error: 'Choose a file first.' });
  const ext = path.extname(req.file.originalname).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12);
  const storagePath = `digital-products/${Date.now()}-${crypto.randomUUID()}${ext}`;
  const file = bucket.file(storagePath);
  await file.save(req.file.buffer, { resumable: false, metadata: { contentType: req.file.mimetype || 'application/octet-stream', metadata: { uploadedBy: req.user.uid, originalName: req.file.originalname.slice(0, 200) } } });
  res.status(201).json({ storagePath, originalName: req.file.originalname, size: req.file.size });
}));
app.get('/api/admin/orders', ...adminAuth, asyncRoute(async (_req, res) => {
  const snap = await db.ref('orders').get(); const orders = [];
  snap.forEach(c => { const o = c.val() || {}; orders.push({ id: c.key, ...o, storagePath: undefined }); });
  orders.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0)); res.json({ orders: orders.slice(0, 500) });
}));
app.patch('/api/admin/orders/:id', ...adminAuth, asyncRoute(async (req, res) => {
  const ref = db.ref(`orders/${req.params.id}`); const snap = await ref.get();
  if (!snap.exists()) return res.status(404).json({ error: 'Order not found.' });
  const patch = {}; const allowedStatus = ['pending','processing','completed','cancelled','rejected'];
  const allowedPayment = ['unpaid','paid','failed','refunded'];
  if (req.body.status !== undefined) { if (!allowedStatus.includes(req.body.status)) return res.status(400).json({ error: 'Invalid order status.' }); patch.status = req.body.status; }
  if (req.body.paymentStatus !== undefined) { if (!allowedPayment.includes(req.body.paymentStatus)) return res.status(400).json({ error: 'Invalid payment status.' }); patch.paymentStatus = req.body.paymentStatus; }
  if (req.body.adminNote !== undefined) patch.adminNote = clean(req.body.adminNote).slice(0, 1000);
  patch.updatedAt = Date.now();
  const restoreOperation = crypto.randomUUID();
  const tx = await ref.transaction(current => {
    if (!current) return;
    const next = { ...current, ...patch };
    if ((patch.status === 'cancelled' || patch.status === 'rejected') && current.stockReserved && !current.stockRestored) {
      next.stockRestored = true;
      next.stockRestoreOperation = restoreOperation;
    }
    return next;
  });
  if (!tx.committed || !tx.snapshot.exists()) return res.status(404).json({ error: 'Order not found.' });
  const updated = tx.snapshot.val();
  if (updated.stockRestoreOperation === restoreOperation && updated.productId) {
    await db.ref(`products/${updated.productId}`).transaction(product => {
      if (!product) return product;
      const stock = product.stock === undefined ? -1 : asNumber(product.stock, -1);
      if (stock >= 0) product.stock = stock + asNumber(updated.quantity, 1);
      return product;
    });
  }
  res.json({ ok: true });
}));
app.get('/api/admin/users', ...adminAuth, asyncRoute(async (_req, res) => {
  let all = [], pageToken;
  do { const page = await admin.auth().listUsers(1000, pageToken); all = all.concat(page.users); pageToken = page.pageToken; } while (pageToken && all.length < 5000);
  const users = all.map(u => ({ uid: u.uid, email: u.email || '', displayName: u.displayName || '', disabled: u.disabled, emailVerified: u.emailVerified, creationTime: u.metadata.creationTime, lastSignInTime: u.metadata.lastSignInTime }));
  res.json({ users });
}));
app.patch('/api/admin/users/:uid', ...adminAuth, asyncRoute(async (req, res) => {
  const patch = {};
  if (req.body.displayName !== undefined) patch.displayName = clean(req.body.displayName).slice(0, 80);
  if (req.body.disabled !== undefined) patch.disabled = Boolean(req.body.disabled);
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'No supported user fields supplied.' });
  const updated = await admin.auth().updateUser(req.params.uid, patch);
  await db.ref(`users/${req.params.uid}`).update({ displayName: updated.displayName || '', updatedAt: Date.now() }).catch(() => {});
  res.json({ user: { uid: updated.uid, email: updated.email || '', displayName: updated.displayName || '', disabled: updated.disabled } });
}));
app.get('/api/admin/settings', ...adminAuth, asyncRoute(async (_req, res) => { const s = (await db.ref('storeSettings').get()).val() || {}; res.json({ settings: s }); }));
app.put('/api/admin/settings', ...adminAuth, asyncRoute(async (req, res) => {
  const b = req.body || {}; const methods = {};
  for (const [k,v] of Object.entries(b.paymentMethods || {})) methods[k] = { enabled: v.enabled !== false, label: clean(v.label || k), account: clean(v.account).slice(0,100), accountType: clean(v.accountType).slice(0,50), instructions: clean(v.instructions).slice(0,1000) };
  const settings = { storeName: clean(b.storeName || 'Sakib Digital Store').slice(0,80), supportContact: clean(b.supportContact).slice(0,150), announcement: clean(b.announcement).slice(0,500), paymentMethods: methods, updatedAt: Date.now() };
  await db.ref('storeSettings').set(settings); res.json({ settings });
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => { console.error(err); if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message }); res.status(500).json({ error: err.message || 'Unexpected server error.' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`Sakib Digital Store ${PANEL_ROLE} panel listening on ${PORT}`));
