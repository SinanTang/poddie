const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * With no Apple Developer ID configured, electron-builder leaves the .app
 * either unsigned or carrying the raw Electron template's stale ad-hoc
 * signature (invalid once app.asar/Info.plist/icon are swapped in). Apple
 * Silicon enforces signature validity at launch time, so an unsigned or
 * stale-signed build silently fails to open. Ad-hoc re-sign here, after
 * packing but before dmg/zip creation, so every build target is launchable.
 *
 * `com.apple.provenance` — stamped by macOS on files extracted from the
 * downloaded Electron zip — makes codesign refuse to sign with "resource
 * fork, Finder information, or similar detritus not allowed"; strip xattrs
 * first.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('xattr', ['-cr', appPath])
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath])
}
