/**
 * scripts/test-entry-source.js — 启动来源捕获（注册归因）测试
 *
 * 把门口径 = utils/entry-source.js 与服务端 core/utils/signup-source.ts 的同一正则：
 *   - scene（getwxacodeunlimit，百分号编码投递）与 src（后台路径参数码）两种入口
 *   - scene 优先于 src；合法才落 storage，最近一次扫码进入覆盖旧值
 *   - 非法值（空格/中文/超长）静默丢弃，不影响已有来源
 *   - 普通启动（无参数）不触碰旧值；get() 对存储做同款校验兜底
 *
 * 运行：node scripts/test-entry-source.js
 */

const storage = new Map();

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
};

const entrySource = require('../utils/entry-source');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log('  ✓ ' + label); }
  else { failed += 1; console.error('  ✗ ' + label); }
}

console.log('utils/entry-source.js — 启动来源捕获');

// ── 基础捕获 ──
entrySource.captureFromQuery({ src: 'gzh_follow' });
ok(entrySource.get() === 'gzh_follow', 'src 路径参数码捕获（后台生成的码）');

entrySource.captureFromQuery({ scene: 'gzh_w1_b' });
ok(entrySource.get() === 'gzh_w1_b', 'scene 短码捕获并覆盖旧来源（最近扫码为准）');

entrySource.captureFromQuery({ scene: '%67zh_w2_b' });
ok(entrySource.get() === 'gzh_w2_b', 'scene 百分号编码自动 decode（微信投递形态）');

entrySource.captureFromQuery({ scene: 'gzh_w3_b', src: 'gzh_follow' });
ok(entrySource.get() === 'gzh_w3_b', 'scene 与 src 同时存在时 scene 优先');

// ── 非法值拒收 ──
storage.delete('entrySource');
entrySource.captureFromQuery({ src: 'bad source!' });
ok(entrySource.get() === '', '含空格/感叹号的值拒收（服务端正则同款）');

entrySource.captureFromQuery({ src: '公众号来源' });
ok(entrySource.get() === '', '中文值拒收');

entrySource.captureFromQuery({ src: 'a'.repeat(101) });
ok(entrySource.get() === '', '超长值（>100）拒收');

entrySource.captureFromQuery({ src: '  gzh_w4_b  ' });
ok(entrySource.get() === 'gzh_w4_b', '首尾空白 trim 后接受');

// ── 普通启动不触碰旧值 ──
entrySource.captureFromQuery({});
ok(entrySource.get() === 'gzh_w4_b', '无参数启动保持旧来源（归因不丢）');

entrySource.captureFromQuery(undefined);
ok(entrySource.get() === 'gzh_w4_b', 'query 缺省（onLaunch 无 options）不抛异常且保持旧值');

entrySource.captureFromQuery({ scene: '', src: '' });
ok(entrySource.get() === 'gzh_w4_b', '空字符串参数视为无来源');

// ── get() 兜底 ──
storage.set('entrySource', 'tampered!! value');
ok(entrySource.get() === '', 'get() 对被篡改的存储值做同款校验兜底');

storage.delete('entrySource');
ok(entrySource.get() === '', '无来源时 get() 返回空串');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
