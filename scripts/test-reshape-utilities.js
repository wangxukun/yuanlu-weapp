/**
 * scripts/test-reshape-utilities.js — 阶段 5 新增工具纯函数直测（T6.2）
 *
 * 覆盖：
 *   A. speech-core 新增 AB 函数（parseSceneData/buildAbPairs/computeWpmMatch/blindHints）
 *   B. utils/scene-favorites 本地收藏夹（toggle/has/remove/上限淘汰）
 *   C. utils/study-footprint 精研足迹（record 去重置顶/clearAll）
 * 运行：node scripts/test-reshape-utilities.js
 */
const path = require('path');

const storage = new Map();
global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
};

const core = require(path.join(__dirname, '../utils/speech-core.js'));
const sceneFavorites = require(path.join(__dirname, '../utils/scene-favorites.js'));
const footprint = require(path.join(__dirname, '../utils/study-footprint.js'));

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else {
    console.error('FAIL:', msg);
    failed++;
  }
}
const near = (a, b) => Math.abs(a - b) < 1e-6;

console.log('━━━ A. speech-core AB 函数（T5.1） ━━━');
{
  // parseSceneData：字幕/词级时间戳按 clipOffset 归一
  const body = {
    data: {
      scene: {
        title: '微剧场', startTime: 100, endTime: 112,
        clips: [
          { subtitleId: 1, start: 100, end: 104, textEn: 'I kind of wanted to ask.', textCn: '我有点想问。',
            words: [{ word: 'I', start: 100.1, end: 100.25 }] },
          { subtitleId: 2, start: 104, end: 108, textEn: 'She said yes.', textCn: '她答应了。', words: [] },
        ],
      },
      clipAudioUrl: 'https://oss/clips/s1.mp3',
      clipOffset: 99.75,
    },
  };
  const r = core.parseSceneData(body);
  ok(r.audioUrl === 'https://oss/clips/s1.mp3' && r.episodeTitle === '微剧场', 'A parseSceneData：标题+直链');
  ok(near(r.subtitles[0].start, 0.25) && near(r.subtitles[0].end, 4.25), 'A 字幕窗口归一（100→0.25 / 104→4.25）');
  ok(near(r.subtitles[0].words[0].start, 100.1 - 99.75), 'A 词级时间戳归一');
  ok(r.absWindows[0].start === 100 && r.absWindows[0].end === 104, 'A absWindows 保留剧集绝对秒（AB A 句播放用）');
  ok(r.isTrialMode === false && r.records.length === 0, 'A 微剧场无试用墙/无历史');

  // buildAbPairs
  const pairs = core.buildAbPairs(r.subtitles, r.absWindows);
  ok(pairs.length === 1 && pairs[0].aIdx === 0 && pairs[0].bIdx === 1, 'A buildAbPairs：1 对（3 句 → 2 对，此处 2 句 → 1 对）');
  ok(pairs[0].bNativeWpm > 0 && pairs[0].bWindowSec > 0, 'A B 句母语语速+窗口秒');

  // computeWpmMatch：对称惩罚
  ok(core.computeWpmMatch(4, 120, 8) === 100, 'A 吻合度 100%（同速）');
  ok(core.computeWpmMatch(8, 120, 8) === 50, 'A 吻合度 50%（2 倍慢）');
  ok(core.computeWpmMatch(2, 120, 8) === 50, 'A 吻合度 50%（2 倍快）');
  ok(core.computeWpmMatch(0.1, 120, 8) === 0, 'A 吻合度 0%（时长过短防御）');

  // blindHints
  ok(JSON.stringify(core.blindHints('I kind of wanted to ask about it', 2)) === JSON.stringify(['kind', 'wanted']),
    'A blindHints：前 2 个实词');
  ok(JSON.stringify(core.blindHints('The a of to and', 3)) === JSON.stringify([]),
    'A blindHints：全虚词 → 空');
  ok(JSON.stringify(core.blindHints('', 3)) === JSON.stringify([]), 'A blindHints：空串防御');
}

console.log('━━━ B. scene-favorites 本地收藏夹 ━━━');
{
  storage.clear();
  ok(sceneFavorites.list().length === 0 && sceneFavorites.has('x') === false, 'B 初始空态');

  const on1 = sceneFavorites.toggle({ sceneid: 's1', title: 'A', en: 'en-a' });
  ok(on1 === true && sceneFavorites.has('s1') === true, 'B 首次 toggle → true（收藏）');
  const off1 = sceneFavorites.toggle({ sceneid: 's1' });
  ok(off1 === false && sceneFavorites.has('s1') === false, 'B 再次 toggle → false（取消）');

  sceneFavorites.toggle({ sceneid: 'a' });
  sceneFavorites.toggle({ sceneid: 'b' });
  ok(sceneFavorites.list().length === 2 && sceneFavorites.list()[0].sceneid === 'b', 'B 最新在前（unshift）');

  sceneFavorites.remove('a');
  ok(sceneFavorites.list().length === 1 && sceneFavorites.list()[0].sceneid === 'b', 'B remove 生效');
}

console.log('━━━ C. study-footprint 精研足迹 ━━━');
{
  storage.clear();
  ok(footprint.list().length === 0, 'C 初始空态');

  footprint.record({ sceneid: 's1', title: 'T1', duration: 28 });
  footprint.record({ sceneid: 's2', title: 'T2', duration: 33 });
  ok(footprint.list().length === 2 && footprint.list()[0].sceneid === 's2', 'C 记录两条（最新在前）');

  footprint.record({ sceneid: 's1', title: 'T1-revisit', duration: 28 });
  ok(footprint.list().length === 2 && footprint.list()[0].sceneid === 's1' && footprint.list()[0].title === 'T1-revisit',
    'C 同 sceneid 去重置顶（不涨总数，更新标题）');

  footprint.clearAll();
  ok(footprint.list().length === 0, 'C clearAll 清空');

  footprint.record(null);
  ok(footprint.list().length === 0, 'C null 记录防御');
}

console.log('----------------------------------------');
if (failed === 0) {
  console.log('ALL RESHAPE UTILITY TESTS PASSED');
} else {
  console.error(failed + ' TEST(S) FAILED');
  process.exitCode = 1;
}
