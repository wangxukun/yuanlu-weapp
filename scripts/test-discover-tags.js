/**
 * test-discover-tags — 原声微流页（第二 Tab，2026-11-15 自 yl-weapp A工程 完整迁移，
 * 替换退役的「专项特训」三段式页面）
 *
 * 断言：tabBar 标签/图标、页面标题、竖滑 swiper 切片流骨架、DIY 下拉刷新、
 * 环形游标与已看去重模块挂载、外链图片零依赖（本地资产）、合规字样零残留、
 * 零旧特训页残留。运行时行为由 test-reels-session.cjs 覆盖。
 */
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../', rel), 'utf8');

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { console.error('FAIL:', msg); failed++; }
}

// —— 场景 A：tabBar（app.json） ——
const app = JSON.parse(read('app.json'));
const tab = app.tabBar.list.find((t) => t.pagePath === 'pages/discover/index');
assert(!!tab && tab.text === '原声微流', 'A tabBar 文案「原声微流」');
assert(tab.iconPath === 'assets/icons/reels.png' && tab.selectedIconPath === 'assets/icons/reels-active.png',
  'A tabBar 图标换 reels 双态');
assert(fs.existsSync(path.join(__dirname, '../assets/icons/reels.png')) &&
  fs.existsSync(path.join(__dirname, '../assets/icons/reels-active.png')), 'A reels 图标资产存在');

// —— 场景 B：页面契约 ——
const json = JSON.parse(read('pages/discover/index.json'));
assert(json.navigationBarTitleText === '原声微流', 'B 页面标题「原声微流」');
assert(!!json.usingComponents && !!json.usingComponents['vocabulary-modal'] &&
  !!json.usingComponents['sentence-tag-drawer'] &&
  !!json.usingComponents['premium-modal'], 'B 组件注册（词卡/标签抽屉/会员弹窗）');

// —— 场景 C：微流骨架（竖滑 swiper + DIY 下拉 + 游标去重） ——
const wxml = read('pages/discover/index.wxml');
const wxss = read('pages/discover/index.wxss');
const js = read('pages/discover/index.js');
assert(wxml.includes('<swiper') && wxml.includes('vertical'), 'C 竖滑 swiper 切片流');
assert(wxml.includes('rl-pull-hint') && wxml.includes('onPullTouchStart'), 'C DIY 下拉刷新提示条与手势');
assert(wxml.includes('<sentence-tag-drawer') && wxml.includes('drawerSentence') && wxml.includes('drawerLocal'),
  'C 挂载 sentence-tag-drawer 并绑定 drawerSentence 与 drawerLocal');
assert(js.includes("require('./reels-session')"), 'C 环形游标会话模块挂载');
assert(js.includes('PAGE_SIZE_CAP') && js.includes('PRELOAD_MARGIN'), 'C 渲染封顶与预取边界常量');
assert(fs.existsSync(path.join(__dirname, '../pages/discover/reels-session.js')), 'C reels-session 模块存在');
assert(fs.existsSync(path.join(__dirname, '../pages/discover/reels-corpus.js')), 'C 本地语料兜底存在');

// —— 场景 D：合规与外链 ——
['播客', '智能', '社区', '大模型'].forEach((w) => {
  assert(!js.includes(w) && !wxml.includes(w) && !json.navigationBarTitleText.includes(w),
    'D 零「' + w + '」字眼');
});
assert(!/\bpodcast\b/i.test(js) && !/\bpodcast\b/i.test(wxml) && !js.includes('podcastTitle'),
  'D 零英文 podcast 标识');
assert(!/\bAI\b/.test(js) && !/\bAI\b/.test(wxml), 'D 零「AI」字眼');
assert(!js.includes('images.unsplash.com') && !wxml.includes('images.unsplash.com') &&
  !read('pages/discover/reels-corpus.js').includes('images.unsplash.com'),
  'D 零 unsplash 外链（封面/头像已本地化）');
assert(fs.existsSync(path.join(__dirname, '../assets/covers')), 'D 本地封面资产目录存在');

// —— 场景 E：零旧特训页残留 ——
['发音急救箱', '语境卡册', '今日微剧场听写', 'learning-paths/mine', 'speech/notebook',
  'mode=dictate', 'layers'].forEach((w) => {
  assert(!js.includes(w) && !wxml.includes(w) && !wxss.includes('layers'),
    'E 零旧特训残留「' + w + '」');
});

// —— 场景 F：P0 6 个 Bug + P1-F1 回归验证 ——
(function runRegressionTests() {
  const vm = require('node:vm');
  const corpus = require('../pages/discover/reels-corpus.js');

  function setByPath(obj, k, v) {
    if (!k.includes('.')) {
      obj[k] = v;
      return;
    }
    const parts = k.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }

  let getHandler = () => Promise.resolve(null);
  let postHandler = () => Promise.resolve(null);
  let deepDiveHandler = () => Promise.resolve(null);
  let timers = [];
  const storageMap = {};

  const mockWx = {
    getStorageSync: (k) => storageMap[k],
    setStorageSync: (k, v) => {
      storageMap[k] = JSON.parse(JSON.stringify(v));
    },
    showToast: () => {},
    showModal: () => {},
    navigateTo: () => {},
  };

  const mockRequest = {
    get: (url, data, opts) => getHandler(url, data, opts),
    post: (url, data, opts) => postHandler(url, data, opts),
  };

  // Load reels-api.js in VM
  const apiMod = { exports: {} };
  vm.runInNewContext(read('pages/discover/reels-api.js'), {
    module: apiMod,
    exports: apiMod.exports,
    require: (id) => {
      if (id === '../../utils/request') return mockRequest;
      if (id === './reels-corpus') return corpus;
      return {};
    },
    Promise,
    Number,
    Array,
    Object,
    String,
    encodeURIComponent,
  });
  const reelsApi = apiMod.exports;

  // B4: fromLocalClip 保留 phoneticTip
  const localItems = reelsApi.localReels();
  assert(
    localItems.length > 0 && localItems.every((it) => typeof it.phoneticTip === 'string' && it.phoneticTip.length > 0),
    'F-B4 本地兜底语料保留 phoneticTip 字段'
  );

  // B5: 无词级时间戳时按空格切分 tokens，F4: 后端 phoneticTip 为空时自动生成常驻发音机密
  const untimedClip = reelsApi.fromFeedItem({
    clipid: 'c-untimed',
    episodeid: 'ep-1',
    subtitleId: 10,
    textEn: 'Hello, world! How are you?',
    textCn: '你好，世界！',
    words: [],
    phoneticTip: null,
  });
  assert(
    Array.isArray(untimedClip.tokens) &&
      untimedClip.tokens.join('|') === 'Hello,|world!|How|are|you?',
    'F-B5 无词级时间戳时生成按空格切分的 tokens'
  );
  assert(
    typeof untimedClip.phoneticTip === 'string' && untimedClip.phoneticTip.length > 0,
    'F4 后端 phoneticTip 为 null 时前端自动生成常驻发音机密文案'
  );
  assert(
    wxml.includes('rl-tip-label') && wxml.includes('发音机密'),
    'F4 WXML 发音机密琥珀胶囊包含「发音机密」常驻标题'
  );
  assert(
    wxml.includes('corpus-examples="{{wordModal.corpusExamples}}"'),
    'F3 WXML vocabulary-modal 绑定 corpus-examples'
  );
  assert(wxml.includes('reel.tokens') && wxml.includes('data-word="{{tok}}"'), 'F-B5 WXML 渲染 tokens 并绑定单字 data-word');

  // Load sentence-tag-drawer/index.js in VM to verify local mode
  let drawerCompDef = null;
  vm.runInNewContext(read('components/sentence-tag-drawer/index.js'), {
    Component: (def) => {
      drawerCompDef = def;
    },
    require: (id) => {
      if (id === '../../utils/request') return mockRequest;
      return {};
    },
    wx: mockWx,
    Promise,
    Array,
    Object,
    String,
  });
  assert(
    !!drawerCompDef && !!drawerCompDef.properties.local,
    'F1 sentence-tag-drawer 支持 local 属性'
  );

  const speechCore = require('../utils/speech-core.js');
  const dictTool = require('../utils/dict-tool.js');

  let recState = { recording: false };
  let recStartResult = true;
  let recStopResult = { base64: 'UklGRg==', wavPath: 'wxfile://usr/rec.wav', bytes: 6400 };
  let recCancelCount = 0;

  const mockRecorder = {
    PCM_RATE: 16000,
    getState: () => recState,
    start: () => {
      if (!recStartResult) return Promise.resolve(false);
      recState.recording = true;
      return Promise.resolve(true);
    },
    stop: () => {
      recState.recording = false;
      return Promise.resolve(recStopResult);
    },
    cancel: () => {
      recState.recording = false;
      recCancelCount += 1;
    },
  };

  let isLoggedIn = true;
  let playStopCount = 0;
  let playStartCount = 0;
  let lastPlayStartSec = 0;

  // Load pages/discover/index.js in VM to test Page methods
  let pageDef = null;
  let playerHooks = null;
  vm.runInNewContext(js, {
    Page: (def) => {
      pageDef = def;
    },
    require: (id) => {
      if (id === '../../utils/theme') {
        return {
          rootClass: () => 'theme-light',
          getEffective: () => 'light',
          applyChrome: () => {},
          setMode: () => {},
        };
      }
      if (id === '../../store/authStore') {
        return { getState: () => ({ isLoggedIn }) };
      }
      if (id === '../../utils/request') return mockRequest;
      if (id === '../../utils/recorder') return mockRecorder;
      if (id === '../../utils/speech-core') return speechCore;
      if (id === '../../utils/dict-tool') return dictTool;
      if (id === '../../utils/clip-player') {
        return {
          createClipPlayer: (hooks) => {
            playerHooks = hooks;
            return {
              playUrl: (_url, kind, opts) => {
                playStartCount += 1;
                lastPlayStartSec = opts && typeof opts.startSec === 'number' ? opts.startSec : 0;
                if (playerHooks && playerHooks.onPlaying) playerHooks.onPlaying(kind || 'reel');
              },
              stop: () => {
                playStopCount += 1;
                if (playerHooks && playerHooks.onPlaying) playerHooks.onPlaying(null);
              },
              estimatedPos: () => 1.2,
            };
          },
        };
      }
      if (id === '../../utils/clip-window') {
        return {
          sentenceWindow: (clip, offset) => ({
            offset: offset || 0,
            winStart: 0,
            winEnd: (clip.end || 5) - (clip.start || 0),
          }),
        };
      }
      if (id === './reels-api') {
        return Object.assign({}, reelsApi, {
          fetchFeed: () => Promise.resolve(null),
          fetchDeepDive: (s) => deepDiveHandler(s),
        });
      }
      if (id === './reels-session') {
        return {
          subject: () => 'user:u1',
          loadSession: () => ({ v: 1, cursor: '00000000', lap: 0, seen: [] }),
          saveSession: () => {},
          recordSeen: () => {},
          filterAndFallback: (_s, pool) => ({ items: pool, softFallbackUsed: false }),
          clipSeenKey: (it) => it.id,
        };
      }
      return {};
    },
    wx: mockWx,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
    Error,
    Promise,
    Date,
    Math,
    Array,
    Number,
    Object,
    String,
    Set,
    encodeURIComponent,
  });

  const ctx = Object.assign({}, pageDef, {
    data: JSON.parse(JSON.stringify(pageDef.data)),
    setData(patch) {
      Object.keys(patch).forEach((k) => setByPath(this.data, k, patch[k]));
    },
  });
  ctx.onLoad();

  // Setup two test clips in the same episode + one sandbox clip
  const clip0 = {
    id: 'clip-0',
    episodeid: 'ep-100',
    subtitleId: 1,
    showTitle: 'Test Show',
    start: 10,
    end: 15,
    textEn: 'First sentence here.',
    textCn: '第一句。',
    words: [
      { word: 'First', start: 10.0, end: 10.4 },
      { word: 'sentence', start: 10.8, end: 11.3 },
      { word: 'here.', start: 11.6, end: 12.0 },
    ],
    tokens: [],
    clipAudioUrl: 'https://example.com/a.mp3',
    audioOffset: 10,
    real: true,
  };
  const clip1 = {
    id: 'clip-1',
    episodeid: 'ep-100',
    subtitleId: 2,
    showTitle: 'Test Show',
    start: 20,
    end: 25,
    textEn: 'Second sentence, untimed!',
    textCn: '第二句。',
    words: [],
    tokens: ['Second', 'sentence,', 'untimed!'],
    clipAudioUrl: 'https://example.com/b.mp3',
    audioOffset: 20,
    real: true,
  };
  const clipLocal = {
    id: 'local-1',
    episodeid: '',
    subtitleId: null,
    showTitle: 'Sandbox Show',
    topic: '日常会话',
    start: 0,
    end: 4,
    textEn: 'Sandbox local sentence.',
    textCn: '沙箱本地句子。',
    words: [],
    tokens: ['Sandbox', 'local', 'sentence.'],
    clipAudioUrl: 'https://example.com/c.mp3',
    audioOffset: 0,
    real: false,
  };
  Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => Promise.resolve())
    .then(() => {
      ctx._reels = [clip0, clip1, clipLocal];
      ctx._applyClip(0, { autoplay: false });
      ctx._audioMeta = { url: clip0.clipAudioUrl, offset: 10, winStart: 0, winEnd: 5 };

      // B1: 词间间隙不闪回原色
      ctx._onTick(0.2); // 在 'First' [0, 0.4) 内
      assert(ctx.data.activeWordIndex === 0 && ctx.data.pastWordIndex === -1, 'F-B1 首词朗读中 active=0, past=-1');
      ctx._onTick(0.6); // 在 'First' 与 'sentence' 之间的间隙 [0.4, 0.8)
      assert(ctx.data.activeWordIndex === -1 && ctx.data.pastWordIndex === 0, 'F-B1 词间间隙 active=-1 但 past=0 保持已读绿词不闪回');
      ctx._onTick(1.0); // 在 'sentence' [0.8, 1.3) 内
      assert(ctx.data.activeWordIndex === 1 && ctx.data.pastWordIndex === 0, 'F-B1 第二词朗读中 active=1, past=0');
      ctx._onTick(1.45); // 在第二词与第三词间隙 [1.3, 1.6)
      assert(ctx.data.activeWordIndex === -1 && ctx.data.pastWordIndex === 1, 'F-B1 第二间隙 past=1 保持前两词绿色');
      assert(wxml.includes('pastWordIndex >= wi'), 'F-B1 WXML 使用 pastWordIndex >= wi 判定已读态');

      // B5 & F3: 点词查词仅查该词，且将当前切片 textEn/textCn 组装为 corpusExamples（命中词 hl=true）注入弹窗
      let queriedDictUrl = '';
      getHandler = (url) => {
        queriedDictUrl = url;
        return Promise.resolve({
          success: true,
          data: {
            word: 'sentence',
            corpusExamples: [
              { clipid: 'other-clip-1', enText: 'Another sentence example.', zhText: '另一个例句。' },
            ],
          },
        });
      };
      ctx.onWordTap({ currentTarget: { dataset: { word: 'sentence,' } } });
      assert(
        ctx.data.wordModal.word === 'sentence' && queriedDictUrl === '/api/dict/sentence',
        'F-B5 点击无时间戳 token 清洗标点后仅查该词'
      );
      const initEx = ctx.data.wordModal.corpusExamples;
      assert(
        Array.isArray(initEx) &&
          initEx.length === 1 &&
          initEx[0].clipid === 'clip-0' &&
          initEx[0].zh === '第一句。' &&
          initEx[0].parts.some((p) => p.hl === true && p.t.toLowerCase() === 'sentence'),
        'F3 点词即刻注入当前切片原声语境例句且命中词 hl=true'
      );
      ctx.onVocabClose();

      // F5: 切 Tab 隐藏记录在播状态与相对位置，回到 Tab 自动续播；有弹窗打开时不自动续播
      ctx._applyClip(0, { autoplay: true });
      return Promise.resolve().then(() => Promise.resolve());
    })
    .then(() => {
      assert(ctx.data.playing === true, 'F5 切 Tab 前处于播放态');
      ctx.onHide();
      assert(
        ctx.data.playing === false && ctx._resumeOnShow === true && ctx._relPos === 1.2,
        'F5 onHide 记录 _resumeOnShow=true 与离开时的相对位置 1.2s'
      );
      // 若此时有弹窗打开，onShow 不自动续播
      ctx.setData({ deepOpen: true });
      ctx._resumeOnShow = true;
      ctx.onShow();
      assert(ctx.data.playing === false, 'F5 弹窗打开时 onShow 不自动续播');
      ctx.setData({ deepOpen: false });

      // 正常回到 Tab 自动从离开时的相对位置续播
      ctx._resumeOnShow = true;
      lastPlayStartSec = -1;
      ctx.onShow();
      assert(
        ctx.data.playing === true && Math.abs(lastPlayStartSec - 1.2) < 1e-6,
        'F5 回到 Tab 时自动从离开相对位置 1.2s 续播'
      );

      // B2 + F2: 录音评测跨切片取消 & 真实跟读录音测评完整链路
      timers = [];
      recCancelCount = 0;
      ctx._applyClip(0, { autoplay: true });
      return Promise.resolve().then(() => Promise.resolve());
    })
    .then(() => {
      assert(ctx.data.playing === true, 'F2 起播后 playing=true');
      return ctx.onShadowing();
    })
    .then(() => {
      assert(
        ctx.data.isEvaluating === true &&
          ctx.data.evalPhase === 'recording' &&
          ctx.data.playing === false &&
          recState.recording === true,
        'F2 点击麦克风暂停原声循环并进入 recording 态'
      );
      const recTimer = timers.find((t) => t.ms === 12000);
      // B2: 录音中切换切片 → 立即清理定时器并调用 recorder.cancel()
      ctx._applyClip(1, { autoplay: false });
      assert(
        !!recTimer &&
          recTimer.cleared === true &&
          recCancelCount === 1 &&
          ctx.data.isEvaluating === false &&
          ctx.data.evalPhase === 'idle',
        'F-B2/F2 录音中切换切片立即清理计时器并释放麦克风'
      );

      // F2 真实评测正常完成路径：再点麦克风停止录音 -> POST /api/speech/evaluate -> 展示分项评分 + 恢复原声循环 -> 刷新 quota
      ctx._applyClip(0, { autoplay: true });
      return Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => ctx.onShadowing());
    })
    .then(() => {
      let evalPayload = null;
      let quotaRefreshed = false;
      postHandler = (url, data) => {
        if (url === '/api/speech/evaluate') {
          evalPayload = data;
          return Promise.resolve({
            success: true,
            data: {
              score: 91,
              recognitionId: 501,
              details: {
                overall: 91,
                pronunciation: 89,
                fluency: 95,
                integrity: 100,
                words: [
                  { word: 'First', pronunciation: 95 },
                  { word: 'sentence', pronunciation: 70 },
                  { word: 'here', pronunciation: 92 },
                ],
              },
            },
          });
        }
        return Promise.resolve({ success: true });
      };
      getHandler = (url) => {
        if (url.startsWith('/api/speech/quota')) quotaRefreshed = true;
        return Promise.resolve({ success: true, data: { remaining: 4 } });
      };
      // 第二次点击麦克风：停止录音并提交评测
      return ctx.onShadowing().then(() => ({ evalPayload, quotaRefreshed }));
    })
    .then((state) => {
      // 等待 _evaluateSpeech + _restoreLoopAfterEval Promise 链微任务完成
      return Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => state);
    })
    .then(({ evalPayload, quotaRefreshed }) => {
      assert(
        !!evalPayload &&
          evalPayload.episodeId === 'ep-100' &&
          evalPayload.subtitleId === 1 &&
          evalPayload.targetText === clip0.textEn &&
          evalPayload.audioBase64 === 'UklGRg==',
        'F2 停止录音提交 POST /api/speech/evaluate 载荷齐备'
      );
      assert(
        ctx.data.isEvaluating === false &&
          ctx.data.evalPhase === 'idle' &&
          ctx.data.evalScore === 91 &&
          ctx.data.evalFluency === 95 &&
          ctx.data.evalPronunciation === 89 &&
          ctx.data.evalIntegrity === 100 &&
          ctx.data.evalFeedback.includes('流利度 95%') &&
          ctx.data.evalFeedback.includes('sentence'),
        'F2 真实评测结果回填总分、分项指标与弱读词针对性点评'
      );
      assert(
        Array.isArray(ctx.data.evalWordScores) &&
          ctx.data.evalWordScores.length === 3 &&
          ctx.data.evalWordScores[0].score === 95 &&
          ctx.data.evalWordScores[0].tier === 'good' &&
          ctx.data.evalWordScores[1].score === 70 &&
          ctx.data.evalWordScores[1].tier === 'mid' &&
          ctx.data.evalWordScores[2].score === 92 &&
          ctx.data.evalWordScores[2].tier === 'good',
        'F2 逐词发音得分与颜色分层（good/mid/bad）准确映射至每个单词'
      );
      assert(
        ctx.data.evalUserAudioPath === 'wxfile://usr/rec.wav' &&
          wxml.includes('rl-word-score') &&
          wxml.includes('onPlayUserAudio'),
        'F2 临时录音路径仅存内存并渲染句末回放图标按钮'
      );
      assert(ctx.data.playing === true, 'F2 评测完成后自动恢复原声循环播放');
      assert(quotaRefreshed === true, 'F2 评测完成后刷新 /api/speech/quota');

      // 测试点击句末「回放我的发音」按钮：暂停原声循环 -> 播放 user 录音 -> 播完自动恢复原声循环
      ctx.onPlayUserAudio();
      assert(
        ctx.data.playingUserAudio === true && ctx.data.playing === false,
        'F2 点击句末回放按钮暂停原声并进入 playingUserAudio 态'
      );
      if (playerHooks && playerHooks.onEnded) playerHooks.onEnded('user');
      return Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
          assert(
            ctx.data.playingUserAudio === false && ctx.data.playing === true,
            'F2 我的发音回放结束后自动恢复原声循环播放'
          );

          // F2 录音过短拦截
          recStopResult = { base64: 'AA==', wavPath: '', bytes: 200 };
          return ctx.onShadowing().then(() => ctx.onShadowing());
        });
    })
    .then(() => {
      assert(
        ctx.data.evalPhase === 'idle' && ctx.data.isEvaluating === false,
        'F2 录音过短（<MIN_RECORD_BYTES）自动拦截并复位 idle'
      );
      recStopResult = { base64: 'UklGRg==', wavPath: 'wxfile://usr/rec.wav', bytes: 6400 };

      // F2 配额耗尽 403 -> 弹会员转化窗 review_eval_quota
      postHandler = (url) => {
        if (url === '/api/speech/evaluate') {
          const err = new Error('今日免费评测次数已用完');
          err.statusCode = 403;
          err.code = 'EVALUATION_QUOTA_EXCEEDED';
          return Promise.reject(err);
        }
        return Promise.resolve({ success: true });
      };
      return ctx.onShadowing().then(() => ctx.onShadowing());
    })
    .then(() => Promise.resolve())
    .then(() => {
      assert(
        ctx.data.evalQuotaLocked === true &&
          ctx.data.showPremiumModal === true &&
          ctx.data.premiumSource === 'review_eval_quota',
        'F2 评测配额 403 耗尽时置锁并唤起 review_eval_quota 会员弹窗'
      );
      ctx.setData({ evalQuotaLocked: false, showPremiumModal: false });

      // B3: 收藏/取消收藏同步更新 _savedKeysByEp 缓存，滑走再滑回不被旧缓存覆盖
      ctx._savedKeysByEp['ep-100'] = { 'ep-100:1': true };
      ctx._savedSub['ep-100:1'] = true;
      ctx._applyClip(0, { autoplay: false });
      assert(ctx.data.isSaved === true, 'F-B3 初始命中已收藏缓存');

      let togglePromiseResolve;
      postHandler = () =>
        new Promise((res) => {
          togglePromiseResolve = res;
        });
      ctx.onToggleBookmark(); // 取消收藏 clip0
      togglePromiseResolve({ success: true, data: { saved: false } });

      // B6: 深度透视请求令牌防竞态
      let resolveDeep1;
      let resolveDeep2;
      let deepCall = 0;
      deepDiveHandler = () =>
        new Promise((res) => {
          deepCall++;
          if (deepCall === 1) resolveDeep1 = res;
          else resolveDeep2 = res;
        });

      return Promise.resolve()
        .then(() => {
          assert(ctx.data.isSaved === false, 'F-B3 取消收藏后 isSaved=false');
          assert(ctx.data.drawerSentence === null, 'F1 取消收藏不弹标签抽屉');
          assert(!ctx._savedKeysByEp['ep-100']['ep-100:1'], 'F-B3 _savedKeysByEp 同步移除已取消的 key');
          // 滑到 clip1 再滑回 clip0
          ctx._applyClip(1, { autoplay: false });
          ctx._applyClip(0, { autoplay: false });
          assert(ctx.data.isSaved === false, 'F-B3 滑走再滑回同集切片，书签态不被旧缓存覆盖');

          // F1 真实切片：收藏成功后自动弹出 drawerSentence（drawerLocal=false）
          ctx.onToggleBookmark();
          togglePromiseResolve({
            success: true,
            data: {
              saved: true,
              sentence: {
                id: 'srv-sent-99',
                episodeid: 'ep-100',
                subtitleId: 1,
                enText: clip0.textEn,
                zhText: clip0.textCn,
                tags: ['地道表达'],
                note: null,
              },
            },
          });
        })
        .then(() => {
          assert(
            ctx.data.isSaved === true &&
              ctx.data.drawerSentence &&
              ctx.data.drawerSentence.id === 'srv-sent-99' &&
              ctx.data.drawerLocal === false,
            'F1 真实切片收藏成功自动唤起标签与笔记抽屉'
          );
          ctx.onDrawerUpdated({
            detail: { id: 'srv-sent-99', tags: ['地道表达', '发音重点'], note: '注意连读' },
          });
          assert(
            ctx._savedRecords['ep-100:1'].note === '注意连读' &&
              ctx._savedRecords['ep-100:1'].tags.includes('发音重点'),
            'F1 真实切片抽屉 updated 事件回写本地记录缓存'
          );
          ctx.onDrawerClose();
          assert(ctx.data.drawerSentence === null, 'F1 关闭抽屉置空 drawerSentence');

          // F1 沙箱语料：收藏自动弹出本地模式抽屉，保存时仅存本地 storage 不调 /api/sentences/meta
          ctx._applyClip(2, { autoplay: false });
          ctx.onToggleBookmark();
          assert(
            ctx.data.isSaved === true &&
              ctx.data.drawerLocal === true &&
              ctx.data.drawerSentence &&
              ctx.data.drawerSentence.textEn === clipLocal.textEn,
            'F1 沙箱语料收藏后自动打开本地模式标签抽屉'
          );

          let metaCalled = false;
          postHandler = (url) => {
            if (url === '/api/sentences/meta') metaCalled = true;
            return Promise.resolve({ success: true });
          };
          const drawerEvents = [];
          const drawerInst = Object.assign({}, drawerCompDef.methods, {
            data: Object.assign({}, JSON.parse(JSON.stringify(drawerCompDef.data)), {
              sentence: ctx.data.drawerSentence,
              local: true,
              selectedTags: ['发音重点', '连读弱读'],
              note: '沙箱本地心得笔记',
            }),
            setData(p) {
              Object.assign(this.data, p);
            },
            triggerEvent(name, detail) {
              drawerEvents.push({ name, detail });
              if (name === 'updated') ctx.onDrawerUpdated({ detail });
              if (name === 'close') ctx.onDrawerClose();
            },
          });
          return drawerInst.onSave().then(() => {
            assert(metaCalled === false, 'F1 沙箱本地模式保存不请求 /api/sentences/meta');
            const savedList = storageMap['reels_saved_sentences'];
            assert(
              Array.isArray(savedList) &&
                savedList.length === 1 &&
                savedList[0].note === '沙箱本地心得笔记' &&
                savedList[0].tags.includes('连读弱读'),
              'F1 沙箱语料标签与笔记仅持久化至本地 storage'
            );
            assert(ctx.data.drawerSentence === null, 'F1 沙箱抽屉保存后自动关闭');
          });
        })
        .then(() => {
          // 测试 B6：在 clip0 打开深度透视 -> 切到 clip1 打开深度透视 -> 慢请求 1 先后返回不覆盖请求 2
          ctx._applyClip(0, { autoplay: false });
          ctx.onDeepDive();
          ctx._applyClip(1, { autoplay: false });
          ctx.onDeepDive();
          resolveDeep1({
            connectedSpeech: 'OLD_CLIP_0',
            toneAndMood: 'OLD',
            paraphrase: 'OLD',
            speakingTip: 'OLD',
            source: 'llm',
          });
        })
        .then(() => {
          assert(ctx.data.deepAnalysis === null && ctx.data.deepLoading === true, 'F-B6 过期深度透视响应被丢弃');
          resolveDeep2({
            connectedSpeech: 'NEW_CLIP_1',
            toneAndMood: 'NEW',
            paraphrase: 'NEW',
            speakingTip: 'NEW',
            source: 'llm',
          });
        })
        .then(() => {
          assert(
            ctx.data.deepLoading === false &&
              ctx.data.deepAnalysis &&
              ctx.data.deepAnalysis.connectedSpeech === 'NEW_CLIP_1',
            'F-B6 当前深度透视响应正常落盘'
          );

          if (failed) {
            console.error('✗ ' + failed + ' 项失败');
            process.exit(1);
          }
          console.log('✓ discover-tags 全部通过');
        });
    });
})();

