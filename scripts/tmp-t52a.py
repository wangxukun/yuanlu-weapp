# -*- coding: utf-8 -*-
import io, sys

# sentence-notebook 出处胶囊 → by-clip 解析 sceneId 直达微剧场（回落剧集模式）
p = "components/review/sentence-notebook/index.js"
with io.open(p, "r", encoding="utf-8", newline="") as f: s = f.read()
old = """    /** meta 出处胶囊 → 原声精研页（原剧集详情页已随整集链路退役，改道精研） */
    onEpisodeTap(e) {
      const id = e.currentTarget.dataset.episodeid;
      if (id) wx.navigateTo({ url: '/pages/intensive-listening/index?id=' + id });
    },"""
new = """    /**
     * meta 出处胶囊 → 微剧场精研室（T5.2）：by-clip 反查包含该句的微剧场，
     * 命中即 ?sceneId= 直达（30 秒语境）；未收录回落剧集模式精研页。
     */
    onEpisodeTap(e) {
      const ds = e.currentTarget.dataset;
      const id = ds.episodeid;
      if (!id) return;
      const subId = ds.subtitleid != null ? Number(ds.subtitleid) : null;
      const params = ['episodeid=' + encodeURIComponent(id)];
      if (Number.isInteger(subId)) params.push('subtitleId=' + subId);
      get('/api/scenes/by-clip?' + params.join('&'), null, { showError: false })
        .then((body) => {
          if (body && body.success && body.data && body.data.sceneid) {
            wx.navigateTo({ url: '/pages/intensive-listening/index?sceneId=' + body.data.sceneid });
          } else {
            wx.navigateTo({ url: '/pages/intensive-listening/index?id=' + id });
          }
        })
        .catch(() => {
          wx.navigateTo({ url: '/pages/intensive-listening/index?id=' + id });
        });
    },"""
assert old in s
s = s.replace(old, new, 1)
# ensure get imported
if "require('../../utils/request')" not in s and "utils/request" not in s:
    anchor = "const audioClip = require('../../utils/audio-clip');"
    assert anchor in s
    s = s.replace(anchor, anchor + "\nconst { get } = require('../../utils/request');", 1)
with io.open(p, "w", encoding="utf-8", newline="") as f: f.write(s)
print("sentence-notebook ok")
