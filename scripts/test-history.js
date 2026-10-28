/**
 * scripts/test-history.js — 「精研足迹」页测试（T5.2 重建：本地微剧场足迹）
 *
 * 覆盖：足迹记录→渲染（今天/更早分组）、重研跳转精研室、清空确认、空态引导。
 * 运行：node scripts/test-history.js
 */
const fs = require('fs');
const path = require('path');

const navigations = [];
const storage = new Map();
let modalConfirm = false;

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: () => {},
  showModal: (o) => { o.success({ confirm: modalConfirm }); },
  navigateTo: (o) => navigations.push(o.url),
  switchTab: (o) => navigations.push(o.url),
  navigateBack: () => {},
};

global.Page = (cfg) => (global.__fpCfg = cfg);

require(path.join(__dirname, '../pages/library/history/index.js'));
const footprint = require(path.join(__dirname, '../utils/study-footprint.js'));
const cfg = global.__fpCfg;

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else {
    console.error('FAIL:', msg);
    failed++;
  }
}

const page = Object.assign({}, cfg, {
  data: JSON.parse(JSON.stringify(cfg.data)),
  setData(patch) {
    Object.assign(this.data, patch);
  },
});

// —— A. 空态 ——
page.onShow();
ok(page.data.total === 0 && page.data.today.length === 0, 'A 空态零足迹');
const wxml = fs.readFileSync(path.join(__dirname, '../pages/library/history/index.wxml'), 'utf8');
ok(wxml.includes('精研足迹') && wxml.includes('去探索画廊'), 'A 空态引导文案');

// —— B. 足迹记录 → 渲染（今天/更早分组） ——
const now = Date.now();
footprint.record({ sceneid: 'sNow', title: '今天的微剧场', coverUrl: 'cvN', duration: 28, situationTag: '职场' });
footprint.record({ sceneid: 'sOld', title: '早前的微剧场', coverUrl: '', duration: 33, situationTag: '' });
// 手动把 sOld 的时间戳拨到昨天（storage 直改——页面渲染层按 at 分组）
const list = footprint.list();
const idx = list.findIndex((x) => x.sceneid === 'sOld');
list[idx].at = now - 24 * 3600 * 1000 - 1000;
storage.set(footprint.KEY, list);
page.onShow();
ok(page.data.total === 2, 'B 总足迹 2 条');
ok(page.data.today.length === 1 && page.data.today[0].sceneid === 'sNow', 'B 今天分组 1 条（sNow）');
ok(page.data.earlier.length === 1 && page.data.earlier[0].sceneid === 'sOld', 'B 更早分组 1 条（sOld）');
ok(page.data.today[0].durText === '28s' && page.data.today[0].situationTag === '职场', 'B 时长/标签预格式化');
ok(/^\d{4}年\d+月\d+日$/.test(page.data.earlier[0].dateText), 'B 更早日期格式化');

// 同 sceneid 重复记录去重置顶
footprint.record({ sceneid: 'sNow', title: '今天的微剧场', coverUrl: 'cvN', duration: 28, situationTag: '职场' });
page.onShow();
ok(page.data.total === 2 && page.data.today[0].sceneid === 'sNow', 'B 同 sceneid 去重（不涨总数，置顶）');

// —— C. 重研跳转 ——
navigations.length = 0;
page.onSceneTap({ currentTarget: { dataset: { scene: 'sNow' } } });
ok(navigations[0] === '/pages/intensive-listening/index?sceneId=sNow', 'C 重研跳精研室 ?sceneId=');

// —— D. 清空 ——
modalConfirm = true;
page.onClearAll();
page.onShow();
ok(page.data.total === 0 && storage.get(footprint.KEY).length === 0, 'D 确认清空后空态');
// WXML 零禁用接口
ok(!wxml.includes('/api/episode/') && !wxml.includes('/api/podcast/') && !wxml.includes('播客'), 'D 零禁用接口与退役文案');

console.log('----------------------------------------');
if (failed === 0) {
  console.log('ALL HISTORY TESTS PASSED');
} else {
  console.error(failed + ' TEST(S) FAILED');
  process.exitCode = 1;
}
