# -*- coding: utf-8 -*-
"""
个人中心模块（PROFILE-TASK T0.4）Material 图标烘焙驱动
- 取源逻辑与 scripts/tmp-material-bake.py 一致：fonts.gstatic.com materialicons
  24px、版本回退 v1..v12、本地缓存、全幅矩形 path 过滤（含 m00h24v24h0v0z 变体）
- 色值 = yuanlu-android theme/Color.kt（严格源）：
  primary #1f7a5c/#4da989 · secondary #d98a17（深浅同值）· tertiary #4a7fa5/#7fa8c8
  error #d2503f（深浅同值）· onSurfaceVariant #57534e/#a8a29e · onSurface #1c1917/#e8e3d9
- 后缀约定：-primary(-dark)/-accent/-tertiary(-dark)/-error 沿用既有资产先例；
  -variant(-dark)=onSurfaceVariant、-onsurface(-dark)=onSurface 为本批新增角色名
用法：python scripts/tmp-profile-bake-icons.py
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
    # 用户信息卡
    ('hiking', '#1f7a5c', 'hiking-primary.svg'),
    ('hiking', '#4da989', 'hiking-primary-dark.svg'),
    ('hiking', '#d98a17', 'hiking-accent.svg'),  # 等级徽章（secondary 橙，深浅同值）
    ('calendar_month', '#57534e', 'calendar-month-variant.svg'),
    ('calendar_month', '#a8a29e', 'calendar-month-variant-dark.svg'),
    ('place', '#57534e', 'place-variant.svg'),
    ('place', '#a8a29e', 'place-variant-dark.svg'),
    ('person', '#57534e', 'person-variant.svg'),        # 头像占位（CSS 调 35~40% 透明度）
    ('person', '#a8a29e', 'person-variant-dark.svg'),
    # 旅程数据三卡
    ('local_fire_department', '#d98a17', 'local-fire-department-accent.svg'),
    ('bookmark', '#4a7fa5', 'bookmark-tertiary.svg'),
    ('bookmark', '#7fa8c8', 'bookmark-tertiary-dark.svg'),
    # 账号与安全四卡
    ('smartphone', '#1f7a5c', 'smartphone-primary.svg'),
    ('smartphone', '#4da989', 'smartphone-primary-dark.svg'),
    ('email', '#d98a17', 'email-accent.svg'),
    ('lock', '#4a7fa5', 'lock-tertiary.svg'),
    ('lock', '#7fa8c8', 'lock-tertiary-dark.svg'),
    ('person_remove', '#d2503f', 'person-remove-error.svg'),
    ('check_circle', '#1f7a5c', 'check-circle-primary.svg'),
    # 绑定弹层输入框 leading（OutlinedTextField 默认 onSurfaceVariant）
    ('phone_iphone', '#57534e', 'phone-iphone-variant.svg'),
    ('phone_iphone', '#a8a29e', 'phone-iphone-variant-dark.svg'),
    ('password', '#57534e', 'password-variant.svg'),
    ('password', '#a8a29e', 'password-variant-dark.svg'),
    ('mail', '#57534e', 'mail-variant.svg'),
    ('mail', '#a8a29e', 'mail-variant-dark.svg'),
    ('lock', '#57534e', 'lock-variant.svg'),
    ('lock', '#a8a29e', 'lock-variant-dark.svg'),
    # 密码强度三项：达标对勾
    ('check', '#1f7a5c', 'check-primary.svg'),
    ('check', '#4da989', 'check-primary-dark.svg'),
    # 编辑资料页
    ('person', '#1f7a5c', 'person-primary.svg'),        # 头部图标 + Tab1 选中
    ('person', '#4da989', 'person-primary-dark.svg'),
    ('tune', '#1f7a5c', 'tune-primary.svg'),            # Tab2 选中
    ('tune', '#4da989', 'tune-primary-dark.svg'),
    ('tune', '#57534e', 'tune-variant.svg'),            # Tab 未选中
    ('tune', '#a8a29e', 'tune-variant-dark.svg'),
    ('camera_alt', '#ffffff', 'camera-alt-white.svg'),
    ('close', '#1c1917', 'close-onsurface.svg'),
    ('close', '#e8e3d9', 'close-onsurface-dark.svg'),
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
