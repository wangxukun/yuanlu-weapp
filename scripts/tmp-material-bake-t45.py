# -*- coding: utf-8 -*-
"""T4.5（闯关页 + 达人榜）Material 图标烘焙：
- arrow_back / leaderboard：优先从 fonts.gstatic.com 拉取（版本回退 + 全幅
  矩形 bounding path 过滤），失败时回退内置 canonical path（material-design-icons
  官方 24px 原值，与 gstatic 同源字形）；
- check_circle / keyboard_arrow_right：复用本地缓存源；
- emoji_events / military_tech：复用已烘焙资产的原 path 换色（同一 Material 字形）。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'scripts', 'tmp-material-cache')
OUT = os.path.join(ROOT, 'assets', 'icons')

BOUNDING = re.compile(r'M0[ ,]0h24v24H0(?:V0)?z')
# 仅匹配 <path> 标签内的 d（enable-background="new..." 的尾缀会伪装成 d="）
PATH_D = re.compile(r'<path[^>]*\bd="([^"]+)"')


def fetch_material(name):
    """fonts.gstatic.com v1..12 版本回退拉取，返回去 bounding 的 path d。"""
    import urllib.request
    last_err = None
    for v in range(1, 13):
        url = 'https://fonts.gstatic.com/s/i/materialicons/%s/v%d/24px.svg' % (name, v)
        for opener in (_proxy_opener(), urllib.request.build_opener()):
            try:
                with opener.open(url, timeout=10) as r:
                    svg = r.read().decode('utf-8')
                m = PATH_D.search(svg)
                if not m:
                    continue
                d = m.group(1)
                if BOUNDING.match(d.replace('\n', '')):
                    continue
                with io.open(os.path.join(CACHE, name + '.svg'), 'w', encoding='utf-8') as f:
                    f.write(svg)
                return d
            except Exception as e:  # noqa: BLE001
                last_err = e
                continue
    print('  fetch failed (%s): %s' % (name, last_err))
    return None


def _proxy_opener():
    """Clash Verge 本机代理 7891（不可用时静默回落直连）。"""
    import urllib.request
    try:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({'http': 'http://127.0.0.1:7891',
                                         'https': 'http://127.0.0.1:7891'}))
    except Exception:  # noqa: BLE001
        return urllib.request.build_opener()


def cached_path(name):
    p = os.path.join(CACHE, name + '.svg')
    if not os.path.exists(p):
        return None
    with io.open(p, encoding='utf-8') as f:
        svg = f.read()
    for m in PATH_D.finditer(svg):
        d = m.group(1).replace('\n', '')
        if BOUNDING.match(d):
            continue
        return d
    return None


def asset_path(filename):
    """取存量资产的原 path + viewBox（**必须连同 viewBox 一起复用**——
    960 网格的 Material Symbols 字形〔如 military_tech〕配 24 viewBox 会
    整体落出视口，渲染成空白，T4.5 银铜奖牌白图教训）"""
    with io.open(os.path.join(OUT, filename), encoding='utf-8') as f:
        svg = f.read()
    m = PATH_D.search(svg)
    vb = re.search(r'viewBox="([^"]+)"', svg)
    return (m.group(1) if m else None, vb.group(1) if vb else '0 0 24 24')


def write_svg(filename, fill, d, viewBox='0 0 24 24'):
    with io.open(os.path.join(OUT, filename), 'w', encoding='utf-8') as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" '
                'viewBox="%s"><path fill="%s" d="%s"/></svg>' % (viewBox, fill, d))
    print('  baked %s (#%s, viewBox=%s)' % (filename, fill, viewBox))


# 内置 canonical path（material-design-icons 官方 24px，网络不可达时的同源回退）
FALLBACK = {
    'arrow_back': 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    'leaderboard': ('M16 11V3H8v6H2v12h20V11h-6zm-6-6h4v14h-4V5zm-6 4h4v10H4V9z'
                    'm16 10h-4v-8h4v8z'),
}


def resolve(name):
    d = cached_path(name) or fetch_material(name)
    if d:
        src = 'network/cache'
    else:
        d = FALLBACK[name]
        src = 'builtin-canonical'
    print('  source %s: %s' % (name, src))
    return d


if __name__ == '__main__':
    print('T4.5 Material bake:')
    # 1) 顶栏返回（两页自定义导航，onSurface 墨/深墨双态）
    arrow = resolve('arrow_back')
    write_svg('arrow-back-ink.svg', '#1c1917', arrow)
    write_svg('arrow-back-dark.svg', '#e8e3d9', arrow)
    # 2) 已达标徽章深色态（浅色已有 check-circle.svg #1f7a5c）
    write_svg('check-circle-primary-dark.svg', '#4da989', cached_path('check_circle'))
    # 3) 底部实底按钮右箭头（onPrimary 白）
    write_svg('keyboard-arrow-right-white.svg', '#ffffff', cached_path('keyboard_arrow_right'))
    # 4) 评测卡「最近得分」按钮（Material leaderboard，primary）
    write_svg('leaderboard-primary.svg', '#1f7a5c', resolve('leaderboard'))
    # 5) 达人榜前三金银铜（emoji_events / military tech 原 path 换色；
    #    连同源 viewBox 一起复用——military_tech 是 0 -960 960 960 网格）
    emoji_d, emoji_vb = asset_path('emoji-events-secondary.svg')
    write_svg('emoji-events-gold.svg', '#EAB308', emoji_d, emoji_vb)   # RankGold
    mil_d, mil_vb = asset_path('military-tech-info.svg')
    write_svg('military-tech-silver.svg', '#9CA3AF', mil_d, mil_vb)    # RankSilver
    write_svg('military-tech-bronze.svg', '#D97706', mil_d, mil_vb)    # RankBronze
    # 6) 闯关配额胶囊 + 试用结算「下一关·解锁 PRO」按钮（Web lucide Crown 的
    #    Material 语义等价物 = workspace_premium；图标政策一律 Material）
    wp = resolve('workspace_premium')
    write_svg('workspace-premium-amber.svg', '#D97706', wp)        # 胶囊预警态（amber-600）
    write_svg('workspace-premium-amber-dark.svg', '#FBBF24', wp)   # 深色（amber-400）
    write_svg('workspace-premium-white.svg', '#ffffff', wp)        # PRO 实底按钮
    print('done.')
    sys.exit(0)
