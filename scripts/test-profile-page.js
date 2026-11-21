/**
 * scripts/test-profile-page.js — 「个人中心」主页（阶段 2-4）自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page / getApp），全链路驱动
 * pages/profile/index.js → utils/api/profile.js → utils/request.js → wx.request：
 * 覆盖登录闸、首载三源并行拉取与 DTO→视图模型映射（mapProfile 展平/404 兜底）、
 * 卡内错误态与重试、Tab 切换、下拉刷新、profileDirty 静默刷新、编辑页跳转、主题接入；
 * 勋章墙：真实成绩、分类筛选、预览、刷新和海报导出。
 * 阶段 5：账号与安全——绑定手机/邮箱弹层（scene:BIND 发码/倒计时/业务失败行内/
 * 强度三项/两密一致/校验链/乐观回写）与注销链路（DELETE→logout→1.2s navigateBack）。
 *
 * 运行：node scripts/test-profile-page.js
 */

/* ==================== mock 基础设施 ==================== */

const storage = new Map();
const toasts = [];
const navigations = [];
const calls = { request: [] };
let requestHandler = null;

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o.title),
  navigateTo: (o) => navigations.push(o.url),
  navigateBack: () => navigations.push('__back__'),
  stopPullDownRefresh: () => { calls.stopPull = (calls.stopPull || 0) + 1; },
  getAppBaseInfo: () => ({ theme: 'light' }),
  getSystemInfoSync: () => ({ theme: 'light', windowWidth: 375, pixelRatio: 2 }),
  setNavigationBarColor: () => {},
  setTabBarStyle: () => {},
  request: (opts) => {
    calls.request.push(opts);
    if (requestHandler) requestHandler(opts);
  },
};

global.getApp = () => ({ globalData: { profileDirty: false } });

let pageConfig = null;
global.Page = (cfg) => { pageConfig = cfg; };

function respond(opts, statusCode, data) {
  opts.success({ statusCode, data, errMsg: 'request:ok' });
}

const flush = () => new Promise((r) => setImmediate(r));

/** 按当前 handler 服务一轮三源请求后等全部微任务落定 */
async function settle(times) {
  for (let i = 0; i < (times || 6); i++) await flush();
}

function mockPosterCanvas() {
  const labels = [];
  const gradients = [];
  const ctx = {
    scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {},
    closePath() {}, fill() {}, stroke() {},
    fillText: (label) => labels.push(label),
    createLinearGradient() {
      return { addColorStop: (_, color) => gradients.push(color) };
    },
  };
  return { node: { width: 0, height: 0, getContext: () => ctx }, labels, gradients };
}

function makePage() {
  const page = Object.assign({}, pageConfig);
  page.data = JSON.parse(JSON.stringify(pageConfig.data));
  page.setData = function (patch, callback) {
    Object.keys(patch).forEach((k) => {
      if (k.indexOf('.') > 0) {
        const parts = k.split('.');
        let obj = this.data;
        for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
        obj[parts[parts.length - 1]] = patch[k];
      } else {
        this.data[k] = patch[k];
      }
    });
    if (callback) callback();
  };
  const poster = mockPosterCanvas();
  page.__poster = poster;
  page.createSelectorQuery = () => ({
    select(id) {
      return {
        fields() {
          return {
            exec(callback) {
              callback(id === '#badgePoster' && page.data.posterOpen ? [{ node: poster.node }] : []);
            },
          };
        },
      };
    },
  });
  return page;
}

/* ==================== 固定响应 ==================== */

const PROFILE_DTO = {
  userid: 'u1',
  nickname: '远路漫漫',
  bio: '',
  learnLevel: 'Beginner',
  avatarUrl: 'https://oss-signed.example.com/avatar.jpg?a=1',
  avatarFileName: 'yuanlu/avatar/1.jpg',
  dailyStudyGoalMins: 30,
  weeklyListeningGoalHours: 5,
  weeklyWordsGoal: 50,
  User: {
    userid: 'u1',
    email: 'ab@ex.com',
    phone: '13812348000',
    role: 'USER',
    createAt: '2026-01-02T18:30:00.000Z',
  },
};

const STATS_DTO = { totalHours: 21.8, streakDays: 4, wordsLearned: 120, speechEvalCount: 9, speechHighScoreCount: 3 };
const ACH_DTO = [
  { key: 'STREAK_3', name: '三连胜', description: 'd', icon: '🔥', unlocked: true, unlockedAt: '2026-09-01T00:00:00.000Z' },
  { key: 'VOCAB_500', name: '词汇大师', description: '积累 500 个生词', icon: '📚', unlocked: false, unlockedAt: null },
  { key: 'SPEECH_GREAT_10', name: '出口成章', description: '累计 10 次达到 85 分', icon: '🎙️', unlocked: false, unlockedAt: null },
];

function serveAll(opts) {
  if (opts.url.endsWith('/api/streak')) return respond(opts, 200, { success: true, data: { streakDays: 4 } });
  if (opts.url.indexOf('/api/user/profile') >= 0) return respond(opts, 200, PROFILE_DTO);
  if (opts.url.indexOf('/api/user/stats/overview') >= 0) return respond(opts, 200, { ...STATS_DTO, streakDays: 0 });
  if (opts.url.indexOf('/api/user/achievements') >= 0) return respond(opts, 200, ACH_DTO);
  respond(opts, 404, { error: 'not found' });
}

/* ==================== 加载被测模块（mock 就绪后） ==================== */

const theme = require('../utils/theme');
const authStore = require('../store/authStore');
require('../pages/profile/index');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}

(async function main() {
  /* ---------- 1. 未登录守门 ---------- */
  console.log('== 未登录守门 ==');
  storage.delete('token');
  let page = makePage();
  page.onLoad();
  page.onShow();
  await settle();
  ok(page.data.isLoading === false && page.data.needLogin === true, '未登录 onShow → needLogin 且不拉取');
  ok(calls.request.length === 0, '未登录零请求');
  page.onLogin();
  ok(navigations[navigations.length - 1] === '/pages/auth/index', '去登录跳转 auth 页');

  /* ---------- 2. 首载三源并行 ---------- */
  console.log('== 首载三源并行 ==');
  authStore.setLoginData('tok-1', { userid: 'u1', nickname: '兜底昵称', email: 'ab@ex.com' });
  await settle(); // setLoginData 触发的 fetchProfile 也走 serveAll
  calls.request.length = 0;

  requestHandler = serveAll;
  page = makePage();
  page.onLoad();
  page.onShow();
  await settle();

  ok(page.data.isLoading === false && page.data.needLogin === false, '首载完成退出骨架态');
  ok(calls.request.length === 4 && ['/profile', '/stats/overview', '/achievements', '/streak'].every((suffix) =>
    calls.request.some((req) => req.url.endsWith(suffix))), '只拉取资料、里程统计和成就');
  const vm = page.data.profile;
  ok(vm && vm.displayName === '远路漫漫' && vm.levelLabel === '初级', 'mapProfile 展平：昵称/等级');
  ok(vm.bioText === '路虽远行则将至，事虽难做则成。', '空签名回退默认座右铭');
  ok(vm.phoneMasked === '138****8000' && vm.hasPhone === true, '安全派生随卡就绪');
  ok(vm.joinDateText.length === 10 && /^\d{4}\/\d{2}\/\d{2}$/.test(vm.joinDateText), '加入日期 yyyy/MM/dd');
  ok(page.data.medalStats.streakDays === 4 && page.data.medalStats.speechHighScoreCount === 3, '勋章使用服务端统计');
  ok(calls.request.find(req => req.url.endsWith('/achievements')).data.platform === 'weapp',
    '勋章解锁与进度请求使用同一小程序连胜口径');
  const { buildMedals } = require('../pages/profile/badge-wall');
  const [seven] = buildMedals([{ key: 'STREAK_7', name: '七连胜' }], page.data.medalStats);
  ok(seven.progress === 57 && seven.progressText === '4 / 7 天', '七日勋章展示 4 天和 57% 进度');
  ok(!buildMedals([{ key: 'STREAK_7' }], {})[0].progressText, '缺少连胜字段时不显示虚假的零天');
  ok(page.data.litCount === 1 && page.data.shownMedals.length === 3, '全部徽章包含未解锁成就');
  ok(page.data.tabs.map((tab) => tab.label).join(',') === '勋章墙,账号与安全', '个人中心标签为勋章墙与账号安全');
  ok(page.data.activeTab === 'badges', '默认显示勋章墙');
  page.onTab({ currentTarget: { dataset: { key: 'milestones' } } });
  ok(page.data.activeTab === 'badges', '旧里程碑入口不再生效');
  ok(page.data.themeClass === '' && page.data.dark === false, '主题跟随系统（空根类）');

  theme.setMode('dark');
  page.onShow();
  ok(page.data.dark === true, '个人中心跟随深色设置');
  theme.setMode('system');
  page.onShow();
  ok(page.data.dark === false, '切回系统浅色');

  /* ---------- 3. onShow 幂等与脏标记 ---------- */
  console.log('== onShow 幂等与脏标记 ==');
  calls.request.length = 0;
  page.onShow();
  await settle();
  ok(calls.request.length === 0, '已加载且无脏标记 → onShow 不重复请求');

  global.getApp = () => ({ globalData: { profileDirty: true } });
  calls.request.length = 0;
  page.onShow();
  await settle();
  ok(calls.request.length === 4, 'profileDirty → 静默重拉三源');
  ok(page.data.isLoading !== true, '静默刷新不回骨架态');

  /* ---------- 4. Tab 切换 ---------- */
  console.log('== Tab 切换 ==');
  page.onTab({ currentTarget: { dataset: { key: 'security' } } });
  ok(page.data.activeTab === 'security', '切到账号与安全');
  const before = page.data.activeTab;
  page.onTab({ currentTarget: { dataset: { key: 'security' } } });
  ok(page.data.activeTab === before, '同 Tab 点击无操作');
  page.onTab({ currentTarget: { dataset: { key: 'badges' } } });
  ok(page.data.activeTab === 'badges', '切回勋章墙');

  console.log('== 勋章墙与战报海报 ==');
  page.onMedalFilter({ currentTarget: { dataset: { key: 'pronunciation' } } });
  ok(page.data.shownMedals.length === 1 && page.data.selectedMedal.id === 'SPEECH_GREAT_10',
    '筛选发音成就时同步更新顶部预览');
  ok(page.data.selectedMedal.progress === 30 && !page.data.selectedMedal.unlocked, '发音勋章保留实际进度及锁定状态');
  page.onMedalFilter({ currentTarget: { dataset: { key: 'all' } } });
  page.onSelectMedal({ currentTarget: { dataset: { id: 'STREAK_3' } } });
  ok(page.data.selectedMedal.status === '已点亮 · 2026-09-01', '点击卡片展示服务端解锁日期');

  const requestsBefore = calls.request.length;
  let respondAchievements;
  requestHandler = (opts) => {
    if (opts.url.endsWith('/achievements')) { respondAchievements = opts; return; }
    serveAll(opts);
  };
  const refresh = page.onRefreshMedals();
  page.onRefreshMedals();
  ok(calls.request.length - requestsBefore === 3 && page.data.medalsLoading, '刷新取统计和成就，进行中重复点击不会再发请求');
  respond(respondAchievements, 503, { error: 'unavailable' });
  await refresh;
  ok(page.data.medals.length === 3 && !!page.data.medalsError, '刷新失败保留上次勋章并提示重试');
  requestHandler = serveAll;
  await page.onRefreshMedals();
  ok(!page.data.medalsError && page.data.selectedMedal.id === 'STREAK_3', '刷新恢复后保留选中的勋章');

  page.onOpenBadgePoster();
  const poster = page.__poster;
  ok(page.data.posterReady && poster.node.width === 1200 && poster.node.height === 1640, '原生画布生成高清战报预览');
  ok(poster.labels.includes('我的学习战报') && poster.labels.includes('三连胜'), '海报绘制实际点亮的勋章');
  page.onPosterTheme({ currentTarget: { dataset: { key: 'editorial' } } });
  ok(page.data.posterTheme === 'editorial' && poster.gradients.includes('#f7f2e7'), '切换海报主题重绘');
  let saved;
  let shared;
  wx.canvasToTempFilePath = (opts) => opts.success({ tempFilePath: 'wxfile://poster.png' });
  wx.saveImageToPhotosAlbum = (opts) => { saved = opts.filePath; opts.success(); opts.complete(); };
  wx.showShareImageMenu = (opts) => { shared = opts.path; opts.complete(); };
  page.onExportBadgePoster({ currentTarget: { dataset: { action: 'save' } } });
  page.onExportBadgePoster({ currentTarget: { dataset: { action: 'share' } } });
  ok(saved === 'wxfile://poster.png' && shared === saved && !page.data.posterBusy, '用户点击后通过微信接口保存或分享海报');
  page.onCloseBadgePoster();
  ok(!page.data.posterOpen && !page.data.posterReady, '关闭海报释放预览状态');
  page.onTab({ currentTarget: { dataset: { key: 'security' } } });

  /* ---------- 4c. 账号与安全：绑定手机/邮箱弹层（阶段 5） ---------- */
  console.log('== 账号与安全 · 绑定弹层 ==');
  ok(page.data.activeTab === 'security', '已在账号与安全 Tab');
  ok(page.data.profile.hasPhone === true && page.data.profile.hasRealEmail === true &&
     page.data.profile.passwordSet === true, '四卡派生就绪（本账号全绑定态）');

  // 手机弹层：表单重置 + 输入过滤（非数字剔除、限 11 位）
  page.onOpenBindPhone();
  ok(page.data.securitySheet === 'phone' && page.data.bindForm.phone === '', '打开手机弹层 + 表单重置');
  page.onPhoneInput({ detail: { value: '138abc12345678' } });
  ok(page.data.bindForm.phone === '13812345678', '手机号输入过滤非数字并截 11 位');
  page.onPhoneInput({ detail: { value: '138' } });
  ok(page.data.bindUi.canSendCode === false, '手机号无效 → 发码不可用');
  await page.onSendCode();
  ok(page.data.bindForm.error === '请输入有效的11位手机号码', '无效手机号发码 → 行内校验文案');

  // 发码成功：请求体 {phone, scene:'BIND'} → notice + 倒计时 60
  page.onPhoneInput({ detail: { value: '13812348000' } });
  ok(page.data.bindUi.canSendCode === true, '有效手机号 → 发码可用');
  calls.request.length = 0;
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/auth/sms/send') >= 0) return respond(opts, 200, { success: true });
    serveAll(opts);
  };
  await page.onSendCode();
  await settle();
  const sendReq = calls.request.find((o) => o.url.indexOf('/api/auth/sms/send') >= 0);
  ok(!!sendReq && sendReq.data.phone === '13812348000' && sendReq.data.scene === 'BIND',
    '发码请求 {phone, scene:BIND}（勿复用写死 LOGIN 的发码）');
  ok(page.data.bindForm.notice === '验证码发送成功', '发码成功 notice 文案');
  ok(page.data.bindForm.countdownSeconds === 60, '倒计时启动 60s');
  await new Promise((r) => setTimeout(r, 1050));
  ok(page.data.bindForm.countdownSeconds === 59, '倒计时 1s 递减');
  page.onCloseSheet();
  ok(page.data.securitySheet === '' && page.data.bindForm.countdownSeconds === 0, '关弹层清倒计时');

  // 业务失败（HTTP 200 + success:false）→ 行内 error，不弹全局 toast
  page.onOpenBindPhone();
  page.onPhoneInput({ detail: { value: '13800000000' } });
  const toastCountBefore = toasts.length;
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/auth/sms/send') >= 0) {
      return respond(opts, 200, { success: false, message: '发送太频繁' });
    }
    serveAll(opts);
  };
  await page.onSendCode();
  await settle();
  ok(page.data.bindForm.error === '发送太频繁' && page.data.bindForm.countdownSeconds === 0,
    '发码业务失败 → 行内 error（assertAction 口径）');
  ok(toasts.length === toastCountBefore, '业务失败不弹全局 toast（showError:false）');

  // 提交绑定手机：校验链 → 成功乐观回写 + 关弹层 + toast
  page.onCodeInput({ detail: { value: '12' } });
  ok(page.data.bindUi.submitEnabled === false, 'code<6 提交不可用');
  await page.onSubmitBind();
  ok(page.data.bindForm.error === '请输入6位验证码', 'code 不足 → 行内文案');
  page.onCodeInput({ detail: { value: '123456' } });
  ok(page.data.bindUi.submitEnabled === true, '表单齐备 → 提交可用');
  calls.request.length = 0;
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/auth/sms/bind') >= 0) return respond(opts, 200, { success: true });
    serveAll(opts);
  };
  await page.onSubmitBind();
  await settle();
  const bindReq = calls.request.find((o) => o.url.indexOf('/api/auth/sms/bind') >= 0);
  ok(!!bindReq && bindReq.data.phone === '13800000000' && bindReq.data.code === '123456', 'sms/bind 请求体');
  ok(page.data.securitySheet === '' && page.data.bindForm.phone === '', '成功关弹层 + 表单重置');
  ok(page.data.profile.phone === '13800000000' && page.data.profile.phoneMasked === '138****0000' &&
     page.data.profile.hasPhone === true, '乐观回写 phone/脱敏/hasPhone（不整页重拉）');
  ok(toasts[toasts.length - 1] === '绑定成功', 'toast 绑定成功');

  // 邮箱弹层：trim / 强度三项实时 / 两密一致 / 校验链 / 回写 passwordSet
  console.log('== 账号与安全 · 绑定邮箱 ==');
  page.onOpenBindEmail();
  ok(page.data.securitySheet === 'email', '打开邮箱弹层');
  page.onEmailInput({ detail: { value: ' wxk@example.com ' } });
  ok(page.data.bindForm.email === 'wxk@example.com', '邮箱输入 trim');
  ok(page.data.bindUi.canSendCode === true, '合法邮箱 → 发码可用');
  page.onPasswordInput({ detail: { value: 'abc' } });
  ok(page.data.bindUi.criteria.length === false && page.data.bindUi.criteria.hasLetter === true &&
     page.data.bindUi.criteria.hasNumber === false && page.data.bindUi.criteria.allMet === false,
    '强度三项实时（abc：仅字母）');
  page.onPasswordInput({ detail: { value: 'abcd1234' } });
  ok(page.data.bindUi.criteria.allMet === true, 'abcd1234 三项全满足');
  page.onConfirmPasswordInput({ detail: { value: 'abcd123' } });
  ok(page.data.bindUi.confirmMatch === false && page.data.bindUi.submitEnabled === false, '两密不一致 → 不可提交');
  await page.onSubmitBind();
  ok(page.data.bindForm.error === '请输入6位邮箱验证码', '校验链：code 空先行文案');
  page.onCodeInput({ detail: { value: '654321' } });
  ok(page.data.bindUi.submitEnabled === false, '两密不一致仍不可提交');
  page.onConfirmPasswordInput({ detail: { value: 'abcd1234' } });
  ok(page.data.bindUi.confirmMatch === true && page.data.bindUi.submitEnabled === true, '两密一致 → 可提交');
  calls.request.length = 0;
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/auth/bind-email/confirm') >= 0) return respond(opts, 200, { success: true });
    serveAll(opts);
  };
  await page.onSubmitBind();
  await settle();
  const emReq = calls.request.find((o) => o.url.indexOf('bind-email/confirm') >= 0);
  ok(!!emReq && emReq.data.email === 'wxk@example.com' && emReq.data.code === '654321' &&
     emReq.data.password === 'abcd1234', 'bind-email/confirm 请求体（email+code+password）');
  ok(page.data.profile.email === 'wxk@example.com' && page.data.profile.emailMasked === 'w**@example.com' &&
     page.data.profile.hasRealEmail === true && page.data.profile.passwordSet === true,
    '乐观回写 email/脱敏/hasRealEmail/passwordSet（绑定即设密码）');
  ok(toasts[toasts.length - 1] === '邮箱绑定成功', 'toast 邮箱绑定成功');
  requestHandler = serveAll;

  /* ---------- 5. 编辑资料跳转 ---------- */
  page.onOpenEdit();
  ok(navigations[navigations.length - 1] === '/pages/profile/edit', '编辑资料 → /pages/profile/edit');

  /* ---------- 6. 下拉刷新 ---------- */
  console.log('== 下拉刷新 ==');
  calls.request.length = 0;
  calls.stopPull = 0;
  page.onPullDownRefresh();
  await settle();
  ok(calls.request.length === 4 && calls.stopPull === 1, '下拉刷新重拉三源 + stopPullDownRefresh');

  /* ---------- 7. profile 404 → 兜底合成 ---------- */
  console.log('== profile 404 兜底 ==');
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/profile') >= 0) return respond(opts, 404, { error: 'Profile not found' });
    serveAll(opts);
  };
  page = makePage();
  page.onLoad();
  page.onShow();
  await settle();
  const vm404 = page.data.profile;
  ok(vm404 && vm404.displayName === '兜底昵称' && vm404.avatarUrl === null, '404 → userInfo 合成最小资料');
  ok(page.data.loadError === '', '404 兜底不算错误态');

  /* ---------- 8. profile 500 → 卡内错误 + 重试 ---------- */
  console.log('== 卡内错误与重试 ==');
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/profile') >= 0) return respond(opts, 500, { error: 'Internal Server Error' });
    serveAll(opts);
  };
  page = makePage();
  page.onLoad();
  page.onShow();
  await settle();
  ok(page.data.profile === null && page.data.loadError === '资料加载失败', '500 → profile 空 + 卡内错误文案');
  ok(page.data.isLoading === false, '错误不回页级骨架（卡内态）');

  requestHandler = serveAll;
  page.onRetry();
  await settle();
  ok(page.data.profile && page.data.profile.displayName === '远路漫漫', '点击重试恢复资料');

  /* ---------- 9. 注销账号（阶段 5：二次确认 → DELETE → logout → 1.2s navigateBack） ---------- */
  console.log('== 注销账号 ==');
  // 失败分支：业务失败 → toast 后端文案 + 弹窗复位
  page = makePage();
  page.onLoad();
  page.onShow();
  await settle();
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/self-delete') >= 0) {
      return respond(opts, 200, { success: false, message: '服务繁忙' });
    }
    serveAll(opts);
  };
  page.onOpenDeleteConfirm();
  ok(page.data.deleteConfirmOpen === true, '打开注销二次确认弹窗');
  await page.onConfirmDelete();
  await settle();
  ok(page.data.deletingAccount === false && page.data.deleteConfirmOpen === false, '注销失败复位弹窗与旗标');
  ok(toasts[toasts.length - 1] === '服务繁忙', '失败 toast 后端文案（自管，非全局）');

  // 成功分支：DELETE → authStore.logout + accountDeleted + toast + 1.2s 后 navigateBack
  requestHandler = (opts) => {
    if (opts.url.indexOf('/api/user/self-delete') >= 0) {
      return respond(opts, 200, { success: true, message: 'ok' });
    }
    serveAll(opts);
  };
  page.onOpenDeleteConfirm();
  await page.onConfirmDelete();
  await settle();
  const delReq = calls.request.find((o) => o.url.indexOf('/api/user/self-delete') >= 0);
  ok(!!delReq && delReq.method === 'DELETE', 'DELETE /api/user/self-delete 发出');
  ok(page.data.accountDeleted === true && page.data.deleteConfirmOpen === false, '注销成功态（弹窗已关）');
  ok(authStore.getState().isLoggedIn === false, 'authStore.logout 清会话（回 mine 游客态）');
  ok(toasts[toasts.length - 1] === '账号已成功注销', 'toast 账号已成功注销');
  await new Promise((r) => setTimeout(r, 1300));
  ok(navigations[navigations.length - 1] === '__back__', '约 1.2s 后 navigateBack（对齐 Android delay(1200)+onBack）');
  requestHandler = serveAll;

  /* ---------- 收尾 ---------- */
  console.log('\n========== 个人中心主页测试：' + passed + ' 通过 / ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
