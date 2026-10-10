# B-brand1/B-brand2: shrike.jpeg + mask.png -> portrait.json, emblem.json, emblem-bust-{40,28}.txt.
# Run from anywhere: python3 design-system/brand/generate.py (needs Pillow). mask.png comes from mask.swift (macOS Vision).
import json, os
from PIL import Image, ImageEnhance, ImageChops, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
EYE = (251.5, 51.0)  # eye centre in photo px
CROP = 0.42  # bust: top 42% of the bird
img = Image.open(os.path.join(HERE, 'shrike.jpeg')).convert('RGB')
mask = Image.open(os.path.join(HERE, 'mask.png')).convert('L').resize(img.size)
x0, y0, x1, y1 = mask.point(lambda v: 255 if v > 128 else 0).getbbox()
BITS = [(0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08), (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80)]

def lerp(a, b, t): t = max(0, min(1, t)); return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def portrait():
    cut = int(y0 + (y1 - y0) * CROP)
    cx = (x0 + x1) / 2; H = (cut - y0) + 18; W = H * 1.0
    box = (int(max(0, cx - W / 2)), max(0, y0 - 14), int(min(img.width, cx + W / 2)), cut + 4)
    p = img.crop(box); m = mask.crop(box)
    w = 128; h = int(p.height * w / p.width); h += (4 - h % 4) % 4
    g = p.convert('L').resize((w, h), Image.LANCZOS); mm = m.resize((w, h), Image.LANCZOS).point(lambda v: 255 if v > 128 else 0)
    col = ImageEnhance.Color(p).enhance(1.6).resize((w, h), Image.LANCZOS)
    inside = [g.getpixel((x, y)) for y in range(h) for x in range(w) if mm.getpixel((x, y))]
    lo, hi = min(inside), max(inside)
    gb = g.point(lambda v: int(255 * ((max(lo, min(hi, v)) - lo) / max(1, hi - lo)) ** 0.8)).convert('1')
    gf = g.point(lambda v: int(v * 0.55)).convert('1')
    edge = ImageChops.subtract(mm, mm.filter(ImageFilter.MinFilter(3)))
    halo = ImageChops.subtract(mm.filter(ImageFilter.MaxFilter(5)), mm)
    rows, colors = [], []
    for y in range(h):
        r = ''
        for x in range(w):
            if mm.getpixel((x, y)):
                if edge.getpixel((x, y)) or gb.getpixel((x, y)):
                    r += 'b'; colors.append('%02x%02x%02x' % lerp(col.getpixel((x, y)), (255, 255, 255), 0.18))
                else: r += ' '
            else: r += ' ' if halo.getpixel((x, y)) or not gf.getpixel((x, y)) else 'f'
        rows.append(r)
    S, pad = 6, 30
    return {
        'w': w, 'h': h, 's0': S, 'r': {'bird': 0.36, 'field': 0.26},
        'eye': [round((EYE[0] - box[0]) * w / p.width, 3), round((EYE[1] - box[1]) * h / p.height, 3)],
        # layout in px at s0 px per dot (the approved GIF): canvas size, dot origin, frame rect, text tops, font px
        'frame': {'size': [w * S + 2 * pad, h * S + 2 * pad + 70], 'dots': [pad, pad + 35], 'rect': [pad - 8, pad + 27, pad + w * S + 8, pad + 35 + h * S + 8],
                  'header': ['◆  S H R I K E  ◆', pad], 'footer': ['⊛  PIN THE BUG  ⊛', pad + h * S + 50], 'font': 18},
        'rows': rows, 'colors': ''.join(colors),
    }

def emblem(cols, gamma=0.75):
    pad = 4; box = (x0 - pad, y0 - pad, x1 + pad, int(y0 + (y1 - y0) * CROP))
    b = img.crop(box); m = mask.crop(box)
    w = cols * 2; h = int(b.height * w / b.width); h += (4 - h % 4) % 4
    g = b.convert('L').resize((w, h), Image.LANCZOS); inside = m.resize((w, h), Image.LANCZOS).point(lambda v: 255 if v > 128 else 0)
    vals = [g.getpixel((x, y)) for y in range(h) for x in range(w) if inside.getpixel((x, y))]
    lo, hi = min(vals), max(vals)
    d = g.point(lambda v: int(255 * (((max(lo, min(hi, v)) - lo) / max(1, hi - lo)) ** gamma))).convert('1')
    edge = ImageChops.subtract(inside, inside.filter(ImageFilter.MinFilter(3)))
    on = lambda x, y: x < w and y < h and inside.getpixel((x, y)) and (edge.getpixel((x, y)) or d.getpixel((x, y)))
    rows = [''.join('#' if on(x, y) else ' ' for x in range(w)) for y in range(h)]
    braille = []
    for cy in range(0, h, 4):
        r = ''
        for cx in range(0, w, 2):
            v = sum(bit for dx, dy, bit in BITS if on(cx + dx, cy + dy))
            r += chr(0x2800 + v) if v else ' '
        braille.append(r.rstrip())
    with open(os.path.join(HERE, 'emblem-bust-%d.txt' % cols), 'w') as f: f.write('\n'.join(braille) + '\n')
    k = w / b.width
    return {'w': w, 'h': h, 's0': 7, 'r': 0.34, 'eye': [round((EYE[0] - box[0]) * k, 3), round((EYE[1] - box[1]) * k, 3)], 'rows': rows, 'braille': braille}

def dump(name, data):
    with open(os.path.join(HERE, name), 'w') as f: json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

dump('portrait.json', portrait())
dump('emblem.json', {'40': emblem(40), '28': emblem(28)})
print('ok')
