/** Archive-layer rules (SPEC.md §5): round-trip, reproducibility, and every refusal. */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import {
  ZIP_LIMITS, crc32, looksLikeZip, readZipEntry, readZipIndex, validateArchivePath, writeZip, ZipError,
} from '../lib/zip.mjs'

const file = (path, text) => ({ path, data: Buffer.from(text, 'utf8') })

/**
 * Rewrite one entry's declared uncompressed size in the central directory.
 * The guards in `readZipIndex` all read that number, so lying about it is how a
 * crafted archive slips past them.
 */
function withDeclaredSize(buffer, path, size) {
  const copy = Buffer.from(buffer)
  let cursor = copy.readUInt32LE(copy.length - 22 + 16)
  while (copy.readUInt32LE(cursor) === 0x02014b50) {
    const nameLength = copy.readUInt16LE(cursor + 28)
    const extraLength = copy.readUInt16LE(cursor + 30)
    const commentLength = copy.readUInt16LE(cursor + 32)
    const name = copy.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (name === path) {
      copy.writeUInt32LE(size, cursor + 24)
      return copy
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`no central-directory entry for ${path}`)
}

test('round-trips entries and verifies CRC', () => {
  const buffer = writeZip([file('a/one.txt', 'hello'), file('two.txt', 'world'), file('a/three.bin', '')])
  const index = readZipIndex(buffer)
  assert.deepEqual(index.entries.map(entry => entry.path), ['a/one.txt', 'a/three.bin', 'two.txt'])
  assert.equal(index.totalBytes, 10)
  const one = index.entries.find(entry => entry.path === 'a/one.txt')
  assert.equal(readZipEntry(buffer, one).toString('utf8'), 'hello')
  assert.equal(readZipEntry(buffer, index.entries[1]).length, 0)
})

test('is byte-reproducible for identical input', () => {
  const entries = [file('b.txt', 'same'), file('a.txt', 'same')]
  assert.ok(writeZip(entries).equals(writeZip(entries)))
})

test('compresses repetitive content and stores incompressible content', () => {
  // Moderate redundancy: comfortably compressible, but well under the 200:1 bomb guard.
  const repetitive = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(120)
  const buffer = writeZip([file('text.txt', repetitive), file('tiny.txt', 'hi')])
  const index = readZipIndex(buffer)
  const text = index.entries.find(entry => entry.path === 'text.txt')
  const tiny = index.entries.find(entry => entry.path === 'tiny.txt')
  assert.equal(text.method, 8)
  assert.equal(tiny.method, 0)
  assert.equal(text.uncompressedSize, Buffer.byteLength(repetitive))
  assert.ok(text.compressedSize < text.uncompressedSize / 4)
})

test('detects content corruption through the CRC', () => {
  const buffer = writeZip([file('a.txt', 'hello world')])
  const index = readZipIndex(buffer)
  const entry = index.entries[0]
  const payloadAt = entry.localOffset + 30 + Buffer.byteLength(entry.path)
  const corrupted = Buffer.from(buffer)
  corrupted[payloadAt] = corrupted[payloadAt] ^ 0xff
  assert.throws(() => readZipEntry(corrupted, entry), error => error.code === 'ZIP_CRC_MISMATCH')
})

test('refuses traversal, absolute, drive-letter, and backslash paths', () => {
  for (const path of ['../escape.txt', '/abs.txt', 'C:/abs.txt', 'a\\b.txt', 'a/../../b.txt', 'a/./b.txt', './a.txt']) {
    assert.throws(() => validateArchivePath(path), error => error.code === 'ZIP_BAD_PATH', path)
  }
  assert.throws(() => writeZip([file('nested/../x.txt', 'x')]), error => error.code === 'ZIP_BAD_PATH')
})

test('refuses reserved device names and trailing dots', () => {
  for (const path of ['package/CON', 'package/nul.txt', 'package/com1', 'package/trailing.']) {
    assert.throws(() => validateArchivePath(path), error => error.code === 'ZIP_BAD_PATH', path)
  }
})

test('refuses duplicate and case-colliding paths', () => {
  assert.throws(() => writeZip([file('A.txt', '1'), file('A.txt', '2')]), error => error.code === 'ZIP_DUPLICATE_PATH')
  assert.throws(() => writeZip([file('A.txt', '1'), file('a.txt', '2')]), error => error.code === 'ZIP_CASE_COLLISION')
})

test('refuses a zip bomb by compression ratio', () => {
  const bomb = { path: 'bomb.bin', data: Buffer.alloc(8 * 1024 * 1024) }
  const buffer = writeZip([bomb])
  assert.ok(deflateRawSync(bomb.data).length * ZIP_LIMITS.maxCompressionRatio < bomb.data.length)
  assert.throws(() => readZipIndex(buffer), error => error.code === 'ZIP_BOMB')
})

test('refuses a stream that inflates past its declared size', () => {
  // Every limit in readZipIndex is measured from the declared uncompressed
  // size, so an archive that declares 1 KiB while its deflate stream expands to
  // 64 KiB passes all of them. The output cap in readZipEntry is what keeps the
  // guards honest: without it zlib would expand the payload unbounded.
  //
  // The content has to compress a little (method deflate, not store) while
  // staying far from the ratio guard: hex text compresses to about half, so the
  // honest archive reads and the patched declaration keeps the ratio tiny.
  const content = Buffer.from(
    Array.from({ length: 1024 }, (unused, index) => createHash('sha256').update(String(index)).digest('hex')).join(''),
    'utf8',
  )
  const buffer = writeZip([{ path: 'bomb.bin', data: content }])
  const honest = readZipIndex(buffer).entries[0]
  assert.equal(honest.method, 8, 'the content compresses, so the entry is deflated')
  assert.ok(honest.uncompressedSize / honest.compressedSize < ZIP_LIMITS.maxCompressionRatio, 'the honest archive passes the ratio guard')

  const lying = withDeclaredSize(buffer, 'bomb.bin', 1024)
  assert.equal(readZipIndex(lying).entries[0].uncompressedSize, 1024, 'the lie is small enough to slip past every index-time guard')
  assert.throws(
    () => readZipEntry(lying, readZipIndex(lying).entries[0]),
    error => error.code === 'ZIP_BOMB' && /declared 1024 bytes/.test(error.message),
  )
  // The honest archive of the same content still reads.
  assert.equal(readZipEntry(buffer, honest).length, content.length)
})

test('tells a zip from other bytes by its signature, whatever the name', () => {
  assert.equal(looksLikeZip(writeZip([file('a.txt', 'x')])), true)
  assert.equal(looksLikeZip(Buffer.from('{"format":"dpk-config-data/1","files":[]}')), false)
  assert.equal(looksLikeZip(Buffer.alloc(2)), false)
  assert.equal(looksLikeZip(Buffer.from('PK\x03\x04')), true)
})

test('refuses an encrypted entry', () => {
  const buffer = writeZip([file('a.txt', 'secret')])
  // General-purpose flag bit 0 sits at central-directory offset +8 and local +6.
  const centralOffset = buffer.readUInt32LE(buffer.length - 22 + 16)
  const encrypted = Buffer.from(buffer)
  encrypted.writeUInt16LE(encrypted.readUInt16LE(centralOffset + 8) | 0x0001, centralOffset + 8)
  assert.throws(() => readZipIndex(encrypted), error => error.code === 'ZIP_ENCRYPTED')
})

test('refuses an unknown compression method', () => {
  const buffer = writeZip([file('a.txt', 'secret')])
  const centralOffset = buffer.readUInt32LE(buffer.length - 22 + 16)
  const patched = Buffer.from(buffer)
  patched.writeUInt16LE(12, centralOffset + 10)
  assert.throws(() => readZipIndex(patched), error => error.code === 'ZIP_METHOD')
})

test('refuses zip64 markers', () => {
  const buffer = writeZip([file('a.txt', 'x')])
  const patched = Buffer.from(buffer)
  patched.writeUInt16LE(0xffff, patched.length - 22 + 10)
  assert.throws(() => readZipIndex(patched), error => error.code === 'ZIP_ZIP64')
})

test('refuses a symlink entry mode', () => {
  const buffer = writeZip([file('link', 'target')])
  const centralOffset = buffer.readUInt32LE(buffer.length - 22 + 16)
  const patched = Buffer.from(buffer)
  patched.writeUInt32LE(((0o120777 & 0xffff) << 16) >>> 0, centralOffset + 38)
  assert.throws(() => readZipIndex(patched), error => error.code === 'ZIP_SYMLINK')
})

test('refuses a non-zip buffer', () => {
  assert.throws(() => readZipIndex(Buffer.from('not a zip at all, really')), error => error.code === 'ZIP_NOT_ZIP')
  assert.throws(() => readZipIndex(Buffer.alloc(4)), ZipError)
})

test('crc32 matches the known IEEE value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})
