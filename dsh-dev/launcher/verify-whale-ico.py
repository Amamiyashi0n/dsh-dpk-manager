"""独立校验生成的 .ico:容器结构、payload 完整性、几何合理性,并打印 ASCII 轮廓供肉眼确认。

不复用 make-whale-ico.py 的填充代码 —— 这里用**逐点射线法**(point-in-polygon,
nonzero winding)独立算一遍覆盖率,与扫描线结果交叉比对,避免"自己验自己"。
"""
import pathlib
import re
import struct
import sys

LAUNCHER = pathlib.Path(r"C:\Users\Amamiya\Dev-ws-next\repos\zcode-dev\launcher")
ICO = LAUNCHER / "deepseek-harness.ico"
SVG = pathlib.Path(r"C:\Users\Amamiya\Dev-ws-next\repos\zcode-dev\deepseek-harness\website\public\favicon.svg")

ok = True
def check(label, cond, detail=""):
    global ok
    if not cond:
        ok = False
    print(f"{'PASS' if cond else 'FAIL'}  {label}" + (f"  {detail}" if detail else ""))


# ---------------------------------------------------- 1. ICO 容器结构
raw = ICO.read_bytes()
reserved, type_, count = struct.unpack("<HHH", raw[:6])
check("ICO 头:reserved=0 且 type=1", reserved == 0 and type_ == 1, f"reserved={reserved} type={type_}")
check("ICO 尺寸条目数 = 7", count == 7, str(count))

entries = []
for i in range(count):
    off = 6 + 16 * i
    w, h, colors, res, planes, bits, size, data_off = struct.unpack("<BBBBHHII", raw[off:off + 16])
    entries.append((w or 256, h or 256, bits, size, data_off))

print("\n目录:")
for (w, h, bits, size, data_off) in entries:
    print(f"  {w:3d}x{h:<3d} {bits}bpp  {size:6d} 字节 @ {data_off}")

sizes = sorted(e[0] for e in entries)
check("尺寸集合 = 16/24/32/48/64/128/256", sizes == [16, 24, 32, 48, 64, 128, 256], str(sizes))
check("所有 width==height", all(e[0] == e[1] for e in entries))
check("全部 32bpp", all(e[2] == 32 for e in entries))

# payload 必须首尾相接且落在文件内
off_expected = 6 + 16 * count
contiguous = True
for (w, h, bits, size, data_off) in entries:
    if data_off != off_expected:
        contiguous = False
    off_expected += size
check("payload 连续排布", contiguous)
check("总长度与目录一致", off_expected == len(raw), f"{off_expected} vs {len(raw)}")

# 每个 payload 自洽:PNG 验签名,BMP 验 DIB 头
for (w, h, bits, size, data_off) in entries:
    blob = raw[data_off:data_off + size]
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        pw, ph = struct.unpack(">II", blob[16:24])
        check(f"  {w}px payload 是 PNG 且尺寸匹配", pw == w and ph == h, f"{pw}x{ph}")
    else:
        bi_size, bi_w, bi_h, planes, bpp = struct.unpack("<IiiHH", blob[:16])
        check(f"  {w}px payload 是 DIB 且尺寸匹配",
              bi_size == 40 and bi_w == w and bi_h == h * 2 and planes == 1 and bpp == 32,
              f"size={bi_size} w={bi_w} h={bi_h} bpp={bpp}")


# ------------------------------------- 2. 独立复算覆盖率(逐点射线法,交叉验证)
def parse_path(d):
    tokens = re.findall(r"[MCZ]|-?\d*\.?\d+(?:[eE]-?\d+)?", d)
    subs, cur, x, y, i = [], [], 0.0, 0.0, 0
    while i < len(tokens):
        t = tokens[i]
        if t == "M":
            if cur:
                subs.append(cur)
            x, y = float(tokens[i + 1]), float(tokens[i + 2])
            cur = [(x, y)]
            i += 3
        elif t == "C":
            x1, y1, x2, y2, x3, y3 = (float(v) for v in tokens[i + 1:i + 7])
            for s in range(1, 25):
                u = s / 24
                v = 1 - u
                cur.append((v**3 * x + 3 * v**2 * u * x1 + 3 * v * u**2 * x2 + u**3 * x3,
                            v**3 * y + 3 * v**2 * u * y1 + 3 * v * u**2 * y2 + u**3 * y3))
            x, y = x3, y3
            i += 7
        elif t == "Z":
            if cur:
                cur.append(cur[0])
                subs.append(cur)
                cur = []
            i += 1
        else:
            raise ValueError(t)
    if cur:
        subs.append(cur)
    return subs


def winding_at(px, py, edges):
    """射线法累计环绕数(向右射线)。"""
    w = 0
    for (x0, y0, x1, y1) in edges:
        if (y0 <= py < y1) or (y1 <= py < y0):
            t = (py - y0) / (y1 - y0)
            if x0 + t * (x1 - x0) > px:
                w += 1 if y1 > y0 else -1
    return w


def coverage_pointwise(subs, size, view=50.0, ss=8):
    scale = size * ss / view
    edges = []
    for sp in subs:
        for k in range(len(sp) - 1):
            x0, y0 = sp[k][0] * scale, sp[k][1] * scale
            x1, y1 = sp[k + 1][0] * scale, sp[k + 1][1] * scale
            if y0 != y1:
                edges.append((x0, y0, x1, y1))
    cov = bytearray(size * size)
    for oy in range(size):
        for ox in range(size):
            hit = 0
            for sy in range(ss):
                py = oy * ss + sy + 0.5
                for sx in range(ss):
                    px = ox * ss + sx + 0.5
                    if winding_at(px, py, edges) != 0:
                        hit += 1
            cov[oy * size + ox] = hit * 255 // (ss * ss)
    return cov


d = re.search(r'<path\s+d="([^"]+)"', SVG.read_text(encoding="utf-8")).group(1)
subs = parse_path(d)
check("子路径数 = 4(与原图 M 数一致)", len(subs) == 4, str(len(subs)))

# 各子路径的环绕方向(外轮廓与内部挖孔应当相反)
def signed_area(sp):
    a = 0.0
    for k in range(len(sp) - 1):
        a += sp[k][0] * sp[k + 1][1] - sp[k + 1][0] * sp[k][1]
    return a / 2

areas = [signed_area(sp) for sp in subs]
print("\n各子路径有符号面积:", [f"{a:.1f}" for a in areas])
# SVG 是 y 向下的坐标系:顺时针的外轮廓用该公式算出来是负数。真正的不变量是
# "外轮廓是面积绝对值最大的那条,其余子路径(挖孔)符号与它相反"。
outer = max(areas, key=abs)
others = [a for a in areas if a is not outer]
check("外轮廓是面积绝对值最大的子路径", abs(outer) > max((abs(a) for a in others), default=0))
check("外轮廓与挖孔子路径环绕方向相反(nonzero 才能挖出孔)",
      all((a > 0) != (outer > 0) for a in others),
      f"outer={outer:.1f} others={[f'{a:.1f}' for a in others]}")

# 交叉验证:64px 覆盖率与扫描线结果(重新生成一次比对)
sys.path.insert(0, str(LAUNCHER))
import importlib.util
spec = importlib.util.spec_from_file_location("whale", LAUNCHER / "make-whale-ico.py")
whale = importlib.util.module_from_spec(spec)
spec.loader.exec_module(whale)   # 会重新写出 ico,顺便验证可复现

cov_scan = whale.rasterize(whale.parse_path(d), 64)
cov_pt = coverage_pointwise(subs, 64)
diff = [abs(a - b) for a, b in zip(cov_scan, cov_pt)]
big = sum(1 for x in diff if x > 40)
print(f"\n交叉验证 64px:最大差 {max(diff)}, 差异>40 的像素 {big} / 4096")
check("两种独立光栅化结果一致(差异>40 的像素 <1%)", big < 41, f"{big} 像素")

# 挖孔检测:外轮廓内部应存在透明像素
filled = sum(1 for c in cov_scan if c > 127)
check("有实心像素", filled > 0, str(filled))
# 取外轮廓包围盒内、非边缘的透明像素作为孔
xs = [p[0] for sp in subs for p in sp]
ys = [p[1] for sp in subs for p in sp]
holes = 0
for oy in range(8, 56):
    for ox in range(8, 56):
        if cov_scan[oy * 64 + ox] < 40:
            # 上下左右都有实心 → 视为孔
            if (cov_scan[(oy - 4) * 64 + ox] > 200 and cov_scan[(oy + 4) * 64 + ox] > 200):
                holes += 1
check("检出内部挖孔(眼睛/嘴缝)", holes > 0, f"{holes} 像素")


# ------------------------------------------------------------ 3. ASCII 轮廓
cov_ascii = coverage_pointwise(subs, 112, ss=6)
print("\n黑色鲸鱼轮廓(56x28,已按字符 2:1 比例压缩):")
for cy in range(28):
    line = ""
    for cx in range(56):
        acc = 0
        for dy in range(2):
            for dx in range(2):
                acc += cov_ascii[(cy * 2 + dy) * 112 + (cx * 2 + dx)]
        acc //= 4
        line += " " if acc < 32 else ("." if acc < 110 else ("*" if acc < 200 else "#"))
    print("  " + line)

print()
print("全部通过" if ok else "存在失败项")
sys.exit(0 if ok else 1)
