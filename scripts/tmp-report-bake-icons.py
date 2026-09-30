# -*- coding: utf-8 -*-
"""
学习报表模块 Material 图标烘焙驱动（复用 tmp-profile-bake-icons.py 口径）
- fonts.gstatic.com materialicons 24px、版本回退 v1..v12、本地缓存、全幅矩形过滤
- 色值 = yuanlu-android theme/Color.kt：primary #1f7a5c/#4da989
- 四宫格图标统一 primary 绿（Web 源码 label 行为灰 40%，按用户截图四绿观感取绿）
用法：python scripts/tmp-report-bake-icons.py
"""
import os
import re
import urllib.request

ROOT = r'D:\WebstormProjects\yuanlu-weapp'
ICON = os.path.join(ROOT, 'assets', 'icons')
CACHE = os.path.join(ROOT, 'scripts', 'tmp-material-cache')
PROXY = 'http://127.0.0.1:7891'  # Clash Verge（直连失败时回退）

FULL_RECT = re.compile(r'^\s*M0[, ]?0h24v24H0(V0)?z\s*$', re.I)


def _open(url):
    try:
        return urllib.request.urlopen(url, timeout=10)
    except Exception:
        handler = urllib.request.ProxyHandler({'http': PROXY, 'https': PROXY})
        opener = urllib.request.build_opener(handler)
        return opener.open(url, timeout=15)


def fetch_material(name):
    """返回 (viewBox, [path_d,...])；缓存优先，版本回退，滤全幅矩形"""
    cache = os.path.join(CACHE, name + '.svg')
    if not os.path.exists(cache):
        for v in range(1, 13):
            url = 'https://fonts.gstatic.com/s/i/materialicons/%s/v%d/24px.svg' % (name, v)
            try:
                with _open(url) as r:
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
    if not ds:
        ds = re.findall(r'\sd="([^"]+)"', s)
    ds = [d for d in ds if not FULL_RECT.match(d)]
    return m.group(1), ds


JOBS = [
    # 页头大图标 + 入口卡 + 四宫格「近 7 天时长」（lucide BarChart3 对应物）
    ('bar_chart', '#1f7a5c', 'bar-chart-primary.svg'),
    ('bar_chart', '#4da989', 'bar-chart-primary-dark.svg'),
    # 四宫格「目标达成」（lucide CalendarCheck 对应物）
    ('event_available', '#1f7a5c', 'event-available-primary.svg'),
    ('event_available', '#4da989', 'event-available-primary-dark.svg'),
    # 四宫格「连续打卡」（绿款；accent 橙款已有）
    ('local_fire_department', '#1f7a5c', 'local-fire-department-primary.svg'),
    ('local_fire_department', '#4da989', 'local-fire-department-primary-dark.svg'),
    # 四宫格「新收生词」（绿款；tertiary 蓝款已有）
    ('bookmark', '#1f7a5c', 'bookmark-primary.svg'),
    ('bookmark', '#4da989', 'bookmark-primary-dark.svg'),
]


def main():
    ok_n = 0
    for name, color, out in JOBS:
        vb, ds = fetch_material(name)
        if not ds:
            raise RuntimeError('no glyph after rect-filter: %s' % name)
        body = ''.join('<path fill="%s" d="%s"/>' % (color, d) for d in ds)
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="%s">%s</svg>' % (vb, body))
        open(os.path.join(ICON, out), 'w', encoding='utf-8', newline='\n').write(svg)
        print('ok %-46s %d path(s)  %s' % (out, len(ds), color))
        ok_n += 1
    print('baked %d files' % ok_n)


if __name__ == '__main__':
    main()
