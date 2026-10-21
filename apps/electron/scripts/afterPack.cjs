/**
 * electron-builder afterPack hook
 *
 * Copies the pre-compiled macOS 26+ Liquid Glass icon (Assets.car) into the
 * app bundle. The Assets.car file is compiled locally using actool with the
 * macOS 26 SDK (not available in CI), then committed to the repo.
 *
 * To regenerate Assets.car after icon changes:
 *   cd apps/electron
 *   xcrun actool "resources/icon.icon" --compile "resources" \
 *     --app-icon AppIcon --minimum-deployment-target 26.0 \
 *     --platform macosx --output-partial-info-plist /dev/null
 *
 * For older macOS versions, the app falls back to icon.icns which is
 * included separately by electron-builder.
 */

const path = require('path');
const fs = require('fs');

/**
 * The bundled Postgres (memwise/postgres, copied from @embedded-postgres/<platform>/native) lists
 * its shared-library symlinks in pg-symlinks.json; npm recreates them in a postinstall script that
 * Bun skips, so the copy has none and initdb cannot load its libraries. Create them here, before
 * signing, so the app never writes into its own bundle (packages/db/src/binaries.ts does the same
 * for a dev run).
 */
function hydratePostgresSymlinks(resourcesDir) {
  const nativeDir = path.join(resourcesDir, 'memwise', 'postgres');
  const list = path.join(nativeDir, 'pg-symlinks.json');
  if (!fs.existsSync(list)) return;
  const inNative = (p) => path.join(nativeDir, p.replace(/^native[\\/]/, ''));
  let made = 0;
  for (const { source, target } of JSON.parse(fs.readFileSync(list, 'utf8'))) {
    const link = inNative(target);
    if (fs.existsSync(link)) continue;
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.relative(path.dirname(link), inNative(source)), link);
    made++;
  }
  console.log(`afterPack: created ${made} Postgres library symlink(s) in ${nativeDir}`);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'linux') {
    hydratePostgresSymlinks(path.join(context.appOutDir, 'resources'));
  }

  // Only process macOS builds
  if (context.electronPlatformName !== 'darwin') {
    console.log('Skipping Liquid Glass icon (not macOS)');
    return;
  }

  const appPath = context.appOutDir;
  const resourcesDir = path.join(appPath, 'MemWise.app', 'Contents', 'Resources');
  hydratePostgresSymlinks(resourcesDir);
  const precompiledAssets = path.join(context.packager.projectDir, 'resources', 'Assets.car');

  console.log(`afterPack: projectDir=${context.packager.projectDir}`);
  console.log(`afterPack: looking for Assets.car at ${precompiledAssets}`);

  // Check if pre-compiled Assets.car exists
  if (!fs.existsSync(precompiledAssets)) {
    console.log('Warning: Pre-compiled Assets.car not found in resources/');
    console.log('The app will use the fallback icon.icns on all macOS versions');
    return;
  }

  // Copy pre-compiled Assets.car to the app bundle
  const destAssetsCar = path.join(resourcesDir, 'Assets.car');
  try {
    fs.copyFileSync(precompiledAssets, destAssetsCar);
    console.log(`Liquid Glass icon copied: ${destAssetsCar}`);
  } catch (err) {
    // Don't fail the build if Assets.car can't be copied - app will use fallback icon.icns
    console.log(`Warning: Could not copy Assets.car: ${err.message}`);
    console.log('The app will use the fallback icon.icns on all macOS versions');
  }
};
