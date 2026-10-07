/**
 * 格式的两份描述必须一致:`schemas/dpk-1.schema.json`(文档/schema)与
 * `lib/dpk-manifest.mjs`(真正的校验器)。schema 没有代码在用,所以它曾经悄悄漂移
 * ——顶层 `data` 字段在 schema 里合法、却被校验器拒绝。这组测试把两边钉在一起:
 * 键集合逐字比对,required/optional 的判定用行为验证(删掉它会不会被拒)。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packDirectory } from '../src/lib/pack.mjs'
import { FILE_KEYS, INTEGRITY_KEYS, MANIFEST_KEYS, validateManifest } from '../src/lib/dpk-manifest.mjs'
import { makePackage } from './helpers.mjs'

const SCHEMA_PATH = join(import.meta.dirname, '..', 'schemas', 'dpk-1.schema.json')

/** The schema next to a real manifest to test the validator against. */
async function fixture() {
  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'))
  const packed = await packDirectory(await makePackage())
  return { schema, manifest: packed.manifest }
}

test('the schema and the validator name the same top-level keys', async () => {
  const { schema } = await fixture()
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    [...MANIFEST_KEYS].sort(),
    'a key the schema allows but the validator refuses (or the reverse) is the drift this pins',
  )
  assert.equal(schema.additionalProperties, false)
})

test('the schema and the validator agree on which keys are required', async () => {
  const { schema, manifest } = await fixture()
  const required = new Set(schema.required)
  for (const key of Object.keys(schema.properties)) {
    const without = { ...manifest }
    delete without[key]
    if (required.has(key)) {
      assert.throws(() => validateManifest(without), `the schema requires ${key}, so the validator must refuse a manifest without it`)
    } else {
      assert.doesNotThrow(() => validateManifest(without), `the schema leaves ${key} optional, so the validator must accept its absence`)
    }
  }
})

test('the schema and the validator name the same file fields', async () => {
  const { schema } = await fixture()
  const file = schema.properties.files.items
  assert.equal(file.additionalProperties, false)
  assert.deepEqual(Object.keys(file.properties).sort(), [...FILE_KEYS].sort())
  assert.deepEqual([...file.required].sort(), [...FILE_KEYS].sort(), 'every declared file field is required')
})

test('the schema and the validator name the same integrity fields', async () => {
  const { schema } = await fixture()
  const integrity = schema.properties.integrity
  assert.equal(integrity.additionalProperties, false)
  assert.deepEqual(Object.keys(integrity.properties).sort(), [...INTEGRITY_KEYS].sort())
  assert.deepEqual([...integrity.required].sort(), [...INTEGRITY_KEYS].sort(), 'every declared integrity field is required')
  assert.equal(integrity.properties.algorithm.const, 'sha256')
})

test('a top-level data key is refused, and the schema no longer offers it', async () => {
  const { schema, manifest } = await fixture()
  assert.equal(Object.hasOwn(schema.properties, 'data'), false, 'the 2.1.8-2.1.9 spelling is not part of format 1')
  // The volumes live in the verbatim dsh copy. The old top-level spelling is an
  // unknown field like any other: the generation that wrote it is not served, so
  // it gets the plain rejection rather than a migration hint.
  assert.throws(
    () => validateManifest({ ...manifest, data: { volumes: [] } }),
    (error) => error.code === 'DPK_MANIFEST_UNKNOWN_FIELD' && /unknown field: data/.test(error.message),
  )
})
