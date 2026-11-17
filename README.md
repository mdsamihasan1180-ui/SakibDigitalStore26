# Sakib Digital Store — User Panel

This is the customer-facing storefront and its Express API. Deploy this folder as its own GitHub repository and Render Web Service.

## Requirements
- Node.js 20+
- Firebase project with Email/Password Authentication enabled
- Firebase Realtime Database and Firebase Storage
- Firebase Admin service-account JSON stored only in Render environment variables

## Local run
1. `npm install`
2. Set the environment variables listed in `.env.example` (create the file yourself; never commit secrets).
3. `npm start`
4. Open `http://localhost:10000`

## Render environment
- `FIREBASE_SERVICE_ACCOUNT`: entire service-account JSON as one value.
- `FIREBASE_DATABASE_URL`: your RTDB URL.
- `FIREBASE_STORAGE_BUCKET`: your Firebase Storage bucket name.
- `ADMIN_EMAILS`: comma-separated admin email allowlist (same value as admin service).
- `ALLOWED_ORIGINS`: comma-separated deployed user and admin URLs, e.g. `https://your-user.onrender.com,https://your-admin.onrender.com`.
- `PANEL_ROLE=user` (included in render.yaml).

The public Firebase web config in `public/index.html` is designed to be public. Never place a service-account key in the frontend.
