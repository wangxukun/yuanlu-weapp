/**
 * pages/profile/edit.js — 「编辑资料」全屏页（阶段 6）
 *
 * UI 复刻 Android EditProfileDialog.kt（全屏 Dialog 等价：navigationStyle custom +
 * disableScroll 自管 scroll-view）：品牌渐变头部（横向 primary 8%→secondary 8%，源码
 * horizontalGradient）+ 双 Tab 分段（个人资料 person / 学习目标 tune，选中白底胶囊）
 * + 底部固定操作条（取消 + 保存所有更改，键盘弹起抬升 onKeyboardHeightChange=imePadding 等价）。
 *
 * 表单（VM openEdit 初始化口径）：
 *   - 昵称/签名原值回填（bio 空→默认座右铭）；learnLevel 缺省 Beginner；
 *     三目标缺省 20/2/50，滑杆每次输入 coerceIn 钳制（VM update 口径）
 *   - 头像：wx.chooseMedia → wx.getImageInfo → 居中正方形裁剪 + 最长边 512 下采样 +
 *     JPEG q0.88（core.avatarCropRect 参数化，cropSquareJpeg 等价）→ 隐藏 canvas 2d
 *     绘制 → canvasToTempFilePath；选图/解码失败静默保持原图（runCatching 同口径）
 *
 * 保存（VM saveProfile 口径）：
 *   - validateNickname/validateBio → 失败标红；昵称错切回 Tab1（bio 错不切）
 *   - 有新头像走 uploadFile multipart、纯文本走 JSON POST（T1.1 别名端点）
 *   - 成功 profileDirty=true + authStore.fetchProfile() 后台刷 storage（mine 页
 *     onShow 吃到新头像昵称）+ toast「设置已更新」+ navigateBack；失败 JSON 路径
 *     request.js 已全局 toast 勿重复，upload 路径自管 toast
 */
const theme = require('../../utils/theme');
const authStore = require('../../store/authStore');
const core = require('../../utils/profile-core');
const api = require('../../utils/api/profile');

/** 滑杆三组定义（min/max/步进/文案——GoalSlider 调用处口径钉死） */
const GOAL_SLIDERS = [
  { key: 'dailyStudyGoalMins', title: '每日学习时长目标', unit: ' 分钟', min: 10, max: 120, step: 5, minLabel: '10m', midLabel: '60m', maxLabel: '120m' },
  { key: 'weeklyListeningGoalHours', title: '每周收听目标', unit: ' 小时', min: 1, max: 20, step: 1, minLabel: '1h', midLabel: '10h', maxLabel: '20h' },
  { key: 'weeklyWordsGoal', title: '每周单词目标', unit: ' 个', min: 10, max: 200, step: 5, minLabel: '10', midLabel: '100', maxLabel: '200' },
];

Page({
  data: {
    themeClass: '', // 手动外观根类（跟随系统为空，走媒体查询）
    dark: false,
    statusBarH: 20,
    kbH: 0, // 键盘高度（底部操作条抬升，imePadding 等价）
    sliderActive: '#1f7a5c', // slider 组件色不支持 CSS 变量，data 驱动深浅
    sliderTrack: '#e3ddcf',
    // ---- 加载态 ----
    loading: true,
    loadError: false,
    // ---- Tab ----
    editTab: 'profile', // 'profile' | 'goals'
    // ---- 表单（openEdit 口径） ----
    formNickname: '',
    formBio: '',
    formLearnLevel: 'Beginner',
    formDailyGoalMins: 20,
    formWeeklyHours: 2,
    formWeeklyWords: 50,
    formAvatarTemp: '', // 新选裁剪图临时路径（空 = 未换头像）
    formAvatarVersion: 0, // 强制 image 重载
    hasHttpAvatar: false, // 旧头像是否 http 可显
    avatarPreview: '', // 预览 src：新裁剪图 > 旧 http 头像 > ''（占位）
    nicknameError: '',
    bioError: '',
    levelChips: core.LEARN_LEVELS,
    goalSliders: GOAL_SLIDERS,
    isSaving: false,
    // ---- 裁剪画布（隐藏，算术定寸） ----
    cropW: 0,
    cropH: 0,
  },

  onLoad() {
    try {
      const win = wx.getSystemInfoSync();
      this.setData({ statusBarH: (win && win.statusBarHeight) || 20 });
    } catch (e) {
      /* 取不到用默认值 */
    }
    if (wx.onKeyboardHeightChange) {
      this._onKb = (res) => this.setData({ kbH: (res && res.height) || 0 });
      wx.onKeyboardHeightChange(this._onKb);
    }
    this.fetchForm();
  },

  onShow() {
    const __t = theme.getState();
    const dark = __t.effective === 'dark';
    this.setData({
      themeClass: __t.rootClass,
      dark: dark,
      sliderActive: dark ? '#4da989' : '#1f7a5c',
      sliderTrack: dark ? '#38332a' : '#e3ddcf',
    });
    theme.applyChrome();
  },

  onUnload() {
    if (wx.offKeyboardHeightChange && this._onKb) wx.offKeyboardHeightChange(this._onKb);
  },

  /** 拉取 profile 初始化表单（与主页同口径：404 兜底合成） */
  fetchForm() {
    api
      .getProfile()
      .then((raw) => {
        const vm = core.mapProfile(raw, authStore.getState().userInfo);
        if (!vm) {
          this.setData({ loading: false, loadError: true });
          return;
        }
        this.initForm(vm);
      })
      .catch(() => this.setData({ loading: false, loadError: true }));
  },

  initForm(vm) {
    const httpAvatar = !!(vm.avatarUrl && vm.avatarUrl.indexOf('http') === 0);
    this.setData({
      loading: false,
      loadError: false,
      formNickname: vm.nickname || '',
      formBio: vm.bio || core.DEFAULT_BIO, // Android null→默认座右铭；s() 归一后空串同回退
      formLearnLevel: vm.learnLevel || 'Beginner',
      formDailyGoalMins: this.clampGoal(GOAL_SLIDERS[0], vm.dailyStudyGoalMins, 20),
      formWeeklyHours: this.clampGoal(GOAL_SLIDERS[1], vm.weeklyListeningGoalHours, 2),
      formWeeklyWords: this.clampGoal(GOAL_SLIDERS[2], vm.weeklyWordsGoal, 50),
      formAvatarTemp: '',
      hasHttpAvatar: httpAvatar,
      avatarPreview: httpAvatar ? vm.avatarUrl : '',
      nicknameError: '',
      bioError: '',
    });
  },

  /** 滑杆值钳制（VM 口径：null/坏值 → openEdit 缺省；数值 → coerceIn + 步进取整） */
  clampGoal(def, value, fallback) {
    const n = Math.round(Number(value));
    if (!isFinite(n) || value == null) return fallback;
    const clamped = Math.min(def.max, Math.max(def.min, n));
    return Math.round(clamped / def.step) * def.step;
  },

  // ==================== Tab 切换 ====================

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab === 'goals' ? 'goals' : 'profile';
    this.setData({ editTab: tab });
  },

  // ==================== 表单输入 ====================

  /** 昵称：即时重校验（有错才重算，无错不标——VM updateNickname 口径） */
  onNicknameInput(e) {
    const v = String((e.detail || {}).value || '');
    const patch = { formNickname: v };
    if (this.data.nicknameError) patch.nicknameError = core.validateNickname(v) || '';
    this.setData(patch);
  },

  onBioInput(e) {
    const v = String((e.detail || {}).value || '');
    const patch = { formBio: v };
    if (this.data.bioError) patch.bioError = core.validateBio(v) || '';
    this.setData(patch);
  },

  onLevelTap(e) {
    const value = e.currentTarget.dataset.value;
    if (!value || value === this.data.formLearnLevel) return;
    this.setData({ formLearnLevel: value });
  },

  onGoalSlide(e) {
    const key = e.currentTarget.dataset.key;
    const def = GOAL_SLIDERS.find(function (d) { return d.key === key; });
    if (!def) return;
    const field =
      key === 'dailyStudyGoalMins' ? 'formDailyGoalMins' :
      key === 'weeklyListeningGoalHours' ? 'formWeeklyHours' : 'formWeeklyWords';
    const patch = {};
    patch[field] = this.clampGoal(def, e.detail.value, def.min);
    this.setData(patch);
  },

  // ==================== 头像选择与裁剪 ====================

  /** 选图 → 取尺寸 → 隐藏 canvas 居中方形裁剪 + ≤512 下采样 + JPEG 0.88 */
  onPickAvatar() {
    const self = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success(res) {
        const tmp = res && res.tempFiles && res.tempFiles[0];
        if (!tmp || !tmp.path) return;
        wx.getImageInfo({
          src: tmp.path,
          success(info) {
            const rect = core.avatarCropRect(info.width, info.height, 512);
            if (!rect) return; // 非法尺寸静默保持原图（runCatching 同口径）
            self.cropAvatar(tmp.path, rect);
          },
          fail() {},
        });
      },
      fail() {},
    });
  },

  cropAvatar(src, rect) {
    const self = this;
    this.setData({ cropW: rect.dSide, cropH: rect.dSide });
    const query = this.createSelectorQuery();
    query
      .select('#cropCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        const entry = res && res[0];
        if (!entry || !entry.node) return;
        const canvas = entry.node;
        // 裁剪目标就是 ≤512 的逻辑像素，直出该尺寸（不乘 dpr，避免无谓大缓冲）
        canvas.width = rect.dSide;
        canvas.height = rect.dSide;
        const ctx = canvas.getContext('2d');
        const img = canvas.createImage();
        img.onload = function () {
          ctx.clearRect(0, 0, rect.dSide, rect.dSide);
          ctx.drawImage(img, rect.sx, rect.sy, rect.sSide, rect.sSide, 0, 0, rect.dSide, rect.dSide);
          wx.canvasToTempFilePath({
            canvas: canvas,
            fileType: 'jpg',
            quality: 0.88,
            success(r) {
              self.setData({
                formAvatarTemp: r.tempFilePath,
                formAvatarVersion: self.data.formAvatarVersion + 1,
                avatarPreview: r.tempFilePath,
              });
            },
            fail() {},
          });
        };
        img.onerror = function () {};
        img.src = src;
      });
  },

  // ==================== 保存与退出（VM saveProfile 口径） ====================

  async onSave() {
    if (this.data.isSaving) return;
    const ne = core.validateNickname(this.data.formNickname);
    const be = core.validateBio(this.data.formBio);
    if (ne || be) {
      this.setData({ nicknameError: ne || '', bioError: be || '' });
      if (ne) this.setData({ editTab: 'profile' }); // 昵称错切回 Tab1（bio 错不切）
      return;
    }
    this.setData({ isSaving: true });
    const goals = core.coerceGoals(
      this.data.formDailyGoalMins,
      this.data.formWeeklyHours,
      this.data.formWeeklyWords
    );
    const fields = {
      nickname: this.data.formNickname.trim(),
      bio: this.data.formBio.trim(),
      learnLevel: this.data.formLearnLevel,
      dailyStudyGoalMins: goals.dailyStudyGoalMins,
      weeklyListeningGoalHours: goals.weeklyListeningGoalHours,
      weeklyWordsGoal: goals.weeklyWordsGoal,
    };
    const withAvatar = !!this.data.formAvatarTemp;
    const task = withAvatar
      ? api.uploadProfileWithAvatar(this.data.formAvatarTemp, fields)
      : api.saveProfile(fields);
    try {
      const body = await task;
      if (body && body.success === false) {
        // JSON 路径 HTTP 200 业务失败（自管 toast）
        this.setData({ isSaving: false });
        wx.showToast({ title: body.message || body.error || '保存失败，请重试', icon: 'none' });
        return;
      }
      getApp().globalData.profileDirty = true; // 主页 onShow 静默重拉
      authStore.fetchProfile(); // 后台刷 storage：mine 页 onShow 吃到新头像昵称
      this.setData({ isSaving: false }); // Android 靠整页关闭复位；weapp 防 navigateBack 被打断后锁死
      wx.showToast({ title: '设置已更新', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 300);
    } catch (err) {
      this.setData({ isSaving: false });
      // JSON 路径走 request.js 已全局 toast 勿重复；uploadFile 路径不走 request.js 自管
      if (withAvatar) {
        wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none' });
      }
    }
  },

  /** 关闭/取消（保存中禁关——防成功回调 navigateBack 落空页） */
  onGoBack() {
    if (this.data.isSaving) return;
    wx.navigateBack();
  },
});
