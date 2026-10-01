# -*- coding: utf-8 -*-
"""
「我的」页 Android 分组列表重构批 Material 图标烘焙驱动
- 取源逻辑与 scripts/tmp-material-bake.py 一致：fonts.gstatic.com materialicons
  24px、版本回退 v1..v12、本地缓存、全幅矩形 path 过滤（含 m00h24v24h0v0z 变体）
- 严格源 = yuanlu-android feature/profile/ProfileScreen.kt MenuRow 原值：
  学习路径 School(primary) / 收听历史 History(secondary) / 我的收藏 Bookmark(#B96F0F
  字面值→新后缀 -accent-deep) / 我的订阅 CreditCard(secondary) / 外观设置
  Contrast(tertiary) / 消息通知 Notifications(primary) / 帮助与支持
  HelpOutline(tertiary)；控制台 Computer(error)=computer-error.svg 既有件复用
- 色值 = theme/Color.kt：primary #1f7a5c/#4da989 · secondary #d98a17 深浅同值 ·
  tertiary #4a7fa5/#7fa8c8
用法：python scripts/tmp-mine-bake-icons.py
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


# (Material 名, 色值, 输出文件)
JOBS = [
    # 学习与记录
    ('school', '#1f7a5c', 'school-primary.svg'),
    ('school', '#4da989', 'school-primary-dark.svg'),
    ('history', '#d98a17', 'history-accent.svg'),
    ('bookmark', '#b96f0f', 'bookmark-accent-deep.svg'),
    # 账户与系统设置
    ('credit_card', '#d98a17', 'credit-card-accent.svg'),
    ('contrast', '#4a7fa5', 'contrast-tertiary.svg'),
    ('contrast', '#7fa8c8', 'contrast-tertiary-dark.svg'),
    ('notifications', '#1f7a5c', 'notifications-primary.svg'),
    ('notifications', '#4da989', 'notifications-primary-dark.svg'),
    ('help_outline', '#4a7fa5', 'help-outline-tertiary.svg'),
    ('help_outline', '#7fa8c8', 'help-outline-tertiary-dark.svg'),
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
        print('ok %-42s %d path(s)  %s' % (out, len(ds), color))
        ok_n += 1
    print('baked %d files' % ok_n)


if __name__ == '__main__':
    main()
