const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * With no Apple Developer ID configured, electron-builder leaves the .app
 * either unsigned or carrying the raw Electron template's stale ad-hoc
 * signature (invalid once app.asar/Info.plist/icon are swapped in). macOS
 * enforces signature validity at exec time (strictly on Apple Silicon), so an
 * unsigned or stale-signed build silently fails to launch. Ad-hoc re-sign here,
 * after packing but before dmg creation, so the app is launchable. `xattr -cr`
 * first strips `com.apple.provenance` (stamped on the extracted Electron zip),
 * which otherwise makes codesign refuse with "resource fork … not allowed".
 *
 * Known limitation (universal builds): Electron's framework bundles carry a
 * `com.apple.FinderInfo` xattr that `codesign --deep` re-adds, so the merged
 * bundle fails `codesign --verify --strict` ("detritus not allowed"). This does
 * NOT prevent launch — AMFI accepts the ad-hoc signature (verified: the copied
 * app launches). A real Developer ID + notarization is the only clean fix and
 * is the proper answer for wide distribution (see Phase 7 in the dev docs).
 *
 * Universal builds also pack each arch into a `*-temp` dir and fire this hook on
 * each, then @electron/universal lipo-merges them — a merge that requires the
 * per-arch apps' non-binary files to be byte-identical, which our re-sign would
 * break. So skip the `-temp` builds; this hook fires again on the merged bundle.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (context.appOutDir.endsWith('-temp')) return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('xattr', ['-cr', appPath])
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath])
}
