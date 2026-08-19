import { describe, expect, test } from "bun:test"
import { resolveImageSrc } from "../resolve-image-src"

const ROUTE_ORG = "4fdbb8e2-f63b-4977-95be-6e18019f0e86"
const ROUTE_DRIVE = "99d03b30-1ffd-4ddd-b332-1244b511b230"
const DOC_PATH = "misc/id/dir/test.md"

describe("resolveImageSrc", () => {
  test("live-host URL resolves to drive", () => {
    const src =
      "https://live.agent-fs.dev/file/~/4fdbb8e2-f63b-4977-95be-6e18019f0e86/99d03b30-1ffd-4ddd-b332-1244b511b230/thoughts/0d022f19-38ff-4d32-95b2-315fc0864114/research/2026-08-19-merge-queue-ci-gate-flow-light.png"
    expect(resolveImageSrc(src, DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)).toEqual({
      kind: "drive",
      orgId: "4fdbb8e2-f63b-4977-95be-6e18019f0e86",
      driveId: "99d03b30-1ffd-4ddd-b332-1244b511b230",
      path: "thoughts/0d022f19-38ff-4d32-95b2-315fc0864114/research/2026-08-19-merge-queue-ci-gate-flow-light.png",
    })
  })

  test("same URL shape on localhost resolves to drive (any-host rule)", () => {
    const src = "http://localhost:5173/file/~/4fdbb8e2-f63b-4977-95be-6e18019f0e86/99d03b30-1ffd-4ddd-b332-1244b511b230/a/b.png"
    const result = resolveImageSrc(src, DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)
    expect(result).toEqual({
      kind: "drive",
      orgId: "4fdbb8e2-f63b-4977-95be-6e18019f0e86",
      driveId: "99d03b30-1ffd-4ddd-b332-1244b511b230",
      path: "a/b.png",
    })
  })

  test("drops query and hash", () => {
    const src = `https://live.agent-fs.dev/file/~/${ROUTE_ORG}/${ROUTE_DRIVE}/a/b.png?mode=full#x`
    const result = resolveImageSrc(src, DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)
    expect(result).toEqual({ kind: "drive", orgId: ROUTE_ORG, driveId: ROUTE_DRIVE, path: "a/b.png" })
  })

  test("decodes percent-encoded path segments", () => {
    const src = `https://live.agent-fs.dev/file/~/${ROUTE_ORG}/${ROUTE_DRIVE}/a%20b/c.png`
    const result = resolveImageSrc(src, DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)
    expect(result).toEqual({ kind: "drive", orgId: ROUTE_ORG, driveId: ROUTE_DRIVE, path: "a b/c.png" })
  })

  test("drive-absolute path resolves to drive with route org/drive", () => {
    const result = resolveImageSrc("/a/b.png", DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)
    expect(result).toEqual({ kind: "drive", orgId: ROUTE_ORG, driveId: ROUTE_DRIVE, path: "a/b.png" })
  })

  test("relative path resolves against the document's directory", () => {
    const result = resolveImageSrc("x.png", DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)
    expect(result).toEqual({ kind: "drive", orgId: ROUTE_ORG, driveId: ROUTE_DRIVE, path: "misc/id/dir/x.png" })
  })

  test("relative path with ../ resolves one level up", () => {
    const result = resolveImageSrc("../up.png", DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)
    expect(result).toEqual({ kind: "drive", orgId: ROUTE_ORG, driveId: ROUTE_DRIVE, path: "misc/id/up.png" })
  })

  test("relative path clamps at the drive root", () => {
    const result = resolveImageSrc("../../../../escape.png", DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)
    expect(result).toEqual({ kind: "drive", orgId: ROUTE_ORG, driveId: ROUTE_DRIVE, path: "escape.png" })
  })

  test("presigned GCS-style URL is external, unchanged", () => {
    const src = "https://storage.googleapis.com/bucket/key.png?X-Amz-Signature=abc"
    expect(resolveImageSrc(src, DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)).toEqual({ kind: "external", url: src })
  })

  test("public https image URL is external, unchanged", () => {
    const src = "https://raw.githubusercontent.com/org/repo/main/logo.png"
    expect(resolveImageSrc(src, DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)).toEqual({ kind: "external", url: src })
  })

  test("malformed UUID in a /file/~/ URL falls back to external", () => {
    const src = "https://live.agent-fs.dev/file/~/not-a-uuid/also-not/a/b.png"
    expect(resolveImageSrc(src, DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)).toEqual({ kind: "external", url: src })
  })

  test("uppercase-hex UUID still resolves to drive", () => {
    const org = ROUTE_ORG.toUpperCase()
    const drive = ROUTE_DRIVE.toUpperCase()
    const src = `https://live.agent-fs.dev/file/~/${org}/${drive}/a/b.png`
    expect(resolveImageSrc(src, DOC_PATH, ROUTE_ORG, ROUTE_DRIVE)).toEqual({
      kind: "drive",
      orgId: org,
      driveId: drive,
      path: "a/b.png",
    })
  })
})
