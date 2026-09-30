/**
 * scripts/test-profile-edit.js — 「编辑资料」全屏页（阶段 6）自动化测试
 *
 * 在 Node 环境中 mock 微信全局对象（wx / Page / getApp / createSelectorQuery），
 * 全链路驱动 pages/profile/edit.js → utils/api/profile.js → utils/request.js / wx.uploadFile：
 * 覆盖表单初始化（profile 回填/404 兜底）、Tab 切换、昵称即时重校验、水平 chip、
 * 滑杆钳制（越界收边/步进取整/NaN 中位）、头像裁剪链路（chooseMedia→getImageInfo→
 * 居中方形+512 下采样 drawImage 9 参→canvasToTempFilePath jpg q0.88→预览替换）、
 * 保存校验链（空昵称切回 Tab1/bio 超限）、保存成功双路径（JSON POST 字段
 * trim+coerceGoals / uploadFile multipart 参数）、profileDirty+fetchProfile、
 * 失败复位、保存中禁关。
 *
 * 运行：node scripts/test-profile-edit.js
 */

/* ==================== mock 基础设施 ==================== */

const storage = new Map();
const toasts = [];
const navigations = [];
const calls = {
  request: [],
  upload: [],
  chooseMedia: 0,
  getImageInfo: [],
  canvasToTempFilePath: [],
  keyboard: [],
};
let requestHandler = null;

global.wx = {
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => toasts.push(o.title),
  navigateBack: () => navigations.push('__back__'),
  stopPullDownRefresh: () => {},
  getAppBaseInfo: () => ({ theme: 'light' }),
  getSystemInfoSync: () => ({ theme: 'light', windowWidth: 375, pixelRatio: 2, statusBarHeight: 44 }),
  setNavigationBarColor: () => {},
  setTabBarStyle: () => {},
  onKeyboardHeightChange: (cb) => { calls.keyboard.push('on'); global.__kbCb = cb; },
  offKeyboardHeightChange: () => { calls.keyboard.push('off'); global.__kbCb = null; },
  chooseMedia: (o) => {
    calls.chooseMedia++;
    calls.chooseMediaOpts = o;
    if (calls.chooseMediaFail) return o.fail && o.fail({});
    o.success({ tempFiles: [{ path: 'wxfile://raw.png' }] });
  },
  getImageInfo: (o) => {
    calls.getImageInfo.push(o);
    if (calls.imageInfoFail) return o.fail && o.fail({});
    o.success(Object.assign({ path: 'wxfile://raw.png' }, calls.imageInfoSize || { width: 1080, height: 1920 }));
  },
  canvasToTempFilePath: (o) => {
    calls.canvasToTempFilePath.push(o);
    if (calls.canvasFail) return o.fail && o.fail({});
    o.success({ tempFilePath: 'wxfile://cropped.jpg' });
  },
  uploadFile: (o) => {
    calls.upload.push(o);
    if (calls.uploadFail) return o.fail && o.fail({ errMsg: 'uploadFile:fail' });
    o.success({ statusCode: 200, data: JSON.stringify({ success: true, data: {} }) });
  },
  request: (opts) => {
    calls.request.push(opts);
    if (requestHandler) requestHandler(opts);
  },
};

let appGlobal = { profileDirty: false };
global.getApp = () => ({ globalData: appGlobal });

let pageConfig = null;
global.Page = (cfg) => { pageConfig = cfg; };

function respond(opts, statusCode, data) {
  opts.success({ statusCode, data, errMsg: 'request:ok' });
}

const flush = () => new Promise((r) => setImmediate(r));
async function settle(times) {
  for (let i = 0; i < (times || 6); i++) await flush();
}

/** 裁剪画布记录桩：createImage 的 src setter 同步触发 onload（测试同步够用） */
function makeCropCanvas() {
  const rec = { width: 0, height: 0, clearRect: 0, drawImage: [] };
  const ctx = {
    clearRect() { rec.clearRect++; },
    drawImage(...args) { rec.drawImage.push(args); },
  };
  const node = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    createImage() {
      const img = { onload: null, onerror: null };
      Object.defineProperty(img, 'src', {
        set(v) { this._src = v; if (this.onload) this.onload(); },
        get() { return this._src; },
        configurable: true,
      });
      return img;
    },
  };
  return { node, rec };
}

function makePage() {
  const page = Object.assign({}, pageConfig);
  page.data = JSON.parse(JSON.stringify(pageConfig.data));
  page.setData = function (patch) {
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
  };
  const crop = makeCropCanvas();
  page.__crop = crop;
  page.createSelectorQuery = () => ({
    select(id) {
      return {
        fields() {
          return { exec(cb) { cb([id === '#cropCanvas' ? { node: crop.node } : null]); } };
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
  User: { userid: 'u1', email: 'ab@ex.com', phone: '13812348000', role: 'USER', createAt: '2026-01-02T18:30:00.000Z' },
};

function serveAll(opts) {
  if (opts.method === 'GET' && opts.url.indexOf('/api/user/profile') >= 0) {
    return respond(opts, 200, PROFILE_DTO);
  }
  if (opts.method === 'POST' && opts.url.indexOf('/api/user/profile') >= 0) {
    return respond(opts, 200, { success: true, data: {} });
  }
  respond(opts, 404, { error: 'not found' });
}

/* ==================== 加载被测模块（mock 就绪后） ==================== */

const theme = require('../utils/theme');
const authStore = require('../store/authStore');
require('../pages/profile/edit');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}

(async function main() {
  /* ---------- 1. 表单初始化 ---------- */
  console.log('== 表单初始化 ==');
  authStore.setLoginData('tok-1', { userid: 'u1', nickname: '兜底昵称', email: 'ab@ex.com' });
  await settle();
  requestHandler = serveAll;
  calls.request.length = 0;

  let page = makePage();
  page.onLoad();
  await settle();
  ok(page.data.statusBarH === 44, 'onLoad 取 statusBarHeight');
  ok(calls.keyboard[0] === 'on', '订阅键盘高度变化（底部条抬升）');
  ok(page.data.loading === false && page.data.loadError === false, 'profile 拉取完成');
  ok(page.data.formNickname === '远路漫漫', '昵称回填');
  ok(page.data.formBio === '路虽远行则将至，事虽难做则成。', 'bio 空 → 默认座右铭（openEdit 口径）');
  ok(page.data.formLearnLevel === 'Beginner', '水平回填');
  ok(page.data.formDailyGoalMins === 30 && page.data.formWeeklyHours === 5 && page.data.formWeeklyWords === 50,
    '三目标回填');
  ok(page.data.hasHttpAvatar === true && page.data.avatarPreview === PROFILE_DTO.avatarUrl,
    'http 头像预览');
  ok(page.data.editTab === 'profile', '默认 Tab=个人资料');
  ok(page.data.levelChips.length === 4 && page.data.levelChips[0].label === '未分级',
    '水平 chips（LEARN_LEVELS 顺序）');
  ok(page.data.goalSliders[0].min === 10 && page.data.goalSliders[0].max === 120 && page.data.goalSliders[0].step === 5 &&
     page.data.goalSliders[1].min === 1 && page.data.goalSliders[1].max === 20 && page.data.goalSliders[1].step === 1 &&
     page.data.goalSliders[2].min === 10 && page.data.goalSliders[2].max === 200 && page.data.goalSliders[2].step === 5,
    '三组滑杆范围/步进钉死');

  // 404 兜底：邮箱新用户无 profile 行 → userInfo 合成（learnLevel 缺省 Beginner、目标缺省 20/2/50）
  requestHandler = (opts) => {
    if (opts.method === 'GET' && opts.url.indexOf('/api/user/profile') >= 0) {
      return respond(opts, 404, { error: 'Profile not found' });
    }
    serveAll(opts);
  };
  page = makePage();
  page.onLoad();
  await settle();
  ok(page.data.formNickname === '兜底昵称' && page.data.formLearnLevel === 'Beginner',
    '404 → 兜底合成表单（水平缺省 Beginner）');
  ok(page.data.formDailyGoalMins === 20 && page.data.formWeeklyHours === 2 && page.data.formWeeklyWords === 50,
    '404 → 三目标缺省 20/2/50');
  requestHandler = serveAll;

  /* ---------- 2. Tab 切换与主题 ---------- */
  console.log('== Tab 切换与主题 ==');
  page.onShow();
  ok(page.data.sliderActive === '#1f7a5c' && page.data.sliderTrack === '#e3ddcf', '浅色滑杆色（data 驱动）');
  page.onSwitchTab({ currentTarget: { dataset: { tab: 'goals' } } });
  ok(page.data.editTab === 'goals', '切到学习目标');
  page.onSwitchTab({ currentTarget: { dataset: { tab: 'goals' } } });
  ok(page.data.editTab === 'goals', '同 Tab 点击无操作');
  theme.setMode('dark');
  page.onShow();
  ok(page.data.dark === true && page.data.sliderActive === '#4da989' && page.data.sliderTrack === '#38332a',
    '深色滑杆换深变体');
  theme.setMode('system');
  page.onShow();

  /* ---------- 3. 输入与校验 ---------- */
  console.log('== 输入与校验 ==');
  page.onSwitchTab({ currentTarget: { dataset: { tab: 'profile' } } });
  // 即时重校验：先制造错误再修正
  page.onNicknameInput({ detail: { value: '' } });
  page.onSave();
  await settle();
  ok(page.data.nicknameError === '请输入昵称' && page.data.editTab === 'profile',
    '空昵称保存 → 错误标红（VM：昵称错保持在/切回 Tab1）');
  ok(calls.request.every((o) => o.method !== 'POST'), '校验失败不发请求');
  page.onNicknameInput({ detail: { value: '新名字' } });
  ok(page.data.nicknameError === '', '修正后即时清错（updateNickname 口径）');
  page.onBioInput({ detail: { value: 'x'.repeat(101) } });
  page.onSave();
  await settle();
  ok(page.data.bioError === '简介不能超过 100 个字' && page.data.editTab === 'profile',
    'bio 超限 → 标红不切 Tab');
  page.onBioInput({ detail: { value: '新的签名' } });
  ok(page.data.bioError === '', 'bio 修正即时清错');

  // 水平 chip
  page.onLevelTap({ currentTarget: { dataset: { value: 'Intermediate' } } });
  ok(page.data.formLearnLevel === 'Intermediate', '水平 chip 选中');
  page.onLevelTap({ currentTarget: { dataset: { value: 'Intermediate' } } });
  ok(page.data.formLearnLevel === 'Intermediate', '同 chip 再点无操作');

  // 滑杆钳制
  page.onGoalSlide({ currentTarget: { dataset: { key: 'dailyStudyGoalMins' } }, detail: { value: 999 } });
  ok(page.data.formDailyGoalMins === 120, '每日目标越界收边 120（步进 5 对齐）');
  page.onGoalSlide({ currentTarget: { dataset: { key: 'weeklyListeningGoalHours' } }, detail: { value: 0 } });
  ok(page.data.formWeeklyHours === 1, '每周小时收边 1');
  page.onGoalSlide({ currentTarget: { dataset: { key: 'weeklyWordsGoal' } }, detail: { value: 'NaN' } });
  ok(page.data.formWeeklyWords === 10, '滑杆坏值落 min 10（表单回填 null 才走缺省 50）');
  page.onGoalSlide({ currentTarget: { dataset: { key: 'dailyStudyGoalMins' } }, detail: { value: 62 } });
  ok(page.data.formDailyGoalMins === 60, '62 → 步进 5 取整 60');

  /* ---------- 4. 头像裁剪链路 ---------- */
  console.log('== 头像裁剪链路 ==');
  page.onPickAvatar();
  ok(calls.chooseMediaOpts && calls.chooseMediaOpts.count === 1 &&
     JSON.stringify(calls.chooseMediaOpts.mediaType) === JSON.stringify(['image']) &&
     JSON.stringify(calls.chooseMediaOpts.sizeType) === JSON.stringify(['compressed']),
    'chooseMedia 参数（count1/image/compressed）');
  await settle();
  ok(page.data.cropW === 512 && page.data.cropH === 512, '裁剪画布算术定寸 512（1080×1920 源）');
  const di = page.__crop.rec.drawImage[0];
  ok(di && di.length === 9 && di[1] === 0 && di[2] === 420 && di[3] === 1080 && di[4] === 1080 &&
     di[5] === 0 && di[6] === 0 && di[7] === 512 && di[8] === 512,
    'drawImage 9 参：居中 1080 方形（sy=420）→ 512 直出');
  const c2t = calls.canvasToTempFilePath[0];
  ok(c2t && c2t.fileType === 'jpg' && c2t.quality === 0.88, 'canvasToTempFilePath jpg q0.88');
  ok(page.data.formAvatarTemp === 'wxfile://cropped.jpg' &&
     page.data.avatarPreview === 'wxfile://cropped.jpg' && page.data.formAvatarVersion === 1,
    '裁剪产物入表单 + 预览替换');

  // 小图不放大：300×200 → 200 方形原尺寸
  calls.imageInfoSize = { width: 300, height: 200 };
  page.onPickAvatar();
  await settle();
  const di2 = page.__crop.rec.drawImage[1];
  ok(di2 && di2[1] === 50 && di2[2] === 0 && di2[3] === 200 && di2[7] === 200 && di2[8] === 200,
    '小图 300×200 → 居中 200 方形不放大');
  calls.imageInfoSize = null;

  // 选图失败静默保持原图（runCatching 同口径）
  calls.chooseMediaFail = true;
  const tempBefore = page.data.formAvatarTemp;
  page.onPickAvatar();
  await settle();
  ok(page.data.formAvatarTemp === tempBefore, '选图失败静默保持');
  calls.chooseMediaFail = false;

  /* ---------- 5. 保存：JSON 路径 ---------- */
  console.log('== 保存（JSON 路径） ==');
  // 先清掉已选头像（回到无新头像的 JSON 分支）
  page = makePage();
  page.onLoad();
  await settle();
  page.onNicknameInput({ detail: { value: '  新名字  ' } });
  page.onBioInput({ detail: { value: '  新签名  ' } });
  page.onLevelTap({ currentTarget: { dataset: { value: 'Advanced' } } });
  calls.request.length = 0;
  appGlobal = { profileDirty: false };
  await page.onSave();
  await settle();
  const saveReq = calls.request.find((o) => o.method === 'POST' && o.url.indexOf('/api/user/profile') >= 0);
  ok(!!saveReq, '无新头像 → JSON POST /api/user/profile');
  ok(saveReq && saveReq.data.nickname === '新名字' && saveReq.data.bio === '新签名' &&
     saveReq.data.learnLevel === 'Advanced', '字段 trim + learnLevel');
  ok(saveReq && saveReq.data.dailyStudyGoalMins === 30 && saveReq.data.weeklyListeningGoalHours === 5 &&
     saveReq.data.weeklyWordsGoal === 50, '三目标原值提交（coerceGoals 兜底）');
  ok(appGlobal.profileDirty === true, '保存成功 profileDirty=true（主页 onShow 静默重拉）');
  ok(toasts[toasts.length - 1] === '设置已更新', 'toast 设置已更新');
  ok(page.data.isSaving === false, 'isSaving 复位');
  await new Promise((r) => setTimeout(r, 400));
  ok(navigations[navigations.length - 1] === '__back__', 'toast 后 navigateBack');
  ok(calls.request.some((o) => o.method === 'GET' && o.url.indexOf('/api/user/profile') >= 0),
    'authStore.fetchProfile 后台刷新触发（mine 页 onShow 吃到新头像昵称）');

  /* ---------- 6. 保存：upload 路径与失败分支 ---------- */
  console.log('== 保存（upload 路径与失败） ==');
  page = makePage();
  page.onLoad();
  await settle();
  page.onPickAvatar(); // 1080×1920 → 裁剪
  await settle();
  ok(page.data.formAvatarTemp === 'wxfile://cropped.jpg', '已选新头像');
  calls.upload.length = 0;
  await page.onSave();
  await settle();
  const up = calls.upload[0];
  ok(!!up && up.url.indexOf('/api/user/profile') >= 0 && up.name === 'avatar' &&
     up.filePath === 'wxfile://cropped.jpg', 'uploadFile url/name/filePath');
  ok(up && up.header && String(up.header.Authorization).indexOf('Bearer tok-1') === 0, 'uploadFile 带 Bearer token');
  ok(up && up.formData.nickname === '远路漫漫' && up.formData.learnLevel === 'Beginner' &&
     up.formData.dailyStudyGoalMins === 30, 'formData 六文本字段');
  ok(appGlobal.profileDirty === true && toasts[toasts.length - 1] === '设置已更新', 'upload 成功同口径收尾');

  // upload 失败：自管 toast（不走 request.js）+ isSaving 复位
  calls.uploadFail = true;
  page = makePage();
  page.onLoad();
  await settle();
  page.onPickAvatar();
  await settle();
  const toastBefore = toasts.length;
  await page.onSave();
  await settle();
  ok(page.data.isSaving === false, 'upload 失败 isSaving 复位');
  ok(toasts.length === toastBefore + 1, 'upload 失败自管 toast（勿静默）');
  calls.uploadFail = false;

  // JSON 失败（HTTP 500）：request.js 已全局 toast，页面只复位不重复
  requestHandler = (opts) => {
    if (opts.method === 'POST' && opts.url.indexOf('/api/user/profile') >= 0) {
      return respond(opts, 500, { error: '服务器错误' });
    }
    serveAll(opts);
  };
  page = makePage();
  page.onLoad();
  await settle();
  const toastBefore2 = toasts.length;
  await page.onSave();
  await settle();
  ok(page.data.isSaving === false && toasts.length === toastBefore2 + 1,
    'JSON 失败：仅 request.js 全局 toast 一发，页面不重复');
  requestHandler = serveAll;

  // 保存中禁关（防成功回调 navigateBack 落空）
  page = makePage();
  page.onLoad();
  await settle();
  page.setData({ isSaving: true });
  navigations.length = 0;
  page.onGoBack();
  ok(navigations.length === 0, '保存中点关闭/取消被拦');

  /* ---------- 收尾 ---------- */
  page.onUnload();
  ok(calls.keyboard[calls.keyboard.length - 1] === 'off', 'onUnload 取消键盘订阅');
  console.log('\n========== 编辑资料页测试：' + passed + ' 通过 / ' + failed + ' 失败 ==========');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
