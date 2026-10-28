# -*- coding: utf-8 -*-
import io
p = "scripts/test-intensive-listening.js"
with io.open(p, "r", encoding="utf-8", newline="") as f: s = f.read()
crlf = "\r\n" in s
s = s.replace("\r\n", "\n")

anchor = "console.log('✅ 全部通过：' + passed + ' 断言');"
assert anchor in s, "summary anchor"

section = r"""
/* ==================== 八、微剧场模式 + 连读显微镜（T4.1） ==================== */

section('微剧场精研室：sceneId 模式 / timeBase 对齐 / 显微镜 / 词块坞');

// 场景夹具：3 句（句 100-108 含 kind/of 连读块），切片起点 99.75
const SCENE_SUBS = [
  { subtitleId: 1, start: 100, end: 104, textEn: 'I kind of wanted to ask.', textCn: '我有点想问。',
    words: [
      { word: 'I', start: 100.1, end: 100.25 },
      { word: 'kind', start: 100.3, end: 100.38 },
      { word: 'of', start: 100.39, end: 100.45 },
      { word: 'wanted', start: 100.6, end: 101.2 },
      { word: 'to', start: 101.3, end: 101.38 },
      { word: 'ask.', start: 101.5, end: 101.9 },
    ] },
  { subtitleId: 2, start: 104, end: 108, textEn: 'She said yes again.', textCn: '她又答应了。',
    words: [
      { word: 'She', start: 104.1, end: 104.4 },
      { word: 'said', start: 104.5, end: 104.8 },
      { word: 'yes', start: 104.9, end: 105.2 },
      { word: 'again.', start: 105.4, end: 105.9 },
    ] },
  { subtitleId: 3, start: 108, end: 112, textEn: 'That was the whole plan then.', textCn: '当时整个计划就是这样。',
    words: [
      { word: 'That', start: 108.1, end: 108.5 },
      { word: 'was', start: 108.6, end: 108.9 },
      { word: 'the', start: 109.0, end: 109.08 },
      { word: 'whole', start: 109.2, end: 109.7 },
      { word: 'plan', start: 109.8, end: 110.3 },
      { word: 'then.', start: 110.4, end: 110.8 },
    ] },
];
const SCENE_DTO = {
  success: true,
  data: {
    scene: {
      sceneid: 's1', episodeid: 'epS', title: '例会上的延期', summaryZh: '推进与退让',
      situationTag: '职场', cefrLevel: 'B2', coverUrl: 'https://oss/cvS.jpg',
      startTime: 100, endTime: 112, duration: 12, clips: SCENE_SUBS,
      deepDive: {
        vocabulary: [{ word: 'ask', phonetic: '/ɑːsk/', meaning: '问', reason: '' }],
        sentences: [{ text: 'She said yes again.', analysis: '过去时叙事' }],
        quiz: [{ question: 'Which word is fast-linked?', options: ['kind', 'plan'], answerIndex: 0, explanation: 'kind of 连读' }],
      },
    },
    clipAudioUrl: 'https://oss/clips/s1.mp3',
    clipOffset: 99.75,
    clipDuration: 12.6,
  },
};

resetMock();
routeHandler = (p2) => {
  if (p2 === '/api/scenes/s1') return { statusCode: 200, data: SCENE_DTO };
  if (p2 === '/api/sentences/keys') return { statusCode: 200, data: { success: true, data: { subtitleIds: [], allTags: [] } } };
  if (p2 === '/api/vocabulary/words') return { statusCode: 200, data: { success: true, data: [] } };
  return { statusCode: 200, data: { success: true } };
};
{
  const sp = makePage();
  sp.onLoad({ sceneId: 's1' });
  await tick(); await tick(); await tick(); await tick();
  assert(sp.data.isSceneMode === true && sp.data.isLoading === false, 'sceneId 进页 → 微剧场模式就绪');
  assert(!requestCalls.some((c) => c.path.indexOf('/api/episode/') !== -1), '零整集请求（subtitles/detail 均不触发，红线 2 终态）');
  assert(sp.data.scene && sp.data.scene.title === '例会上的延期' && sp.data.scene.episodeid === 'epS', '画报头卡数据（标题/出处）');
  assert(sp.data.insight && sp.data.insight.quiz.length === 1, '精析视图预处理（quiz 就位）');
  assert(Math.abs(sp._timeBase - 99.75) < 1e-9, 'timeBase = clipOffset（切片在原时间轴的起点）');
  const sctx = lastCtx();
  assert(sctx.src === 'https://oss/clips/s1.mp3', '音频 = 物理切片直链（缓存命中免二次拉取）');

  // 连读词块标记：kind/of 80ms/60ms 功能词 → fl；句 3 the 80ms → fl
  const v0 = sp.data.viewList[0];
  assert(v0.words[1].fl === true && v0.words[2].fl === true && v0.words[1].flHead === true, '⚡连读块标记：kind/of 入块（flHead=块首）');
  assert(v0.words[3].fl === false, '实词 wanted 不标');

  // timeBase 对齐：本地 1.2s + 99.75 = 绝对 100.95 → 句 0 内
  kickPlay(sp);
  playbackAt(1.2);
  await tick();
  assert(sp.data.activeIndex === 0, '扫光用绝对时间轴（本地 1.2s → 句 0）');
  playbackAt(5.5);
  await tick();
  assert(sp.data.activeIndex === 1, '本地 5.5s → 绝对 105.25 → 句 1（切片偏移对齐）');

  // 跳句重锚换算：点句 2（绝对 108）→ 本地 8.25
  const playsJump = playCount();
  sp.onCardTap({ currentTarget: { dataset: { index: 2 } } });
  await tick();
  assert(Math.abs(lastStart() - (108 - 99.75)) < 1e-6, '点句跳播换算切片本地秒（108-99.75=8.25）');

  // 倍速：0.75 重锚
  sp.onRatePick({ currentTarget: { dataset: { rate: '0.75' } } });
  assert(sp._rate === 0.75 && sp.data.rateLabel === '0.75x', '倍速切换 0.75x（重锚续播）');

  // —— 显微镜：词块选区 + 点读坞 ——
  sp.onToggleLinkRead();
  assert(sp.data.linkRead === true && storageSets.some((x) => x.key === 'intensiveLinkRead' && x.value === true), '显微镜开关 + 偏好落盘');
  sp.onWordTap({ currentTarget: { dataset: { index: 0, wi: 1 } } }); // kind 首点
  assert(sp.data.phrase && sp.data.phrase.pending === true, '首点 pending（提示再点尾词）');
  sp.onWordTap({ currentTarget: { dataset: { index: 0, wi: 3 } } }); // wanted 尾点（跨度 3 词）
  const ph = sp.data.phrase;
  assert(ph && ph.pending === false && ph.startWi === 1 && ph.endWi === 3 && ph.text === 'kind of wanted',
    '次点定界：kind of wanted（顺序归一）');
  const mainStops = sp._player.getKind() === null, '占位';
}
{
  // 词块坞：慢镜/三连放走独立播放器（窗口=词块本地秒）；主播放器互停
  const sp2 = (() => { const x = makePage(); return x; })();
  // 复用上一段页面驱动成本高——直接驱动内部状态构造选区
  // （构造：scene 模式已含 _views[0] 的词级时间戳）
  resetMock();
  routeHandler = (p2) => {
    if (p2 === '/api/scenes/s1') return { statusCode: 200, data: SCENE_DTO };
    return { statusCode: 200, data: { success: true } };
  };
  sp2.onLoad({ sceneId: 's1' });
  await tick(); await tick(); await tick();
  sp2.setData({ linkRead: true });
  sp2._selAnchor = { index: 0, wi: 1 };
  sp2._onWordSelect({ index: 0, wi: 2 }); // kind of
  assert(sp2.data.phrase && sp2.data.phrase.text === 'kind of' && !sp2.data.phrase.pending, '选区 kind of 定界');
  kickPlay(sp2); // 主播放器在播
  const before = playCount();
  sp2.onPhrasePlay({ currentTarget: { dataset: { mode: 'triple' } } });
  const pctx = lastCtx();
  assert(playCount() === before + 1 && pctx.src === 'https://oss/clips/s1.mp3', '三连放第 1 段起播（独立 ctx）');
  assert(Math.abs((pctx.startTimeVal || 0) - (100.3 - 99.75)) < 1e-6, '词块窗口换算本地秒（100.3-99.75）');
  assert(sp2._player.getKind() === null, '主播放器被互停');
  pctx._h.ended && pctx._h.ended(); // 第 1 段播完 → 推进 0.75 段
  const pctx2 = lastCtx();
  assert(pctx2 !== pctx && pctx2.rateVal === 0.75, '三连放推进：第 2 段 0.75x 慢镜');
  pctx2._h.ended && pctx2._h.ended();
  const pctx3 = lastCtx();
  assert(pctx3 !== pctx2 && pctx3.rateVal === 1, '三连放收尾：第 3 段回原速');
  pctx3._h.ended && pctx3._h.ended();
  assert(sp2.data.phrasePlaying === '' && sp2._phraseSeq === null, '三连放完成清序列');

  // 同词再点取消选区
  sp2._selAnchor = { index: 0, wi: 1 };
  sp2._onWordSelect({ index: 0, wi: 1 });
  assert(sp2.data.phrase === null, '同词再点 → 取消选区收坞');

  // 小测作答锁定
  sp2.onQuizPick({ currentTarget: { dataset: { q: 0, o: 1 } } });
  assert(sp2.data.quizPick[0] === 1, '随堂小测作答记录');
  sp2.onQuizPick({ currentTarget: { dataset: { q: 0, o: 0 } } });
  assert(sp2.data.quizPick[0] === 1, '已作答锁定（不覆盖）');

  // WXML 结构红线
  const WXML = fs.readFileSync(path.join(__dirname, '../pages/intensive-listening/index.wxml'), 'utf8');
  assert(WXML.indexOf('il-hero') >= 0 && WXML.indexOf('onRatePick') >= 0, 'WXML：画报头卡 + 倍速切换');
  assert(WXML.indexOf('onToggleLinkRead') >= 0 && WXML.indexOf('w-flash-mark') >= 0, 'WXML：显微镜开关 + ⚡块首标');
  assert(WXML.indexOf("data-mode=\\"triple\\"") >= 0 && WXML.indexOf('il-dock') >= 0, 'WXML：词块点读坞（三连放）');
  assert(WXML.indexOf('🔍 精析') >= 0 && WXML.indexOf('ai-deep-dive') >= 0, 'WXML：三 Tab + 剧集模式内嵌精析组件');
}

"""
# 修正上面误留的一行占位语法错误：删除 "  const mainStops = ..." 行
bad = "  const mainStops = sp._player.getKind() === null, '占位';\n"
assert bad in section
section = section.replace(bad, "")

s = s.replace(anchor, section + "\n" + anchor, 1)
if crlf:
    s = s.replace("\n", "\r\n")
with io.open(p, "w", encoding="utf-8", newline="") as f: f.write(s)
print("section-8 added")
