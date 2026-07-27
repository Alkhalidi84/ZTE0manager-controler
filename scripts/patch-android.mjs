import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Post-`cap add` platform patches. Idempotent — safe to run on every build.
 *
 * Android: the router API is plain http://, but Android 9+ (API 28) blocks ALL
 * cleartext traffic by default — including CapacitorHttp's native requests.
 * Without `android:usesCleartextTraffic="true"` in the manifest the app cannot
 * reach ANY router and every login attempt dies with a network error (this was
 * the "login failed" bug in the released APK). Capacitor's `server.cleartext`
 * config does NOT write this attribute, so we patch the generated manifest.
 *
 * iOS: same idea — ATS blocks http:// unless local networking is allowed.
 */

function patchAndroidManifest() {
  const manifest = 'android/app/src/main/AndroidManifest.xml';
  if (!existsSync(manifest)) {
    console.log('patch-android: android/ not present — skipping (run `npx cap add android` first).');
    return;
  }
  const xml = readFileSync(manifest, 'utf8');
  if (xml.includes('android:usesCleartextTraffic')) {
    console.log('patch-android: cleartext HTTP already enabled.');
    return;
  }
  writeFileSync(
    manifest,
    xml.replace('<application', '<application\n        android:usesCleartextTraffic="true"'),
  );
  console.log('patch-android: enabled cleartext HTTP in AndroidManifest.xml (router API is plain http).');
}

function patchIosPlist() {
  const plist = 'ios/App/App/Info.plist';
  if (!existsSync(plist)) return;
  const xml = readFileSync(plist, 'utf8');
  if (xml.includes('NSAppTransportSecurity')) {
    console.log('patch-android: iOS ATS exception already present.');
    return;
  }
  const ats =
    '<dict>\n' +
    '\t<key>NSAppTransportSecurity</key>\n' +
    '\t<dict>\n' +
    '\t\t<key>NSAllowsArbitraryLoads</key>\n' +
    '\t\t<true/>\n' +
    '\t\t<key>NSAllowsLocalNetworking</key>\n' +
    '\t\t<true/>\n' +
    '\t</dict>';
  // Only the first <dict> (the plist root) is replaced.
  writeFileSync(plist, xml.replace('<dict>', ats));
  console.log('patch-android: allowed local http:// in iOS Info.plist (ATS).');
}

patchAndroidManifest();
patchIosPlist();
