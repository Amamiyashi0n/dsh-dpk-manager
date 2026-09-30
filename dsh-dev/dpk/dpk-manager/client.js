/**
 * Browser half of the assistant: a dedicated local DPK panel.
 *
 * The package manager is a fully local bundle. It owns one sidebar entry and
 * one main panel; it does not inject rows, badges, or sections into the shipped
 * official Plugins page.
 *
 * Everything the browser cannot do itself (unpack, install, re-pack, remove)
 * goes through the Host half's `ctx.remote.dpk` namespace. This module is plain
 * ESM in the module-table format the Web app loads, so it needs no build step.
 */

window.__ModuleLoader__.load({
  id: 'dsh-dpk-manager',
  factory(require) {
    const React = require('react')
    const { IconArchiveOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'dsh-package-manager'

    const zh = {
      importTitle: '导入 DPK 安装包',
      panel: '本地 DPK',
      pageTitle: '本地 DPK 包',
      packages: '已管理的本地包',
      empty: '还没有本地 DPK 包。',
      cardSummary: '从本地选择一个 .dpk 归档，校验后安装进当前 profile。',
      choose: '选择 .dpk 文件',
      importing: '校验并安装中…',
      imported: '已安装',
      failed: '失败',
      export: '导出 DPK',
      exporting: '打包中…',
      exported: '已导出',
      uninstall: '卸载',
      uninstalling: '卸载中…',
      confirmUninstall: '卸载该插件？这会把它从当前 profile 移除；没有其它 profile 引用时，本地仓库中的副本会一并删除。',
      badge: '由 DPK 安装',
      badgeTitle: '该插件由「DSH 安装包管理助手」以 .dpk 归档安装（内容寻址、可校验）。',
      sectionTitle: 'DPK 安装信息',
      installedBy: '安装方式',
      installedByValue: 'DSH 安装包管理助手（dpk）',
      source: '来源归档',
      digest: '内容摘要',
      installedAt: '安装时间',
      storePath: '本地仓库路径',
      profileState: '当前状态',
      store: '本地 DPK 仓库',
      hint: '此包由 dpk 管理：上方「导出 DPK」可重新打包，「卸载」会从 profile 移除并不留副本（仍有其它 profile 引用时除外）。',
    }
    const en = {
      importTitle: 'Import a DPK package',
      panel: 'Local DPK',
      pageTitle: 'Local DPK packages',
      packages: 'Managed local packages',
      empty: 'No local DPK packages yet.',
      cardSummary: 'Pick a .dpk archive, verify it, and install it into this profile.',
      choose: 'Choose a .dpk file',
      importing: 'Verifying and installing…',
      imported: 'Installed',
      failed: 'Failed',
      export: 'Export DPK',
      exporting: 'Packing…',
      exported: 'Exported',
      uninstall: 'Uninstall',
      uninstalling: 'Uninstalling…',
      confirmUninstall: 'Uninstall this plugin? It is removed from this profile; with no other profile using it, the stored copy is deleted too.',
      badge: 'Installed by DPK',
      badgeTitle: 'This plugin was installed from a .dpk archive by the DSH package manager assistant (content-addressed and verifiable).',
      sectionTitle: 'DPK installation',
      installedBy: 'Installed by',
      installedByValue: 'DSH package manager assistant (dpk)',
      source: 'Source archive',
      digest: 'Content digest',
      installedAt: 'Installed at',
      storePath: 'Local store path',
      profileState: 'State',
      store: 'Local DPK store',
      hint: 'Managed by dpk: “Export DPK” re-packs it, “Uninstall” removes it without leaving a copy (unless another profile still uses it).',
    }

    const requestCodec = method => ({
      mode: 'strict',
      typeSymbol: `dsh-dpk-manager#${method}Request`,
      // The Client carrier forwards JSON values unchanged. The factory is kept
      // for the strict generated-descriptor contract and is never materialized
      // by this source-only contribution.
      create: () => ({ parse: value => value }),
    })
    const descriptor = (method, parameter) => ({
      id: `dsh-dpk-manager#dpk/${method}`,
      service: 'dpk',
      namespace: 'dpk',
      method,
      invocation: { kind: 'direct' },
      parameters: parameter === undefined ? [] : [{
        name: parameter,
        wire: parameter,
        source: 'json',
        codec: requestCodec(method),
      }],
      result: { mode: 'src-json' },
    })
    const DPK_REMOTE = {
      package: 'dsh-dpk-manager',
      descriptors: [
        descriptor('managed'),
        descriptor('importArchive', 'input'),
        descriptor('exportArchive', 'request'),
        descriptor('removeArchive', 'request'),
      ],
    }

    /** Base64 without blowing the argument limit on large archives. */
    function toBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let at = 0; at < bytes.length; at += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(at, at + chunk))
      }
      return btoa(binary)
    }

    function toBytes(base64) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
      return bytes
    }

    const buttonStyle = {
      padding: '4px 10px',
      borderRadius: 6,
      border: '1px solid currentColor',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit',
    }
    const mutedStyle = { opacity: 0.7, marginLeft: 8, font: 'inherit' }
    const rowStyle = { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', margin: 0 }
    const labelStyle = { opacity: 0.7 }
    const valueStyle = { wordBreak: 'break-all' }

    return {
      inject: ['slots', 'locale', 'remote'],
      async apply(ctx) {
        await ctx.remote.$mount(DPK_REMOTE)
        const dpk = ctx.get('remote.dpk')
        if (dpk === undefined) throw new Error('dsh-package-manager: remote.dpk did not mount')
        const callDpk = async (method, ...args) => {
          const outcome = await dpk[method](...args)
          if (outcome?.ok === true) return outcome.value
          if (outcome?.ok === false) throw outcome.error
          throw new Error(`dsh-package-manager: ${method} returned an invalid Remote result`)
        }

        if (ctx.locale) ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-package-manager: dictionaries')
        const tr = ctx.locale ? ctx.locale.bind(NS) : key => (zh[key] ?? en[key] ?? key)

        // --- shared managed-package state -------------------------------------
        const state = { entries: [], store: '', error: undefined, listeners: new Set() }
        const notify = () => { for (const listener of state.listeners) listener() }

        async function refresh() {
          try {
            const answer = await callDpk('managed')
            state.entries = answer.entries ?? []
            state.store = answer.store ?? ''
            state.error = undefined
          } catch (error) {
            state.error = String(error?.message ?? error)
          } finally {
            notify()
          }
        }

        const entryFor = name => state.entries.find(entry => entry.name === name)
        const useManaged = () => {
          const [snapshot, setSnapshot] = React.useState(state.entries.length)
          React.useEffect(() => {
            const listener = () => setSnapshot(state.entries.length + state.entries.map(entry => entry.digest).join('').length)
            state.listeners.add(listener)
            if (state.entries.length === 0) void refresh()
            return () => { state.listeners.delete(listener) }
          }, [])
          return snapshot
        }

        if (ctx.remote?.$on) {
          ctx.effect(
            () => ctx.remote.$on('plugin-manager/changed', () => { void refresh() }),
            'dsh-package-manager: follow manager changes',
          )
        }

        // --- import controls --------------------------------------------------
        function DpkImportSection() {
          const [status, setStatus] = React.useState(undefined)
          const [busy, setBusy] = React.useState(false)
          const snapshot = useManaged()
          const inputId = 'dpk-import-input'

          async function onFile(event) {
            const file = event.target.files && event.target.files[0]
            if (!file) return
            setBusy(true)
            setStatus(tr('importing'))
            try {
              const bytes = new Uint8Array(await file.arrayBuffer())
              const result = await callDpk('importArchive', { fileName: file.name, base64: toBase64(bytes) })
              setStatus(`${tr('imported')} ${result.name}@${result.version}`)
              await refresh()
            } catch (error) {
              setStatus(`${tr('failed')}: ${String(error?.message ?? error)}`)
            } finally {
              setBusy(false)
              event.target.value = ''
            }
          }

          return h('section', { style: { display: 'grid', gap: 8 } }, [
            h('h4', { key: 'title', style: { margin: 0 } }, tr('importTitle')),
            h('div', { key: 'summary' }, tr('cardSummary')),
            h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
              h('input', {
                key: 'input', id: inputId, type: 'file', accept: '.dpk', disabled: busy,
                onChange: onFile, style: { display: 'none' },
              }),
              h('button', {
                key: 'pick', type: 'button', disabled: busy, style: buttonStyle,
                onClick: () => { const input = document.getElementById(inputId); if (input) input.click() },
              }, tr('choose')),
              status === undefined ? null : h('span', { key: 'status', style: mutedStyle }, status),
            ]),
            h('div', { key: 'store', style: mutedStyle }, `${tr('store')}: ${state.store || '—'} (${state.entries.length})`),
            snapshot === undefined ? null : null,
          ])
        }

        // --- detail actions ---------------------------------------------------
        function DpkActions(props) {
          const [status, setStatus] = React.useState(undefined)
          const [busy, setBusy] = React.useState(false)
          useManaged()
          const subject = props.subject
          if (!subject || subject.kind !== 'bundle') return null
          const name = subject.pkg.name
          if (entryFor(name) === undefined) return null

          async function onExport() {
            setBusy(true)
            setStatus(tr('exporting'))
            try {
              const result = await callDpk('exportArchive', { name })
              const url = URL.createObjectURL(new Blob([toBytes(result.base64)], { type: 'application/zip' }))
              const anchor = document.createElement('a')
              anchor.href = url
              anchor.download = result.fileName
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
              URL.revokeObjectURL(url)
              setStatus(`${tr('exported')} ${result.fileName} (${result.bytes} B)`)
            } catch (error) {
              setStatus(`${tr('failed')}: ${String(error?.message ?? error)}`)
            } finally {
              setBusy(false)
            }
          }

          async function onUninstall() {
            if (typeof window.confirm === 'function' && !window.confirm(tr('confirmUninstall'))) return
            setBusy(true)
            setStatus(tr('uninstalling'))
            try {
              await callDpk('removeArchive', { name })
              setStatus(`${tr('uninstall')} ✓`)
              await refresh()
            } catch (error) {
              setStatus(`${tr('failed')}: ${String(error?.message ?? error)}`)
            } finally {
              setBusy(false)
            }
          }

          return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
            h('button', { key: 'export', type: 'button', disabled: busy, style: buttonStyle, onClick: onExport }, tr('export')),
            h('button', { key: 'remove', type: 'button', disabled: busy, style: buttonStyle, onClick: onUninstall }, tr('uninstall')),
            status === undefined ? null : h('span', { key: 'status', style: mutedStyle }, status),
          ])
        }

        function DpkPackageRow({ entry }) {
          const values = [
            [tr('installedBy'), tr('installedByValue')],
            [tr('source'), entry.source ?? '—'],
            [tr('digest'), entry.digest],
            [tr('installedAt'), entry.installedAt ?? '—'],
            [tr('storePath'), `${state.store}\\store\\${entry.digest}\\package`],
            [tr('profileState'), `${entry.profileState ?? ''}${entry.installed ? 'installed' : 'not-a-dependency'}${entry.enabled ? ' · enabled' : ' · disabled'}`],
          ]
          return h('article', {
            style: { display: 'grid', gap: 10, padding: '18px 0', borderTop: '1px solid color-mix(in srgb, currentColor 16%, transparent)' },
          }, [
            h('div', { key: 'heading', style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } }, [
              h('strong', { key: 'name' }, entry.name),
              h('span', { key: 'version', style: mutedStyle }, entry.version),
            ]),
            h('div', { key: 'details', style: { display: 'grid', gap: 6 } }, [
              h('dl', { key: 'rows', style: rowStyle }, values.flatMap(([label, value]) => [
                h('dt', { key: `${label}-k`, style: labelStyle }, label),
                h('dd', { key: `${label}-v`, style: { ...valueStyle, margin: 0 } }, String(value)),
              ])),
              h('div', { key: 'hint', style: { opacity: 0.7 } }, tr('hint')),
            ]),
            h(DpkActions, { key: 'actions', subject: { kind: 'bundle', pkg: { name: entry.name } } }),
          ])
        }

        function DpkPage() {
          useManaged()
          return h('main', { style: { height: '100%', overflow: 'auto' } },
            h('div', { style: { width: 'min(920px, 100%)', margin: '0 auto', padding: '24px' } }, [
              h('h2', { key: 'title', style: { margin: '0 0 20px', fontSize: 22 } }, tr('pageTitle')),
              h(DpkImportSection, { key: 'import' }),
              state.error === undefined
                ? null
                : h('div', { key: 'error', role: 'alert', style: { marginTop: 16, color: '#b42318' } }, state.error),
              h('section', { key: 'packages', style: { marginTop: 28 } }, [
                h('h3', { key: 'heading', style: { margin: '0 0 8px', fontSize: 16 } }, tr('packages')),
                state.entries.length === 0
                  ? h('div', { key: 'empty', style: mutedStyle }, tr('empty'))
                  : state.entries.map(entry => h(DpkPackageRow, { key: entry.name, entry })),
              ]),
            ]))
        }

        function DpkPanelIcon({ size }) {
          return h(IconArchiveOutlineRegular, { size })
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'dpk', locale: NS,
        }, DpkPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'dpk', order: 10, label: () => tr('panel'), locale: NS,
        }, DpkPanelIcon))
      },
    }
  },
})
