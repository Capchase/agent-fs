import { describe, expect, test } from "bun:test"
import { DriveImageCache, type DriveImageResolution } from "../drive-image-cache"

const RES: DriveImageResolution = {
  orgId: "4fdbb8e2-f63b-4977-95be-6e18019f0e86",
  driveId: "99d03b30-1ffd-4ddd-b332-1244b511b230",
  path: "docs/logo.png",
}

const FRESH_ENTRY = { url: "https://signed.example.com/a", expiresAt: Date.now() + 60 * 60 * 1000 }

describe("DriveImageCache", () => {
  test("entries are scoped per client id, even for the identical org/drive/path", () => {
    const cache = new DriveImageCache()
    cache.set("client-a", RES, FRESH_ENTRY)

    expect(cache.getFresh("client-a", RES)).toEqual(FRESH_ENTRY)
    expect(cache.getFresh("client-b", RES)).toBeNull()
  })

  test("switching client id does not reuse the prior account's still-valid signed URL", () => {
    const cache = new DriveImageCache()
    cache.set("account-1", RES, FRESH_ENTRY)

    // Switching accounts must mint fresh, not silently hand back account-1's URL.
    expect(cache.get("account-2", RES)).toBeUndefined()
    expect(cache.getFresh("account-2", RES)).toBeNull()
  })

  test("delete only clears the entry for the given client id", () => {
    const cache = new DriveImageCache()
    cache.set("client-a", RES, FRESH_ENTRY)
    cache.set("client-b", RES, FRESH_ENTRY)

    cache.delete("client-a", RES)

    expect(cache.getFresh("client-a", RES)).toBeNull()
    expect(cache.getFresh("client-b", RES)).toEqual(FRESH_ENTRY)
  })

  test("an entry close to expiry is not considered fresh", () => {
    const cache = new DriveImageCache()
    cache.set("client-a", RES, { url: "https://signed.example.com/b", expiresAt: Date.now() + 1000 })

    expect(cache.getFresh("client-a", RES)).toBeNull()
  })
})
