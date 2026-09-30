import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

test('client mounts its local Remote contribution before reading the namespace', async () => {
  let registration
  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  }
  vm.runInNewContext(source, { window })

  assert.equal(registration.id, '@local/dsh-package-manager')
  const plugin = registration.factory((name) => {
    if (name === 'react') return { createElement() {} }
    assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives')
    return { IconArchiveOutlineRegular() {} }
  })
  assert.deepEqual(
    [...plugin.inject].sort(),
    ['locale', 'remote', 'slots'].sort(),
  )

  const accessed = new Set()
  const registrations = []
  let contribution
  const dpk = {
    managed: async () => ({ ok: true, value: { entries: [], store: '' } }),
    importArchive: async () => ({ ok: true, value: {} }),
    exportArchive: async () => ({ ok: true, value: {} }),
    removeArchive: async () => ({ ok: true, value: {} }),
  }
  const services = {
    locale: {
      bind: () => key => key,
      register: () => () => {},
    },
    remote: {
      $on: () => () => {},
      async $mount(value) {
        contribution = value
        this.dpk = dpk
        return async () => { delete this.dpk }
      },
    },
    slots: {
      inject(_name, factory) {
        factory()
      },
      register(spec, component) {
        registrations.push({ name: spec.name, id: spec.id, key: spec.key, component })
        return { spec, component }
      },
    },
  }
  const ctx = new Proxy({
    effect(callback) {
      callback()
    },
    get(name) {
      assert.equal(name, 'remote.dpk')
      return services.remote.dpk
    },
  }, {
    get(target, property) {
      if (Reflect.has(target, property)) return Reflect.get(target, property)
      assert.equal(plugin.inject.includes(property), true, `undeclared service read: ${String(property)}`)
      accessed.add(property)
      return services[property]
    },
  })

  await plugin.apply(ctx)
  assert.deepEqual([...accessed].sort(), ['locale', 'remote', 'slots'])
  assert.equal(contribution.package, '@local/dsh-package-manager')
  assert.deepEqual(
    [...contribution.descriptors].map(value => [value.namespace, value.method, value.parameters.length]),
    [
      ['dpk', 'managed', 0],
      ['dpk', 'importArchive', 1],
      ['dpk', 'exportArchive', 1],
      ['dpk', 'removeArchive', 1],
    ],
  )
  for (const value of contribution.descriptors.slice(1)) {
    assert.equal(value.parameters[0].codec.mode, 'strict')
    assert.equal(typeof value.parameters[0].codec.create, 'function')
  }
  assert.deepEqual(
    registrations.map(value => `${value.name}:${value.id ?? value.key}`).sort(),
    [
      'main:dpk',
      'sidebar.panellist:dpk',
    ],
  )
})
