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

  assert.equal(registration.id, 'dsh-dpk-manager')
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
    exportVolumes: async () => ({ ok: true, value: {} }),
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
  assert.equal(contribution.package, 'dsh-dpk-manager')
  assert.deepEqual(
    [...contribution.descriptors].map(value => [value.namespace, value.method, value.parameters.length]),
    [
      ['dpk', 'managed', 0],
      ['dpk', 'importArchive', 1],
      ['dpk', 'exportVolumes', 1],
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
      'plugins.detail.badge:dpk-managed',
      'sidebar.panellist:dpk',
    ],
  )
})

test('the two buttons ask the Host for the app scope and the app+data scope', async () => {
  let registration
  const window = { __ModuleLoader__: { load(value) { registration = value } } }
  vm.runInNewContext(source, { window })

  const calls = []
  const effects = []
  const react = {
    // Enough of createElement to keep the children: the panel builds its buttons
    // with them, and the labels are what this test reads.
    createElement: (type, props, ...children) => ({
      type,
      props: { ...props, children: children.length === 1 ? children[0] : children },
    }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: fn => { effects.push(fn) },
  }
  let page
  const dictionary = {
    export: '导出插件（仅 app）',
    migrate: '迁移插件（app+data）',
    exporting: '导出中…',
    migrating: '迁移中…',
    choose: '选择 .dpk 文件',
    uninstall: '卸载',
  }
  const services = {
    locale: {
      bind: () => (key, vars) => (vars === undefined ? (dictionary[key] ?? key) : `${dictionary[key] ?? key} ${JSON.stringify(vars)}`),
      register: () => () => {},
    },
    remote: {
      $on: () => () => {},
      async $mount() {
        this.dpk = {
          managed: async () => ({
            ok: true,
            value: {
              entries: [{ name: '@local/known', version: '1.0.0', digest: 'd'.repeat(64), installed: true, enabled: true, store: '' }],
              store: '',
            },
          }),
          // The Host builds the file; the browser only downloads it. Recording
          // the request is what proves which verb each button asks for.
          exportVolumes: async request => { calls.push(request); return { ok: true, value: { fileName: 'x.json', base64: '', bytes: 0 } } },
          removeArchive: async () => ({ ok: true, value: {} }),
        }
        return async () => { delete this.dpk }
      },
    },
    slots: {
      inject(_name, factory) { factory() },
      register(spec, component) {
        if (spec.name === 'main') page = component
        return { spec, component }
      },
    },
  }
  const ctx = new Proxy({
    effect(callback) { callback() },
    get() { return services.remote.dpk },
  }, {
    get(target, property) {
      if (Reflect.has(target, property)) return Reflect.get(target, property)
      if (typeof property === 'symbol' || property === 'then') return undefined
      return services[property]
    },
  })

  const plugin = registration.factory(name => (name === 'react' ? react : { IconArchiveOutlineRegular() {} }))
  await plugin.apply(ctx)

  /** Every `button` element in the rendered tree, in order. */
  const buttons = []
  const walk = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node !== 'object') return
    if (typeof node.type === 'function') { walk(node.type(node.props)); return }
    if (node.type === 'button') buttons.push(node)
    walk(node.props?.children)
  }

  // First render: no ledger yet, so the rows are absent — this is what registers
  // the effect that fetches it.
  walk(page())
  assert.deepEqual(buttons.map(button => button.props.children), ['选择 .dpk 文件'])
  for (const fn of effects) await fn()
  await new Promise(resolve => setImmediate(resolve))

  buttons.length = 0
  walk(page())

  assert.deepEqual(
    buttons.map(button => button.props.children),
    ['选择 .dpk 文件', '导出插件（仅 app）', '迁移插件（app+data）', '卸载'],
  )
  // The old `导出 DPK` button re-packed the package; these two carry volumes.
  // Clicking runs the download, which needs a browser: the verb is recorded
  // before the Blob is built, so what the button asked for is still observable.
  const byLabel = label => buttons.find(button => button.props.children === label)
  byLabel('导出插件（仅 app）').props.onClick()
  byLabel('迁移插件（app+data）').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.map(call => [call.name, call.verb]), [['@local/known', 'export'], ['@local/known', 'snap']])
})

test('the plugins-page badge tags only bundles this manager installed', async () => {
  let registration
  let injectList
  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  }
  vm.runInNewContext(source, { window })

  const effects = []
  const react = {
    createElement: (type, props) => ({ type, props }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: fn => { effects.push(fn) },
  }
  const badgeRef = {}
  const dictionary = {
    badge: '该插件由 dpk 管理器安装和管理',
    badgeTitle: 'Installed by the DSH package manager assistant',
  }
  const services = {
    locale: { bind: () => key => dictionary[key] ?? key, register: () => () => {} },
    remote: {
      $on: () => () => {},
      async $mount(value) {
        this.dpk = {
          managed: async () => ({
            ok: true,
            value: { entries: [{ name: '@local/known', version: '1.0.0', digest: 'd', installed: true }], store: '' },
          }),
        }
        return async () => { delete this.dpk }
      },
    },
    slots: {
      inject(_name, factory) { factory() },
      register(spec, component) {
        if (spec.name === 'plugins.detail.badge') badgeRef.component = component
        return { spec, component }
      },
    },
  }
  const ctx = new Proxy({
    effect(callback) { callback() },
    get(name) { return services.remote.dpk },
  }, {
    get(target, property) {
      if (Reflect.has(target, property)) return Reflect.get(target, property)
      if (typeof property === 'symbol' || property === 'then') return undefined
      assert.equal(injectList.includes(property), true, `undeclared service read: ${String(property)}`)
      return services[property]
    },
  })

  const plugin = registration.factory(name => (name === 'react' ? react : { IconArchiveOutlineRegular() {} }))
  injectList = [...plugin.inject]
  await plugin.apply(ctx)
  assert.notEqual(badgeRef.component, undefined)

  const render = subject => badgeRef.component({ subject })
  // 首次渲染：账本尚未拉回，不渲染任何东西
  assert.equal(render({ kind: 'bundle', pkg: { name: '@local/known', installed: true, enabled: true, rows: [] } }), null)
  // 挂载副作用把账本拉回来（refresh 是异步的，冲一冲微任务）
  for (const fn of effects) await fn()
  await new Promise(resolve => setImmediate(resolve))
  // 非受管包、未安装包、行主题一律不渲染
  assert.equal(render({ kind: 'bundle', pkg: { name: 'npm-only', installed: true, enabled: true, rows: [] } }), null)
  assert.equal(render({ kind: 'bundle', pkg: { name: '@local/known', installed: false, enabled: false, rows: [] } }), null)
  assert.equal(render({ kind: 'row', pkg: { name: '@local/known', installed: true, enabled: true, rows: [] }, row: { rowId: 'r', moduleName: '@local/known', enabled: true } }), null)
  // 受管且已安装的包得到徽章，悬停文案指向本助手
  const tagged = render({ kind: 'bundle', pkg: { name: '@local/known', installed: true, enabled: true, rows: [] } })
  assert.equal(tagged.type, 'span')
  assert.match(tagged.props.title, /DSH/)
})
test('a completed import or uninstall schedules one delayed settling refresh', async () => {
  // The overwrite install emits its changed events mid-flight; the refresh
  // right after the call can still read the interim view, so the client
  // schedules one delayed refresh to settle the cards.
  assert.equal((source.match(/refreshSettled\(\)/g) || []).length, 2, 'import and uninstall both settle')
  assert.match(source, /settleTimer = setTimeout\(\(\) => \{ void refresh\(\) \}, delay\)/)
})
