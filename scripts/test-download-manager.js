/**
 * scripts/test-download-manager.js — 音频离线缓存下载编排单测（DOWNLOAD-TASK T3.1）
 *
 * mock wx.downloadFile / FileSystemManager / 请求路由，全分支覆盖：
 *   A. 首次下载全链路（签名 URL → downloadFile → saveFile 落盘 → 索引 → 事件序列）
 *   B. 缓存命中（零请求零下载）/ 并发去重（在途共享 Promise）
 *   C. 失败自动重试 1 次（fail→ok 成功 / 持续 fail 拒绝且 pending 清空 / 非 200 同口径）
 *   D. 扩展名解析（剥 query / 非法兜底 m4a）
 *   E. API 层错误（requirePremium 403 透传，不触发 downloadFile）
 *   F. remove / clearAll / getUsage / touch / 索引自愈（外部删文件）
 *   G. 显式超时参数（600000，附录 B 第 4 条大文件口径）
 *   H. LRU 配额驱逐（T3.2）：落盘后硬保证 / touch 优先级 / 预检腾位 /
 *      keepId 永不驱逐 / 单文件超线不死循环（递增假时钟消除同毫秒排序不稳定）
 *
 * 运行：node scripts/test-download-manager.js
 */

/* ==================== mock 基础设施（须先于 require 被测模块） ==================== */

const storage = new Map();
const files = new Map(); // path → { size }
const dirs = new Set(['wxfile://usr']);

const api = { calls: 0, mode: 'ok', errorBody: null };
const dl = { calls: [], mode: 'ok', hangRelease: null, fileSize: 5 * 1024 * 1024, failConsumed: false };
let progressCb = null;

global.wx = {
  env: { USER_DATA_PATH: 'wxfile://usr' },
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: () => {},
  request: (opts) => {
    const p = opts.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (p === '/api/episode/download') {
      api.calls += 1;
      if (api.mode === 'error') {
        opts.success({ statusCode: api.errorStatus || 403, data: api.errorBody || { success: false, error: '权限不足，需要高级会员权限' } });
        return;
      }
      opts.success({
        statusCode: 200,
        data: { success: true, downloadUrl: 'https://wxkzd.oss-cn-beijing.aliyuncs.com/yuanlu/audios/1782.m4a?Expires=1790000000&Signature=abc' },
      });
      return;
    }
    opts.success({ statusCode: 200, data: {} });
  },
  downloadFile: (opts) => {
    dl.calls.push(opts);
    if (dl.mode === 'hang') {
      // 挂起：由用例手动释放（并发去重窗口）
      dl.hangRelease = (result) => {
        if (result === 'fail') opts.fail && opts.fail({ errMsg: 'downloadFile:fail timeout' });
        else opts.success && opts.success(result);
      };
      return { onProgressUpdate: (cb) => { progressCb = cb; } };
    }
    // setImmediate 延迟响应：留出 onProgressUpdate 注册与进度推送窗口（真实时序）
    setImmediate(() => {
      if (dl.mode === 'fail' || (dl.mode === 'fail-once' && !dl.failConsumed)) {
        if (dl.mode === 'fail-once') dl.failConsumed = true;
        opts.fail && opts.fail({ errMsg: 'downloadFile:fail timeout' });
        return;
      }
      const statusCode = dl.mode === '403' ? 403 : 200;
      opts.success && opts.success({ statusCode, tempFilePath: `wxfile://tmp-${dl.calls.length}` });
    });
    return {
      onProgressUpdate: (cb) => {
        progressCb = cb;
      },
    };
  },
  getFileSystemManager: () => ({
    mkdirSync: (dir) => {
      if (dirs.has(dir)) {
        const e = new Error('mkdir:fail file already exists');
        throw e;
      }
      dirs.add(dir);
    },
    saveFileSync: (temp, dest) => {
      files.set(dest, { size: dl.fileSize });
      return dest;
    },
    statSync: (p) => {
      if (!files.has(p)) throw new Error('statSync:fail no such file');
      return { size: files.get(p).size };
    },
    accessSync: (p) => {
      if (!files.has(p)) throw new Error('accessSync:fail no such file');
    },
    unlinkSync: (p) => {
      if (!files.has(p)) throw new Error('unlinkSync:fail no such file');
      files.delete(p);
    },
  }),
};

const dm = require('../utils/download-manager');

let passed = 0;
let failed = 0;
const failures = [];
function assert(cond, name) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}
function section(t) {
  console.log(`\n━━━ ${t} ━━━`);
}
const tick = () => new Promise((r) => setImmediate(r));

const EVENTS = [];
dm.subscribe((e) => EVENTS.push(e));

(async () => {
  /* ---------- A. 首次下载全链路 ---------- */
  section('一、首次下载全链路');
  {
    const ep = { episodeid: 'ep1', title: 'Episode One' };
    const progressSeen = [];
    const p = dm.download(ep, { onProgress: (v) => progressSeen.push(v) });
    await tick(); // 链路推进至 downloadFile（onProgressUpdate 已注册）
    progressCb && progressCb({ progress: 42 });
    progressCb && progressCb({ progress: 100 });
    const path = await p;
    assert(path === 'wxfile://usr/audio/ep1.m4a', '落盘路径 = USER_DATA_PATH/audio/ep1.m4a');
    assert(api.calls === 1 && dl.calls.length === 1, '一次 API + 一次 downloadFile');
    assert(dl.calls[0].timeout === 600000, '显式超时 10 分钟（附录 B 第 4 条）');
    assert(dl.calls[0].header === undefined, 'OSS 公开签名直链免鉴权头');
    assert(files.has('wxfile://usr/audio/ep1.m4a'), '文件已写入（saveFileSync）');
    const idx = storage.get('download_index');
    assert(!!idx && !!idx.ep1, '索引已持久化');
    assert(idx.ep1.path === path && idx.ep1.size === 5 * 1024 * 1024 && idx.ep1.title === 'Episode One', '索引字段（path/size/title）');
    assert(idx.ep1.savedAt > 0 && idx.ep1.lastPlayedAt === 0, '索引时间字段（savedAt>0, lastPlayedAt 起始 0）');
    assert(progressSeen.indexOf(42) !== -1 && progressSeen.indexOf(100) !== -1, 'onProgress 回调透传（42/100）');
    assert(
      EVENTS.some((e) => e.type === 'progress' && e.episodeid === 'ep1' && e.progress === 100) &&
        EVENTS.some((e) => e.type === 'downloaded' && e.episodeid === 'ep1' && e.path === path),
      '事件序列 progress → downloaded',
    );
  }

  /* ---------- B. 缓存命中 / 并发去重 ---------- */
  section('二、缓存命中与并发去重');
  {
    const before = { api: api.calls, dl: dl.calls.length };
    const again = await dm.download({ episodeid: 'ep1', title: 'Episode One' });
    assert(again === 'wxfile://usr/audio/ep1.m4a', '缓存命中返回同路径');
    assert(api.calls === before.api && dl.calls.length === before.dl, '命中零请求零下载');

    dm.remove('ep1'); // 清场后测并发
    dl.mode = 'hang';
    const dlBase = dl.calls.length; // 相对计数（套件全局累计）
    const p1 = dm.download({ episodeid: 'epC', title: 'Concurrent' });
    const p2 = dm.download({ episodeid: 'epC', title: 'Concurrent' });
    await tick();
    await tick();
    assert(dl.calls.length === dlBase + 1, '并发两连点 → 仅一次 downloadFile（在途共享 Promise）');
    dl.hangRelease({ statusCode: 200, tempFilePath: 'wxfile://tmp-c' });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert(r1 === r2 && r1 === 'wxfile://usr/audio/epC.m4a', '两调用方共享同一结果路径');
    dl.mode = 'ok';
  }

  /* ---------- C. 失败重试 ---------- */
  section('三、失败自动重试（1 次）');
  {
    EVENTS.length = 0;
    dl.mode = 'fail-once';
    dl.failConsumed = false; // 本用例内第一次 downloadFile 失败、重试成功
    const path = await dm.download({ episodeid: 'epR', title: 'Retry' });
    assert(path === 'wxfile://usr/audio/epR.m4a', '首次网络失败 → 自动重试成功落盘');
    assert(EVENTS.some((e) => e.type === 'retry' && e.episodeid === 'epR'), '重试事件广播');

    dl.mode = 'fail';
    let rejected = null;
    await dm.download({ episodeid: 'epF', title: 'Fail' }).catch((e) => { rejected = e; });
    assert(rejected && rejected.message === 'downloadFile:fail timeout', '持续失败 → reject 原始 errMsg');
    assert(EVENTS.some((e) => e.type === 'error' && e.episodeid === 'epF'), 'error 事件广播');
    const dlBefore = dl.calls.length;
    let rejected2 = null;
    await dm.download({ episodeid: 'epF', title: 'Fail' }).catch((e) => { rejected2 = e; });
    assert(dl.calls.length > dlBefore && !!rejected2, 'pending 已清空（失败后可重新发起）');

    dm.remove('epF'); // 清场
    dl.mode = '403';
    let httpErr = null;
    await dm.download({ episodeid: 'epH', title: 'HTTP403' }).catch((e) => { httpErr = e; });
    assert(httpErr && httpErr.message === '下载失败（HTTP 403）', '签名直链非 200 → 重试后仍 403 → HTTP 文案 reject');
    dl.mode = 'ok';
  }

  /* ---------- D. 扩展名解析 ---------- */
  section('四、扩展名解析');
  {
    // epD 用带 .mp3 的直链：临时改 API 返回
    const rawRequest = global.wx.request;
    global.wx.request = (opts) => {
      if (opts.url.includes('/api/episode/download') && opts.url.includes('epD')) {
        opts.success({ statusCode: 200, data: { success: true, downloadUrl: 'https://oss/x/old.mp3?Expires=1&Signature=s' } });
        return;
      }
      rawRequest(opts);
    };
    const pMp3 = await dm.download({ episodeid: 'epD', title: 'Mp3' });
    assert(pMp3.endsWith('/epD.mp3'), 'URL 带 query → 剥参数取 .mp3');
    global.wx.request = (opts) => {
      if (opts.url.includes('/api/episode/download') && opts.url.includes('epN')) {
        opts.success({ statusCode: 200, data: { success: true, downloadUrl: 'https://oss/x/noext?Expires=1' } });
        return;
      }
      rawRequest(opts);
    };
    const pNo = await dm.download({ episodeid: 'epN', title: 'NoExt' });
    assert(pNo.endsWith('/epN.m4a'), '无扩展名 → 兜底 m4a（历史批次口径）');
    global.wx.request = rawRequest;
  }

  /* ---------- E. API 层错误 ---------- */
  section('五、API 层错误（门禁 403）');
  {
    api.mode = 'error';
    const dlBefore = dl.calls.length;
    let apiErr = null;
    await dm.download({ episodeid: 'ep403', title: 'Denied' }).catch((e) => { apiErr = e; });
    assert(apiErr && apiErr.message === '权限不足，需要高级会员权限', 'requirePremium 403 → 后端文案 reject');
    assert(dl.calls.length === dlBefore, '拿不到直链不触发 downloadFile');
    api.mode = 'ok';
  }

  /* ---------- F. remove / clearAll / usage / touch / 自愈 ---------- */
  section('六、缓存管理原语');
  {
    // 现存：epC/epR/epD/epN
    let usage = dm.getUsage();
    assert(usage.count === 4 && usage.bytes === 4 * 5 * 1024 * 1024, 'getUsage 汇总（4 集 × 5MB）');

    assert(dm.getCachedPath('epC') === 'wxfile://usr/audio/epC.m4a', 'getCachedPath 命中');
    dm.touch('epC');
    assert(storage.get('download_index').epC.lastPlayedAt > 0, 'touch 刷新 LRU 时钟');

    EVENTS.length = 0;
    dm.remove('epC');
    assert(!files.has('wxfile://usr/audio/epC.m4a') && dm.getCachedPath('epC') === null, 'remove 删文件+索引');
    assert(EVENTS.some((e) => e.type === 'removed' && e.episodeid === 'epC'), 'removed 事件');

    // 自愈：索引在、文件被外部清除
    files.delete('wxfile://usr/audio/epR.m4a');
    EVENTS.length = 0;
    assert(dm.getCachedPath('epR') === null, '索引脏（文件已删）→ 返回 null');
    assert(!storage.get('download_index').epR, '脏条目自愈剔除');
    assert(EVENTS.some((e) => e.type === 'removed' && e.episodeid === 'epR' && e.reason === 'stale'), '自愈广播 removed(stale)');

    dm.clearAll();
    usage = dm.getUsage();
    assert(usage.count === 0 && usage.bytes === 0, 'clearAll 清空索引');
    assert(!files.has('wxfile://usr/audio/epD.m4a') && !files.has('wxfile://usr/audio/epN.m4a'), 'clearAll 删除全部文件');
  }

  /* ---------- G. LRU 配额驱逐（T3.2） ---------- */
  section('七、LRU 驱逐：落盘后硬保证 + touch 优先级');
  {
    // 递增假时钟：消除同毫秒 savedAt/lastPlayedAt 的排序不稳定
    const realNow = Date.now;
    let fakeNow = 1700000000000;
    Date.now = () => (fakeNow += 1000);
    try {
      dm.setUsageLimit(10 * 1024 * 1024);
      dl.fileSize = 5 * 1024 * 1024;
      await dm.download({ episodeid: 'epL1', title: 'L1' });
      await dm.download({ episodeid: 'epL2', title: 'L2' });
      assert(dm.getUsage().count === 2, '10MB 上限：2×5MB 恰好在线上不驱逐');

      dm.touch('epL1'); // epL1 最近播放 → epL2 变最旧
      EVENTS.length = 0;
      await dm.download({ episodeid: 'epL3', title: 'L3' });
      assert(dm.getUsage().count === 2 && dm.getCachedPath('epL1') && dm.getCachedPath('epL3'), '落盘 15MB 超线 → 驱逐未播的 epL2，touch 过的 epL1 与新集 epL3 保留');
      assert(!files.has('wxfile://usr/audio/epL2.m4a'), '驱逐条目文件同步删除');
      assert(EVENTS.some((e) => e.type === 'removed' && e.episodeid === 'epL2' && e.reason === 'lru'), '驱逐广播 removed(lru)');

      section('八、预检腾位 + keepId 保护 + 单文件超线');
      dm.setUsageLimit(5 * 1024 * 1024); // 当前 10MB 已超线
      EVENTS.length = 0;
      await dm.download({ episodeid: 'epL4', title: 'L4' });
      const idx8 = storage.get('download_index');
      assert(Object.keys(idx8).length === 1 && !!idx8.epL4, '预检驱逐最旧 + 落盘后再驱逐 → 最终仅存当次 epL4（keepId 永不驱逐）');
      const evictSeq = EVENTS.filter((e) => e.type === 'removed' && e.reason === 'lru').map((e) => e.episodeid);
      assert(evictSeq.indexOf('epL1') !== -1 && evictSeq.indexOf('epL3') !== -1 && evictSeq.indexOf('epL4') === -1, '驱逐序列只含旧集（epL1/epL3），当次集绝不被驱逐');

      // 单文件超线极端：驱逐全部其余后停，不死循环、不 reject、当次集保留
      dl.fileSize = 8 * 1024 * 1024;
      const bigPath = await dm.download({ episodeid: 'epBig', title: 'Big' });
      assert(bigPath === 'wxfile://usr/audio/epBig.m4a' && !!dm.getCachedPath('epBig'), '单文件 8MB 超线 5MB：驱逐其余后保留当次集（不 reject）');
      assert(dm.getUsage().count === 1 && dm.getUsage().bytes === 8 * 1024 * 1024, '超线残留如实记账（无候选可驱逐即停）');
      dm.setUsageLimit(180 * 1024 * 1024); // 复位默认线
    } finally {
      Date.now = realNow;
    }
  }

  /* ---------- 汇总 ---------- */
  console.log(`\n========== 下载编排测试：${passed} 通过 / ${failed} 失败 ==========`);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
