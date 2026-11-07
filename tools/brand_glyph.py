# Cuts the REX Chain mark out of the render Elio sent and writes the sizes the site asks for.
#
# The source arrives from Telegram as an 800x800 JPEG on a black field with a floor reflection under
# it. Three things have to happen before it can be a logo: the black has to become transparency (the
# header draws a glow around the mark, and a black square inside a rounded tile is exactly the
# "looks compressed" complaint), the reflection has to go (at 30px it reads as a smudge), and the
# result has to be square and centred so every call site can just scale it.
#
#   python3 tools/brand_glyph.py <source.jpg>
import sys, numpy as np
from collections import deque
from PIL import Image, ImageFilter

src = sys.argv[1] if len(sys.argv) > 1 else 'tools/brand-src/rexchain-logo.jpg'
im = Image.open(src).convert('RGB')
a = np.asarray(im).astype(np.float32)
W, H = im.size

# Luminance, but weighted towards green: the mark is green on black, so green carries the signal and
# the blue channel is almost pure JPEG noise.
lum = (0.2 * a[..., 0] + 0.75 * a[..., 1] + 0.05 * a[..., 2]) / 255.0

# Alpha from luminance. A floor kills the JPEG mush in the black field without eating the glow; the
# curve below it is linear so the bloom fades out instead of ending on a hard edge.
FLOOR, FULL = 0.06, 0.42
alpha = np.clip((lum - FLOOR) / (FULL - FLOOR), 0, 1)

# The mark is a solid object with holes in it (the eye, the mouth). Those holes are genuinely meant
# to be see-through, so they are left alone — but the dark FACETS on its lit left edge are part of
# the solid and must not go translucent. Anything enclosed by the bright outline gets forced opaque,
# which is what a fill from the outside gives us: whatever the flood cannot reach is inside.
inside = np.ones((H, W), dtype=bool)
q = deque()
bg = alpha < 0.12
for x in range(W):
    for y in (0, H - 1):
        if bg[y, x] and inside[y, x]: inside[y, x] = False; q.append((y, x))
for y in range(H):
    for x in (0, W - 1):
        if bg[y, x] and inside[y, x]: inside[y, x] = False; q.append((y, x))
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < H and 0 <= nx < W and inside[ny, nx] and bg[ny, nx]:
            inside[ny, nx] = False; q.append((ny, nx))
# `inside` now also covers the eye and the mouth, which SHOULD stay open. They are small and fully
# enclosed; the body is not. Keep only components bigger than a threshold out of the forced-opaque
# set by simply not forcing anything that is itself dark AND small — cheap version: force opaque only
# where the pixel has some colour in it, which the eye and the mouth do not.
has_colour = (a[..., 1] > 24)
alpha = np.where(inside & has_colour, np.maximum(alpha, 1.0), alpha)

# Now the bounds, which have to separate the mark from its own reflection. A scan by row cannot: the
# two touch at the floor and the mark's mouth slot puts a dip in the middle of the profile that looks
# just like the gap. What does work is the largest CONNECTED bright region — at a high enough
# threshold the reflection is dimmer than the mark and breaks away from it, so the biggest blob is
# the mark and nothing else. 0.65 is where that separation happens on this render; lower and the
# floor glow bridges the two back together.
bright = lum > 0.65
seen = np.zeros_like(bright); best = []
for sy in range(0, H, 3):
    for sx in range(0, W, 3):
        if not bright[sy, sx] or seen[sy, sx]: continue
        q2 = deque([(sy, sx)]); seen[sy, sx] = True; pts = []
        while q2:
            y, x = q2.popleft(); pts.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and bright[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True; q2.append((ny, nx))
        if len(pts) > len(best): best = pts
ys = np.array([p[0] for p in best]); xs = np.array([p[1] for p in best])
top, bottom, left, right = int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())
# Give the glow a few pixels to fade into, but never reach back down into the reflection.
pad = int(0.02 * max(W, H))
top, left = max(0, top - pad), max(0, left - pad)
right = min(W - 1, right + pad)

# A single horizontal cut at the lowest point of the mark still leaves the pool of light it casts on
# the floor, which survives as a green smear under the logo. The mark does not have one base, it has
# a different one in every column, so the floor is cleared per column — just below where that column's
# own silhouette ends, with a short feather so the bottom edge keeps its glow instead of ending on a
# line.
FEATHER = max(6, int(0.015 * H))
col_bottom = np.full(W, -1)
for y, x in best:
    if y > col_bottom[x]: col_bottom[x] = y
# columns the mark never touches get the overall base, so stray floor light there goes too
col_bottom[col_bottom < 0] = bottom
yy = np.arange(H)[:, None]
below = yy - (col_bottom[None, :] + 1)
fade = np.clip(1.0 - below / FEATHER, 0, 1)
alpha = np.where(below >= 0, alpha * fade, alpha)
print(f'mark body x {left}..{right}  y {top}..{bottom}   reflection below y={bottom} cleared')

out = np.dstack([a, alpha * 255]).astype(np.uint8)
glyph = Image.fromarray(out).crop((left, top, right + 1, bottom + 1))

# Square it with a little air, so every consumer can scale without doing its own maths.
gw, gh = glyph.size
# Only a hair of air: the mark is wider than it is tall, so squaring already leaves a band above and
# below it, and at 30px in the header every pixel spent on padding is one not spent on the logo.
side = int(max(gw, gh) * 1.02)
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
canvas.paste(glyph, ((side - gw) // 2, (side - gh) // 2), glyph)

for size, name in [(1024, 'public/brand/rex-glyph@1024.png'), (512, 'public/brand/rex-glyph.png'), (180, 'public/brand/apple-touch-icon.png')]:
    canvas.resize((size, size), Image.LANCZOS).save(name)
    print('wrote', name)
