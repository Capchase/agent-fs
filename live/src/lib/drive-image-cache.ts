/**
 * Caches minted signed URLs for markdown drive images, scoped per-client so
 * switching accounts (a different backend/credential) never reuses a
 * still-valid signed URL minted for the previous account.
 */

export interface DriveImageResolution {
  orgId: string
  driveId: string
  path: string
}

export interface DriveImageCacheEntry {
  url: string
  /** Epoch ms; `Infinity` for a non-expiring entry. */
  expiresAt: number
}

export const MIN_FRESH_MS = 5 * 60 * 1000

type CacheValue = DriveImageCacheEntry | Promise<DriveImageCacheEntry>

export class DriveImageCache {
  private entries = new Map<string, CacheValue>()

  private key(clientId: string, res: DriveImageResolution): string {
    return `${clientId}::${res.orgId}/${res.driveId}/${res.path}`
  }

  get(clientId: string, res: DriveImageResolution): CacheValue | undefined {
    return this.entries.get(this.key(clientId, res))
  }

  /** Returns the cached entry only if it's settled (not pending) and has enough life left. */
  getFresh(clientId: string, res: DriveImageResolution): DriveImageCacheEntry | null {
    const cached = this.entries.get(this.key(clientId, res))
    if (cached && !(cached instanceof Promise) && cached.expiresAt - Date.now() > MIN_FRESH_MS) {
      return cached
    }
    return null
  }

  set(clientId: string, res: DriveImageResolution, value: CacheValue): void {
    this.entries.set(this.key(clientId, res), value)
  }

  delete(clientId: string, res: DriveImageResolution): void {
    this.entries.delete(this.key(clientId, res))
  }
}

export const driveImageCache = new DriveImageCache()
