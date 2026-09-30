"""把 favicon.svg 的鲸鱼路径光栅化成黑色多尺寸 .ico(零依赖)。

环境里没有 ImageMagick / inkscape / resvg / cairosvg / Pillow,也没有 Edge/Chrome,
所以这里自己做三件事:
  1. 解析 SVG path(本文件只用到 M/C/Z),把三次贝塞尔细分成折线;
  2. 扫描线 + nonzero 环绕规则填充,按 S 倍超采样得到抗锯齿覆盖率;
  3. 用 zlib 自己编 PNG(for 128/256),小尺寸写 32bpp BGRA DIB + AND 掩码(兼容性最好),
     再按 ICO 容器格式组装。

忠实保留原图的 fill-rule="nonzero";颜色改为黑色(原图是 #4D6BFE 蓝)。
"""

import re
import struct
import zlib
import pathlib

SVG = pathlib.Path(r"C:\Users\Amamiya\Dev-ws-next\repos\zcode-dev\deepseek-harness\website\public\favicon.svg")
OUT_DIR = pathlib.Path(r"C:\Users\Amamiya\Dev-ws-next\repos\zcode-dev\launcher")
OUT_DIR.mkdir(parents=True, exist_ok=True)

SIZES = [16, 24, 32, 48, 64, 128, 256]
SUPERSAMPLE = 8
COLOR = (0, 0, 0)          # 黑色鲸鱼
FLATTEN_STEPS = 24         # 每条三次贝塞尔的细分段数(原图曲线平缓,足够)


# ---------------------------------------------------------------- path 解析
def parse_path(d):
    """解析 M/C/Z,返回子路径列表,每个子路径是 [(x,y), ...]。"""
    tokens = re.findall(r"[MCZ]|-?\d*\.?\d+(?:[eE]-?\d+)?", d)
    subpaths = []
    current = []
    x = y = 0.0
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in "Mm":
            if current:
                subpaths.append(current)
            x = float(tokens[i + 1]); y = float(tokens[i + 2])
            i += 3
            current = [(x, y)]
        elif t in "Cc":
            pts = [float(v) for v in tokens[i + 1:i + 7]]
            x1, y1, x2, y2, x3, y3 = pts
            for s in range(1, FLATTEN_STEPS + 1):
                u = s / FLATTEN_STEPS
                v = 1 - u
                bx = v**3 * x + 3 * v**2 * u * x1 + 3 * v * u**2 * x2 + u**3 * x3
                by = v**3 * y + 3 * v**2 * u * y1 + 3 * v * u**2 * y2 + u**3 * y3
                current.append((bx, by))
            x, y = x3, y3
            i += 7
        elif t in "Zz":
            if current:
                current.append(current[0])
                subpaths.append(current)
                current = []
            i += 1
        else:
            raise ValueError(f"未处理的 path 命令: {t!r}")
    if current:
        subpaths.append(current)
    return subpaths


# ------------------------------------------------------- 扫描线 nonzero 填充
def rasterize(subpaths, size, view=50.0):
    """返回 size×size 的覆盖率数组(0..255),已按 SUPERSAMPLE 降采样。"""
    S = SUPERSAMPLE
    hi = size * S
    scale = hi / view

    # 全部子路径的边(超采样坐标),带方向
    edges = []
    for sp in subpaths:
        n = len(sp)
        for k in range(n - 1):
            x0, y0 = sp[k][0] * scale, sp[k][1] * scale
            x1, y1 = sp[k + 1][0] * scale, sp[k + 1][1] * scale
            if y0 == y1:
                continue
            direction = 1 if y1 > y0 else -1
            edges.append((y0, y1, x0, x1, direction))

    # 每个超采样行的覆盖位图
    rows = bytearray(hi * hi)
    for row in range(hi):
        yc = row + 0.5
        crossings = []
        for (y0, y1, x0, x1, direction) in edges:
            # 半开区间规则,避免顶点重复计数
            if (y0 <= yc < y1) or (y1 <= yc < y0):
                t = (yc - y0) / (y1 - y0)
                crossings.append((x0 + t * (x1 - x0), direction))
        if not crossings:
            continue
        crossings.sort()
        wind = 0
        span_start = 0
        base = row * hi
        for (cx, direction) in crossings:
            prev = wind
            wind += direction
            if prev == 0 and wind != 0:
                span_start = cx
            elif prev != 0 and wind == 0:
                a = int(span_start + 0.5)
                b = int(cx + 0.5)
                if a < 0:
                    a = 0
                if b > hi:
                    b = hi
                for px in range(a, b):
                    rows[base + px] = 1

    # 降采样成覆盖率
    cov = bytearray(size * size)
    total = S * S
    for oy in range(size):
        for ox in range(size):
            hit = 0
            for sy in range(S):
                base = (oy * S + sy) * hi + ox * S
                for sx in range(S):
                    hit += rows[base + sx]
            cov[oy * size + ox] = (hit * 255) // total
    return cov


# ------------------------------------------------------------- PNG 编码
def png_bytes(cov, size, rgb=COLOR):
    raw = bytearray()
    for oy in range(size):
        raw.append(0)  # filter: none
        for ox in range(size):
            a = cov[oy * size + ox]
            r, g, b = rgb
            # 预乘无关:PNG 用直通 alpha
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def bmp_entry(cov, size, rgb=COLOR):
    """32bpp BGRA DIB + AND 掩码(ICO 内的小尺寸用,兼容性最好),自下而上。"""
    r, g, b = rgb
    pixels = bytearray()
    for oy in range(size - 1, -1, -1):
        for ox in range(size):
            a = cov[oy * size + ox]
            pixels += bytes((b, g, r, a))

    # AND 掩码:每行按 4 字节对齐,1 bit/像素;alpha 通道已表达透明,这里全 0
    mask_row = ((size + 31) // 32) * 4
    mask = bytes(mask_row * size)

    header = struct.pack("<IiiHHIIiiII",
                         40,          # biSize
                         size,        # biWidth
                         size * 2,    # biHeight(XOR + AND)
                         1,           # biPlanes
                         32,          # biBitCount
                         0,           # biCompression = BI_RGB
                         len(pixels) + len(mask),
                         0, 0, 0, 0)
    return header + bytes(pixels) + mask


def build_ico(entries):
    """entries: [(size, payload)];小尺寸走 DIB,大尺寸走 PNG。"""
    count = len(entries)
    out = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    dir_entries = b""
    blobs = b""
    for (size, payload, is_png) in entries:
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        dir_entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(payload), offset)
        offset += len(payload)
        blobs += payload
        del is_png
    return out + dir_entries + blobs


def main():
    d = re.search(r'<path\s+d="([^"]+)"', SVG.read_text(encoding="utf-8")).group(1)
    subpaths = parse_path(d)
    print(f"子路径数: {len(subpaths)} | 顶点数: {sum(len(s) for s in subpaths)}")

    entries = []
    for size in SIZES:
        cov = rasterize(subpaths, size)
        filled = sum(1 for c in cov if c > 127)
        print(f"  {size:3d}px  实心像素 {filled:6d} ({filled * 100 // (size * size)}%)")
        if size in (128, 256):
            entries.append((size, png_bytes(cov, size), True))
        else:
            entries.append((size, bmp_entry(cov, size), False))
        if size == 256:
            (OUT_DIR / "whale-preview-256.png").write_bytes(png_bytes(cov, size))
        if size == 64:
            (OUT_DIR / "whale-preview-64.png").write_bytes(png_bytes(cov, size))

    ico = build_ico(entries)
    target = OUT_DIR / "deepseek-harness.ico"
    target.write_bytes(ico)
    print(f"\n写出 {target}  ({len(ico)} 字节, {len(SIZES)} 个尺寸)")


main()
