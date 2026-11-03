# Ope' Code Vault setup and data protection

## Run the app locally

Keep the files in the same folder. From that folder, start a local web server:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000/java-vault.html` in Chrome. To install it, use Chrome's **Install page as app** option. The app shell works offline after it has loaded once; Google sign-in and cloud sync require an internet connection.

## Local lessons and recovery

- Lesson data is stored in this browser profile using IndexedDB. Existing `java-vault-library-v1` localStorage data is migrated on first launch and left in place as a legacy copy.
- The app keeps up to 10 automatic restore points on this device. Open **Settings & backup** to restore one.
- **Protect storage on this device** asks the browser not to automatically evict the app's local data. Browser/site data can still be cleared, and this does not protect against device loss.
- Export a JSON backup regularly and keep it outside this device. Import merges matching lesson IDs; restoring an automatic point replaces the current library after confirmation.
- Browser storage is not encrypted by this app and is not a substitute for a secure device account. Anyone with access to the browser profile may be able to access the lessons.

## Optional Supabase + Google sync

Cloud sync is manual and opt-in. Nothing is sent to Supabase until you save the project settings, sign in, and choose **Sync now**.

1. Create a Supabase project and open its **SQL Editor**.
2. Run [`supabase-setup.sql`](./supabase-setup.sql). It creates the per-user lesson table and row-level security policies. Do not disable RLS.
3. In Supabase **Authentication → Providers**, enable Google and add the OAuth client ID and secret from your Google Cloud OAuth setup. Add the Supabase callback URL (`https://<project-ref>.supabase.co/auth/v1/callback`) as an authorized redirect URI in Google Cloud.
4. In Supabase **Authentication → URL Configuration**, add the app's exact URL to the redirect allow list, for example `http://localhost:8000/java-vault.html`. Add the production HTTPS URL too if you host the app.
5. In **Project Settings → API**, copy the project URL and the public anon/publishable key. Enter those in the app's Cloud sync settings. Never use a `service_role` key in this browser app.
6. Save settings, continue with Google, then choose **Sync now** on each device when you want to merge changes.

The Supabase JavaScript client is loaded from a version-pinned CDN only when cloud features are used. Cloud sync needs network access. The browser stores the public project key and the Supabase sign-in session locally; the key is not a password, but the session is private and should not be shared. The app uses Supabase row-level security so authenticated users can only access their own rows.

Sync merges by lesson ID and latest update time; deletions are represented by tombstones so they can sync between devices. It does not sync continuously or in the background. If a cloud upload fails after the local merge is saved, the app reports that clearly and you can retry **Sync now**.

## Reminders and AI

- Reminder alerts work while the app is open. Some browsers support scheduled notifications after the app closes, but support and delivery are not guaranteed. The app checks overdue reminders when opened again.
- AI review sends the selected lesson to the AI endpoint you configure, only after confirmation. Remote endpoints can receive your code and notes; review provider privacy and billing terms before use.
- This is a local-first learning tool, not a managed commercial service. A public deployment still needs an appropriate privacy notice, support and recovery process, production OAuth settings, and regular security/dependency review.
