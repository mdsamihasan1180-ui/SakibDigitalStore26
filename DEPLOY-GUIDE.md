# SAKIB DIGITAL STORE — DEPLOYMENT GUIDE (v2)

## ZIP structure
- `user-panel/` — customer storefront + API
- `admin-panel/` — protected admin dashboard + API

Deploy these as **two independent GitHub repositories and two independent Render Web Services**. Do not upload the parent folder as one service.

## 1. Firebase setup
1. Open Firebase Console → Authentication → Sign-in method → enable **Email/Password**.
2. Create your owner/admin account in Authentication. Verify that email address.
3. Check that Realtime Database and Firebase Storage are enabled.
4. In Project settings → Service accounts, generate a Firebase Admin SDK private key. Keep the downloaded JSON private.
5. Do not upload the service-account JSON to GitHub, do not paste it into either HTML file, and do not share it publicly.

### Recommended Firebase security rules
The Express backend uses Firebase Admin SDK, which bypasses client rules. To prevent direct browser access to the database and private files, set these rules in Firebase Console → Realtime Database → Rules:

```json
{
  ".read": false,
  ".write": false
}
```

And in Firebase Console → Storage → Rules:

```text
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

These deny direct client reads/writes; the trusted Express backend continues to operate with its service account.

## 2. Create the two GitHub repositories
1. Create a repository for the user panel. Upload the **contents inside `user-panel/`** to the repository root (`server.js`, `package.json`, `render.yaml`, `public/`, etc.).
2. Create another repository for the admin panel. Upload the **contents inside `admin-panel/`** to that repository root.
3. Do not put `user-panel/` or `admin-panel/` as an extra nested folder inside each repository.

## 3. Create two Render services
For each repository, choose **New → Web Service**, connect the matching repository, and use:
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Root directory: leave blank
- Health check path: `/api/health`

The included `render.yaml` files provide the main settings if you use Render Blueprint deployment.

## 4. Add these environment variables to BOTH Render services
- `FIREBASE_SERVICE_ACCOUNT` = the complete contents of the Firebase service-account JSON file (one environment variable value; keep it secret).
- `FIREBASE_DATABASE_URL` = `https://premium-top-up-a2e23-default-rtdb.firebaseio.com`
- `FIREBASE_STORAGE_BUCKET` = `premium-top-up-a2e23.firebasestorage.app`
- `ADMIN_EMAILS` = your verified admin email address(es), comma-separated. Set this on both services.
- `ALLOWED_ORIGINS` = both deployed origins separated by a comma, for example `https://your-user-service.onrender.com,https://your-admin-service.onrender.com`. Do not include a trailing slash.

The `PANEL_ROLE` variable is already set in each render.yaml (`user` or `admin`).

## 5. First use
1. Open the User Panel URL and create a customer account.
2. Open the Admin Panel URL and sign in with the same verified email listed in `ADMIN_EMAILS`.
3. Add products in Admin → Products. A digital file can be uploaded to private Firebase Storage.
4. Configure bKash/Nagad/Rocket/bank payment instructions in Admin → Store settings.
5. Place a test order from the User Panel. Admin → Orders can mark its payment as paid and update order status. A paid order with an attached file receives a short-lived signed download link.

## Real functionality and important boundaries
- Product catalogue, order placement, stock reservation, payment-status management, customer account listing, product uploads and gated downloads use Firebase/Express backend routes.
- Payment instructions and transaction-reference submission are **manual verification**. Automatic payment confirmation is not switched on. A real auto-payment connection requires the exact provider (for example, a licensed merchant checkout API), server-side credentials, signature verification and a webhook endpoint. Never trust a payment screenshot or a client-side “success” flag as proof of payment.
- Firebase passwords are never shown to admins. Admin can change display names and disable/enable accounts. Admin access is restricted to verified email addresses listed in `ADMIN_EMAILS`.
- Digital files are stored privately through Firebase Admin Storage. The app only creates a short-lived signed download URL after checking the logged-in customer owns the order and payment status is `paid`.
- Stock `-1` means unlimited. Stock `0` means sold out. Placing an order reserves available stock; cancelling or rejecting an order automatically returns its reserved stock once.
- The Firebase web config in `public/index.html` is client config, not an admin secret. The service-account key is the secret.

## Troubleshooting
- Render exits immediately: confirm `FIREBASE_SERVICE_ACCOUNT` is valid JSON and `FIREBASE_DATABASE_URL` is set.
- Admin says access denied: verify the email is exactly in `ADMIN_EMAILS`, with no typo, and confirm the Firebase user can sign in.
- CORS error: set `ALLOWED_ORIGINS` on both services to the exact two Render URLs, comma-separated.
- Upload fails: check `FIREBASE_STORAGE_BUCKET` matches your Firebase Storage bucket and that Firebase Storage is enabled.
- Do not use `*` for `ALLOWED_ORIGINS` in production.

Developed by Developer Sakib
