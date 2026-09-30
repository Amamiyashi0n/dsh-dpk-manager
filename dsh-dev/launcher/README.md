# DSH Web UI launcher

`dsh.cmd` is the single Windows entry point for this checkout. It always requests
an elevated administrator token with High integrity, pins the traditional
Windows Node.js runtime, uses the canonical `C:\Users\Amamiya\.dsh`
data root, stops the previous checkout instance, and starts the Web UI on
`http://127.0.0.1:51080`. Every Bash, Node, native build, and DSH child process
inherits that administrator token.

## Desktop shortcut

The installed shortcut is:

- Path: `C:\Users\Amamiya\Desktop\dsh-webui.lnk`
- Target: `launcher\dsh.cmd`
- Icon: `launcher\deepseek-harness.ico`
- Mode: Run as administrator (High integrity)

Run `install-shortcut.cmd` after moving the checkout so the absolute target and
icon paths are refreshed.

## Runtime contract

- Node: `C:\Program Files\nodejs\node.exe`
- DSH data: `C:\Users\Amamiya\.dsh`
- Web port: `51080`
- Historical port also cleared on startup: `3080`

There is no alternate data-root or temporary-directory fallback. Access errors
remain visible, and the elevated launch owns the permission boundary.

The launcher verifies the administrator role and High integrity label before
starting. DSH passes `--expose-internals` so the full ESM/CommonJS profile
resolver runs directly on the pinned Windows Node.js runtime; package
interception remains enabled.

## Commands

```cmd
dsh.cmd
dsh.cmd stop
dsh.cmd web --no-open
dsh.cmd web --port 8080
dsh.cmd headless "task"
dsh.cmd --help
```

With no arguments, `dsh.cmd` stops only a listener whose command line contains
this checkout's absolute `apps\cli\src\bin.ts` path. Other Node processes are
left untouched.

## Files

| File | Purpose |
| --- | --- |
| `dsh.cmd` | Elevated DSH launcher |
| `stop-dsh.ps1` | Checkout-specific listener cleanup |
| `install-shortcut.cmd` | Create the elevated `dsh-webui` shortcut |
| `deepseek-harness.ico` | Shortcut icon |
| `make-whale-ico.py` | Regenerate the icon assets |
| `verify-whale-ico.py` | Validate icon structure and outline |
| `verify-ico-payloads.py` | Validate embedded icon frames |
