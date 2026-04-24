# PersonalDataHub: Android Port Implementation Plan

This document outlines the strategy and step-by-step plan for porting PersonalDataHub to an Android application. The recommended approach utilizes **Capacitor** to wrap the existing web-based GUI while adapting the backend Node.js logic to run within a mobile environment or as a direct client-side application.

## 1. Architecture Strategy

PersonalDataHub currently consists of a Node.js API (Hono) and a Vanilla JS Single Page Application (SPA) served from the same process. To run this on Android, we have two main architectural paths:

### Path A: Embedded Node.js (Recommended for least backend changes)
Use a plugin like `nodejs-mobile-capacitor` to run the existing Hono API and background tasks (like the Staging queue and Audit logs) in a background thread on the Android device. The Capacitor frontend simply points to `localhost:3000` running on the device.
*   **Pros:** Requires minimal changes to the existing business logic, connectors, and Hono routes.
*   **Cons:** Heavier app size, complex inter-process communication if background execution is needed when the app is closed.

### Path B: Pure Client-Side Refactor (Recommended for native feel)
Move the API logic directly into the frontend SPA or use Capacitor plugins for HTTP requests, OAuth, and Storage.
*   **Pros:** Lighter app, better integration with native mobile APIs.
*   **Cons:** Requires significant refactoring to eliminate Node.js dependencies (`better-sqlite3`, `crypto`, `googleapis` node SDK).

We will proceed assuming **Path A (Embedded Node.js)** as it preserves the core MCP/Agent access model which requires a running server anyway.

## 2. Technical Hurdles & Solutions

### Database Layer (`better-sqlite3`)
*   **Issue:** `better-sqlite3` relies on native C++ bindings for Node.js, which will not compile for Android's ARM architectures out of the box via standard npm install.
*   **Solution:** Replace `better-sqlite3` with a pure JavaScript SQLite implementation (like `sql.js` or `@capacitor-community/sqlite` via a bridge) OR cross-compile a mobile-compatible SQLite module for `nodejs-mobile`.
*   **Action:** Implement a new `DataStore` class (e.g., `CapacitorSqliteStore`) that conforms to the existing `DataStore` interface.

### OAuth 2.0 Flow
*   **Issue:** The current OAuth flow redirects to `localhost:3000/oauth/callback`. On Android, this might open in an external browser and fail to redirect back to the app seamlessly.
*   **Solution:** Register a Custom URL Scheme (e.g., `pdh://`) or use App Links. Update the Google and GitHub OAuth configurations to accept this custom scheme as a valid redirect URI. Use the Capacitor Browser plugin to handle the auth window and intercept the redirect.

### User Interface (GUI)
*   **Issue:** The current UI in `src/gateway/gui/routes.ts` is hardcoded as a string and optimized for desktop (fixed 224px sidebar).
*   **Solution:**
    1.  **Extract SPA:** Move the HTML, CSS, and JS out of the backend route into a dedicated `www/` or `frontend/` directory.
    2.  **Mobile Layout:** Convert the sidebar into a Bottom Navigation Bar or a Hamburger menu. Increase touch targets (buttons, list rows) to at least 44x44dp.

## 3. Step-by-Step Implementation Roadmap

### Phase 1: Frontend Extraction & Capacitor Setup
1.  **Extract GUI:** Refactor `src/gateway/gui/routes.ts`. Move `getIndexHtml()` content to `frontend/index.html`, `frontend/style.css`, and `frontend/app.js`.
2.  **Initialize Capacitor:**
    ```bash
    npm install @capacitor/core @capacitor/cli
    npx cap init PersonalDataHub com.aismithlab.pdh
    npm install @capacitor/android
    npx cap add android
    ```
3.  **Update Build Script:** Modify `package.json` to build the frontend assets into a `www/` folder that Capacitor can consume.

### Phase 2: Mobile Node.js Environment
1.  **Install Node.js Mobile:** Integrate a Node.js runtime for Capacitor (e.g., `nodejs-mobile-capacitor` or an equivalent modern fork).
2.  **Database Migration:** Create `src/database/mobile-store.ts` using a mobile-compatible SQLite library. Update `src/gateway/server.ts` to instantiate this store when running in the Android environment.
3.  **Server Startup:** Modify the app's entry point to start the Hono server programmatically via the Node.js mobile bridge on app launch.

### Phase 3: OAuth & Deep Linking Configuration
1.  **Capacitor Plugins:** Install `@capacitor/browser` and `@capacitor/app`.
2.  **Deep Links:** Configure `AndroidManifest.xml` to handle `pdh://` intent filters.
3.  **Auth Logic:** Update `src/gateway/auth/oauth-routes.ts` to use the custom scheme for redirects if a mobile environment variable is detected.

### Phase 4: UI/UX Mobile Refinements
1.  **Responsive CSS:** Add media queries to `style.css`:
    ```css
    @media (max-width: 768px) {
      .sidebar { display: none; /* Replace with bottom nav */ }
      .main-content { margin-left: 0; }
      .gmail-grid { grid-template-columns: 1fr; }
    }
    ```
2.  **Touch Optimizations:** Increase padding on `.email-row`, `.btn`, and `.nav-item`.

### Phase 5: Testing & Deployment
1.  **Emulator Testing:** Run `npx cap open android` and build/deploy to an Android Virtual Device (AVD).
2.  **Agent Connectivity Check:** Ensure that MCP clients or API requests from the host device can reach the Android app (may require specific network configurations or running agents directly on the mobile device).
3.  **Release:** Generate a signed APK/AAB via Android Studio.
