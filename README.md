# Valorant Tracker — improved

## Run it
1. Open `index.html` in a modern browser, or serve this folder with a local static server.
2. Enter your Riot ID (name and tag).
3. Click **Fetch latest**. The first fetch asks for your HenrikDev API key and stores it in this browser's local storage.
4. Use **☆ Add favorite** to save an account to the welcome screen for quick access.

Get a key from https://api.henrikdev.xyz/dashboard/ and read the API docs at https://docs.henrikdev.xyz/.

## Changes in this version
- Removed the Settings panel and all match-delete controls.
- Added favorite Riot IDs, saved locally in this browser, with one-click switching from the welcome screen.
- Added an API-key prompt only when no key is saved; the key is not embedded in the source files.
- Added visible fetch/loading feedback, more polished responsive styling and button hover/press states.
- Added import/export controls outside Settings.
- Match log now sorts newest-first by full match timestamp, not only by calendar date. API matches preserve the match start timestamp, so matches on the same day are correctly ordered.
- The recent-form chart uses the most recent 20 matches in chronological order (oldest on the left).
- Left a clear UI note for future Google sign-in with Supabase; authentication is intentionally not wired up yet.

## Future Supabase + Google login
This version is still a static browser app. Favorites and matches are stored in local storage and are specific to this browser. To add personal accounts later:
1. Create a Supabase project and enable Google under **Authentication → Providers**.
2. Add the deployed website URL to Supabase's redirect URL allowlist and configure Google OAuth credentials.
3. Add `@supabase/supabase-js`, initialize it with the project's public URL and anon/publishable key, and implement `signInWithOAuth({ provider: 'google' })`.
4. Create user-owned tables such as `profiles`, `favorite_accounts`, and `matches`, with `user_id` referencing `auth.users`.
5. Enable Row Level Security and policies that restrict reads/writes to `auth.uid() = user_id`.
6. Move HenrikDev API requests to a server-side function/proxy and keep its API key in server-side environment variables. Do not expose the HenrikDev key in a public static site.
7. On login, migrate local favorites/matches into the signed-in user's database after checking for duplicates.

## Security note
The API key you pasted into chat should be treated as exposed. Revoke/replace it in the HenrikDev dashboard. Do not commit any API key to GitHub. The browser prompt stores the replacement key in local storage, which is suitable only for a personal local prototype, not a public multi-user deployment.

## Troubleshooting
- **401/403:** check the HenrikDev dashboard and replace the key if necessary.
- **404:** check Riot ID spelling/tag; the provider may not have the account/history.
- **429:** wait and retry after the rate-limit window.
- **CORS/network error:** check https://status.henrikdev.xyz/ and try serving the files over localhost instead of opening from `file://`.
- **Returned matches cannot be parsed:** the status message describes the fields returned by the provider to help diagnose schema changes.

The API provider is unofficial and is not endorsed by Riot Games. Availability and fields may change.
