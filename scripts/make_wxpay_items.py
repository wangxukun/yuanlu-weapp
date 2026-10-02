# -*- coding: utf-8 -*-
"""
make_wxpay_items.py — 微信虚拟支付四档道具图片烘焙（200x200 PNG，<200KB）

MP 后台【道具管理-添加道具】要求：PNG/JPG、200x200、小于 200KB。
设计口径：远路品牌色板（app.wxss 同源）——accent 曙光橙系会员向，
四档分色区分（周=accent-500 橙 / 月=primary-500 远青 / 季=info-500 黛蓝 /
年=accent-600 深橙+皇冠=推荐档）；圆角方卡+档位大字+天数小字。

输出：assets/brand/wxpay-items/（该目录在 packOptions.ignore，不进小程序代码包）
"""

import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "brand", "wxpay-items")
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"

# (文件名, 档位大字, 天数小字, 主色, 浅底色, 是否年卡皇冠)
ITEMS = [
    ("wxpay-item-weekly.png",    "周", "7 天",   "#B96F0F", "#FDF4E7", False),  # accent-600 / accent-50
    ("wxpay-item-monthly.png",   "月", "30 天",  "#1F7A5C", "#EDF7F2", False),  # primary-600 / primary-50
    ("wxpay-item-quarterly.png", "季", "90 天",  "#4A7FA5", "#EEF4F8", False),  # info-500 / 淡蓝
    ("wxpay-item-yearly.png",    "年", "365 天", "#B96F0F", "#FDF4E7", True),   # 推荐档：accent + 皇冠
]

SIZE = 200
RADIUS = 40


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def draw_crown(draw, cx, top, width, color):
    """三峰皇冠（workspace_premium 简化形）：主体三角波 + 底座横条。"""
    h = int(width * 0.62)
    left, right = cx - width // 2, cx + width // 2
    mid_y = top + h
    # 皇冠主体：左底-左峰-中谷-右峰-右底 的多边形
    pts = [
        (left, mid_y),
        (left, top + int(h * 0.18)),
        (cx - width // 4, top + int(h * 0.52)),
        (cx, top),
        (cx + width // 4, top + int(h * 0.52)),
        (right, top + int(h * 0.18)),
        (right, mid_y),
    ]
    draw.polygon(pts, fill=color)
    # 底座
    draw.rounded_rectangle(
        [left, mid_y + 4, right, mid_y + 14], radius=5, fill=color
    )


def make_item(filename, char, days, main_hex, bg_hex, crown):
    main = hex_rgb(main_hex)
    bg = hex_rgb(bg_hex)
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角方卡：浅底 + 主色描边
    draw.rounded_rectangle(
        [6, 6, SIZE - 6, SIZE - 6], radius=RADIUS, fill=bg + (255,), outline=main + (255,), width=6
    )

    top = 22
    if crown:
        draw_crown(draw, SIZE // 2, top, width=56, color=main)
        top += 40
    else:
        # 非年卡：顶部小圆点装饰（同主色 35% 透明）
        deco = main + (90,)
        draw.ellipse([SIZE // 2 - 5, top + 6, SIZE // 2 + 5, top + 16], fill=deco)
        top += 24

    # 档位大字
    f_char = ImageFont.truetype(FONT_BOLD, 86)
    bbox = draw.textbbox((0, 0), char, font=f_char)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(
        ((SIZE - w) / 2 - bbox[0], top + (86 - h) / 2 - bbox[1] - 4),
        char,
        font=f_char,
        fill=main + (255,),
    )

    # 底部天数小字（次级色 = 主色 78% 透明）
    f_days = ImageFont.truetype(FONT_BOLD, 26)
    bbox = draw.textbbox((0, 0), days, font=f_days)
    w = bbox[2] - bbox[0]
    draw.text(
        ((SIZE - w) / 2 - bbox[0], SIZE - 44),
        days,
        font=f_days,
        fill=main + (200,),
    )

    out = os.path.join(OUT_DIR, filename)
    img.save(out, "PNG", optimize=True)
    kb = os.path.getsize(out) / 1024
    print(f"OK {filename}  {kb:.1f} KB")
    assert kb < 200, f"{filename} 超过 200KB 限制"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for row in ITEMS:
        make_item(*row)
    print("DONE:", OUT_DIR)


if __name__ == "__main__":
    main()
