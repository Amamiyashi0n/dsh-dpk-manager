"""深度校验 ico 内每个 payload 的像素数据完整可解(截断/损坏会渲染成空白图标)。"""
import pathlib, struct, zlib, sys

ICO = pathlib.Path(r"C:\Users\Amamiya\Dev-ws-next\repos\zcode-dev\launcher\deepseek-harness.ico")
raw = ICO.read_bytes()
_, _, count = struct.unpack("<HHH", raw[:6])
ok = True

for i in range(count):
    off = 6 + 16 * i
    w, h, _, _, _, bits, size, data_off = struct.unpack("<BBBBHHII", raw[off:off + 16])
    w = w or 256
    h = h or 256
    blob = raw[data_off:data_off + size]
    label = f"{w}x{h}"

    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        # 走完 chunk,累积 IDAT,解压后核对长度
        pos = 8
        idat = b""
        ihdr = None
        while pos < len(blob):
            ln = struct.unpack(">I", blob[pos:pos + 4])[0]
            tag = blob[pos + 4:pos + 8]
            data = blob[pos + 8:pos + 8 + ln]
            crc = struct.unpack(">I", blob[pos + 8 + ln:pos + 12 + ln])[0]
            if zlib.crc32(tag + data) & 0xFFFFFFFF != crc:
                print(f"FAIL  {label} chunk {tag!r} CRC 不符"); ok = False
            if tag == b"IHDR":
                ihdr = struct.unpack(">IIBBBBB", data)
            elif tag == b"IDAT":
                idat += data
            elif tag == b"IEND":
                pass
            pos += 12 + ln
        if pos != len(blob):
            print(f"FAIL  {label} chunk 链长度不符: {pos} vs {len(blob)}"); ok = False
        pw, ph, depth, ctype = ihdr[0], ihdr[1], ihdr[2], ihdr[3]
        expect = ph * (1 + pw * 4)
        try:
            pixels = zlib.decompress(idat)
        except Exception as e:
            print(f"FAIL  {label} IDAT 解压失败: {e}"); ok = False
            continue
        good = (pw == w and ph == h and depth == 8 and ctype == 6 and len(pixels) == expect)
        print(f"{'PASS' if good else 'FAIL'}  {label} PNG: {pw}x{ph} depth={depth} type={ctype} "
              f"解压后 {len(pixels)} 字节(期望 {expect})")
        ok &= good
        # 每行前面有 1 字节 filter,alpha 不是简单的 [3::4];按行剥离后再统计
        alpha = []
        filters = set()
        for row in range(ph):
            base = row * (1 + pw * 4)
            filters.add(pixels[base])
            alpha.extend(pixels[base + 1 + 3: base + 1 + pw * 4: 4])
        if filters != {0}:
            print(f"        注意:使用了 filter {sorted(filters)}(本实现只写 0)")
        opaque = sum(1 for a in alpha if a > 128)
        frac = opaque * 100 / (pw * ph)
        print(f"        不透明像素 {opaque} ({frac:.1f}%)")
        if frac < 5:
            print(f"FAIL  {label} 几乎全透明,图标会显示为空白"); ok = False
    else:
        bi_size, bi_w, bi_h, planes, bpp, comp, img_size = struct.unpack("<IiiHHII", blob[:24])
        mask_row = ((w + 31) // 32) * 4
        expect = w * h * 4 + mask_row * h
        good = (bi_w == w and bi_h == h * 2 and comp == 0 and bpp == 32 and len(blob) - 40 == expect)
        print(f"{'PASS' if good else 'FAIL'}  {label} DIB: {bi_w}x{bi_h // 2} bpp={bpp} comp={comp} "
              f"数据 {len(blob) - 40} 字节(期望 {expect})")
        ok &= good
        px = blob[40:40 + w * h * 4]
        alpha = px[3::4]
        opaque = sum(1 for a in alpha if a > 128)
        frac = opaque * 100 / (w * h)
        print(f"        不透明像素 {opaque} ({frac:.1f}%)")
        if frac < 5:
            print(f"FAIL  {label} 几乎全透明"); ok = False

print()
print("全部 payload 可解" if ok else "存在损坏 payload")
sys.exit(0 if ok else 1)
