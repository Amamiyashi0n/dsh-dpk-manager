#!/usr/bin/env python3
"""Extract annotated code snippets from the official zcode.cjs bundle.

Writes re-app-server/snippets/*.js — each file is a raw (still-minified) window
of the bundle with a header documenting byte offsets and the symbols inside.
"""
import os

BUNDLE = r'C:\Users\Amamiya\Dev-ws-next\repos\zcode-dev\re-zcode\zcode-unpacked\resources\glm\zcode.cjs'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'snippets')

REGIONS = [
    # (file, start, end, title, symbols)
    ('protocol-methods.js', 784250, 787600,
     '完整 NDJSON 协议方法表 va{...}(session/* workspace/* provider/* mcp/* plugins/* skills/* workflows/* automation/* offPeak/* usage/* interaction/*)',
     'va (method table), providerUpdateAccountConfig, usageStats, offPeakCreate'),
    ('registry-fail-closed.js', 554900, 557400,
     '账号 Provider 快照:fail-closed 语义与可变账号配置源',
     'SKe createFailClosedAccountProviderConfigSnapshot, KEe createAccountProviderConfigSnapshot, M4i, lee MutableAccountProviderConfigSource'),
    ('zhipu-account-schema.js', 547800, 549400,
     'access schema:zhipu-account / api-key 两类(providers.access 的字段定义)',
     'Mj ZhipuAccountAccessConfig, rpe ProviderApiConfig, kk ProviderConfig'),
    ('catalog-env.js', 1065900, 1067500,
     'builtin/personal 目录路径解析与 CDN 刷新入口(环境变量)',
     'IV ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, lXe ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE, Hee ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, FZi prepareCliProviderRuntimeEnv, QAe refresh reporter'),
    ('registry-lookup-error.js', 13850000, 13851600,
     'Registry 查找与错误映射(provider_not_found 的产生点)',
     'FCn (provider-not-found -> "Provider Registry 中不存在 Provider"), mwt selection resolve'),
    ('account-gating.js', 14090700, 14093600,
     '★ 核心门控链:standalone 账号快照如何从凭证库推导 entitled',
     'HEn readStandaloneCodingPlanCatalog, Fie identityCredentialKey, Pje apiKeyCredentialKey, JEn readStandaloneAccountProviderConfigSnapshot, Kqo hasStandaloneCodingPlanAccess, Zqo createStandaloneProviderRuntimeHeadersPort'),
    ('standalone-wiring.js', 14103000, 14105600,
     '★ Registry 服务装配:standalone 分支才会创建账号源(createAccountSource)',
     'lkt (registry service factory), zKe (config service), wKe (refreshing account source), cfr resolveNodeProviderRuntimePaths'),
    ('credential-cipher.js', 4277800, 4285000,
     '凭证加密库:enc:v1 AES-256-GCM,密钥派生与凭据存取(含 ZCODE_CREDENTIAL_SECRET 优先级)',
     'iKr createZCodeCredentialCipher, lUs deriveCipherKey, uUs resolveCredentialSecret, PM credential store, gUs default path ~/.zcode/v2/credentials.json'),
    ('generate-workspace-text.js', 13184500, 13188000,
     'workspace/generateText 的实现(selection 解析、modelFactory 调用、事件与 usage 回传)',
     'bTa generateWorkspaceTextImpl, cPo generateWorkspaceText, aPo testModelConnectivity, lPo assertWorkspaceModelInput'),
    ('runtime-model.js', 12565900, 12567200,
     'createRuntimeModel / AgentRuntime.modelFactory 的调用形态',
     'WC createRuntimeModel, zga withRuntimeInvocationLayer, FB withModelInvocationContext'),
    ('refresh-revision-gate.js', 582400, 584700,
     '★ Registry 刷新:修订号闸门(basedOnZCodeBuiltinRevision 不匹配则静默跳过合并)与 resolve 合并',
     'ProviderRegistryService refresh #y/#g, config+account 双源读, basedOn 闸门, #n.resolve(...) 三源合并'),
    ('revision-path-hash.js', 587700, 588500,
     '★ 目录修订号公式:zcode-builtin:<rev>:sha256(resolve(activeFilePath)) — 对路径字符串做哈希,非内容',
     'DO catalog reader: #n=createHash(sha256).update(resolve(path)), Z4i(revision 拼装), QEe/uV canonical 序列化'),
    ('standalone-detection.js', 0, 0,
     'standalone 模式检测:tui/app-server/agent-server/login/logout 均视为 standalone',
     'jZi (standalone argv detector)'),
]

def main():
    os.makedirs(OUT, exist_ok=True)
    data = open(BUNDLE, encoding='utf-8', errors='replace').read()
    for name, start, end, title, symbols in REGIONS:
        if name == 'standalone-detection.js':
            i = data.find('function jZi')
            j = data.find('\n', i + 600)
            body = data[i:j]
            start = i
        else:
            body = data[start:end]
        header = (
            f'// {title}\n'
            f'// source: zcode-unpacked/resources/glm/zcode.cjs (14,796,911 bytes, 3.14.1)\n'
            f'// window: bytes {start}..{start + len(body)}\n'
            f'// symbols: {symbols}\n'
            f'// NOTE: raw minified code, single line preserved as-is; annotate locally.\n\n'
        )
        with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
            f.write(header + body + '\n')
        print(f'{name}: {len(body)} bytes @ {start}')
    print('done ->', OUT)

if __name__ == '__main__':
    main()
