# PersonalDataHub — Android Build Guide

This document describes how to build and run the Android app after the port
implementation (see `ANDROID-PORT-PLAN.md`).

## Architecture recap

The Android app uses **Capacitor** wrapping the existing Hono web server:

```
┌─────────────────────────────────────────────────┐
│  Android App                                    │
│  ┌───────────────┐    ┌───────────────────────┐ │
│  │  Capacitor    │    │  @choreruiz/           │ │
│  │  WebView      │◄──►│  capacitor-node-js    │ │
│  │               │    │  (background thread)  │ │
│  │  Loads        │    │                       │ │
│  │  localhost:   │    │  src/android.ts       │ │
│  │  3000         │    │  Hono server          │ │
│  └───────────────┘    │  sql.js DataStore     │ │
│                       └───────────────────────┘ │
└─────────────────────────────────────────────────┘
```

The Hono server runs on `127.0.0.1:3000` inside a Node.js Mobile thread.
The Capacitor WebView points at that address via `capacitor.config.ts → server.url`.
`better-sqlite3` is replaced by `sql.js` (pure JS + WASM) for ARM compatibility.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 22 | `nvm install 22` |
| Android Studio | Ladybug+ | [developer.android.com/studio](https://developer.android.com/studio) |
| Android SDK | API 26+ (Android 8) | Via Android Studio SDK Manager |
| Java (JDK) | 17 or 21 | `sdk install java 21.0.x-tem` |

Set environment variables:
```bash
export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
```

---

## Step 1 — Install dependencies

```bash
npm install
```

This installs:
- `sql.js` — pure-JS SQLite for Android
- `@capacitor/core`, `@capacitor/cli`, `@capacitor/android` — Capacitor 8
- `@choreruiz/capacitor-node-js` — Node.js runtime plugin for Capacitor 8

> **Package note:** The plugin `nodejs-mobile-capacitor` does **not** exist on npm.
> The correct package for running Node.js inside a Capacitor app is
> `@choreruiz/capacitor-node-js` (a Capacitor-8-compatible fork of
> [hampoelz/Capacitor-NodeJS](https://github.com/hampoelz/Capacitor-NodeJS)).

---

## Step 2 — Initialize the Android project

```bash
npx cap add android
```

This creates the `android/` directory with a standard Android Gradle project.
Only needs to be run once.

---

## Step 4 — Configure nodejs-mobile-capacitor

In `android/app/src/main/assets/`, the plugin looks for a `nodejs-project/`
folder containing the Node.js entry point and its dependencies.

Create the directory and link the compiled entry point:

```bash
mkdir -p android/app/src/main/assets/nodejs-project
```

Add to `android/app/src/main/assets/nodejs-project/package.json`:
```json
{
  "name": "pdh-mobile",
  "version": "1.0.0",
  "main": "android.js"
}
```

After each TypeScript build (`npm run build`), copy the compiled files:
```bash
cp dist/android.js android/app/src/main/assets/nodejs-project/
cp -r node_modules android/app/src/main/assets/nodejs-project/
```

Or add this to your build script.

---

## Step 5 — Configure AndroidManifest.xml for OAuth deep links

Edit `android/app/src/main/AndroidManifest.xml` and add inside `<application>`:

```xml
<!-- OAuth callback deep link: pdh://oauth/callback -->
<activity
  android:name="com.getcapacitor.BridgeActivity"
  android:exported="true">
  <intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW"/>
    <category android:name="android.intent.category.DEFAULT"/>
    <category android:name="android.intent.category.BROWSABLE"/>
    <data android:scheme="pdh" android:host="oauth"/>
  </intent-filter>
</activity>
```

Also add the cleartext network permission (required for localhost HTTP):
```xml
<uses-permission android:name="android.permission.INTERNET"/>
```

And in `<application>`:
```xml
android:usesCleartextTraffic="true"
```

---

## Step 6 — Register OAuth redirect URIs

In Google Cloud Console and GitHub OAuth settings, add the custom scheme as an
additional redirect URI:

- **Gmail / Calendar:** `pdh://oauth/callback`
- **GitHub:** `pdh://oauth/callback`

Update `src/gateway/auth/oauth-routes.ts` to use this URI when
`process.env.PDH_MOBILE === 'true'`:

```typescript
const redirectUri = process.env.PDH_MOBILE === 'true'
  ? 'pdh://oauth/callback'
  : `${baseUrl}/oauth/gmail/callback`;
```

---

## Step 7 — Build and deploy

### Build TypeScript
```bash
npm run build
```

### Sync Capacitor (copies www/ and native config)
```bash
npm run build:android   # = tsc + npx cap sync android
```

### Open in Android Studio
```bash
npm run android:open    # = npx cap open android
```

In Android Studio: **Build → Make Project**, then **Run → Run 'app'**
on a connected device or emulator.

### Direct run (if device is connected via ADB)
```bash
npm run android:run     # = npx cap run android
```

---

## Step 8 — SQLJS_WASM_PATH (if sql.js WASM is not found)

On some Android configurations Node.js Mobile may not resolve the WASM file
path automatically. If you see a `WASM file not found` error, set:

```bash
# In android.ts or via an Android plugin that sets env vars before Node.js starts
process.env.SQLJS_WASM_PATH = '/path/to/nodejs-project/node_modules/sql.js/dist/sql-wasm.wasm';
```

The typical path inside the APK's assets is:
```
/data/data/com.aismithlab.pdh/files/nodejs-project/node_modules/sql.js/dist/sql-wasm.wasm
```

---

## Environment variables summary

| Variable | Default | Purpose |
|----------|---------|---------|
| `PDH_MOBILE` | `false` | Set to `true` to use sql.js instead of better-sqlite3 |
| `PDH_DB_PATH` | `./pdh-data/pdh.db` | Path to the SQLite database file |
| `PDH_DATA_DIR` | `./pdh-data` | Directory for database + config |
| `PDH_CONFIG_PATH` | `{PDH_DATA_DIR}/hub-config.yaml` | Path to hub-config.yaml |
| `PDH_ENCRYPTION_KEY` | auto-generated | Master key for OAuth token encryption |
| `SQLJS_WASM_PATH` | auto-resolved | Override WASM location for sql.js |

---

## Generating a signed APK/AAB

1. In Android Studio: **Build → Generate Signed Bundle / APK**
2. Create or use an existing keystore
3. Select release build variant
4. Build APK (direct install) or AAB (Play Store)

---

## Tested configurations

| Device | Android | Status |
|--------|---------|--------|
| Emulator (x86_64, API 33) | 13 | Planned |
| Physical ARM64 device | 11+ | Planned |

---

## Known limitations

- **MCP/Agent connectivity:** External MCP clients cannot reach the on-device
  server unless the Android device is on the same network and port 3000 is
  accessible. For remote agent access, consider running pdh on a server instead.
- **Token refresh background work:** When the app is backgrounded, Android may
  kill the Node.js thread. OAuth tokens will be refreshed on next app open.
- **App size:** Bundling Node.js Mobile + node_modules adds ~30-50 MB to the APK.
  The sql.js WASM binary is ~1 MB.
