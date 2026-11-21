"""Marchio FUORI: un cerchio aperto, e un aereo di carta che esce dal varco.
Uso: python3 tools/make_icons.py
"""
import math
from PIL import Image, ImageDraw

BG = (6, 6, 6, 255)
LIME = (215, 255, 62, 255)
SS = 4  # sovracampionamento

RING_C = (50.0, 54.0)
RING_R = 32.0
STROKE = 9.0

# varco del cerchio: da -90° a 0° (in alto a destra, dove passa l'aereo)
GAP_A = -90.0
GAP_B = 0.0

# aereo di carta: stessi punti del logo dentro l'app
PLANE = [(96.0, 10.0), (56.8, 29.7), (70.8, 32.1)]
PLANE2 = [(96.0, 10.0), (70.8, 32.1), (71.2, 46.3)]


def draw_mark(size, scale=1.0, bg=True):
    """Stesse forme del logo dentro l'app (viewBox 0 0 100 100)."""
    S = size * SS
    img = Image.new("RGBA", (S, S), BG if bg else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    unit_len = S / 100.0 * scale
    off = (S - S * scale) / 2.0

    def pt(p):
        return (off + p[0] * unit_len, off + p[1] * unit_len)

    w = max(2, int(round(STROKE * unit_len)))
    cx, cy = RING_C
    r = RING_R

    # cerchio aperto: stesso arco del logo (varco in alto a destra)
    box = [pt((cx - r, cy - r)), pt((cx + r, cy + r))]
    d.arc(box, GAP_B, GAP_A + 360.0, fill=LIME, width=w)

    # aereo di carta: le due ali del logo, identiche
    d.polygon([pt(p) for p in PLANE], fill=LIME)
    d.polygon([pt(p) for p in PLANE2], fill=(166, 205, 44, 255))

    return img.resize((size, size), Image.LANCZOS)


def save(img, path):
    img.save(path, optimize=True)
    print(path, img.size)


if __name__ == "__main__":
    out = "public/icons/"
    save(draw_mark(512, scale=0.86), out + "icon-512.png")
    save(draw_mark(192, scale=0.86), out + "icon-192.png")
    save(draw_mark(180, scale=0.86), out + "icon-180.png")
    save(draw_mark(32), out + "favicon-32.png")
    save(draw_mark(192), out + "favicon-192.png")
    save(draw_mark(512, scale=0.62), out + "icon-maskable-512.png")

    # aggiorna manifest e collegamenti con un'impronta del disegno, così
    # l'app installata si accorge che l'icona è cambiata
    import hashlib, json, re
    h = hashlib.sha256(
        open(out + "icon-192.png", "rb").read() + open(out + "icon-maskable-512.png", "rb").read()
    ).hexdigest()[:8]
    mpath = "public/manifest.webmanifest"
    data = json.load(open(mpath))
    for ic in data["icons"]:
        ic["src"] = ic["src"].split("?")[0] + "?v=" + h
    json.dump(data, open(mpath, "w"), ensure_ascii=False, indent=2)
    open(mpath, "a").write("\n")
    hpath = "public/index.html"
    html = open(hpath).read()
    html = re.sub(r'href="(/icons/(?:favicon-32|favicon-192|icon-180)\.png)(?:\?v=[^"]*)?"',
                  lambda m: 'href="%s?v=%s"' % (m.group(1), h), html)
    html = re.sub(r'href="(/manifest\.webmanifest)(?:\?v=[^"]*)?"',
                  'href="/manifest.webmanifest?v=%s"' % h, html)
    open(hpath, "w").write(html)
    print("icone firmate:", h)

    import os
    os.makedirs("tools/preview", exist_ok=True)
    draw_mark(32, scale=0.86).resize((256, 256), Image.NEAREST).save("tools/preview/piccolo.png")
    draw_mark(512, scale=0.86).convert("RGB").save("tools/preview/grande.jpg", quality=92)
    print("pronto")
