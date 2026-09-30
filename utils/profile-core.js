/**
 * utils/profile-core.js — 个人中心纯逻辑层（PROFILE-TASK 阶段 0，T0.1）
 *
 * yuanlu-android feature/profile/ProfileUtils.kt 逐函数全量移植（口径唯一来源，
 * 冲突时以 ProfileUtils.kt 为准）+ DTO→视图模型映射（WXML 零方法调用红线：
 * 页面 require 本模块组装完成再 setData）。纯 Node 可测，无任何 wx 依赖；
 * 图表几何函数（T0.2：monotone 面积图曲线 / 里程碑路图坐标与脉冲插值 / 折线
 * 长度裁剪）在本文件后半，dp→px 换算统一以 W/375（= 750rpx 满宽）口径。
 *
 * 源文件对照：
 * - 常量/换算/校验/脱敏：ProfileUtils.kt（L14-182）
 * - 响应形状：ProfileDtos.kt + domain/model/Models.kt（UserProfile 及 toDomain 展平）
 * - 404 兜底：AuthRepositoryImpl.kt toFallbackProfile（L421-430）——邮箱注册只建
 *   User 行不建 user_profile 行（Web/Android sign-up 同口径），GET /api/user/profile
 *   在首次编辑资料（PUT upsert）前恒 404 "Profile not found"；weapp 兜底源为
 *   authStore.userInfo（登录响应的最小身份，见 store/authStore.js）
 * - 安全派生：PersonalCenterScreen.kt SecuritySection（L1112-1115）
 * - 学习目标钳制：UserProfileViewModel.kt（L273-281 coerceIn 10-120 / 1-20 / 10-200）
 */

// ---------- 常量（ProfileUtils.kt L17-50） ----------

/** 步行速度 5km/h → 1 小时收听 = 5km 里程（Web StatsOverview/MilestoneRoadmap 同值） */
const KM_PER_HOUR = 5;

/** 未设置简介时的默认座右铭 */
const DEFAULT_BIO = '路虽远行则将至，事虽难做则成。';

/** 昵称长度上限（超出即校验失败） */
const NICKNAME_MAX_LENGTH = 20;

/** 简介长度上限 */
const BIO_MAX_LENGTH = 100;

/** 远路里程碑（km → 名称），与 Web MILESTONES 一致；末项 100.0 = 全程阈值 */
const MILESTONES = [
  { km: 1.0, name: '起步' },
  { km: 5.0, name: '小径' },
  { km: 21.1, name: '半马' },
  { km: 42.2, name: '全马' },
  { km: 100.0, name: '远路' },
];

/** 水平键 → 中文称号（levelLabel 用） */
const LEVEL_MAPPING = {
  Beginner: '初级',
  Intermediate: '中级',
  Advanced: '高级',
  General: '未分级',
};

/** 学习水平表单选项（值 → 展示文案），顺序对齐 Web 下拉框 / Android FilterChip */
const LEARN_LEVELS = [
  { value: 'General', label: '未分级' },
  { value: 'Beginner', label: '初级' },
  { value: 'Intermediate', label: '中级' },
  { value: 'Advanced', label: '高级' },
];

/** 学习目标滑杆范围（VM coerceIn 同值；min/max 闭区间，步进 5/1/5 属编辑页 UI 口径） */
const GOAL_RANGES = {
  dailyStudyGoalMins: { min: 10, max: 120 },
  weeklyListeningGoalHours: { min: 1, max: 20 },
  weeklyWordsGoal: { min: 10, max: 200 },
};

// ---------- 换算与展示（ProfileUtils.kt L53-71） ----------

/** 累计收听小时 → 里程 */
function totalKm(totalHours) {
  return (Number(totalHours) || 0) * KM_PER_HOUR;
}

/** 里程展示：固定一位小数（Web toFixed(1)） */
function formatKm(km) {
  return (Number(km) || 0).toFixed(1);
}

/** 小时数展示：整数值省略小数点（JS `${12.0}h` 渲染为 "12h" 的口径） */
function formatHours(hours) {
  const h = Number(hours) || 0;
  return Number.isInteger(h) ? String(h) : String(h);
}

/** 水平键 → 中文；null 视为中级（Web fetchProfile 的 `data.learnLevel || "中级"` 口径） */
function levelLabel(level) {
  const v = level == null ? '' : String(level);
  if (LEVEL_MAPPING[v]) return LEVEL_MAPPING[v];
  return v !== '' ? v : '中级';
}

/** 昵称为空时回退邮箱前缀，再回退 User（Web 头部标题同口径） */
function displayName(nickname, email) {
  const n = nickname == null ? '' : String(nickname);
  if (n.trim() !== '') return n;
  const e = email == null ? '' : String(email);
  const prefix = e.split('@')[0];
  if (prefix.trim() !== '') return prefix;
  return 'User';
}

/** 简介展示：空时回退默认座右铭 */
function displayBio(bio) {
  const v = bio == null ? '' : String(bio);
  return v.trim() !== '' ? v : DEFAULT_BIO;
}

// ---------- 脱敏与占位邮箱（ProfileUtils.kt L74-91） ----------

/** 手机号脱敏：138****8000；位数不符时原样返回（replace 未命中即不变），null → "" */
function maskPhone(phone) {
  if (phone == null) return '';
  return String(phone).replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

/** 注册占位邮箱后缀（手机号注册、未设密码的标志；绑定邮箱前 password 一栏显示"未设置"的判定依据） */
const PLACEHOLDER_EMAIL_SUFFIX = '@placeholder.yuanlu.com';

function isPlaceholderEmail(email) {
  return email != null && String(email).endsWith(PLACEHOLDER_EMAIL_SUFFIX);
}

/** 邮箱脱敏：a****b@example.com（中间最多打 4 个星，Web 同口径）；占位邮箱 → "" */
function maskEmail(email) {
  if (email == null || String(email).trim() === '') return '';
  const e = String(email);
  if (isPlaceholderEmail(e)) return '';
  const atIndex = e.indexOf('@');
  if (atIndex <= 0) return e;
  const middle = e.substring(1, atIndex);
  return e.charAt(0) + '*'.repeat(Math.min(middle.length, 4)) + e.substring(atIndex);
}

// ---------- 资料表单校验（ProfileUtils.kt L94-102） ----------

/** 昵称校验：null = 通过；返回用户可读错误文案 */
function validateNickname(nickname) {
  const v = nickname == null ? '' : String(nickname);
  if (v.trim() === '') return '请输入昵称';
  if (v.length > NICKNAME_MAX_LENGTH) return '昵称不能超过 ' + NICKNAME_MAX_LENGTH + ' 个字';
  return null;
}

/** 简介校验：null = 通过 */
function validateBio(bio) {
  const v = bio == null ? '' : String(bio);
  if (v.length > BIO_MAX_LENGTH) return '简介不能超过 ' + BIO_MAX_LENGTH + ' 个字';
  return null;
}

// ---------- 账号与安全：绑定表单校验（ProfileUtils.kt L107-137，对齐 Web BindPhoneForm/BindEmailForm） ----------

/** 大陆手机号：1 开头 + [3-9] 号段 + 共 11 位 */
const PHONE_REGEX = /^1[3-9]\d{9}$/;

/** 宽松邮箱格式：局部@域名.后缀 */
const BIND_EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function validateBindPhone(phone) {
  return PHONE_REGEX.test(String(phone == null ? '' : phone))
    ? null
    : '请输入有效的11位手机号码';
}

function validateBindEmail(email) {
  return BIND_EMAIL_REGEX.test(String(email == null ? '' : email))
    ? null
    : '请输入有效的邮箱地址';
}

/**
 * 绑定邮箱时同步设置的登录密码强度（Web BindEmailForm 三项实时判定）：
 * 8 位以上 / 包含字母 / 包含数字（[a-zA-Z] 与 \d 仅匹配 ASCII），全满足才可提交。
 */
function passwordCriteria(password) {
  const pw = password == null ? '' : String(password);
  return {
    length: pw.length >= 8,
    hasLetter: /[a-zA-Z]/.test(pw),
    hasNumber: /[0-9]/.test(pw),
  };
}

function allPasswordCriteriaMet(password) {
  const c = passwordCriteria(password);
  return c.length && c.hasLetter && c.hasNumber;
}

// ---------- 头像裁剪（EditProfileDialog.kt cropSquareJpeg 的参数化等价） ----------

/**
 * 居中正方形裁剪 + 最长边下采样参数：min(w,h) 为源边，偏移取整；
 * 源边超过 maxDim（默认 512）时目标边收缩到 maxDim，否则原尺寸。
 * 返回 { sx, sy, sSide, dSide }（drawImage 9 参直用）；非法尺寸 → null（调用方静默保持原图）。
 */
function avatarCropRect(width, height, maxDim) {
  const w = Math.floor(Number(width) || 0);
  const h = Math.floor(Number(height) || 0);
  if (w <= 0 || h <= 0) return null;
  const side = Math.min(w, h);
  const md = Math.floor(Number(maxDim) || 512);
  return {
    sx: Math.floor((w - side) / 2),
    sy: Math.floor((h - side) / 2),
    sSide: side,
    dSide: side > md ? md : side,
  };
}

// ---------- 成就排序（ProfileUtils.kt L140-141） ----------

/** 已解锁排前、解锁与否之间保持稳定（手工稳定排序，不依赖引擎 sort 稳定性） */
function sortAchievements(items) {
  return (Array.isArray(items) ? items : [])
    .map(function (item, idx) {
      return { item: item, idx: idx };
    })
    .sort(function (a, b) {
      const ua = a.item && a.item.unlocked ? 0 : 1;
      const ub = b.item && b.item.unlocked ? 0 : 1;
      return ua - ub || a.idx - b.idx;
    })
    .map(function (e) {
      return e.item;
    });
}

// ---------- 周活动图 Y 轴（ProfileUtils.kt L148-159） ----------

/**
 * Y 轴上限：recharts 默认 5 刻度的 nice 口径——步长在每一数量级内按 1/2/3/4/5
 * 递进，上限 = 4 × 步长（保证 5 个整数刻度）。如峰值 13 分钟 → 上限 16。
 */
function chartYMax(minutes) {
  let max = 0;
  const list = Array.isArray(minutes) ? minutes : [];
  for (let i = 0; i < list.length; i++) {
    const n = Number(list[i]) || 0;
    if (n > max) max = n;
  }
  const ladder = [1, 2, 3, 4, 5];
  let decade = 1;
  for (;;) {
    for (let b = 0; b < ladder.length; b++) {
      const yMax = ladder[b] * decade * 4;
      if (yMax >= max) return yMax;
    }
    decade *= 10;
  }
}

// ---------- 加入日期（ProfileUtils.kt L166-182） ----------

const ISO_PREFIX_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/;

/** 本地时区 yyyy/MM/dd（Android SimpleDateFormat 无 TZ 参数时即设备本地时区） */
function formatLocalYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '/' + m + '/' + d;
}

/**
 * 加入日期展示：ISO → yyyy/MM/dd（Web lib/tools formatDate）。
 * - 解析口径同 Java SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", UTC)：取前 19 位
 *   按UTC 构造时刻（尾随 ".sssZ" 忽略），再按设备本地时区展示日期；
 * - 空值回退今天（Web personal-center joinDate 初始值即当天，资料 404 时保持）；
 * - 解析失败回退"未知日期"。
 */
function formatDate(iso) {
  if (iso == null || String(iso).trim() === '') {
    return formatLocalYmd(new Date());
  }
  const m = ISO_PREFIX_REGEX.exec(String(iso));
  if (!m) return '未知日期';
  const ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (!isFinite(ts)) return '未知日期';
  return formatLocalYmd(new Date(ts));
}

// ---------- 学习目标钳制（UserProfileViewModel.kt L273-281） ----------

/** 三目标值兜底钳制（滑杆越界/坏值防御；四舍五入到整数再收口） */
function coerceGoals(dailyStudyGoalMins, weeklyListeningGoalHours, weeklyWordsGoal) {
  function clamp(v, range) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return range.min;
    return Math.min(range.max, Math.max(range.min, n));
  }
  return {
    dailyStudyGoalMins: clamp(dailyStudyGoalMins, GOAL_RANGES.dailyStudyGoalMins),
    weeklyListeningGoalHours: clamp(weeklyListeningGoalHours, GOAL_RANGES.weeklyListeningGoalHours),
    weeklyWordsGoal: clamp(weeklyWordsGoal, GOAL_RANGES.weeklyWordsGoal),
  };
}

// ---------- DTO → 视图模型映射（WXML 零方法调用红线） ----------

/** 可空字符串归一：null/undefined/非字符串 → null（保留空串语义给校验层，展示层不区分） */
function s(v) {
  if (v == null) return null;
  const str = String(v);
  return str === '' ? null : str;
}

/** 可空整数归一：非有限数 → null */
function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.round(n);
}

/**
 * GET /api/user/stats/overview（裸对象）→ 视图模型；null/坏形状 → null（区块不渲染）。
 * 附带里程/小时展示串（StatCard 直用）。
 */
function mapStats(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const totalHours = Number(raw.totalHours) || 0;
  const streakDays = intOrNull(raw.streakDays) || 0;
  const wordsLearned = intOrNull(raw.wordsLearned) || 0;
  const speechEvalCount = intOrNull(raw.speechEvalCount) || 0;
  const speechHighScoreCount = intOrNull(raw.speechHighScoreCount) || 0;
  const km = totalKm(totalHours);
  return {
    totalHours: totalHours,
    streakDays: streakDays,
    wordsLearned: wordsLearned,
    speechEvalCount: speechEvalCount,
    speechHighScoreCount: speechHighScoreCount,
    totalKm: km,
    kmText: formatKm(km),
    hoursText: formatHours(totalHours),
  };
}

/**
 * GET /api/user/stats/weekly-activity（信封 { weeklyActivity: [{day, minutes}] }）
 * → [{ day, minutes }]；day 为服务端中文星期标签，坏项防御性归零。
 */
function mapWeekly(raw) {
  const arr = raw && Array.isArray(raw.weeklyActivity) ? raw.weeklyActivity : [];
  return arr.map(function (item) {
    const it = item || {};
    return {
      day: it.day == null ? '' : String(it.day),
      minutes: Math.round(Number(it.minutes) || 0),
    };
  });
}

/**
 * GET /api/user/achievements（裸数组）→ { items, unlockedCount }。
 * items = 排序后全量（已解锁稳定排前）；网格取前 8 属页面展示口径（Android
 * state.achievements.take(8)），core 不裁剪。icon 为服务端 emoji 字符串。
 */
function mapAchievements(raw) {
  const items = sortAchievements(
    (Array.isArray(raw) ? raw : []).map(function (item) {
      const it = item || {};
      return {
        key: it.key == null ? '' : String(it.key),
        name: it.name == null ? '' : String(it.name),
        description: it.description == null ? '' : String(it.description),
        icon: it.icon == null ? '' : String(it.icon),
        unlocked: !!it.unlocked,
        unlockedAt: s(it.unlockedAt),
      };
    })
  );
  let unlockedCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].unlocked) unlockedCount++;
  }
  return { items: items, unlockedCount: unlockedCount };
}

/**
 * 视图模型组装：UserProfileDto.toDomain 展平（嵌套 User 的 email/phone/role/
 * userid/createAt 提升到顶层，Models.kt L104-118）+ 展示派生（displayName/
 * bioText/levelLabel/joinDateText）+ 安全部派生（SecuritySection L1112-1115）。
 */
function buildProfileViewModel(p) {
  const hasPhone = p.phone != null;
  const hasRealEmail = p.email != null && !isPlaceholderEmail(p.email);
  // 密码与真实邮箱绑定设置（占位邮箱 = 手机号注册、未设密码）
  const passwordSet = !(isPlaceholderEmail(p.email) && !hasRealEmail);
  return {
    userid: p.userid,
    nickname: p.nickname,
    avatarUrl: p.avatarUrl,
    avatarFileName: p.avatarFileName,
    bio: p.bio,
    learnLevel: p.learnLevel,
    email: p.email,
    phone: p.phone,
    role: p.role,
    createAt: p.createAt,
    dailyStudyGoalMins: p.dailyStudyGoalMins,
    weeklyListeningGoalHours: p.weeklyListeningGoalHours,
    weeklyWordsGoal: p.weeklyWordsGoal,
    // 展示派生
    displayName: displayName(p.nickname, p.email),
    bioText: displayBio(p.bio),
    levelLabel: levelLabel(p.learnLevel),
    joinDateText: formatDate(p.createAt),
    // 账号与安全派生（值直接可绑；脱敏串空 = 未绑定/占位，页面另有 hasXxx 分支）
    hasPhone: hasPhone,
    hasRealEmail: hasRealEmail,
    passwordSet: passwordSet,
    phoneMasked: maskPhone(p.phone),
    emailMasked: maskEmail(p.email),
  };
}

/**
 * GET /api/user/profile（裸 user_profile 行 + 嵌套 User）→ 视图模型。
 * - raw 缺失/坏形状（含 404）：走 404 兜底——用登录态最小身份（authStore.userInfo）
 *   合成，口径同 Android toFallbackProfile：仅身份字段、头像/简介/水平/目标全空，
 *   userid 与 email 全空则返回 null（页面转错误态）。
 * - 正常路径：嵌套 User 字段优先（userid 以 User 为准，缺 User 的裸行如 PUT 响应
 *   data 也可映射，仅身份字段为空）。
 */
function mapProfile(raw, fallback) {
  const src = raw && typeof raw === 'object' ? raw : null;
  if (!src) {
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    const userid = s(fb.userid);
    const email = s(fb.email);
    if (!userid && !email) return null;
    return buildProfileViewModel({
      userid: userid || '',
      nickname: s(fb.nickname),
      avatarUrl: null,
      avatarFileName: null,
      bio: null,
      learnLevel: null,
      email: email,
      phone: s(fb.phone),
      role: s(fb.role),
      createAt: null,
      dailyStudyGoalMins: null,
      weeklyListeningGoalHours: null,
      weeklyWordsGoal: null,
    });
  }
  const user = src.User && typeof src.User === 'object' ? src.User : {};
  return buildProfileViewModel({
    userid: s(user.userid) || s(src.userid) || '',
    nickname: s(src.nickname),
    avatarUrl: s(src.avatarUrl),
    avatarFileName: s(src.avatarFileName),
    bio: s(src.bio),
    learnLevel: s(src.learnLevel),
    email: s(user.email),
    phone: s(user.phone),
    role: s(user.role),
    createAt: s(user.createAt),
    dailyStudyGoalMins: intOrNull(src.dailyStudyGoalMins),
    weeklyListeningGoalHours: intOrNull(src.weeklyListeningGoalHours),
    weeklyWordsGoal: intOrNull(src.weeklyWordsGoal),
  });
}

// ---------- 图表几何：周活动面积图（PersonalCenterScreen.kt L771-809 / L698-763） ----------

/**
 * Fritsch–Carlson 单调三次插值 → 三次贝塞尔段（recharts type="monotone"、d3
 * curveMonotoneX 同族）：曲线严格经过每个数据点，局部极值处不过冲。
 * 返回 { start, segments:[{c1x,c1y,c2x,c2y,x,y}] }，canvas 层 moveTo(start)
 * 后逐段 bezierCurveTo(c1, c2, 终点)。
 * - 内点切线：两侧斜率异号（局部极值）取 0，否则加权调和平均
 *   (w1+w2)/(w1/δ[i-1]+w2/δ[i])，w1=2dx[i]+dx[i-1]、w2=dx[i]+2dx[i-1]
 * - 端点切线（d3 slope2 口径）：n=2 直接取端段斜率，否则 (3δ-邻切线)/2
 * - 控制点 = 两端各 1/3 段长处的切线端点（Hermite→Bezier）
 */
function monotonePath(points) {
  const pts = (Array.isArray(points) ? points : []).map(function (p) {
    return { x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 };
  });
  const n = pts.length;
  if (n === 0) return { start: null, segments: [] };
  const start = { x: pts[0].x, y: pts[0].y };
  if (n === 1) return { start: start, segments: [] };

  const dx = [];
  const delta = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1].x - pts[i].x;
    dx.push(h);
    delta.push(h === 0 ? 0 : (pts[i + 1].y - pts[i].y) / h);
  }
  const tangent = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      tangent[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  tangent[0] = n === 2 ? delta[0] : (3 * delta[0] - tangent[1]) / 2;
  tangent[n - 1] = n === 2 ? delta[n - 2] : (3 * delta[n - 2] - tangent[n - 2]) / 2;

  const segments = [];
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    segments.push({
      c1x: pts[i].x + h / 3,
      c1y: pts[i].y + (tangent[i] * h) / 3,
      c2x: pts[i + 1].x - h / 3,
      c2y: pts[i + 1].y - (tangent[i + 1] * h) / 3,
      x: pts[i + 1].x,
      y: pts[i + 1].y,
    });
  }
  return { start: start, segments: segments };
}

/**
 * 周活动图几何（CanvasChart L698-763）：内边距 L34/T6/R6/B22dp；yMax 走 chartYMax
 * nice 阶梯；5 个整数刻度 0m..yMax；点位 yFraction = minutes/yMax 收口 [0,1]（越界
 * 数据钳到边界，Android coerceIn 同）。
 * dpScale = dp→px 系数：调用方应传 屏宽/375（= 2×rpx 系数，Android 屏幕密度口径）；
 * 不传时退 W/375 窄幅近似（仅供单测，画布窄于屏宽时内边距会偏小）。
 * 文字宽度属运行时 measureText，不在纯函数职责内。
 */
function chartGeometry(W, H, minutes, dpScale) {
  const list = (Array.isArray(minutes) ? minutes : []).map(function (m) {
    return Math.round(Number(m) || 0);
  });
  const ds = dpScale && dpScale > 0 ? dpScale : W / 375;
  const leftPad = 34 * ds;
  const topPad = 6 * ds;
  const rightPad = 6 * ds;
  const bottomPad = 22 * ds;
  const chartW = W - leftPad - rightPad;
  const chartH = H - topPad - bottomPad;
  const yMax = chartYMax(list);
  const stepX = list.length > 1 ? chartW / (list.length - 1) : 0;
  const points = list.map(function (m, i) {
    const yFraction = Math.min(1, Math.max(0, m / yMax));
    return { x: leftPad + i * stepX, y: topPad + chartH * (1 - yFraction) };
  });
  const step = yMax / 4; // yMax 恒为 4 的倍数（ladder×4），整除无余数
  const yTicks = [0, 1, 2, 3, 4].map(function (s) {
    return {
      value: s * step,
      label: s * step + 'm',
      y: topPad + chartH * (1 - s / 4),
    };
  });
  return {
    yMax: yMax,
    chartW: chartW,
    chartH: chartH,
    leftPad: leftPad,
    topPad: topPad,
    rightPad: rightPad,
    bottomPad: bottomPad,
    points: points,
    yTicks: yTicks,
    lineWidth: 2.5 * ds,
    dotOuter: 4 * ds, // 白圈半径（Web dot r3 stroke white 2 的等价观感）
    dotInner: 3 * ds, // primary 实心半径
    tickGapX: 6 * ds, // Y 轴刻度文字与轴右缘距离
    labelGapY: 8 * ds, // X 轴标签与绘图区底边距离
  };
}

// ---------- 图表几何：里程碑路图（PersonalCenterScreen.kt L814-995） ----------

/** 全程阈值 = 末档 km（100.0） */
const MILESTONE_TOTAL_KM = MILESTONES[MILESTONES.length - 1].km;

/** 进度比例 = totalKm / 全程 收口 [0,1]（L925 progressRatio） */
function milestoneProgress(totalKm) {
  const r = (Number(totalKm) || 0) / MILESTONE_TOTAL_KM;
  return Math.min(1, Math.max(0, r));
}

/** 各档达成判定：totalKm >= km（L943 reached） */
function milestoneReached(totalKm) {
  const km = Number(totalKm) || 0;
  return MILESTONES.map(function (m) {
    return km >= m.km;
  });
}

/** km 档位标签 "1.0km".."100.0km"（Kotlin "${it.first}km" Double.toString 口径，%.1f 等价） */
function milestoneKmTexts() {
  return MILESTONES.map(function (m) {
    return m.km.toFixed(1) + 'km';
  });
}

/**
 * 里程碑路图坐标与尺寸（MilestoneStrip L886-901）：
 * 5 节点 x 自 pad(42dp) 等分至 W-pad；y 波浪 base=H*0.52、amp=H*0.10，
 * 偏移序列 [+amp, -amp, +0.7amp, -0.9amp, +0.5amp]。
 * dpScale 口径同 chartGeometry（屏宽/375；不传退 W/375 窄幅近似）。
 */
function milestoneGeometry(W, H, dpScale) {
  const ds = dpScale && dpScale > 0 ? dpScale : W / 375;
  const pad = 42 * ds;
  const count = MILESTONES.length;
  const xs = [];
  const step = (W - pad * 2) / (count - 1);
  for (let i = 0; i < count; i++) xs.push(pad + i * step);
  const base = H * 0.52;
  const amp = H * 0.1;
  const ys = [base + amp, base - amp, base + amp * 0.7, base - amp * 0.9, base + amp * 0.5];
  return {
    xs: xs,
    ys: ys,
    base: base,
    amp: amp,
    nodeRadius: 6 * ds,
    strokeWidth: 2.5 * ds,
    hollowStroke: 1.5 * ds, // 未达成节点描边
    dash: [0.1, 9 * ds], // 圆点虚线段（0.1 长度 + 9dp 间隔，圆端帽成点）
    flag: { up: 11 * ds, right: 9 * ds, waistHigh: 7.5 * ds, waistLow: 4.5 * ds },
    labelBelow: 6 * ds, // 名称标签距节点下缘（y+r+6dp）
    kmAboveReached: 15 * ds, // 达成 km 标签上距（y-r-15dp-文字高）
    kmAboveLocked: 7 * ds, // 未达成（y-r-7dp-文字高）
    pulseBase: 2 * ds, // 脉冲半径基数 r+2dp
    pulseAmp: 6 * ds, // +6dp×pulse
    pulseDot: 4 * ds, // 脉冲中心实心 4dp
  };
}

/** 冲线小旗四顶点（secondary 三角旗，L950-957：(x,y-r)→上→右腰→下腰 闭合） */
function milestoneFlagPoints(x, y, geo) {
  const r = geo.nodeRadius;
  const f = geo.flag;
  return [
    { x: x, y: y - r },
    { x: x, y: y - r - f.up },
    { x: x + f.right, y: y - r - f.waistHigh },
    { x: x, y: y - r - f.waistLow },
  ];
}

/**
 * 当前进度脉冲点（L984-993）：落在相邻节点连线上的线性插值位置 + 呼吸半径/透明度。
 * pulse∈[0,1] 由动画层每帧驱动（2s 线性循环）；totalKm<=0 或已达满程 → null（不画）。
 */
function milestonePulsePoint(totalKm, geo, pulse) {
  const km = Number(totalKm) || 0;
  if (!(km > 0 && km < MILESTONE_TOTAL_KM)) return null;
  const ratio = milestoneProgress(km);
  const count = MILESTONES.length;
  const seg = Math.min(count - 2, Math.floor(ratio * (count - 1)));
  const t = ratio * (count - 1) - seg;
  const p = Math.min(1, Math.max(0, Number(pulse) || 0));
  return {
    x: geo.xs[seg] + (geo.xs[seg + 1] - geo.xs[seg]) * t,
    y: geo.ys[seg] + (geo.ys[seg + 1] - geo.ys[seg]) * t,
    radius: geo.nodeRadius + geo.pulseBase + geo.pulseAmp * p,
    alpha: 0.5 - 0.35 * p,
    dotRadius: geo.pulseDot,
  };
}

// ---------- 平滑路径测量与裁剪（替代 Android PathMeasure + dashPathEffect 裁剪） ----------

/**
 * 中点法二次贝塞尔平滑路径（L904-912）：moveTo(首节点) 后逐段以「前节点为控制点、
 * 两节点中点为终点」quadraticCurveTo，最后 lineTo 末节点。返回 { start, quads, end }：
 * canvas 直绘用 start+quads+lineTo(end)；测量/裁剪走 sampleQuadPath 采样折线。
 */
function quadMidPath(xs, ys) {
  const X = Array.isArray(xs) ? xs : [];
  const Y = Array.isArray(ys) ? ys : [];
  const n = Math.min(X.length, Y.length);
  if (n === 0) return { start: null, quads: [], end: null };
  const quads = [];
  for (let i = 1; i < n; i++) {
    quads.push({
      cx: X[i - 1],
      cy: Y[i - 1],
      x: (X[i - 1] + X[i]) / 2,
      y: (Y[i - 1] + Y[i]) / 2,
    });
  }
  return { start: { x: X[0], y: Y[0] }, quads: quads, end: { x: X[n - 1], y: Y[n - 1] } };
}

/** 二次贝塞尔参数式采样（B(t)=(1-t)²P0+2(1-t)tC+t²P1），逐段链式衔接；含末段 lineTo 终点 */
function sampleQuadPath(path, perSegment) {
  if (!path || !path.start) return [];
  const n = Math.max(2, Math.round(perSegment || 48));
  const pts = [{ x: path.start.x, y: path.start.y }];
  (path.quads || []).forEach(function (q) {
    const p0 = pts[pts.length - 1];
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      pts.push({
        x: u * u * p0.x + 2 * u * t * q.cx + t * t * q.x,
        y: u * u * p0.y + 2 * u * t * q.cy + t * t * q.y,
      });
    }
  });
  if (path.end) pts.push({ x: path.end.x, y: path.end.y });
  return pts;
}

/** 折线总长 */
function polylineLength(points) {
  const pts = Array.isArray(points) ? points : [];
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

/**
 * 按比例截取折线前缀（终点在段内线性插值）：已完成段实线的绘制口径——
 * Android 为 PathMeasure 全长 × progressRatio 后 dash 裁剪，此处返回可直绘折线。
 * ratio<=0 → []（不画）；>=1 → 全量副本；零长折线 → 原样返回。
 */
function clipPolyline(points, ratio) {
  const pts = Array.isArray(points) ? points : [];
  const r = Math.min(1, Math.max(0, Number(ratio) || 0));
  if (pts.length < 2 || r <= 0) return [];
  if (r >= 1) return pts.slice();
  const total = polylineLength(pts);
  if (total <= 0) return pts.slice();
  const target = total * r;
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + seg >= target - 1e-9) {
      const t = seg > 0 ? (target - acc) / seg : 0;
      out.push({
        x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
        y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
      });
      break;
    }
    acc += seg;
    out.push(pts[i]);
  }
  return out;
}

// ---------- 学习报表派生（Web LearningReportView.tsx L40-98 / LearningHeatmap.tsx） ----------

/** 后端 LearningReportDto 防御性映射（dailyGoalMins ?? 20 与 service 同口径兜底） */
function mapReport(raw) {
  const r = raw || {};
  const days = (Array.isArray(r.days) ? r.days : []).map(function (d) {
    return {
      date: String((d && d.date) || ''),
      minutes: Math.max(0, Math.round(Number(d && d.minutes) || 0)),
      wordsLearned: Math.max(0, Math.round(Number(d && d.wordsLearned) || 0)),
      isActive: !!(d && d.isActive),
    };
  });
  const goal = Number(r.dailyGoalMins);
  return {
    days: days,
    streakDays: Math.max(0, Math.round(Number(r.streakDays) || 0)),
    dailyGoalMins: goal > 0 ? Math.round(goal) : 20,
  };
}

/** 近 7 天简报派生：总时长拆小时+分、活跃天数、新收生词、日均（四宫格 + 建议输入） */
function reportBrief(days) {
  const list = (Array.isArray(days) ? days : []).slice(-7);
  let totalMins = 0;
  let activeDays = 0;
  let wordsLearned = 0;
  list.forEach(function (d) {
    totalMins += Math.max(0, Math.round(Number(d && d.minutes) || 0));
    activeDays += d && d.isActive ? 1 : 0;
    wordsLearned += Math.max(0, Math.round(Number(d && d.wordsLearned) || 0));
  });
  return {
    hours: Math.floor(totalMins / 60),
    minsPart: totalMins % 60,
    totalMins: totalMins,
    activeDays: activeDays,
    wordsLearned: wordsLearned,
    avgMins: Math.round(totalMins / 7),
  };
}

/** 智能学习建议（规则派生零 LLM，Web 逐字文案；命中多条时取前 3） */
function reportSuggestions(brief, streakDays, dailyGoalMins) {
  const b = brief || {};
  const streak = Math.max(0, Math.round(Number(streakDays) || 0));
  const goal = Number(dailyGoalMins) > 0 ? Math.round(Number(dailyGoalMins)) : 20;
  const list = [];
  if (streak >= 3) {
    list.push('连续打卡 ' + streak + ' 天，节奏已经成型——保持“每天一集短播客”的惯性比时长更重要。');
  }
  if (b.avgMins > 0 && b.avgMins < goal) {
    list.push('近 7 天日均 ' + b.avgMins + ' 分钟，低于目标 ' + goal + ' 分钟——通勤时打开自动连播，碎片时间就能补齐。');
  }
  if (b.activeDays >= 5) {
    list.push('近 7 天学习 ' + b.activeDays + ' 天，稳定性很好——可以把每日目标上调 10% 挑战一下自己。');
  } else if (b.activeDays > 0 && b.activeDays < 3) {
    list.push('学习日还比较分散，试着固定一个时段（如睡前 15 分钟）培养触发习惯。');
  }
  if (b.wordsLearned === 0) {
    list.push('近 7 天没有新收生词——精听时遇到生词点一下查词收藏，复习闭环从这里开始。');
  }
  if (list.length === 0) {
    list.push('继续保持，数据积累后这里会给出更具体的学习建议。');
  }
  return list.slice(0, 3);
}

/** 热力图档位：分钟 → 0..4（Web LearningHeatmap levelOf，相对期内最大值分档） */
function heatmapLevel(minutes, max) {
  const m = Math.max(0, Number(minutes) || 0);
  if (m <= 0) return 0;
  if (!(max > 0)) return 1;
  const ratio = m / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/**
 * 全年热力图网格（Web LearningHeatmap）：周一为每周第一行，首日前置空格对齐到
 * 周一列；月标注 = 每列首个非空格月份与前列不同时标「X月」；max 至少 1（全零期
 * 档位按 1 处理，与 Web Math.max(..., 1) 同）。
 */
function heatmapGrid(days) {
  const list = Array.isArray(days) ? days : [];
  if (list.length === 0) return { weeks: [], monthLabels: [], max: 1 };
  const parsed = list.map(function (d) {
    const dt = new Date(String((d && d.date) || '') + 'T00:00:00Z');
    return {
      date: String((d && d.date) || ''),
      minutes: Math.max(0, Math.round(Number(d && d.minutes) || 0)),
      isActive: !!(d && d.isActive),
      month: isFinite(dt.getTime()) ? dt.getUTCMonth() : -1,
      row: isFinite(dt.getTime()) ? (dt.getUTCDay() + 6) % 7 : 0,
    };
  });
  let max = 1;
  parsed.forEach(function (p) {
    if (p.minutes > max) max = p.minutes;
  });
  const cells = new Array(parsed[0].row).fill(null).concat(parsed);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(
      cells.slice(i, i + 7).map(function (c) {
        if (!c) return null;
        return {
          date: c.date,
          minutes: c.minutes,
          isActive: c.isActive,
          month: c.month,
          level: heatmapLevel(c.minutes, max),
        };
      }),
    );
  }
  const monthLabels = weeks.map(function (week, i) {
    const first = week.find(function (c) {
      return c !== null;
    });
    if (!first) return '';
    const prev = i > 0 ? weeks[i - 1].find(function (c) {
      return c !== null;
    }) : null;
    if (!prev || prev.month !== first.month) return (first.month + 1) + '月';
    return '';
  });
  return { weeks: weeks, monthLabels: monthLabels, max: max };
}

/** 趋势图 X 轴标签抽稀（recharts interval=preserveStartEnd 等价：≤7 全显，否则约 6 个含首尾） */
function xLabelStride(n) {
  const count = Number(n) || 0;
  if (count <= 7) return 1;
  return Math.ceil(count / 6);
}

module.exports = {
  // 常量
  KM_PER_HOUR: KM_PER_HOUR,
  DEFAULT_BIO: DEFAULT_BIO,
  NICKNAME_MAX_LENGTH: NICKNAME_MAX_LENGTH,
  BIO_MAX_LENGTH: BIO_MAX_LENGTH,
  MILESTONES: MILESTONES,
  LEVEL_MAPPING: LEVEL_MAPPING,
  LEARN_LEVELS: LEARN_LEVELS,
  GOAL_RANGES: GOAL_RANGES,
  PLACEHOLDER_EMAIL_SUFFIX: PLACEHOLDER_EMAIL_SUFFIX,
  // 换算与展示
  totalKm: totalKm,
  formatKm: formatKm,
  formatHours: formatHours,
  levelLabel: levelLabel,
  displayName: displayName,
  displayBio: displayBio,
  // 脱敏
  maskPhone: maskPhone,
  maskEmail: maskEmail,
  isPlaceholderEmail: isPlaceholderEmail,
  // 校验
  validateNickname: validateNickname,
  validateBio: validateBio,
  validateBindPhone: validateBindPhone,
  validateBindEmail: validateBindEmail,
  passwordCriteria: passwordCriteria,
  allPasswordCriteriaMet: allPasswordCriteriaMet,
  avatarCropRect: avatarCropRect,
  // 图表
  chartYMax: chartYMax,
  // 图表几何（T0.2）
  monotonePath: monotonePath,
  chartGeometry: chartGeometry,
  MILESTONE_TOTAL_KM: MILESTONE_TOTAL_KM,
  milestoneProgress: milestoneProgress,
  milestoneReached: milestoneReached,
  milestoneKmTexts: milestoneKmTexts,
  milestoneGeometry: milestoneGeometry,
  milestoneFlagPoints: milestoneFlagPoints,
  milestonePulsePoint: milestonePulsePoint,
  quadMidPath: quadMidPath,
  sampleQuadPath: sampleQuadPath,
  polylineLength: polylineLength,
  clipPolyline: clipPolyline,
  // 日期
  formatDate: formatDate,
  // 目标
  coerceGoals: coerceGoals,
  // 学习报表
  mapReport: mapReport,
  reportBrief: reportBrief,
  reportSuggestions: reportSuggestions,
  heatmapLevel: heatmapLevel,
  heatmapGrid: heatmapGrid,
  xLabelStride: xLabelStride,
  // 映射
  mapStats: mapStats,
  mapWeekly: mapWeekly,
  mapAchievements: mapAchievements,
  mapProfile: mapProfile,
  sortAchievements: sortAchievements,
};
