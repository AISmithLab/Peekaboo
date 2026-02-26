# OAuth Setup

## Default Mode (No Setup Required)

`npx pdh init` fetches default OAuth credentials and writes them into `hub-config.yaml` automatically. PersonalDataHub uses **PKCE (Proof Key for Code Exchange)** for secure authorization. No additional configuration needed — just click "Connect Gmail" or "Connect GitHub" in the PersonalDataHub GUI.

How it works:
- PersonalDataHub generates a cryptographic code verifier and challenge (PKCE S256)
- Redirects you to Google/GitHub to authorize
- Exchanges the authorization code + code verifier for tokens locally
- Tokens are stored encrypted on your machine — they never leave your device

Google Desktop app client secrets are [not confidential](https://developers.google.com/identity/protocols/oauth2/native-app) by design. PKCE adds defense-in-depth against authorization code interception.

---

## Advanced: Using Your Own OAuth App

If you prefer to use your own OAuth app credentials (e.g., for branding, higher rate limits, or organizational policies), you can provide them in `hub-config.yaml`. When custom credentials are present, PersonalDataHub uses them instead of the defaults. PKCE is always applied regardless.

### Gmail

#### 1. Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)

#### 2. Enable the Gmail API

1. Go to **APIs & Services > Library**
2. Search for **Gmail API** and click **Enable**

#### 3. Configure the OAuth consent screen

1. Go to **APIs & Services > OAuth consent screen**
2. Choose **External** (or **Internal** if using Google Workspace)
3. Fill in:
   - App name: e.g. `PersonalDataHub`
   - User support email: your email
4. Add scopes: `gmail.readonly` and `gmail.compose`
5. Add yourself as a **test user** (required while app is in "Testing" status)

#### 4. Create OAuth credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Application type: **Desktop app** or **Web application** (both work)

**Desktop app** (simpler):
- No redirect URI configuration needed — Google auto-allows loopback redirects
- Google still provides a Client Secret (find it in the downloaded JSON or by clicking the credential)

**Web application** (if you prefer):
- Add this as an Authorized redirect URI:
  ```
  http://127.0.0.1:3000/oauth/gmail/callback
  ```
  (Replace `3000` with your configured port if different)

4. Add your credentials to `hub-config.yaml` under `sources.gmail`:

```yaml
sources:
  gmail:
    enabled: true
    owner_auth:
      type: oauth2
      clientId: "your-client-id.apps.googleusercontent.com"
      clientSecret: "your-client-secret"
```

---

### GitHub

#### 1. Create a GitHub App

1. Go to [GitHub Settings > Developer settings > GitHub Apps](https://github.com/settings/apps)
2. Click **New GitHub App**
3. Fill in:
   - **App name:** `PersonalDataHub` (must be globally unique)
   - **Homepage URL:** `http://127.0.0.1:3000`
   - **Callback URL:** `http://127.0.0.1:3000/oauth/github/callback`
   - Check **Request user authorization (OAuth) during installation**
   - Uncheck **Enable Device Flow** (not needed)
   - Uncheck **Webhook > Active** (not needed)

#### 2. Set permissions

Under **Repository permissions**:
- Contents: **Read & write**
- Metadata: **Read-only**
- Pull requests: **Read & write**
- Issues: **Read-only**

#### 3. Generate credentials

1. Click **Create GitHub App**
2. Note the **Client ID** (shown at top of the app page)
3. Click **Generate a new client secret** — copy it immediately

#### 4. Add to config

Add your credentials to `hub-config.yaml` under `sources.github`:

```yaml
sources:
  github:
    enabled: true
    owner_auth:
      type: github_app
      clientId: "your-github-client-id"
      clientSecret: "your-github-client-secret"
```

---

## Redirect URI reference

| Source | Redirect URI                                         |
|--------|------------------------------------------------------|
| Gmail  | `http://127.0.0.1:<port>/oauth/gmail/callback`      |
| GitHub | `http://127.0.0.1:<port>/oauth/github/callback`     |

Default port is `3000` (configurable in `hub-config.yaml` via `port: N`).

Gmail Desktop app credentials do not require manual redirect URI configuration.
GitHub Apps always require the callback URL to be set in the app settings.
