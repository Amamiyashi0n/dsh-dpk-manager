import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

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
      ['dpk', 'debugStatus', 0],
      ['dpk', 'setDebugMode', 1],
      ['dpk', 'importArchive', 1],
      ['dpk', 'exportVolumes', 1],
      ['dpk', 'exportArchive', 1],
      ['dpk', 'removeArchive', 1],
    ],
  )
  for (const value of contribution.descriptors.filter(value => value.parameters.length > 0)) {
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

test('export downloads a dpk and migration downloads app plus data', async () => {
  let registration
  const window = { __ModuleLoader__: { load(value) { registration = value } } }

  const calls = []
  const archiveCalls = []
  const downloads = []
  const revoked = []
  const blobs = []
  class TestBlob {
    constructor(parts, options) {
      this.bytes = [...parts[0]]
      this.type = options.type
      blobs.push(this)
    }
  }
  const document = {
    body: {
      appendChild(anchor) { downloads.push(anchor) },
    },
    createElement(tag) {
      assert.equal(tag, 'a')
      return {
        click() { this.clicked = true },
        remove() { this.removed = true },
      }
    },
  }
  const URL = {
    createObjectURL(blob) { return `blob:${blobs.indexOf(blob)}` },
    revokeObjectURL(url) { revoked.push(url) },
  }
  vm.runInNewContext(source, {
    window,
    URL,
    Blob: TestBlob,
    document,
    atob: () => '{}',
    setTimeout: callback => { callback(); return 0 },
  })
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
    debugTitle: 'DPK 调试模式',
    debugEnable: '开启 DPK 调试模式',
    debugDisable: '关闭 DPK 调试模式',
    debugEnabling: '打开 DSH Web 中…',
    debugEnabled: 'DSH Web 已打开',
    debugDisabled: 'DPK 调试模式已关闭',
    debugBlocked: '浏览器阻止了新窗口，请允许后重试',
    debugHint: '使用 DSH 官方 Web 端口打开调试界面；Electron 主界面继续运行。',
    export: '导出插件（.dpk）',
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
          debugStatus: async () => ({ ok: true, value: { enabled: false, available: true, port: 19387 } }),
          setDebugMode: async enabled => ({
            ok: true,
            value: enabled
              ? { enabled: true, available: true, port: 19387, url: 'http://127.0.0.1:19387/?token=fixture' }
              : { enabled: false, available: true },
          }),
          // The Host builds the file; the browser only downloads it. Recording
          // the request is what proves which verb each button asks for.
          exportVolumes: async request => {
            calls.push(request)
            return { ok: true, value: { fileName: `${request.verb}.json`, base64: 'e30=', bytes: 2 } }
          },
          exportArchive: async request => {
            archiveCalls.push(request)
            return { ok: true, value: { fileName: 'known@1.0.0.dpk', base64: 'e30=', bytes: 2 } }
          },
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
  assert.deepEqual(buttons.map(button => button.props.children), ['开启 DPK 调试模式', '选择 .dpk 文件'])
  for (const fn of effects) await fn()
  await new Promise(resolve => setImmediate(resolve))

  buttons.length = 0
  walk(page())

  assert.deepEqual(
    buttons.map(button => button.props.children),
    ['开启 DPK 调试模式', '选择 .dpk 文件', '导出插件（.dpk）', '迁移插件（app+data）', '卸载'],
  )
  // A disabled button swallows the click and still looks alive: `busy` idles
  // at `undefined`, so `disabled: busy !== undefined` must start out false.
  // A `false` initialiser would weld these buttons shut from the first render.
  assert.deepEqual(
    buttons.slice(2).map(button => button.props.disabled),
    [false, false, false],
  )
  // Export re-packs the installed store copy into a real `.dpk`; migration
  // remains a data-volume snapshot because runtime data is not package content.
  const byLabel = label => buttons.find(button => button.props.children === label)
  byLabel('导出插件（.dpk）').props.onClick()
  byLabel('迁移插件（app+data）').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(archiveCalls.map(call => call.name), ['@local/known'])
  assert.deepEqual(calls.map(call => [call.name, call.verb]), [['@local/known', 'snap']])
  assert.deepEqual(downloads.map(anchor => ({ name: anchor.download, href: anchor.href, clicked: anchor.clicked, removed: anchor.removed })), [
    { name: 'known@1.0.0.dpk', href: 'blob:0', clicked: true, removed: true },
    { name: 'snap.json', href: 'blob:1', clicked: true, removed: true },
  ])
  assert.deepEqual(blobs.map(blob => ({ bytes: blob.bytes, type: blob.type })), [
    { bytes: [123, 125], type: 'application/octet-stream' },
    { bytes: [123, 125], type: 'application/json' },
  ])
  assert.deepEqual(revoked, ['blob:0', 'blob:1'])
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

test('debug mode reserves a browser popup before the Remote call and navigates it', async () => {
  let registration
  const window = {
    location: { protocol: 'http:' },
    __ModuleLoader__: { load(value) { registration = value } },
  }
  const popup = { location: { href: 'about:blank' }, closed: false }
  const order = []
  window.open = (url, target) => {
    order.push(['open', url, target])
    return popup
  }
  vm.runInNewContext(source, { window })

  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
  let page
  const remote = {
    $mount: async () => {
      remote.dpk = {
        managed: async () => ({ ok: true, value: { entries: [], store: '' } }),
        debugStatus: async () => ({ ok: true, value: { enabled: false, available: true } }),
        setDebugMode: async enabled => {
          order.push(['remote', enabled])
          return { ok: true, value: enabled
            ? { enabled: true, available: true, url: 'http://127.0.0.1:19387/?token=fixture' }
            : { enabled: false, available: true } }
        },
      }
      return async () => {}
    },
  }
  const services = {
    locale: { bind: () => key => key, register: () => () => {} },
    remote,
    slots: {
      inject(_name, factory) { factory() },
      register(spec, component) { if (spec.name === 'main') page = component },
    },
  }
  const ctx = new Proxy({
    effect() {},
    get() { return remote.dpk },
  }, {
    get(target, property) {
      if (Reflect.has(target, property)) return Reflect.get(target, property)
      return services[property]
    },
  })
  const plugin = registration.factory(name => (name === 'react' ? react : { IconArchiveOutlineRegular() {} }))
  await plugin.apply(ctx)

  const walk = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return []
    if (Array.isArray(node)) return node.flatMap(walk)
    if (typeof node !== 'object') return []
    if (node.type === 'button') return [node, ...walk(node.props?.children)]
    if (typeof node.type === 'function') return walk(node.type(node.props))
    return walk(node.props?.children)
  }
  const debug = walk(page()).find(button => button.props.children === 'debugEnable')
  assert.notEqual(debug, undefined)
  debug.props.onClick()
  assert.deepEqual(order, [['open', 'about:blank', 'dsh-dpk-debug'], ['remote', true]])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(popup.location.href, 'http://127.0.0.1:19387/?token=fixture')
})
