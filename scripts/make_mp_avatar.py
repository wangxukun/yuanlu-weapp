# -*- coding: utf-8 -*-
"""合成微信小程序头像（黑底版，观感严格对齐 Android 实机图标）。

实机 Android 图标 = #1F1C17 黑底 + 前景 logo，但前景内容的实际可见占比
比"裁中间 2/3"口径更小更居中。故以 192px legacy 烘焙图为基准，反推
前景内容的缩放与平移，再套用到 432 高清前景上输出 1024 方图。
"""
import numpy as np
from PIL import Image

BG = (31, 28, 23, 255)  # #1F1C17
FG = r"D:\WebstormProjects\yuanlu-android\app\src\main\res\mipmap-xxxhdpi\ic_launcher_foreground.png"
LEGACY = r"D:\WebstormProjects\yuanlu-android\app\src\main\res\mipmap-xxxhdpi\ic_launcher.png"
OUT = r"D:\WebstormProjects\yuanlu-weapp\assets\brand\miniprogram-avatar-1024.png"
SIZE = 1024

legacy = Image.open(LEGACY).convert("RGB")
assert legacy.size == (192, 192)
# legacy 内容 bbox：偏离背景色的像素（前景边缘有抗锯齿渐变，阈值 8）
la = np.asarray(legacy).astype(int)
mask_l = np.any(np.abs(la - np.array(BG[:3])) > 8, axis=2)
ys, xs = np.where(mask_l)
bl = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)  # 192 坐标系
print("legacy content bbox(192):", bl)

fg = Image.open(FG).convert("RGBA")
fa = np.asarray(fg)
mask_f = fa[:, :, 3] > 8
fy, fx = np.where(mask_f)
bf = (fx.min(), fy.min(), fx.max() + 1, fy.max() + 1)  # 432 坐标系
print("foreground content bbox(432):", bf)

# 目标：生成图中内容 bbox = legacy bbox * (1024/192)
k = SIZE / 192
target = tuple(round(v * k) for v in bl)
# 缩放：432 前景内容的宽高 -> 目标宽高（等比，取两轴均值）
s_x = (target[2] - target[0]) / (bf[2] - bf[0])
s_y = (target[3] - target[1]) / (bf[3] - bf[1])
s = (s_x + s_y) / 2
print("scale:", round(s, 4), "s_x:", round(s_x, 4), "s_y:", round(s_y, 4))

new_fg = fg.resize((round(fg.width * s), round(fg.height * s)), Image.LANCZOS)
# 内容中心对齐到目标内容中心
cx = (target[0] + target[2]) / 2 + (bf[0] + bf[2]) / 2 * 0  # 内容中心在目标系
cx = ((bl[0] + bl[2]) / 2) * k
cy = ((bl[1] + bl[3]) / 2) * k
# new_fg 中内容中心相对图片左上的偏移 = bf 中心 * s
off_x = cx - (bf[0] + bf[2]) / 2 * s
off_y = cy - (bf[1] + bf[3]) / 2 * s
px, py = round(off_x), round(off_y)
print("paste at:", (px, py), "new_fg size:", new_fg.size)

canvas = Image.new("RGBA", (SIZE, SIZE), BG)
canvas.alpha_composite(new_fg, (px, py))
out = canvas.convert("RGB")
out.save(OUT, "PNG", optimize=True)
print("saved:", OUT)

# 校验 1：四角仍是背景色
for p in [(2, 2), (SIZE - 3, 2), (2, SIZE - 3), (SIZE - 3, SIZE - 3)]:
    print("corner", p, out.getpixel(p))
# 校验 2：生成图内容 bbox 与目标对齐
oa = np.asarray(out).astype(int)
mask_o = np.any(np.abs(oa - np.array(BG[:3])) > 8, axis=2)
oy, ox = np.where(mask_o)
print("output content bbox:", (ox.min(), oy.min(), ox.max() + 1, oy.max() + 1), "target:", target)
