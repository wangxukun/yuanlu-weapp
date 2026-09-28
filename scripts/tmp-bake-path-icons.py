# -*- coding: utf-8 -*-
"""scripts/tmp-bake-path-icons.py — 学习路径模块 Material 图标烘焙（一次性）

按 Android-Meterial.md 第七节规范：源 = Google 官方 materialicons 24px.svg，
保留源 viewBox，重 emit 为 <path fill="指定色">，过滤全幅矩形 bounding 底路径。
产出 10 个 SVG（学习路径列表/详情页所需）。
"""
import io
import os
import re
import urllib.request

OUT = r"D:\WebstormProjects\yuanlu-weapp\assets\icons"
PROXIES = [
    None,  # 直连优先
    {"http": "http://127.0.0.1:7891", "https": "http://127.0.0.1:7891"},  # Clash 兜底
]

# (material 名, 版本候选, 着色, 输出文件名)
JOBS = [
    ("auto_awesome", [7], "#ffffff", "auto-awesome-white.svg"),
    ("auto_awesome", [7], "#d97706", "auto-awesome-amber.svg"),
    ("public", [1], "#ffffff", "public-white.svg"),
    ("map", [1], "#ffffff", "map-white.svg"),
    ("playlist_add", [1], "#655d4c", "playlist-add-onsurface.svg"),
    ("playlist_add", [1], "#a8a29e", "playlist-add-onsurface-dark.svg"),
    ("more_horiz", [1], "#655d4c", "more-horiz-onsurface.svg"),
    ("more_horiz", [1], "#a8a29e", "more-horiz-onsurface-dark.svg"),
    ("play_circle", [1, 2, 3, 4, 5], "#ffffff", "play-circle-white.svg"),
    ("add", [1], "#ffffff", "add-white.svg"),
    ("shuffle", [1], "#655d4c", "shuffle-onsurface.svg"),
    ("shuffle", [1], "#a8a29e", "shuffle-onsurface-dark.svg"),
]


def fetch(url):
    last = None
    for proxy in PROXIES:
        try:
            handlers = []
            if proxy:
                handlers.append(
                    urllib.request.ProxyHandler({"http": proxy["http"], "https": proxy["https"]})
                )
            opener = urllib.request.build_opener(*handlers) if handlers else urllib.request.build_opener()
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with opener.open(req, timeout=15) as resp:
                return resp.read().decode("utf-8")
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def is_full_rect(d):
    """全幅矩形 bounding 底（M0 0h24v24H0z / H-24z / H0V0z 等变体）：漏滤会渲染成实心方块"""
    s = re.sub(r"\s+", "", d).lower()
    return (
        s in ("m00h24v24h0z", "m00h24v24h-24z", "m00h24v24h0v0z")
        or s.endswith("h0v0z")
    )


def bake(name, versions, fill, outfile):
    for v in versions:
        url = "https://fonts.gstatic.com/s/i/materialicons/%s/v%d/24px.svg" % (name, v)
        try:
            svg = fetch(url)
        except Exception as e:  # noqa: BLE001
            print("  miss %s v%d (%s)" % (name, v, e))
            continue
        paths = re.findall(r'<path[^>]*\bd="([^"]+)"', svg)
        kept = [d for d in paths if not is_full_rect(d)]
        if not kept:
            raise SystemExit("no glyph paths in %s v%d" % (name, v))
        m = re.search(r'viewBox="([^"]+)"', svg)
        viewbox = m.group(1) if m else "0 0 24 24"
        body = "".join('<path fill="%s" d="%s"/>' % (fill, d) for d in kept)
        out = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="%s">%s</svg>' % (
            viewbox,
            body,
        )
        with io.open(os.path.join(OUT, outfile), "w", encoding="utf-8", newline="\n") as f:
            f.write(out)
        print("  ok %-28s <- %s v%d (%d paths)" % (outfile, name, v, len(kept)))
        return
    raise SystemExit("all versions missed for %s" % name)


if __name__ == "__main__":
    for job in JOBS:
        bake(*job)
    print("done")
