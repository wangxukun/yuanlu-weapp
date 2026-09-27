# -*- coding: utf-8 -*-
"""
Material 图标批量烘焙 + 全量替换（lucide → Android Material）
- 从 fonts.gstatic.com 拉取 materialicons 官方 24px path（版本回退 v1..v12，本地缓存）
- SVG：保留源 viewBox，fill 指定色（沿用旧 lucide 文件色值）
- PNG：自写 path 栅格化器（贝塞尔展平 + even-odd 扫描线 + 8x 超采样 + LANCZOS 缩小）
- 引用重写：pages/ components/ app.json（scripts/ 测试随后统一处理）
用法：python scripts/tmp-material-bake.py [--dry]
"""
import os, re, sys, math, json, urllib.request

ROOT = r'D:\WebstormProjects\yuanlu-weapp'
ICON = os.path.join(ROOT, 'assets', 'icons')
CACHE = os.path.join(ROOT, 'scripts', 'tmp-material-cache')
os.makedirs(CACHE, exist_ok=True)
DRY = '--dry' in sys.argv

# ---------------- gstatic 拉取 ----------------
def fetch_material(name):
    """返回 (viewBox, [path_d,...])；缓存优先，版本回退"""
    cache = os.path.join(CACHE, name + '.svg')
    if not os.path.exists(cache):
        for v in range(1, 13):
            url = 'https://fonts.gstatic.com/s/i/materialicons/%s/v%d/24px.svg' % (name, v)
            try:
                with urllib.request.urlopen(url, timeout=10) as r:
                    data = r.read().decode('utf-8')
                if '<path' in data and '<html' not in data:
                    open(cache, 'w', encoding='utf-8').write(data)
                    break
            except Exception:
                continue
    if not os.path.exists(cache):
        raise RuntimeError('fetch fail: ' + name)
    s = open(cache, encoding='utf-8').read()
    m = re.search(r'viewBox="([^"]+)"', s)
    ds = re.findall(r'<path[^>]*?\sd="([^"]+)"', s, re.S)
    if not ds:  # d 在其它属性前
        ds = re.findall(r'\sd="([^"]+)"', s)
    # 过滤全幅矩形路径（新版源文件的 bounding 底，非字形；H0z/H0V0z 两种写法）
    full = re.compile(r'^\s*M0[, ]?0h24v24H0(V0)?z\s*$', re.I)
    ds = [d for d in ds if not full.match(d)]
    return m.group(1), ds

# ---------------- path 解析 + 展平 ----------------
NUM = re.compile(r'[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?')
CMD = re.compile(r'[MLHVCSQTAZmlhvcsqtaz]')

def parse_points(d):
    """SVG path → 多个子路径（各为点列），贝塞尔/弧线展平"""
    tokens = re.findall(r'[MLHVCSQTAZmlhvcsqtaz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?', d)
    i, x, y, sx, sy = 0, 0.0, 0.0, 0.0, 0.0
    start = (0.0, 0.0); last_c = None; last_q = None
    subs, cur = [], []
    def nums(n):
        nonlocal i
        out = []
        while len(out) < n and i < len(tokens) and not CMD.match(tokens[i]):
            out.append(float(tokens[i])); i += 1
        return out
    while i < len(tokens):
        c = tokens[i]; i += 1
        up = c.upper()
        if up == 'M':
            if cur: subs.append(cur)
            a = nums(2); x, y = a if c.isupper() else (x + a[0], y + a[1])
            start = (x, y); last_c = last_q = None; cur = [start]
            # 后续隐式 L
            while i < len(tokens) and not CMD.match(tokens[i]):
                a = nums(2); x, y = a if c.isupper() else (x + a[0], y + a[1]); cur.append((x, y))
        elif up == 'L':
            while True:
                a = nums(2)
                if len(a) < 2: break
                x, y = a if c.isupper() else (x + a[0], y + a[1]); cur.append((x, y))
            last_c = last_q = None
        elif up == 'H':
            while i < len(tokens) and not CMD.match(tokens[i]):
                a = nums(1); x = a[0] if c.isupper() else x + a[0]; cur.append((x, y))
            last_c = last_q = None
        elif up == 'V':
            while i < len(tokens) and not CMD.match(tokens[i]):
                a = nums(1); y = a[0] if c.isupper() else y + a[0]; cur.append((x, y))
            last_c = last_q = None
        elif up == 'C':
            while True:
                a = nums(6)
                if len(a) < 6: break
                if c.isupper():
                    x1, y1, x2, y2, x3, y3 = a
                else:
                    x1, y1, x2, y2, x3, y3 = x + a[0], y + a[1], x + a[2], y + a[3], x + a[4], y + a[5]
                x0, y0 = x, y
                for k in range(1, 17):
                    t = k / 16.0; mt = 1 - t
                    cur.append((mt**3*x0 + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t**3*x3,
                                mt**3*y0 + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t**3*y3))
                x, y = x3, y3; last_c = (x2, y2); last_q = None
        elif up == 'S':
            while True:
                a = nums(4)
                if len(a) < 4: break
                if c.isupper():
                    x2, y2, x3, y3 = a
                else:
                    x2, y2, x3, y3 = x + a[0], y + a[1], x + a[2], y + a[3]
                x1, y1 = (2*x - last_c[0], 2*y - last_c[1]) if last_c else (x, y)
                x0, y0 = x, y
                for k in range(1, 17):
                    t = k / 16.0; mt = 1 - t
                    cur.append((mt**3*x0 + 3*mt*mt*t*x1 + 3*mt*t*t*x2 + t**3*x3,
                                mt**3*y0 + 3*mt*mt*t*y1 + 3*mt*t*t*y2 + t**3*y3))
                x, y = x3, y3; last_c = (x2, y2); last_q = None
        elif up == 'Q':
            while True:
                a = nums(4)
                if len(a) < 4: break
                if c.isupper():
                    x1, y1, x3, y3 = a
                else:
                    x1, y1, x3, y3 = x + a[0], y + a[1], x + a[2], y + a[3]
                x0, y0 = x, y
                for k in range(1, 13):
                    t = k / 12.0; mt = 1 - t
                    cur.append((mt*mt*x0 + 2*mt*t*x1 + t*t*x3, mt*mt*y0 + 2*mt*t*y1 + t*t*y3))
                x, y = x3, y3; last_q = (x1, y1); last_c = None
        elif up == 'T':
            while True:
                a = nums(2)
                if len(a) < 2: break
                x3, y3 = a if c.isupper() else (x + a[0], y + a[1])
                x1, y1 = (2*x - last_q[0], 2*y - last_q[1]) if last_q else (x, y)
                x0, y0 = x, y
                for k in range(1, 13):
                    t = k / 12.0; mt = 1 - t
                    cur.append((mt*mt*x0 + 2*mt*t*x1 + t*t*x3, mt*mt*y0 + 2*mt*t*y1 + t*t*y3))
                x, y = x3, y3; last_q = (x1, y1); last_c = None
        elif up == 'A':
            while True:
                a = nums(7)
                if len(a) < 7: break
                rx, ry, rot, laf, sf, x2, y2 = a
                if c.islower(): x2, y2 = x + x2, y + y2
                for pt in arc_points(x, y, rx, ry, rot, laf, sf, x2, y2):
                    cur.append(pt)
                x, y = x2, y2; last_c = last_q = None
        elif up == 'Z':
            if cur:
                cur.append(start); subs.append(cur); cur = []
                x, y = start; last_c = last_q = None
    if cur: subs.append(cur)
    return subs

def arc_points(x0, y0, rx, ry, rot, laf, sf, x1, y1, n=24):
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0 or (x0 == x1 and y0 == y1):
        return [(x1, y1)]
    phi = math.radians(rot % 360)
    dx, dy = (x0 - x1) / 2.0, (y0 - y1) / 2.0
    xe = dx * math.cos(phi) + dy * math.sin(phi)
    ye = -dx * math.sin(phi) + dy * math.cos(phi)
    lam = xe*xe/(rx*rx) + ye*ye/(ry*ry)
    if lam > 1:
        s = math.sqrt(lam); rx *= s; ry *= s
    num = rx*rx*ry*ry - rx*rx*ye*ye - ry*ry*xe*xe
    den = rx*rx*ye*ye + ry*ry*xe*xe
    co = math.sqrt(max(0.0, num / den)) * (-1 if laf != sf else 1)
    cx = co * rx * ye / ry; cy = -co * ry * xe / rx
    ox = cx * math.cos(phi) - cy * math.sin(phi) + (x0 + x1) / 2.0
    oy = cx * math.sin(phi) + cy * math.cos(phi) + (y0 + y1) / 2.0
    def ang(ux, uy, vx, vy):
        d = (ux*vx + uy*vy) / (math.hypot(ux, uy) * math.hypot(vx, vy))
        d = max(-1.0, min(1.0, d))
        a = math.acos(d)
        return a if ux*vy - uy*vx >= 0 else -a
    t1 = ang(1, 0, (xe - cx) / rx, (ye - cy) / ry)
    dt = ang((xe - cx) / rx, (ye - cy) / ry, (-xe - cx) / rx, (-ye - cy) / ry)
    if not sf and dt > 0: dt -= 2 * math.pi
    if sf and dt < 0: dt += 2 * math.pi
    pts = []
    for k in range(1, n + 1):
        t = t1 + dt * k / n
        px = ox + rx * math.cos(t) * math.cos(phi) - ry * math.sin(t) * math.sin(phi)
        py = oy + rx * math.cos(t) * math.sin(phi) + ry * math.sin(t) * math.cos(phi)
        pts.append((px, py))
    return pts

# ---------------- PNG 栅格化 ----------------
def raster_png(name, color, px, out):
    from PIL import Image
    vb, ds = fetch_material(name)
    vb = [float(v) for v in vb.replace(',', ' ').split()]
    vx, vy, vw, vh = vb
    S = 8
    W = px * S
    subs = []
    for d in ds:
        subs.extend(parse_points(d))
    edges = []
    for sub in subs:
        for a, b in zip(sub, sub[1:]):
            if a != b:
                edges.append((a, b))
    mask = Image.new('L', (W, W), 0)
    mp = mask.load()
    scale = W / max(vw, vh)
    ox = -vx * scale + (W - vw * scale) / 2
    oy = -vy * scale + (W - vh * scale) / 2
    for row in range(W):
        yy = (row + 0.5) / scale + vy - oy / scale  # 逆变换回源坐标
        yy = yy  # 源坐标
        xs = []
        for (ax, ay), (bx, by) in edges:
            if (ay <= yy < by) or (by <= yy < ay):
                xs.append(ax + (yy - ay) * (bx - ax) / (by - ay))
        if not xs:
            continue
        xs.sort()
        for j in range(0, len(xs) - 1, 2):
            x0 = int((xs[j] * scale + ox))
            x1 = int((xs[j + 1] * scale + ox))
            if x1 < 0 or x0 >= W:
                continue
            for xx in range(max(0, x0), min(W - 1, x1 - 1) + 1):
                mp[xx, row] = 255
    mask = mask.resize((px, px), Image.LANCZOS)
    c = tuple(int(color[i:i+2], 16) for i in (1, 3, 5)) + (255,)
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    img.paste(c, (0, 0, px, px), mask)
    img.save(out)

# ---------------- SVG 烘焙 ----------------
def bake_svg(name, color, out):
    vb, ds = fetch_material(name)
    body = ''.join('<path fill="%s" d="%s"/>' % (color, d) for d in ds)
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="%s">%s</svg>' % (vb, body))
    open(out, 'w', encoding='utf-8').write(svg)

def old_color(fname):
    s = open(os.path.join(ICON, fname), encoding='utf-8').read()
    m = re.search(r'stroke="(#[0-9A-Fa-f]{3,8})"', s) or re.search(r'fill="(#[0-9A-Fa-f]{3,8})"', s)
    return m.group(1).lower() if m else '#000000'

# ---------------- 映射表 ----------------
# (旧文件, Material 名, 新文件 or None=原地换字形, 色值 or None=自动取旧色, or 'dedupe:目标'仅改引用)
SVG_MAP = [
    # ── 就地换字形（旧名 == Material 名）──
    ('send-white.svg', 'send', None, None),
    ('translate.svg', 'translate', None, '#64748B'),
    ('translate-primary.svg', 'translate', None, None),
    ('translate-primarydark.svg', 'translate', None, None),
    ('translate-gray.svg', 'translate', None, None),
    ('translate-graydark.svg', 'translate', None, None),
    ('tv.svg', 'tv', None, None),
    ('download.svg', 'download', None, None),
    ('bookmark-border.svg', 'bookmark_border', None, None),
    ('share.svg', 'share', None, None),
    ('list.svg', 'list', None, None),
    ('lock.svg', 'lock', None, None),
    ('lock-white.svg', 'lock', None, None),
    ('lock-amber.svg', 'lock', None, None),
    ('lock-faint.svg', 'lock', None, None),
    ('lock-faint-dark.svg', 'lock', None, None),
    ('check-circle.svg', 'check_circle', None, None),
    ('check-circle-success.svg', 'check_circle', None, None),
    ('check-circle-success-dark.svg', 'check_circle', None, None),
    ('check-white.svg', 'check', None, None),
    ('mic-gray.svg', 'mic', None, None),
    ('mic-ink.svg', 'mic', None, None),
    ('mic-ink-active.svg', 'mic', None, None),
    ('settings-ink.svg', 'settings', None, None),
    ('settings-light.svg', 'settings', None, None),
    ('settings-primary.svg', 'settings', None, None),
    ('repeat-lucide-gray.svg', 'repeat', 'repeat-gray.svg', None),
    ('repeat-lucide-graydark.svg', 'repeat', 'repeat-graydark.svg', None),
    ('layers-primary.svg', 'layers', None, None),
    ('layers-gray.svg', 'layers', None, None),
    ('list-gray.svg', 'list', None, None),
    ('list-ink.svg', 'list', None, None),
    ('list-ink100.svg', 'list', None, None),
    ('trending-up-primary.svg', 'trending_up', None, None),
    ('trending-up-primary-dark.svg', 'trending_up', None, None),
    ('lightbulb-amber.svg', 'lightbulb', None, None),
    ('pause-primary.svg', 'pause', None, None),
    ('pause-primary-dark.svg', 'pause', None, None),
    ('schedule-accent.svg', 'schedule', None, None),
    ('replay-error.svg', 'replay', None, None),
    ('play-circle-primary.svg', 'play_circle', None, None),
    # ── 改名换字形 ──
    ('calendar.svg', 'date_range', 'date-range.svg', None),
    ('clock.svg', 'schedule', 'schedule.svg', None),
    ('circle-alert-error.svg', 'error', 'error.svg', None),
    ('file-text.svg', 'description', 'description.svg', None),
    ('file-text-primary.svg', 'description', 'description-primary.svg', None),
    ('file-text-indigo.svg', 'description', 'description-indigo.svg', None),
    ('chevron-up.svg', 'keyboard_arrow_up', 'keyboard-arrow-up.svg', None),
    ('chevron-down.svg', 'keyboard_arrow_down', 'keyboard-arrow-down.svg', None),
    ('chevron-up-gray.svg', 'keyboard_arrow_up', 'keyboard-arrow-up-gray.svg', None),
    ('chevron-down-gray.svg', 'keyboard_arrow_down', 'keyboard-arrow-down-gray.svg', None),
    ('chevron-down-light.svg', 'keyboard_arrow_down', 'keyboard-arrow-down-light.svg', None),
    ('chevron-down-ink.svg', 'keyboard_arrow_down', 'keyboard-arrow-down-ink.svg', None),
    ('chevron-down-primary.svg', 'keyboard_arrow_down', 'keyboard-arrow-down-primary.svg', None),
    ('chevron-down-primary-dark.svg', 'keyboard_arrow_down', 'keyboard-arrow-down-primary-dark.svg', None),
    ('chevron-up-primary.svg', 'keyboard_arrow_up', 'keyboard-arrow-up-primary.svg', None),
    ('chevron-up-primary-dark.svg', 'keyboard_arrow_up', 'keyboard-arrow-up-primary-dark.svg', None),
    ('chevron-left-primary.svg', 'keyboard_arrow_left', 'keyboard-arrow-left-primary.svg', None),
    ('chevron-left-dark.svg', 'keyboard_arrow_left', 'keyboard-arrow-left-dark.svg', None),
    ('chevron-right-primary.svg', 'keyboard_arrow_right', 'keyboard-arrow-right-primary.svg', None),
    ('chevron-right-dark.svg', 'keyboard_arrow_right', 'keyboard-arrow-right-dark.svg', None),
    ('arrows-right-left-primary.svg', 'swap_horiz', 'swap-horiz-primary.svg', None),
    ('arrows-right-left-gray.svg', 'swap_horiz', 'swap-horiz-gray.svg', None),
    ('bookmark-outline-gray.svg', 'bookmark_border', 'bookmark-border-gray.svg', None),
    ('bookmark-filled.svg', 'bookmark', 'bookmark.svg', None),
    ('bookmark-check-primary.svg', 'bookmark_added', 'bookmark-added-primary.svg', None),
    ('layout-dashboard-error.svg', 'computer', 'computer-error.svg', None),
    ('palette-ink.svg', 'contrast', 'contrast-ink.svg', None),
    ('circle-help-ink.svg', 'help_outline', 'help-outline-ink.svg', None),
    ('help-circle-primary.svg', 'help_outline', 'help-outline-primary.svg', None),
    ('book-a.svg', 'menu_book', 'menu-book-gray.svg', None),
    ('book-a-active.svg', 'menu_book', 'menu-book-primary.svg', None),
    ('book-open-primary.svg', 'menu_book', 'menu-book-primary.svg', None),
    ('text-quote.svg', 'format_quote', 'format-quote-gray.svg', None),
    ('text-quote-active.svg', 'format_quote', 'format-quote-primary.svg', None),
    ('text-quote-primary.svg', 'format_quote', 'format-quote-primary.svg', None),
    ('text-quote-primary-dark.svg', 'format_quote', 'format-quote-primary-dark.svg', None),
    ('list-ordered-primary.svg', 'format_list_numbered', 'format-list-numbered-primary.svg', None),
    ('list-ordered-gray.svg', 'format_list_numbered', 'format-list-numbered-gray.svg', None),
    ('sparkles.svg', 'auto_awesome', 'auto-awesome.svg', None),
    ('sparkles-primary.svg', 'auto_awesome', 'auto-awesome-primary.svg', None),
    ('sparkles-gray.svg', 'auto_awesome', 'auto-awesome-gray.svg', None),
    ('flame-orange.svg', 'local_fire_department', 'local-fire-department-orange.svg', None),
    ('arrow-right-white.svg', 'arrow_forward', 'arrow-forward-white.svg', None),
    ('volume-2-gray.svg', 'volume_up', 'volume-up-gray.svg', None),
    ('volume-1-white.svg', 'slow_motion_video', 'slow-motion-video-white.svg', None),
    ('volume-1-dark.svg', 'slow_motion_video', 'slow-motion-video-dark.svg', None),
    ('volume-1-primary.svg', 'slow_motion_video', 'slow-motion-video-primary.svg', None),
    ('repeat-1-primary.svg', 'repeat_one', 'repeat-one-primary.svg', None),
    ('repeat-1-primary-dark.svg', 'repeat_one', 'repeat-one-primary-dark.svg', None),
    ('eye-primary.svg', 'visibility', 'visibility-primary.svg', None),
    ('eye-dark.svg', 'visibility', 'visibility-dark.svg', None),
    ('eye-off-primary.svg', 'visibility_off', 'visibility-off-primary.svg', None),
    ('eye-off-dark.svg', 'visibility_off', 'visibility-off-dark.svg', None),
    ('refresh-ccw-light.svg', 'refresh', 'refresh-light.svg', None),
    ('refresh-ccw-gray.svg', 'refresh', 'refresh-gray.svg', None),
    ('x-circle.svg', 'cancel', 'cancel.svg', None),
    ('infinity-accent.svg', 'all_inclusive', 'all-inclusive-accent.svg', None),
    ('stethoscope-primary.svg', 'monitor_heart', 'monitor-heart-primary.svg', None),
    ('stethoscope-primary-dark.svg', 'monitor_heart', 'monitor-heart-primary-dark.svg', None),
    ('stethoscope-faint.svg', 'monitor_heart', 'monitor-heart-faint.svg', None),
    ('stethoscope-faint-dark.svg', 'monitor_heart', 'monitor-heart-faint-dark.svg', None),
    ('loader-primary.svg', 'autorenew', 'autorenew-primary.svg', None),
    ('layout-grid-gray.svg', 'grid_view', 'grid-view-gray.svg', None),
    ('layout-grid-ink.svg', 'grid_view', 'grid-view-ink.svg', None),
    ('layout-grid-ink100.svg', 'grid_view', 'grid-view-ink100.svg', None),
    ('book-a-warning.svg', 'warning', 'warning.svg', None),
    ('book-a-warning-dark.svg', 'warning', 'warning-dark.svg', None),
    ('tag-info.svg', 'label', 'label-info.svg', None),
    ('tag-info-dark.svg', 'label', 'label-info-dark.svg', None),
    ('filter-gray.svg', 'filter_list', 'filter-list-gray.svg', None),
    ('radio-gray.svg', 'podcasts', 'podcasts-gray.svg', None),
    ('mic-disabled.svg', 'mic_off', 'mic-off.svg', None),
    ('edit-2-gray.svg', 'edit', 'edit-gray.svg', None),
    ('trash-2-gray.svg', 'delete', 'delete-gray.svg', None),
    ('tag-primary.svg', 'label', 'label-primary.svg', None),
    ('plus-gray.svg', 'add', 'add-gray.svg', None),
    ('plus-primary.svg', 'add', 'add-primary.svg', None),
    ('plus-dark.svg', 'add', 'add-dark.svg', None),
    ('minus-primary.svg', 'remove', 'remove-primary.svg', None),
    ('minus-dark.svg', 'remove', 'remove-dark.svg', None),
    ('speaker-wave-gray.svg', 'volume_up', 'volume-up-osv.svg', None),
    ('headphones.svg', 'headset', 'headset.svg', None),
    ('podcast-primary.svg', 'podcasts', 'podcasts-primary.svg', None),
    # ── 去重：仅改引用指向既有 Material 文件 ──
    ('speaker-wave-primary.svg', None, 'dedupe:volume-up-primary.svg', None),
    # ── 保留（装饰图形，非图标）──
    # journey-curve.svg：学习之旅虚线小径背景，保留
]

PNG_SPECS = [
    # (输出, Material, 色, 尺寸)
    ('home.png', 'home', '#a79e8a', 81),
    ('home-active.png', 'home', '#1f7a5c', 81),
    ('explore.png', 'explore', '#a79e8a', 81),
    ('explore-active.png', 'explore', '#1f7a5c', 81),
    ('menu-book.png', 'menu_book', '#a79e8a', 81),
    ('menu-book-active.png', 'menu_book', '#1f7a5c', 81),
    ('school.png', 'school', '#1f7a5c', 64),
    ('history.png', 'history', '#d88916', 64),
    ('bookmark.png', 'bookmark', '#d88916', 64),
    ('credit-card.png', 'credit_card', '#d88916', 64),
    ('person.png', 'person', '#a69d89', 81),
]

def main():
    renames = {}   # 旧名→新名（含 dedupe），用于引用重写
    record = []
    # 1) SVG
    color_check = {}
    for old, mat, new, color in SVG_MAP:
        oldp = os.path.join(ICON, old)
        if not os.path.exists(oldp):
            print('!! 旧文件不存在（跳过）:', old); continue
        if new and new.startswith('dedupe:'):
            target = new.split(':', 1)[1]
            renames[old] = target
            record.append((old, '→ 指向既有 ' + target))
            continue
        target = new or old
        c = color or old_color(old)
        if target in color_check and color_check[target] != c:
            print('!! 同名异色冲突:', target, color_check[target], c); sys.exit(1)
        color_check[target] = c
        if not DRY:
            bake_svg(mat, c, os.path.join(ICON, target))
        renames[old] = target
        record.append((old, mat, target, c))
    # 2) PNG
    for out, mat, c, px in PNG_SPECS:
        if not DRY:
            raster_png(mat, c, px, os.path.join(ICON, out))
        record.append(('PNG', mat, out, c, str(px) + 'px'))
    # 3) PNG 改名映射（tabBar/mine）
    renames.update({
        'compass.png': 'explore.png', 'compass-active.png': 'explore-active.png',
        'book-open.png': 'menu-book.png', 'book-open-active.png': 'menu-book-active.png',
        'route.png': 'school.png', 'user.png': 'person.png',
    })
    # 4) 引用重写（pages/components/app.json）
    n = 0
    for base in ('pages', 'components'):
        for dirpath, _, files in os.walk(os.path.join(ROOT, base)):
            for f in files:
                if not f.endswith(('.wxml', '.js', '.json')):
                    continue
                p = os.path.join(dirpath, f)
                s = open(p, encoding='utf-8').read()
                s2 = s
                for old, new in renames.items():
                    s2 = s2.replace('/assets/icons/' + old, '/assets/icons/' + new)
                if s2 != s:
                    n += 1
                    if not DRY:
                        open(p, 'w', encoding='utf-8').write(s2)
    appj = os.path.join(ROOT, 'app.json')
    s = open(appj, encoding='utf-8').read(); s2 = s
    for old, new in renames.items():
        s2 = s2.replace('assets/icons/' + old, 'assets/icons/' + new)
    if s2 != s and not DRY:
        open(appj, 'w', encoding='utf-8').write(s2); n += 1
    print('重写文件数:', n)
    json.dump({'renames': renames, 'record': [list(map(str, r)) for r in record]},
              open(os.path.join(ROOT, 'scripts', 'tmp-material-record.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print('烘焙 SVG 条目:', len(SVG_MAP), 'PNG:', len(PNG_SPECS))

if __name__ == '__main__':
    main()
