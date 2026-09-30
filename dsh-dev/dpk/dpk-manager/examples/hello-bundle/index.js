/**
 * DPK smoke-test bundle.
 *
 * Deliberately dependency-free: it registers one runtime skill through the
 * skills service, which is enough to prove that a package unpacked from a
 * `.dpk` archive was loaded by the Harness and that its JS actually ran.
 *
 * @module @local/dpk-hello
 */

/** Cordis plugin name. */
export const name = 'dpk-hello'
/** Skill registry the smoke-test skill registers into. */
export const inject = ['skills']

/** Register one skill so the install is visible in the session catalog. */
export function apply(ctx) {
  ctx.effect(() => ctx.skills.register({
    name: 'dpk-hello',
    description: 'Smoke test installed from a .dpk archive by the dpk tool. Confirms the package was unpacked, selected as a bundle, and loaded.',
    source: 'custom',
    content: '# dpk-hello\n\nA `.dpk` archive was verified, unpacked into the local store, installed through the DSH plugin CLI, and loaded.\n',
  }))
  ctx.logger?.info?.('dpk-hello: registered the dpk smoke-test skill')
}
