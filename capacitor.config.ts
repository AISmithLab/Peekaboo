import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aismithlab.pdh',
  appName: 'PersonalDataHub',

  // The Capacitor WebView loads this directory for its initial HTML.
  // Once the Node.js Mobile server is running we redirect to localhost:3000.
  webDir: 'www',

  server: {
    // cleartext needed so the WebView can fetch http://127.0.0.1:3000
    cleartext: true,
    // Allow the WebView to navigate to the Hono server once it's ready.
    // Without this Capacitor intercepts the navigation and opens the system browser.
    allowNavigation: ['127.0.0.1'],
  },

  android: {
    allowMixedContent: true,
    appendUserAgent: 'PersonalDataHub-Android/1.0',
  },

  plugins: {
    CapacitorNodeJS: {
      // 'nodejs' maps to www/nodejs/ which Capacitor syncs into
      // android/app/src/main/assets/public/nodejs/ in the APK.
      // The plugin copies it to getFilesDir()/nodejs/public/ and starts android.js.
      nodeDir: 'nodejs',
      startMode: 'auto',   // starts the Node.js engine at activity launch
    },
    Browser: {
      presentationStyle: 'popover',
    },
  },
};

export default config;
