/**
 * scripts/test-progress-reporter.js — 收听进度双端同步器测试（断点续播）
 *
 * 把门口径 = 三端既有实现（Android ProgressReporter.kt / Web useSaveProgress.ts /
 * Android resumePositionMs + Web GlobalAudio fetchEpisodeStatus）：
 *   - 远端 15s 位置差周期上报（POST /api/episode/{id}/progress，wx.request 无 PATCH）
 *   - 本地 3s 节流缓存（wx storage，游客/断网续播降级源）
 *   - 暂停/停止即报；距尾 ≤5s 记 isFinished=true 且清本地
 *   - 播完只报一次 finished，此后不覆盖（切集冲刷跳过已完成的上一集）
 *   - 切集冲刷上一集最终进度（isFinished=false）
 *   - 游客（无 token）跳过远端、本地照存
 *   - 续播阈值：≤30s 从头；距尾 ≤15s 从头；远端 isFinished 从头；
 *     远端进度优先、失败/未登录降级本地；只应用一次（暂停恢复不重跳）
 *
 * 运行：node scripts/test-progress-reporter.js
 */

/* ==================== mock 基础设施 ==================== */

const storage = new Map();
const uploads = []; // { url, body }
const detailResponses = {}; // episodeid → userState（远端续播源 mock）
let toastCount = 0;

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: () => { toastCount += 1; },
  request: (opt) => {
    const url = opt.url || '';
    if (url.indexOf('/api/episode/') >= 0 && url.indexOf('/progress') >= 0) {
      uploads.push({ url, body: opt.data, method: opt.method });
      setTimeout(() => opt.success({ statusCode: 200, data: { success: true } }), 2);
      return;
    }
    if (url.indexOf('/api/episode/detail') >= 0) {
      const id = decodeURIComponent((url.split('id=')[1] || '').split('&')[0]);
      setTimeout(() => opt.success({
        statusCode: 200,
        data: { episodeid: id, userState: detailResponses[id] || null },
      }), 2);
      return;
    }
    setTimeout(() => opt.success({ statusCode: 200, data: { success: true } }), 2);
  },
};

const reporter = require('../utils/progress-reporter');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + label);
  } else {
    failed += 1;
    console.error('  ✗ ' + label);
  }
}
function uploadsFor(id) {
  // request.js 会拼 BASE_URL 前缀，按路径后缀匹配
  return uploads.filter((u) => u.url.endsWith('/api/episode/' + id + '/progress'));
}
function login(token) {
  if (token) storage.set('token', token);
  else storage.delete('token');
}
function fresh() {
  reporter._reset();
  storage.delete(reporter.PROGRESS_KEY);
  uploads.length = 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('== 远端周期上报（15s 位置差，POST 别名） ==');
  fresh();
  login('tk');
  reporter.setEpisode('ep1');
  [1, 5, 10, 14, 16, 20, 30, 31].forEach((t) => reporter.handleTime('ep1', t, 600));
  await sleep(20);
  ok(uploadsFor('ep1').length === 2, '两次周期上报（16s 与 31s，差值 ≥15）');
  ok(uploadsFor('ep1').every((u) => u.method === 'POST' && u.body.isFinished === false),
    'POST 方法 + isFinished=false');
  ok(uploadsFor('ep1')[0].body.progressSeconds === 16, '首报位置 16s');

  console.log('== 本地 3s 节流缓存 ==');
  fresh();
  login('');
  reporter.setEpisode('ep2');
  [1, 2, 2.5, 3.5, 4].forEach((t) => reporter.handleTime('ep2', t, 600));
  const rec = JSON.parse(JSON.stringify({})) && (storage.get(reporter.PROGRESS_KEY) || {}); 
  ok(rec.ep2 && Math.abs(rec.ep2.position - 4) < 0.01, '本地记录最新位置 4s');
  ok(rec.ep2.duration === 600, '本地记录时长');
  ok(reporter.readLocal('ep2') === 4, 'readLocal 读取');

  console.log('== 暂停即报 + 距尾 5s 记 finished 清本地 ==');
  fresh();
  login('tk');
  reporter.setEpisode('ep3');
  reporter.handleTime('ep3', 100, 600);
  await sleep(10);
  reporter.handlePause('ep3', 100, 600);
  await sleep(10);
  reporter.handlePause('ep3', 100, 600); // 幂等
  await sleep(10);
  let ups = uploadsFor('ep3');
  ok(ups.length === 1 && ups[0].body.progressSeconds === 100 && ups[0].body.isFinished === false,
    '中途暂停：立即上报一次（非 finished，幂等去重）');
  reporter.handlePause('ep3', 597, 600);
  await sleep(10);
  ups = uploadsFor('ep3');
  ok(ups.length === 2 && ups[1].body.isFinished === true, '距尾 ≤5s 暂停：isFinished=true');
  ok(!(storage.get(reporter.PROGRESS_KEY) || {}).ep3, 'finished 暂停清本地进度');

  console.log('== 自然完播：只报一次 finished，切集不覆盖 ==');
  fresh();
  login('tk');
  reporter.setEpisode('ep4');
  reporter.handleTime('ep4', 300, 600);
  reporter.handleEnded('ep4', 600);
  await sleep(10);
  reporter.handleEnded('ep4', 600); // 重复 ended
  reporter.handlePause('ep4', 600, 600); // 完播后暂停
  await sleep(10);
  ups = uploadsFor('ep4');
  ok(ups.filter((u) => u.body.isFinished === true).length === 1, 'finished 只报一次');
  reporter.setEpisode('ep5'); // 切集冲刷：已完成不覆盖
  await sleep(10);
  ok(uploadsFor('ep4').every((u) => u.body.isFinished === true || u.body.progressSeconds < 600),
    '切集不覆盖已完成标记');

  console.log('== 切集冲刷上一集最终进度 ==');
  fresh();
  login('tk');
  reporter.setEpisode('epA');
  reporter.handleTime('epA', 120, 600);
  await sleep(10);
  reporter.setEpisode('epB');
  await sleep(10);
  ups = uploadsFor('epA');
  ok(ups.length === 1 && ups[0].body.progressSeconds === 120 && ups[0].body.isFinished === false,
    '切集冲刷上一集 120s（isFinished=false）');

  console.log('== 游客：跳过远端、本地照存 ==');
  fresh();
  login('');
  reporter.setEpisode('epG');
  reporter.handleTime('epG', 50, 600);
  reporter.handlePause('epG', 50, 600);
  await sleep(10);
  ok(uploads.length === 0, '无 token 不发远端请求');
  ok(reporter.readLocal('epG') === 50, '本地仍保存（断网/游客续播降级源）');

  console.log('== 续播阈值（Android resumePositionMs 口径） ==');
  fresh();
  login('');
  reporter.saveLocal('epR1', 10, 600);   // ≤30s
  reporter.saveLocal('epR2', 120, 600);  // 有效
  reporter.saveLocal('epR3', 590, 600);  // 距尾 ≤15s
  reporter.prepareResume('epR1');
  ok(reporter.applyResume('epR1', 600) === 0, '≤30s 从头播');
  reporter.prepareResume('epR2');
  ok(reporter.applyResume('epR2', 600) === 120, '120s 续播到 120s');
  ok(reporter.applyResume('epR2', 600) === 0, '只应用一次（暂停恢复不重跳）');
  reporter.prepareResume('epR3');
  ok(reporter.applyResume('epR3', 600) === 0, '距尾 ≤15s 从头播');
  reporter.prepareResume('epR2');
  ok(reporter.applyResume('epR2', 0) === 120, '时长未知（0）时不截尾、正常续播');

  console.log('== 远端续播优先 / 失败降级本地 / isFinished 从头 ==');
  fresh();
  login('tk');
  detailResponses['epW'] = { progressSeconds: 200, isFinished: false };
  reporter.saveLocal('epW', 80, 600); // 本地旧值
  reporter.prepareResume('epW');
  await sleep(20); // 等远端 detail 回包覆盖 pendingResume
  reporter.setEpisode; // no-op（保持 epW 上下文）
  ok(reporter.applyResume('epW', 600) === 200, '远端 200s 覆盖本地 80s（应用前返回）');
  detailResponses['epF'] = { progressSeconds: 400, isFinished: true };
  reporter.prepareResume('epF');
  await sleep(20);
  ok(reporter.applyResume('epF', 600) === 0, '远端 isFinished=true 从头播');
  login('');
  reporter.saveLocal('epL', 90, 600);
  reporter.prepareResume('epL');
  await sleep(20);
  ok(reporter.applyResume('epL', 600) === 90, '游客/接口失败 → 本地降级值续播');

  console.log('== 本地表容量剪裁（LRU） ==');
  fresh();
  login('');
  for (let i = 0; i < 60; i++) reporter.saveLocal('cap' + i, 100 + i, 600);
  const map = storage.get(reporter.PROGRESS_KEY) || {};
  ok(Object.keys(map).length <= 50, '上限 50（实际 ' + Object.keys(map).length + '）');
  ok(map['cap59'] && map['cap0'] === undefined, '保留最新、剪掉最旧');

  console.log('');
  console.log('进度同步：' + passed + ' 通过，' + failed + ' 失败');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
