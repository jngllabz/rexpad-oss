# Renders public/og.png (1200x630) — the REX Chain social card. Run: python3 tools/og.py
# This is what every shared link unfurls into, so it carries the site's own positioning verbatim.
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import random

W, H = 1200, 630
INK = (11, 16, 12)
REX = (34, 197, 94)
LIME = (157, 255, 143)
MINT = (207, 233, 214)

img = Image.new('RGB', (W, H), INK)

# emerald bloom
glow = Image.new('RGB', (W, H), INK); g = ImageDraw.Draw(glow)
g.ellipse((120, -340, 1000, 360), fill=(8, 64, 30))
g.ellipse((700, 160, 1460, 900), fill=(6, 48, 24))
g.ellipse((-320, 320, 320, 860), fill=(4, 34, 18))
glow = glow.filter(ImageFilter.GaussianBlur(150))
img = Image.blend(img, glow, 0.95)

# contour rings (the rex.fun topo texture)
rings = Image.new('RGBA', (W, H), (0, 0, 0, 0)); rd = ImageDraw.Draw(rings)
for i in range(9):
    r = 150 + i * 78
    rd.ellipse((980 - r, 300 - r, 980 + r, 300 + r), outline=(34, 197, 94, 26), width=2)
rings = rings.filter(ImageFilter.GaussianBlur(0.6))
img = Image.alpha_composite(img.convert('RGBA'), rings)

# speckle field
sp = Image.new('RGBA', (W, H), (0, 0, 0, 0)); sd = ImageDraw.Draw(sp)
random.seed(11)
for _ in range(110):
    x, y, r = random.randint(0, W), random.randint(0, H), random.uniform(1, 2.6)
    a = random.randint(30, 120)
    sd.ellipse((x - r, y - r, x + r, y + r), fill=(34, 197, 94, a))
img = Image.alpha_composite(img, sp)

# mascot, radially masked into the right side
try:
    m = Image.open('public/brand/rex-hero.jpg').convert('RGB')
    size = 620
    m = m.resize((size, size), Image.LANCZOS)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size, size), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(70))
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    layer.paste(m, (W - size - 10, H - size + 60), mask)
    img = Image.alpha_composite(img, layer)
except FileNotFoundError:
    pass

d = ImageDraw.Draw(img)
f_big = ImageFont.truetype('tools/fonts/SpaceGrotesk-Bold.ttf', 92)
f_word = ImageFont.truetype('tools/fonts/SpaceGrotesk-Bold.ttf', 30)
f_body = ImageFont.truetype('tools/fonts/Inter-Medium.ttf', 25)
f_mono = ImageFont.truetype('tools/fonts/Inter-Medium.ttf', 20)

# frame
frame = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(frame).rounded_rectangle((40, 40, W - 40, H - 40), radius=34, outline=(34, 197, 94, 105), width=2, fill=(255, 255, 255, 6))
img = Image.alpha_composite(img, frame)
d = ImageDraw.Draw(img)

# logo glyph + wordmark
try:
    glyph = Image.open('public/brand/rex-glyph.png').convert('RGBA').resize((58, 58), Image.LANCZOS)
    img.paste(glyph, (86, 82), glyph)   # its own alpha — it is a cut-out, not a tile
except FileNotFoundError:
    pass
WORD = 'REX CHAIN'
d.text((158, 95), WORD, font=f_word, fill=(255, 255, 255))
d.text((158 + d.textlength(WORD, font=f_word) + 28, 99), 'the $REX ecosystem', font=f_mono, fill=(120, 190, 145))

# Headline — the site's own five verbs, split over two lines. The mascot owns the right side of
# the card, so the type is fitted to the clear column rather than set at a fixed size: a longer
# line shrinks instead of running under the artwork.
LINE1, LINE2 = 'Launch. Build. Trade.', 'Discover. Grow.'
COL = 600
size = 92
while size > 40:
    f_big = ImageFont.truetype('tools/fonts/SpaceGrotesk-Bold.ttf', size)
    if max(d.textlength(LINE1, font=f_big), d.textlength(LINE2, font=f_big)) <= COL:
        break
    size -= 2
lead = int(size * 1.06)
y1 = 232
d.text((88, y1), LINE1, font=f_big, fill=(255, 255, 255))

# second line in the brand gradient, painted through the glyphs themselves
y2 = y1 + lead
run = int(d.textlength(LINE2, font=f_big)) or 1
grad = Image.new('RGBA', (W, H), (0, 0, 0, 0)); gd = ImageDraw.Draw(grad)
for i in range(run):
    t = i / run
    gd.line((88 + i, y2 - 4, 88 + i, y2 + lead), fill=(int(21 + (157 - 21) * t), int(128 + (255 - 128) * t), int(61 + (143 - 61) * t), 255))
mask = Image.new('L', (W, H), 0)
ImageDraw.Draw(mask).text((88, y2), LINE2, font=f_big, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)

# chips
layer = Image.new('RGBA', (W, H), (0, 0, 0, 0)); ld = ImageDraw.Draw(layer)
def chip(x, y, text, col):
    tw = ld.textlength(text, font=f_body) + 44
    ld.rounded_rectangle((x, y, x + tw, y + 52), radius=26, fill=col + (30,), outline=col + (135,), width=2)
    ld.text((x + 22, y + 12), text, font=f_body, fill=col + (255,))
    return x + tw + 14
CHIP_Y = max(470, y2 + lead + 26)
x = chip(88, CHIP_Y, 'Sealed Fair Opens', LIME)
x = chip(x, CHIP_Y, 'Holder rewards', REX)
if x + 190 < 700:
    chip(x, CHIP_Y, 'Share & earn', MINT)
img = Image.alpha_composite(img, layer)

img.convert('RGB').save('public/og.png', optimize=True)
print('wrote public/og.png')
