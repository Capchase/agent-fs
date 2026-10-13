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
  /** `url` is an object URL this cache owns and revokes once it is replaced or deleted and no longer held. */
  objectUrl?: boolean
}

export const MIN_FRESH_MS = 5 * 60 * 1000

type CacheValue = DriveImageCacheEntry | Promise<DriveImageCacheEntry>

export class DriveImageCache {
  private entries = new Map<string, CacheValue>()
  private holds = new Map<string, number>()
  private retired = new Set<string>()

  /** A mounted image is showing `url`; an owned object URL stays alive until every holder releases it. */
  hold(url: string): void {
    this.holds.set(url, (this.holds.get(url) ?? 0) + 1)
  }

  release(url: string): void {
    const count = (this.holds.get(url) ?? 0) - 1
    if (count > 0) {
      this.holds.set(url, count)
      return
    }
    this.holds.delete(url)
    if (this.retired.delete(url)) URL.revokeObjectURL(url)
  }

  /** Revokes an owned object URL that left the cache, now or when its last holder releases it. */
  private retire(previous: CacheValue | undefined, next?: CacheValue): void {
    if (!previous || previous instanceof Promise || !previous.objectUrl) return
    if (next && !(next instanceof Promise) && next.url === previous.url) return
    if (this.holds.has(previous.url)) this.retired.add(previous.url)
    else URL.revokeObjectURL(previous.url)
  }

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
    const key = this.key(clientId, res)
    this.retire(this.entries.get(key), value)
    this.entries.set(key, value)
  }

  delete(clientId: string, res: DriveImageResolution): void {
    const key = this.key(clientId, res)
    this.retire(this.entries.get(key))
    this.entries.delete(key)
  }
}

export const driveImageCache = new DriveImageCache()
