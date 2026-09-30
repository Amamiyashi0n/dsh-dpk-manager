// ★ 目录修订号公式:zcode-builtin:<rev>:sha256(resolve(activeFilePath)) — 对路径字符串做哈希,非内容
// source: zcode-unpacked/resources/glm/zcode.cjs (14,796,911 bytes, 3.14.1)
// window: bytes 587700..588500
// symbols: DO catalog reader: #n=createHash(sha256).update(resolve(path)), Z4i(revision 拼装), QEe/uV canonical 序列化
// NOTE: raw minified code, single line preserved as-is; annotate locally.

#t=t.activeFilePath?.trim()||n,this.#n=(0,ptr.createHash)("sha256").update((0,dee.resolve)(this.#t)).digest("hex"),this.#r=t.watch!==!1}get activeFilePath(){return this.#t}async read(){this.#p();let t;try{await this.#u(),t=await cw(this.#t,()=>this.#l())}catch{t=utr(await Vqt(this.#e),null)}return this.#c??=QEe(t),Z4i(t,this.#n)}async applyRemoteRelease(t){this.#p(),await this.#u();let n=await cw(this.#t,async()=>{this.#p();let o=await this.#l();if(this.#p(),t.revision<o.revision)return"stale";if(t.revision===o.revision){if(uV(t)===uV(o))return"unchanged";throw new Error(`ZCode Built-in \u76F8\u540C revision ${t.revision} \u5BF9\u5E94\u4E0D\u540C\u5185\u5BB9`)}return await this.#d(t),this.#c=QEe(t),"updated"});return n==="updated"&&!this.#a&&this.#f("remote-updated"),n}onDidChange(t){retur
