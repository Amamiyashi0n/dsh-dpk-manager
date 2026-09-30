// standalone 模式检测:tui/app-server/agent-server/login/logout 均视为 standalone
// source: zcode.cjs @ 1067700
// symbols: jZi standalone argv detector

function jZi(e){if(e.some(n=>n==="--help"||n==="-h"||n==="--version"||n==="-v"))return!1;if(e.some(n=>n==="--prompt"||n.startsWith("--prompt=")||n==="--target"||n.startsWith("--target=")))return!0;let t=e[0];return t===void 0||t.startsWith("-")?!0:t==="tui"||t==="app-server"||t==="agent-server"||t==="login"||t==="logout"}async function BZi(e){if(e.sea?.isSea()){let a=e.sea.getAsset(pfr,"utf8");return Ttr({environmentConfigRoot:(0,qj.join)(e.dataBaseDir,".zcode","v2"),content:a})}let t=e.entrypoint?.trim();if(!t)throw new Error("\u65E0\u6CD5\u5B9A\u4F4D CLI ZCode Built-in Provider Config\uFF1A\u7F3A\u5C11\u5165\u53E3\u8DEF\u5F84");let n=(0,qj.dirname)((0,qj.resolve)(t)),o=[(0,qj.join)(n,"prov
