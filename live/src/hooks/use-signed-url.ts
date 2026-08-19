import { useState, useEffect, useCallback } from "react"
import { useAuth } from "@/contexts/auth"
import type { AgentFsClient } from "@/api/client"

export function useSignedUrl(path: string | null) {
  const { client, orgId, driveId } = useAuth()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!path || !orgId) {
      setUrl(null)
      return
    }

    let cancelled = false
    setIsLoading(true)
    setError(null)

    client.getSignedUrl(orgId, driveId, path).then((result) => {
      if (!cancelled) {
        setUrl(result.url)
        setIsLoading(false)
      }
    }).catch((err) => {
      if (!cancelled) {
        setError((err as Error).message)
        setIsLoading(false)
      }
    })

    return () => { cancelled = true }
  }, [path, orgId, driveId, client])

  return { url, error, isLoading }
}

export interface DriveImageResolution {
  orgId: string
  driveId: string
  path: string
}

interface DriveImageCacheEntry {
  url: string
  /** Epoch ms; `Infinity` for a `kind: "app"`-free, non-expiring entry. */
  expiresAt: number
}

// Keyed by "org/drive/path" so a document that repeats one image doesn't
// re-mint it, and a remount of the viewer reuses an already-fresh URL.
const driveImageCache = new Map<string, DriveImageCacheEntry | Promise<DriveImageCacheEntry>>()
const MIN_FRESH_MS = 5 * 60 * 1000

function cacheKey(res: DriveImageResolution): string {
  return `${res.orgId}/${res.driveId}/${res.path}`
}

async function mintDriveImageUrl(client: AgentFsClient, res: DriveImageResolution): Promise<DriveImageCacheEntry> {
  const result = await client.getSignedUrl(res.orgId, res.driveId, res.path)
  if (result.kind === "app") {
    throw new Error("this backend cannot mint public image URLs")
  }
  return {
    url: result.url,
    expiresAt: result.expiresAt ? new Date(result.expiresAt).getTime() : Infinity,
  }
}

/**
 * Like `useSignedUrl`, but mints against an explicit org/drive (not
 * necessarily the currently active one) and caches the result — needed for
 * markdown images, which can reference any drive the reader has access to
 * and can repeat the same image many times in one document.
 */
export function useDriveImageUrl(res: DriveImageResolution | null) {
  const { client } = useAuth()
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!res) {
      setUrl(null)
      setError(null)
      return
    }

    const key = cacheKey(res)
    const cached = driveImageCache.get(key)
    let cancelled = false

    if (cached && !(cached instanceof Promise) && cached.expiresAt - Date.now() > MIN_FRESH_MS) {
      setUrl(cached.url)
      setError(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)

    const pending = cached instanceof Promise ? cached : mintDriveImageUrl(client, res)
    driveImageCache.set(key, pending)
    pending.then((entry) => {
      driveImageCache.set(key, entry)
      if (cancelled) return
      setUrl(entry.url)
      setError(null)
      setIsLoading(false)
    }).catch((err: unknown) => {
      driveImageCache.delete(key)
      if (cancelled) return
      setError((err as Error).message)
      setIsLoading(false)
    })

    return () => { cancelled = true }
  }, [res?.orgId, res?.driveId, res?.path, client, nonce])

  // Drops the cached entry and re-mints — used for the single-retry-on-load-error path.
  const retry = useCallback(() => {
    if (res) driveImageCache.delete(cacheKey(res))
    setNonce((n) => n + 1)
  }, [res?.orgId, res?.driveId, res?.path])

  return { url, error, isLoading, retry }
}
