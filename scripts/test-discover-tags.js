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

  // B5: 无词级时间戳时按空格切分 tokens
  const untimedClip = reelsApi.fromFeedItem({
    clipid: 'c-untimed',
    episodeid: 'ep-1',
    subtitleId: 10,
    textEn: 'Hello, world! How are you?',
    textCn: '你好，世界！',
    words: [],
  });
  assert(
    Array.isArray(untimedClip.tokens) &&
      untimedClip.tokens.join('|') === 'Hello,|world!|How|are|you?',
    'F-B5 无词级时间戳时生成按空格切分的 tokens'
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
        return { getState: () => ({ isLoggedIn: true }) };
      }
      if (id === '../../utils/request') return mockRequest;
      if (id === '../../utils/clip-player') {
        return {
          createClipPlayer: (hooks) => {
            playerHooks = hooks;
            return {
              playUrl: () => {},
              stop: () => {},
              estimatedPos: () => 0,
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

  // B2: 评测定时器跨切片不泄漏
  timers = [];
  ctx.onShadowing();
  assert(ctx.data.isEvaluating === true && timers.length === 1, 'F-B2 启动跟读评测计时器');
  const evalTimer = timers[0];
  ctx._applyClip(1, { autoplay: false });
  assert(evalTimer.cleared === true && ctx.data.isEvaluating === false, 'F-B2 切换切片立即清理评测定时器');
  evalTimer.fn(); // 即使定时器回调被触发也不应污染新切片
  assert(ctx.data.evalScore === 0, 'F-B2 旧切片评测回调被令牌拦截，不污染新切片');

  // B5: 无词级时间戳切片点击单个 token 只查该词而非整句
  let queriedDictUrl = '';
  getHandler = (url) => {
    queriedDictUrl = url;
    return Promise.resolve({ success: true, data: { word: 'sentence' } });
  };
  ctx.onWordTap({ currentTarget: { dataset: { word: 'sentence,' } } });
  assert(
    ctx.data.wordModal.word === 'sentence' && queriedDictUrl === '/api/dict/sentence',
    'F-B5 点击无时间戳 token 清洗标点后仅查该词'
  );

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

  Promise.resolve()
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
})();

