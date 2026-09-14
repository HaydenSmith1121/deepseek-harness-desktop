# -*- coding: utf-8 -*-
"""纯标准库生成应用图标 build/icon.png（256x256 RGBA）：
渐变圆角方块 + 像素字 "DH"。"""
import struct, zlib, os

SIZE = 256
R = 44  # 圆角半径

# 5x7 像素字体：D, H
GLYPH_D = [
    "1110.",
    "1001.",
    "1001.",
    "1001.",
    "1001.",
    "1001.",
    "1110.",
]
GLYPH_H = [
    "1001",
    "1001",
    "1001",
    "1111",
    "1001",
    "1001",
    "1001",
]

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

C1 = (99, 102, 241)    # indigo
C2 = (34, 211, 238)    # cyan
WHITE = (240, 244, 255)

def rounded_alpha(x, y):
    # 判断像素是否在圆角方块内
    dx = min(x, SIZE - 1 - x)
    dy = min(y, SIZE - 1 - y)
    if dx >= R or dy >= R:
        return True
    return (R - dx) ** 2 + (R - dy) ** 2 <= R * R

# 排版：两字母，每字母 5 列（D 是 5 列、H 是 4 列，统一用 5），字距 2 列
SCALE = 13
GAP = 3  # 字间距（像素单位）
cols_total = 5 + GAP + 4
px_w = cols_total * SCALE
px_h = 7 * SCALE
ox = (SIZE - px_w) // 2
oy = (SIZE - px_h) // 2

def in_glyph(x, y):
    gx = (x - ox) // SCALE
    gy = (y - oy) // SCALE
    if gx < 0 or gy < 0 or gy >= 7:
        return False
    if gx < 5:
        row = GLYPH_D[gy]
        return row[gx] == '1'
    gx2 = gx - 5 - GAP
    if 0 <= gx2 < 4:
        row = GLYPH_H[gy]
        return row[gx2] == '1'
    return False

rows = []
for y in range(SIZE):
    row = bytearray([0])  # filter type 0
    for x in range(SIZE):
        if not rounded_alpha(x, y):
            row += bytes([0, 0, 0, 0])
            continue
        t = (x + y) / (2 * SIZE)
        c = lerp(C1, C2, t)
        if in_glyph(x, y):
            c = WHITE
        # 轻微内阴影高光：顶部更亮
        hl = 1 + 0.10 * (1 - y / SIZE)
        c = tuple(min(255, int(v * hl)) for v in c)
        row += bytes([c[0], c[1], c[2], 255])
    rows.append(bytes(row))

raw = b''.join(rows)

def chunk(tag, data):
    c = struct.pack('>I', len(data)) + tag + data
    return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(raw, 9))
png += chunk(b'IEND', b'')

out = os.path.join(os.path.dirname(__file__), '..', 'build', 'icon.png')
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'wb') as f:
    f.write(png)
print('ICON_OK', out)
