/**
 * Classifies a markdown image `src` so the viewer knows whether to render it
 * as-is (`external`) or mint a signed URL for it (`drive`).
 *
 * A plain `<img src>` cannot carry the `Authorization` header the daemon
 * requires, so any reference that points at a file inside an agent-fs drive
 * — by live-host viewer URL, drive-absolute path, or path relative to the
 * markdown document — must resolve to a signed URL instead of the raw path.
 */

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
const DRIVE_VIEWER_PATH = new RegExp(`^/file/~/(${UUID})/(${UUID})/(.+)$`)

export type ImageSrcResolution =
  | { kind: "external"; url: string }
  | { kind: "drive"; orgId: string; driveId: string; path: string }

/**
 * @param src Raw `src` attribute from the parsed markdown image node.
 * @param docPath Path of the markdown document itself, inside its drive.
 * @param routeOrgId Org of the document currently open (from the route).
 * @param routeDriveId Drive of the document currently open (from the route).
 */
export function resolveImageSrc(
  src: string,
  docPath: string,
  routeOrgId: string,
  routeDriveId: string,
): ImageSrcResolution {
  const url = tryParseAbsoluteUrl(src)
  if (url) {
    const match = DRIVE_VIEWER_PATH.exec(url.pathname)
    if (match) {
      return {
        kind: "drive",
        orgId: match[1],
        driveId: match[2],
        path: safeDecodeURIComponent(match[3]),
      }
    }
    return { kind: "external", url: src }
  }

  if (src.startsWith("/")) {
    return { kind: "drive", orgId: routeOrgId, driveId: routeDriveId, path: src.slice(1) }
  }

  return {
    kind: "drive",
    orgId: routeOrgId,
    driveId: routeDriveId,
    path: resolveRelativePath(docPath, src),
  }
}

function tryParseAbsoluteUrl(src: string): URL | null {
  try {
    return new URL(src)
  } catch {
    return null
  }
}

/** A malformed percent escape (e.g. `%zz`) must not crash rendering — fall back to the raw segment. */
function safeDecodeURIComponent(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Resolves `relative` against the directory of `docPath`, clamped at the drive root. */
function resolveRelativePath(docPath: string, relative: string): string {
  const docDir = docPath.split("/").slice(0, -1)
  const segments = [...docDir, ...relative.split("/")]
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.join("/")
}
