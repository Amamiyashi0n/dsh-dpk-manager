/**
 * Browser half of the assistant: a dedicated local DPK panel, plus one badge
 * on the official Plugins page — a bundle this manager installed carries the
 * 「该插件由 dpk 管理器安装和管理」 tag beside its title.
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
      export: '导出插件（仅 app）',
      exporting: '导出中…',
      exported: '已导出',
      migrate: '迁移插件（app+data）',
      migrating: '迁移中…',
      migrated: '已迁移',
      exportHint: '下载这个插件的 app 卷（运行期写下的数据），等价于 dpk export name=<包>',
      migrateHint: '下载这个插件的 app 卷与 data 卷（含声明的设置），等价于 dpk snap name=<包>',
      uninstall: '卸载',
      uninstalling: '卸载中…',
      confirmUninstall: '卸载该插件？这会把它从当前 profile 移除；没有其它 profile 引用时，本地仓库中的副本会一并删除。',
      badge: '该插件由 dpk 管理器安装和管理',
      badgeTitle: '该插件由「DSH 安装包管理助手」以 .dpk 归档安装（内容寻址、可校验），安装、升级与卸载都经本地 DPK 面板完成。',
      sectionTitle: 'DPK 安装信息',
      installedBy: '安装方式',
      installedByValue: 'DSH 安装包管理助手（dpk）',
      source: '来源归档',
      digest: '内容摘要',
      installedAt: '安装时间',
      storePath: '本地仓库路径',
      profileState: '当前状态',
      store: '本地 DPK 仓库',
      restartNotice: '以下插件包将在下一次 DeepSeek Harness 启动后生效：',
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
      export: 'Export plugin (app)',
      exporting: 'Exporting…',
      exported: 'Exported',
      migrate: 'Migrate plugin (app + data)',
      migrating: 'Migrating…',
      migrated: 'Migrated',
      exportHint: 'Download this plugin\'s app volumes — the same file as dpk export name=<package>',
      migrateHint: 'Download this plugin\'s app and data volumes — the same file as dpk snap name=<package>',
      uninstall: 'Uninstall',
      uninstalling: 'Uninstalling…',
      confirmUninstall: 'Uninstall this plugin? It is removed from this profile; with no other profile using it, the stored copy is deleted too.',
      badge: 'Installed and managed by the dpk manager',
      badgeTitle: 'This plugin was installed from a .dpk archive by the DSH package manager assistant (content-addressed and verifiable); install, upgrade, and uninstall all go through the Local DPK panel.',
      sectionTitle: 'DPK installation',
      installedBy: 'Installed by',
      installedByValue: 'DSH package manager assistant (dpk)',
      source: 'Source archive',
      digest: 'Content digest',
      installedAt: 'Installed at',
      storePath: 'Local store path',
      profileState: 'State',
      store: 'Local DPK store',
      restartNotice: 'These packages take effect at the next DeepSeek Harness start:',
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
        descriptor('exportVolumes', 'request'),
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
        const state = { entries: [], store: '', error: undefined, notice: undefined, listeners: new Set() }
        const notify = () => { for (const listener of state.listeners) listener() }

        async function refresh() {
          try {
            const answer = await callDpk('managed')
            state.entries = answer.entries ?? []
            state.store = answer.store ?? ''
            // A restart is only owed when something the running Harness has not
            // loaded remains; the reminder names each package, so it says what
            // the next start will bring instead of just asking for one.
            state.notice = answer.restartRequired === true
              ? `${tr('restartNotice')} ${(answer.awaitingRestart ?? []).map(item => `${item.name}@${item.version}`).join('、')}`
              : undefined
            state.error = undefined
          } catch (error) {
            state.error = String(error?.message ?? error)
          } finally {
            notify()
          }
        }

        // An install that overwrites (removeBundle + installBundle) emits its
        // changed events mid-flight, so the refresh right after the call can
        // still read the interim view. A short delayed refresh settles it.
        let settleTimer
        function refreshSettled(delay = 1600) {
          clearTimeout(settleTimer)
          settleTimer = setTimeout(() => { void refresh() }, delay)
        }

        const entryFor = name => state.entries.find(entry => entry.name === name)
        const useManaged = () => {
          const currentSnapshot = () => JSON.stringify({
            store: state.store,
            error: state.error,
            notice: state.notice,
            entries: state.entries.map(entry => ({
              name: entry.name,
              version: entry.version,
              digest: entry.digest,
              installed: entry.installed,
              enabled: entry.enabled,
              profileState: entry.profileState,
            })),
          })
          const [snapshot, setSnapshot] = React.useState(currentSnapshot)
          React.useEffect(() => {
            const listener = () => setSnapshot(currentSnapshot())
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
              refreshSettled()
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
          const managed = entryFor(name)
          if (managed === undefined) return null
          const canUninstall = managed.installed === true || (managed.profiles?.length ?? 0) > 0

          // Both buttons hand the browser a data file the Host built with the dpk
          // verb of the same name: `export` carries this package's app volumes,
          // `snap` carries app and data volumes.
          async function onExportVolumes(verb) {
            setBusy(verb)
            setStatus(tr(verb === 'snap' ? 'migrating' : 'exporting'))
            try {
              const result = await callDpk('exportVolumes', { name, verb })
              const url = URL.createObjectURL(new Blob([toBytes(result.base64)], { type: 'application/json' }))
              const anchor = document.createElement('a')
              anchor.href = url
              anchor.download = result.fileName
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
              // Let the browser start the download before releasing its blob.
              setTimeout(() => URL.revokeObjectURL(url), 1000)
              setStatus(`${tr(verb === 'snap' ? 'migrated' : 'exported')} ${result.fileName} (${result.bytes} B)`)
            } catch (error) {
              setStatus(`${tr('failed')}: ${String(error?.message ?? error)}`)
            } finally {
              setBusy(undefined)
            }
          }

          async function onUninstall() {
            if (typeof window.confirm === 'function' && !window.confirm(tr('confirmUninstall'))) return
            setBusy('remove')
            setStatus(tr('uninstalling'))
            try {
              await callDpk('removeArchive', { name })
              // A stale profile link has no active bundle to unload. The Host
              // still removed the local profile/store state successfully.
              setStatus(`${tr('uninstall')} ✓`)
              await refresh()
              refreshSettled()
            } catch (error) {
              setStatus(`${tr('failed')}: ${String(error?.message ?? error)}`)
            } finally {
              setBusy(undefined)
            }
          }

          return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
            h('button', {
              key: 'export', type: 'button', disabled: busy !== undefined, style: buttonStyle,
              title: tr('exportHint'), onClick: () => { void onExportVolumes('export') },
            }, tr('export')),
            h('button', {
              key: 'migrate', type: 'button', disabled: busy !== undefined, style: buttonStyle,
              title: tr('migrateHint'), onClick: () => { void onExportVolumes('snap') },
            }, tr('migrate')),
            canUninstall
              ? h('button', { key: 'remove', type: 'button', disabled: busy !== undefined, style: buttonStyle, onClick: () => { void onUninstall() } }, tr('uninstall'))
              : null,
            status === undefined ? null : h('span', { key: 'status', style: mutedStyle }, status),
          ])
        }

        /**
         * A ledger timestamp in the reader's own time, to the minute. The raw
         * ISO string stays available on hover; a missing or unparseable value
         * reads as `—` (or as itself) rather than as "Invalid Date".
         */
        function formatStamp(value) {
          if (typeof value !== 'string' || value === '') return '—'
          const at = new Date(value)
          if (Number.isNaN(at.getTime())) return value
          const pad = number => String(number).padStart(2, '0')
          return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
        }

        function DpkPackageRow({ entry }) {
          const values = [
            [tr('installedBy'), tr('installedByValue')],
            [tr('source'), entry.source ?? '—'],
            [tr('digest'), entry.digest],
            [tr('installedAt'), formatStamp(entry.installedAt), entry.installedAt],
            [tr('storePath'), `${state.store}\\store\\${entry.digest}\\package`],
            [tr('profileState'), `${entry.profileState ?? ''} · ${entry.installed ? 'installed' : 'not-a-dependency'} · ${entry.enabled ? 'enabled' : 'disabled'}`],
          ]
          return h('article', {
            style: { display: 'grid', gap: 10, padding: '18px 0', borderTop: '1px solid color-mix(in srgb, currentColor 16%, transparent)' },
          }, [
            h('div', { key: 'heading', style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } }, [
              h('strong', { key: 'name' }, entry.name),
              h('span', { key: 'version', style: mutedStyle }, entry.version),
            ]),
            h('div', { key: 'details', style: { display: 'grid', gap: 6 } }, [
              h('dl', { key: 'rows', style: rowStyle }, values.flatMap(([label, value, hint]) => [
                h('dt', { key: `${label}-k`, style: labelStyle }, label),
                h('dd', { key: `${label}-v`, style: { ...valueStyle, margin: 0 }, title: hint }, String(value)),
              ])),
            ]),
            h(DpkActions, { key: 'actions', subject: { kind: 'bundle', pkg: { name: entry.name } } }),
          ])
        }

        function DpkPage() {
          useManaged()
          return h('main', { style: { height: '100%', overflow: 'auto' } },
            h('div', { style: { width: 'min(920px, 100%)', margin: '0 auto', padding: '24px' } }, [
              h('h2', { key: 'title', style: { margin: '0 0 20px', fontSize: 22 } }, tr('pageTitle')),
              state.notice === undefined
                ? null
                : h('div', { key: 'notice', role: 'status', style: { marginBottom: 16, padding: 12, border: '1px solid color-mix(in srgb, currentColor 24%, transparent)', borderRadius: 6 } }, state.notice),
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

        // --- official Plugins page: one tag on bundles this manager installed --
        function DpkManagedBadge(props) {
          useManaged()
          const subject = props.subject
          if (!subject || subject.kind !== 'bundle' || subject.pkg?.installed !== true) return null
          if (entryFor(subject.pkg.name) === undefined) return null
          return h('span', {
            key: 'dpk-managed', title: tr('badgeTitle'),
            style: {
              display: 'inline-flex', alignItems: 'center',
              padding: '1px 8px', margin: '0 4px', borderRadius: 999,
              border: '1px solid color-mix(in srgb, currentColor 24%, transparent)',
              font: 'inherit', fontSize: '0.82em', opacity: 0.85,
              whiteSpace: 'nowrap', verticalAlign: 'middle',
            },
          }, tr('badge'))
        }

        ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
          name: 'plugins.detail.badge', id: 'dpk-managed', order: 50, label: () => tr('badge'), locale: NS,
        }, DpkManagedBadge))
      },
    }
  },
})
