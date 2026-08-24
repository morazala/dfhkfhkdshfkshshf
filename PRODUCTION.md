# Production deployment

## 1. Static PWA

The GitHub Pages build reads only `data.json`, `tts-routes.json`,
`audio-cache/manifest.json`, and pre-generated WAV files. It never calls the
TTS generator. `app-config.js` contains public, non-secret configuration. Set
`RENDER_API_URL` and `GOOGLE_CLIENT_ID` during the static build if sign-in is
enabled; never put `JWT_SECRET`, `ADMIN_SECRET`, `DATABASE_URL`, or an FPT token
in the repository.

## 2. Render API

Set all variables in `.env.example` in the Render dashboard. The server creates
the PostgreSQL schema on startup. `ALLOWED_ORIGINS` must contain the exact
GitHub Pages origin(s), separated by commas. `JWT_SECRET` and `ADMIN_SECRET`
must each be long random values (at least 32 characters).

The admin page is `/admin.html`. It keeps the admin secret in memory only and
uses `x-admin-secret` for `/api/admin/users` and account deletion.

## 3. Google OAuth

Create a Web OAuth client in Google Cloud. Add the GitHub Pages origin to
Authorized JavaScript origins. The backend verifies the Google ID token and
creates or updates the user/device record in PostgreSQL. The session is an
HttpOnly cookie, not a token stored in localStorage.

## 4. Presentation mode

USB/HDMI/VGA connections are intentionally not inspected because browsers do
not expose that hardware state. Clicking `BẮT ĐẦU` requests fullscreen and a
screen wake lock, subject to browser permission and OS policy.
