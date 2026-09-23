"""Renders the app icon as PNGs with only the standard library."""
import struct, zlib, sys, os

def render(size):
    px = bytearray()
    s = size / 108.0
    stones = [(44, 44, 'b'), (64, 64, 'b'), (64, 44, 'w'), (44, 64, 'w')]
    for yy in range(size):
        px.append(0)
        for xx in range(size):
            x, y = (xx + .5) / s, (yy + .5) / s
            t = (x + y) / 216
            r, g, b = int(0xE9 - 0x13 * t), int(0xC2 - 0x1C * t), int(0x7C - 0x21 * t)
            if 24 <= x <= 84 and 24 <= y <= 84:
                if any(abs(x - v) < 1.25 for v in (24, 44, 64, 84)) or any(abs(y - v) < 1.25 for v in (24, 44, 64, 84)):
                    r, g, b = 0x5A, 0x3E, 0x1B
            for cx, cy, c in stones:
                d = ((x - cx) ** 2 + (y - cy) ** 2) ** .5
                if d <= 9.5:
                    k = max(0.0, 1 - ((x - cx + 3.5) ** 2 + (y - cy + 3.5) ** 2) ** .5 / 13)
                    if c == 'b':
                        v = int(20 + 80 * k); r = g = b = v
                    else:
                        v = int(200 + 55 * k); r = g = b = v
                    if c == 'w' and d > 8.9:
                        r = g = b = 150
            px += bytes((r, g, b))
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(px), 9)) + chunk(b'IEND', b''))

out = sys.argv[1]
for n in (180, 192, 512):
    open(os.path.join(out, f'icon-{n}.png'), 'wb').write(render(n))
