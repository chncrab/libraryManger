"""生成应用图标：深色圆角底 + 金色书脊 + 米色封面，取色沿用界面变量。
用法：python scripts/make-icon.py  产出 build/icon.png(1024) 与 build/icon.ico"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 4096                      # 4 倍超采样，缩到 1024 边缘才干净
BG_TOP = (28, 24, 21)
BG_BOT = (15, 13, 11)
LINE = (47, 43, 37)
GOLD = (201, 162, 39)
GOLD_DARK = (150, 118, 26)
CREAM = (234, 230, 223)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 竖向渐变底
for y in range(S):
    t = y / (S - 1)
    c = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))
    d.line([(0, y), (S, y)], fill=c + (255,))

# 圆角遮罩
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.21), fill=255)
img.putalpha(mask.rgb2gray() if mask.mode == "RGB" else mask)

# 描边
d.rounded_rectangle(
    [int(S * 0.008), int(S * 0.008), S - int(S * 0.008), S - int(S * 0.008)],
    radius=int(S * 0.205),
    outline=LINE + (255,),
    width=int(S * 0.008),
)

# 书本：整体金色，再叠米色封面，左侧留出书脊
x0, x1 = int(S * 0.205), int(S * 0.795)
y0, y1 = int(S * 0.175), int(S * 0.825)
d.rounded_rectangle([x0, y0, x1, y1], radius=int(S * 0.04), fill=GOLD + (255,))
# 书脊右侧的分界
sx = int(S * 0.335)
d.rectangle([sx - int(S * 0.004), y0, sx + int(S * 0.004), y1], fill=GOLD_DARK + (255,))
# 封面
d.rounded_rectangle([sx, y0, x1, y1], radius=int(S * 0.04), fill=CREAM + (255,))
d.rectangle([sx, y0, sx + int(S * 0.03), y1], fill=CREAM + (255,))
# 封面上一道短压纹当书名位
d.rounded_rectangle(
    [int(S * 0.435), int(S * 0.325), int(S * 0.695), int(S * 0.352)],
    radius=int(S * 0.012),
    fill=GOLD_DARK + (255,),
)
d.rounded_rectangle(
    [int(S * 0.435), int(S * 0.395), int(S * 0.585), int(S * 0.418)],
    radius=int(S * 0.011),
    fill=GOLD_DARK + (255,),
)

out = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
out.alpha_composite(img.resize((1024, 1024), Image.LANCZOS))
root = Path(__file__).resolve().parent.parent
(root / "build").mkdir(exist_ok=True)
out.save(root / "build" / "icon.png")
out.save(root / "build" / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("已生成", root / "build" / "icon.ico")
