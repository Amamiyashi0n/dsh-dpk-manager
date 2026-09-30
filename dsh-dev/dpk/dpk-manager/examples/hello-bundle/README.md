# @local/dpk-hello

A deliberately minimal DSH bundle used to exercise the whole DPK path:

1. `dpk pack examples/hello-bundle` validates it as a DSH package and writes a `.dpk`;
2. `dpk verify` re-checks the archive, its integrity, and DSH conformance;
3. `dpk install` unpacks it into the local store and hands the directory to
   `dsh plugin --profile <p> install <abs path>`;
4. the file supplies

It has no dependencies at all, so nothing about the test depends on a local
`link:` target existing on the installing machine.
