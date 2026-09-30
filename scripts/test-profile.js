/**
 * scripts/test-profile.js — 「个人中心」核心纯逻辑测试（PROFILE-TASK 阶段 0，T0.3）
 *
 * utils/profile-core.js 全量把门：ProfileUtils.kt 移植口径（换算/等级/脱敏/校验/
 * 密码强度/成就排序/chartYMax 阶梯/formatDate UTC→本地）+ DTO 映射（mapProfile
 * 嵌套展平与 404 兜底、mapStats/mapWeekly/mapAchievements、coerceGoals 钳制）+
 * 图表几何（monotonePath Fritsch–Carlson、quadMidPath 中点法、折线长度/比例裁剪、
 * milestoneGeometry 波浪坐标/脉冲插值、chartGeometry 时刻度与点位）。
 * 纯函数无 wx 依赖，直接 require 断言。运行：node scripts/test-profile.js
 */

const core = require('../utils/profile-core.js');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}
function close(a, b, label, eps) {
  const e = eps == null ? 1e-6 : eps;
  ok(Math.abs(a - b) <= e, label + '（' + a + ' ≈ ' + b + '）');
}
const localYmd = (d) =>
  d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');

/* ==================== 常量 ==================== */
console.log('== 常量 ==');
ok(core.MILESTONES.length === 5 && core.MILESTONES[0].name === '起步' && core.MILESTONES[4].km === 100.0, 'MILESTONES 五档/全程 100');
ok(core.MILESTONES.map((m) => m.name).join(',') === '起步,小径,半马,全马,远路', 'MILESTONES 名称顺序');
ok(core.LEARN_LEVELS.length === 4 && core.LEARN_LEVELS[0].value === 'General' && core.LEARN_LEVELS[3].label === '高级', 'LEARN_LEVELS 顺序');
ok(core.KM_PER_HOUR === 5 && core.DEFAULT_BIO.indexOf('路虽远') === 0, 'KM_PER_HOUR / DEFAULT_BIO');
ok(core.NICKNAME_MAX_LENGTH === 20 && core.BIO_MAX_LENGTH === 100, '长度上限 20/100');
ok(core.GOAL_RANGES.dailyStudyGoalMins.min === 10 && core.GOAL_RANGES.dailyStudyGoalMins.max === 120 &&
   core.GOAL_RANGES.weeklyListeningGoalHours.min === 1 && core.GOAL_RANGES.weeklyListeningGoalHours.max === 20 &&
   core.GOAL_RANGES.weeklyWordsGoal.min === 10 && core.GOAL_RANGES.weeklyWordsGoal.max === 200, 'GOAL_RANGES 三区间');

/* ==================== 换算与展示 ==================== */
console.log('== 换算与展示 ==');
ok(core.formatKm(core.totalKm(21.8)) === '109.0', '21.8h → 109.0km');
ok(core.formatKm(0) === '0.0' && core.totalKm(0) === 0, '零值 0.0');
ok(core.formatHours(12) === '12' && core.formatHours(12.5) === '12.5' && core.formatHours(0) === '0', 'formatHours 整数省小数');
ok(core.levelLabel('Beginner') === '初级' && core.levelLabel('Intermediate') === '中级' &&
   core.levelLabel('Advanced') === '高级' && core.levelLabel('General') === '未分级', 'levelLabel 映射');
ok(core.levelLabel(null) === '中级' && core.levelLabel('') === '中级', 'levelLabel null/空 → 中级');
ok(core.levelLabel('Expert') === 'Expert', 'levelLabel 未知原样透传');
ok(core.displayName('远路漫漫', 'a@b.com') === '远路漫漫', 'displayName 昵称优先');
ok(core.displayName('  ', 'ab@b.com') === 'ab', 'displayName 空白昵称 → 邮箱前缀');
ok(core.displayName(null, '@b.com') === 'User' && core.displayName(null, null) === 'User', 'displayName 兜底 User');
ok(core.displayBio(null) === core.DEFAULT_BIO && core.displayBio('  ') === core.DEFAULT_BIO && core.displayBio('签名') === '签名', 'displayBio 默认座右铭');

/* ==================== 脱敏与占位邮箱 ==================== */
console.log('== 脱敏与占位邮箱 ==');
ok(core.maskPhone('13812348000') === '138****8000', 'maskPhone 标准脱敏');
ok(core.maskPhone('123') === '123' && core.maskPhone('1381234800') === '1381234800', 'maskPhone 位数不符原样');
ok(core.maskPhone(null) === '' && core.maskPhone(undefined) === '', 'maskPhone null → 空串');
ok(core.isPlaceholderEmail('x@placeholder.yuanlu.com') === true &&
   core.isPlaceholderEmail('a@b.com') === false && core.isPlaceholderEmail(null) === false, 'isPlaceholderEmail');
ok(core.maskEmail('abc@example.com') === 'a**@example.com', 'maskEmail 短中段逐字打星');
ok(core.maskEmail('abcdefgh@x.com') === 'a****@x.com', 'maskEmail 中段最多 4 星');
ok(core.maskEmail('x@placeholder.yuanlu.com') === '', 'maskEmail 占位邮箱 → 空串');
ok(core.maskEmail('no-at') === 'no-at' && core.maskEmail('@x.com') === '@x.com' && core.maskEmail(null) === '', 'maskEmail 无@/首@/null');

/* ==================== 校验 ==================== */
console.log('== 校验 ==');
ok(core.validateNickname('') === '请输入昵称' && core.validateNickname('   ') === '请输入昵称', 'validateNickname 空白');
ok(core.validateNickname('a'.repeat(21)) === '昵称不能超过 20 个字', 'validateNickname 超长文案');
ok(core.validateNickname('a'.repeat(20)) === null, 'validateNickname 恰 20 字通过');
ok(core.validateBio('b'.repeat(101)) === '简介不能超过 100 个字', 'validateBio 超长');
ok(core.validateBio('b'.repeat(100)) === null && core.validateBio('') === null, 'validateBio 恰限/空通过');
ok(core.validateBindPhone('13812348000') === null && core.validateBindPhone('19999999999') === null, 'validateBindPhone 合法号段');
ok(core.validateBindPhone('12812348000') !== null, 'validateBindPhone 2 号段拒绝');
ok(core.validateBindPhone('1381234800') !== null && core.validateBindPhone('138123480001') !== null, 'validateBindPhone 位数拒绝');
ok(core.validateBindEmail('a@b.co') === null && core.validateBindEmail('user.name+tag@ex.org') === null, 'validateBindEmail 合法');
ok(core.validateBindEmail('a@b') !== null && core.validateBindEmail('a b@x.co') !== null, 'validateBindEmail 无后缀/含空格拒绝');
const pc = core.passwordCriteria('abcd123');
ok(pc.length === false && pc.hasLetter === true && pc.hasNumber === true, 'passwordCriteria 7 位不达标');
ok(core.passwordCriteria('abcdefgh').hasNumber === false, 'passwordCriteria 纯字母缺数字');
ok(core.passwordCriteria('12345678').hasLetter === false, 'passwordCriteria 纯数字缺字母');
ok(core.passwordCriteria('全角ａｂｃ１２３４５').hasLetter === false, 'passwordCriteria 全角不算 ASCII 字母');
ok(core.allPasswordCriteriaMet('abc12345') === true && core.allPasswordCriteriaMet('abcdefgh') === false, 'allPasswordCriteriaMet');

/* ==================== 成就排序 / chartYMax ==================== */
console.log('== 成就排序 / chartYMax ==');
ok(core.sortAchievements([{ key: 'b', unlocked: true }, { key: 'a', unlocked: false }, { key: 'c', unlocked: true }])
  .map((i) => i.key).join(',') === 'b,c,a', 'sortAchievements 解锁稳定排前');
ok(core.sortAchievements(null).length === 0, 'sortAchievements 容错');
ok(core.chartYMax([13]) === 16 && core.chartYMax([12]) === 12, 'chartYMax 13→16 / 12→12');
ok(core.chartYMax([0]) === 4 && core.chartYMax([]) === 4, 'chartYMax 空数据 → 4');
ok(core.chartYMax([4]) === 4 && core.chartYMax([5]) === 8, 'chartYMax 4→4 / 5→8');
ok(core.chartYMax([80]) === 80 && core.chartYMax([100]) === 120 && core.chartYMax([81]) === 120, 'chartYMax 跨数量级');

/* ==================== formatDate ==================== */
console.log('== formatDate ==');
ok(core.formatDate('2026-09-29T18:30:00.000Z') === localYmd(new Date(Date.UTC(2026, 8, 29, 18, 30, 0))), 'ISO 前 19 位按 UTC 解析、本地展示');
ok(core.formatDate('2026-09-29T08:30:00Z') === '2026/09/29' || core.formatDate('2026-09-29T08:30:00Z') === localYmd(new Date(Date.UTC(2026, 8, 29, 8, 30, 0))), '带 Z 后缀兼容');
ok(core.formatDate('') === localYmd(new Date()) && core.formatDate(null) === localYmd(new Date()), '空值回退今天');
ok(core.formatDate('garbage') === '未知日期', '解析失败 → 未知日期');
ok(core.formatDate('2026-09-29') === '未知日期', '缺时间段 → 未知日期（Java 严格模式同口径）');

/* ==================== coerceGoals ==================== */
console.log('== coerceGoals ==');
const cg = core.coerceGoals(5, 99, 1000);
ok(cg.dailyStudyGoalMins === 10 && cg.weeklyListeningGoalHours === 20 && cg.weeklyWordsGoal === 200, '越界钳到 min/max');
const cg2 = core.coerceGoals(65.4, '7', NaN);
ok(cg2.dailyStudyGoalMins === 65 && cg2.weeklyListeningGoalHours === 7 && cg2.weeklyWordsGoal === 10, '四舍五入 / 字符串数 / NaN→min');

/* ==================== DTO 映射 ==================== */
console.log('== DTO 映射 ==');
ok(core.mapStats(null) === null && core.mapStats('x') === null, 'mapStats 坏形状 → null');
const st = core.mapStats({ totalHours: 21.8, streakDays: 4, wordsLearned: 120, speechEvalCount: 9, speechHighScoreCount: 3 });
ok(st.kmText === '109.0' && st.hoursText === '21.8' && st.streakDays === 4 && st.wordsLearned === 120, 'mapStats 派生串');
ok(core.mapStats({}).totalHours === 0 && core.mapStats({}).kmText === '0.0', 'mapStats 缺省 0');
ok(JSON.stringify(core.mapWeekly({ weeklyActivity: [{ day: '周一', minutes: 30 }, { day: '周二' }] })) ===
   JSON.stringify([{ day: '周一', minutes: 30 }, { day: '周二', minutes: 0 }]), 'mapWeekly 信封解包+归零');
ok(core.mapWeekly({}).length === 0 && core.mapWeekly(null).length === 0, 'mapWeekly 容错');
const ach = core.mapAchievements([{ key: 'b', unlocked: true, icon: '🔥', name: 'n2' }, { key: 'a', unlocked: false, icon: '🔒', name: 'n1' }]);
ok(ach.unlockedCount === 1 && ach.items[0].key === 'b' && ach.items[1].unlocked === false, 'mapAchievements 排序+计数');
ok(core.mapAchievements(null).items.length === 0 && core.mapAchievements('x').unlockedCount === 0, 'mapAchievements 容错');
ok(core.mapAchievements([{ key: 'k', unlocked: 1 }]).items[0].unlocked === true, 'unlocked 真值归一');

const vm = core.mapProfile({
  userid: 'u1', nickname: '远路漫漫', bio: '', learnLevel: 'Beginner',
  avatarUrl: 'https://signed/x.jpg', avatarFileName: 'yuanlu/avatar/1.jpg',
  dailyStudyGoalMins: 30, weeklyListeningGoalHours: 5, weeklyWordsGoal: 50,
  User: { userid: 'u1', email: 'ab@ex.com', phone: '13812348000', role: 'USER', createAt: '2026-01-02T18:30:00.000Z' },
}, null);
ok(vm.displayName === '远路漫漫' && vm.bioText === core.DEFAULT_BIO && vm.levelLabel === '初级', 'mapProfile 展示派生');
ok(vm.phoneMasked === '138****8000' && vm.emailMasked === 'a*@ex.com', 'mapProfile 脱敏');
ok(vm.hasPhone === true && vm.hasRealEmail === true && vm.passwordSet === true, 'mapProfile 安全部派生（真实邮箱）');
ok(vm.userid === 'u1' && vm.role === 'USER' && vm.dailyStudyGoalMins === 30, 'mapProfile 嵌套 User 展平');
ok(vm.joinDateText === localYmd(new Date(Date.UTC(2026, 0, 2, 18, 30, 0))), 'mapProfile 加入日期');
const vm2 = core.mapProfile({ userid: 'u2', User: { email: '13812348000@placeholder.yuanlu.com', phone: '13812348000', createAt: '2026-01-02T10:00:00.000Z' } }, null);
ok(vm2.hasRealEmail === false && vm2.passwordSet === false && vm2.emailMasked === '' && vm2.hasPhone === true, '占位邮箱 → 未设密码/未绑邮箱');
const vm3 = core.mapProfile(null, { userid: 'u3', email: 'x@y.com', nickname: '昵称', phone: null, role: 'USER' });
ok(vm3 !== null && vm3.userid === 'u3' && vm3.displayName === '昵称' && vm3.avatarUrl === null &&
   vm3.hasRealEmail === true && vm3.passwordSet === true, '404 兜底合成（toFallbackProfile 口径）');
ok(vm3.joinDateText === localYmd(new Date()), '兜底 createAt 空 → 加入日期=今天');
ok(core.mapProfile(null, {}) === null && core.mapProfile(null, null) === null, '身份全空兜底 → null');
ok(core.mapProfile({ userid: 'u4', nickname: '裸行' }).displayName === '裸行' && core.mapProfile({ userid: 'u4' }).passwordSet === true, '无 User 裸行可映射');

/* ==================== 图表几何：monotonePath ==================== */
console.log('== monotonePath（Fritsch–Carlson） ==');
ok(core.monotonePath([]).start === null && core.monotonePath([]).segments.length === 0, '空点列');
ok(core.monotonePath([{ x: 1, y: 2 }]).start.x === 1 && core.monotonePath([{ x: 1, y: 2 }]).segments.length === 0, '单点仅 start');
const mp2 = core.monotonePath([{ x: 0, y: 0 }, { x: 10, y: 20 }]);
ok(mp2.segments.length === 1, '两点一段');
close(mp2.segments[0].c1x, 10 / 3, '两点 c1x = x0+h/3'); close(mp2.segments[0].c1y, 20 / 3, '两点 c1y = y0+d·h/3');
close(mp2.segments[0].c2x, 20 / 3, '两点 c2x = x1-h/3'); close(mp2.segments[0].c2y, 40 / 3, '两点 c2y = y1-d·h/3');
const mpMax = core.monotonePath([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]);
ok(mpMax.segments.length === 2, '三点两段');
close(mpMax.segments[0].c1y, 0.5, '局部极大：端点切线 (3δ-0)/2 → c1y=0.5');
close(mpMax.segments[0].c2y, 1.0, '极值点切线=0 → c2y=y1');
close(mpMax.segments[1].c1y, 1.0, '极值点切线=0 → c2 段 c1y=y1');
close(mpMax.segments[1].c2y, 0.5, '末点切线 (3·δ1-0)/2 → c2y=0.5');
const mpLine = core.monotonePath([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]);
close(mpLine.segments[0].c1x, 1 / 3, '单调共线退化为直线 c1x'); close(mpLine.segments[0].c1y, 1 / 3, '单调共线 c1y=y=x');
close(mpLine.segments[0].c2x, 2 / 3, '共线 c2x'); close(mpLine.segments[0].c2y, 2 / 3, '共线 c2y');
const mpH = core.monotonePath([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 3 }]);
close(mpH.segments[0].c2y, 1 - (4 / 3) / 3, '调和平均切线 4/3 → c2y=1-4/9（不过冲）', 1e-9);

/* ==================== 图表几何：周活动图 ==================== */
console.log('== chartGeometry ==');
const W = 351, H = 440, ds = W / 375;
const cg7 = core.chartGeometry(W, H, [0, 10, 5, 20, 13, 7, 16]);
ok(cg7.yMax === 20 && cg7.points.length === 7, '7 点位 / yMax=20');
close(cg7.leftPad, 34 * ds, 'leftPad 34dp'); close(cg7.bottomPad, 22 * ds, 'bottomPad 22dp');
close(cg7.points[0].x, cg7.leftPad, '首点贴左轴');
close(cg7.points[3].y, cg7.topPad, '峰值点贴顶（minutes=yMax）');
close(cg7.points[0].y, cg7.topPad + cg7.chartH, '零值点贴底');
close(cg7.stepX || (cg7.points[1].x - cg7.points[0].x), cg7.chartW / 6, 'x 等距 chartW/(n-1)');
ok(JSON.stringify(cg7.yTicks.map((t) => t.label)) === JSON.stringify(['0m', '5m', '10m', '15m', '20m']), '5 刻度 0m..20m');
close(cg7.yTicks[0].y, cg7.topPad + cg7.chartH, '刻度 0 在底'); close(cg7.yTicks[4].y, cg7.topPad, '刻度 yMax 在顶');
ok(cg7.points.every((p) => p.y >= cg7.topPad - 1e-9 && p.y <= cg7.topPad + cg7.chartH + 1e-9), '点位全部落在绘图区内');
ok(core.chartGeometry(W, H, []).yMax === 4 && core.chartGeometry(W, H, []).points.length === 0, '空数据容错（页面先判空再绘）');
close(core.chartGeometry(W, H, [1]).lineWidth, 2.5 * ds, '线宽 2.5dp');
close(core.chartGeometry(W, H, [1]).dotOuter, 4 * ds, '白圈 4dp'); close(core.chartGeometry(W, H, [1]).dotInner, 3 * ds, '实心 3dp');
close(core.chartGeometry(303, 220, [10], 1).leftPad, 34, '显式 dpScale=1（屏宽/屏宽）时 leftPad=34px（非 W/375 窄幅口径）');
close(core.milestoneGeometry(303, 256, 1).xs[0], 42, 'milestoneGeometry 显式 dpScale=1 时 pad=42px');

/* ==================== 图表几何：里程碑 ==================== */
console.log('== milestoneGeometry ==');
ok(core.milestoneProgress(50) === 0.5 && core.milestoneProgress(150) === 1 && core.milestoneProgress(0) === 0 && core.milestoneProgress(-5) === 0, 'progress 收口 [0,1]');
ok(JSON.stringify(core.milestoneReached(21.1)) === JSON.stringify([true, true, true, false, false]), '21.1km 达半马（含等于）');
ok(JSON.stringify(core.milestoneReached(0.9)) === JSON.stringify([false, false, false, false, false]), '0.9km 全未达');
ok(JSON.stringify(core.milestoneReached(1.0)) === JSON.stringify([true, false, false, false, false]), '1.0km 恰达起步');
ok(JSON.stringify(core.milestoneReached(109)) === JSON.stringify([true, true, true, true, true]), '满程后全达');
ok(JSON.stringify(core.milestoneKmTexts()) === JSON.stringify(['1.0km', '5.0km', '21.1km', '42.2km', '100.0km']), 'km 档位标签');
const geo = core.milestoneGeometry(351, 256);
close(geo.xs[0], 42 * (351 / 375), 'xs[0]=pad 42dp'); close(geo.xs[4], 351 - 42 * (351 / 375), 'xs[4]=W-pad');
close(geo.xs[1] - geo.xs[0], geo.xs[4] - geo.xs[3], '节点等距');
close(geo.ys[0], 256 * 0.52 + 256 * 0.1, 'ys[0]=base+amp'); close(geo.ys[1], 256 * 0.52 - 256 * 0.1, 'ys[1]=base-amp');
close(geo.ys[2], 256 * 0.52 + 256 * 0.1 * 0.7, 'ys[2]=base+0.7amp'); close(geo.ys[3], 256 * 0.52 - 256 * 0.1 * 0.9, 'ys[3]=base-0.9amp');
close(geo.ys[4], 256 * 0.52 + 256 * 0.1 * 0.5, 'ys[4]=base+0.5amp');
close(geo.nodeRadius, 6 * (351 / 375), '节点半径 6dp'); close(geo.dash[1], 9 * (351 / 375), '虚线间隔 9dp');
const fp = core.milestoneFlagPoints(10, 20, geo);
close(fp[1].y, 20 - geo.nodeRadius - 11 * (351 / 375), '旗顶 y-r-11dp');
close(fp[2].x, 10 + 9 * (351 / 375), '旗右 x+9dp'); close(fp[2].y, 20 - geo.nodeRadius - 7.5 * (351 / 375), '旗腰 y-r-7.5dp');
close(fp[3].y, 20 - geo.nodeRadius - 4.5 * (351 / 375), '旗底 y-r-4.5dp');
const pulseMid = core.milestonePulsePoint(50, geo, 0.5);
close(pulseMid.x, geo.xs[2], '脉冲 50km 落第 3 节点（t=0）'); close(pulseMid.y, geo.ys[2], '脉冲 y 同步');
close(pulseMid.radius, geo.nodeRadius + 2 * (351 / 375) + 6 * (351 / 375) * 0.5, '脉冲半径 r+2dp+6dp·p');
close(pulseMid.alpha, 0.5 - 0.35 * 0.5, '脉冲透明度 0.5-0.35p');
const pulse10 = core.milestonePulsePoint(10, geo, 0);
close(pulse10.x, geo.xs[0] + (geo.xs[1] - geo.xs[0]) * 0.4, '10km(ratio 0.1) 落段内 t=0.4');
ok(core.milestonePulsePoint(100, geo, 0.5) === null && core.milestonePulsePoint(109, geo, 0.5) === null, '满程不显示脉冲');
ok(core.milestonePulsePoint(0, geo, 0.5) === null && core.milestonePulsePoint(-1, geo, 0.5) === null, '零/负不显示脉冲');

/* ==================== 平滑路径测量与裁剪 ==================== */
console.log('== quadMidPath / 折线裁剪 ==');
const qp = core.quadMidPath([0, 1, 2], [0, 1, 0]);
ok(qp.start.x === 0 && qp.start.y === 0 && qp.end.x === 2 && qp.end.y === 0, '中点法首末节点');
ok(qp.quads.length === 2 && qp.quads[0].cx === 0 && qp.quads[0].x === 0.5 && qp.quads[0].y === 0.5, 'quad0 控制点=前节点、终点=中点');
ok(qp.quads[1].cx === 1 && qp.quads[1].cy === 1 && qp.quads[1].x === 1.5, 'quad1 同口径');
ok(core.quadMidPath([], []).start === null && core.quadMidPath([5], [7]).quads.length === 0, '空/单点容错');
const sp = core.sampleQuadPath(qp, 4);
ok(sp.length === 1 + 2 * 4 + 1 && sp[0].x === qp.start.x && sp[sp.length - 1].x === qp.end.x, '采样含首末、逐段衔接');
const spFlat = core.sampleQuadPath(core.quadMidPath([0, 2], [0, 0]), 8);
ok(spFlat.every((p) => Math.abs(p.y) < 1e-9), '共线控制点采样退化为直线');
ok(core.sampleQuadPath(null).length === 0, '空路径采样容错');
ok(core.polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]) === 5, '折线长 3-4-5');
close(core.polylineLength([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]), 2, '折线累加');
ok(core.polylineLength([]) === 0 && core.polylineLength([{ x: 1, y: 1 }]) === 0, '空/单点长 0');
ok(core.clipPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.5).length === 2 &&
   core.clipPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.5)[1].x === 5, '单段中点裁剪');
const cp = core.clipPolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], 0.75);
ok(cp.length === 3 && cp[1].x === 1 && cp[2].x === 1 && cp[2].y === 0.5, '跨段裁剪终点插值');
const cpV = core.clipPolyline([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], 0.5);
ok(cpV.length === 2 && cpV[1].x === 2 && cpV[1].y === 0, '恰落顶点不重复');
const full = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
ok(core.clipPolyline(full, 1).length === 2 && core.clipPolyline(full, 2).length === 2, 'ratio>=1 全量副本');
ok(core.clipPolyline(full, 0).length === 0 && core.clipPolyline(full, -1).length === 0, 'ratio<=0 → 空');
ok(core.clipPolyline([{ x: 1, y: 1 }, { x: 1, y: 1 }], 0.5).length === 2, '零长折线原样返回');
const road = core.sampleQuadPath(core.quadMidPath(geo.xs, geo.ys), 64);
close(core.polylineLength(core.clipPolyline(road, 1)), core.polylineLength(road), '裁剪 ratio=1 等长');
ok(core.clipPolyline(road, 0.5).length >= 2 && core.clipPolyline(road, 0.5).length <= road.length, '半程裁剪点数界');

/* ==================== 头像裁剪参数（cropSquareJpeg 等价） ==================== */
(function () {
  console.log('\n== 头像裁剪参数 ==');
  const r1 = core.avatarCropRect(1080, 1920, 512);
  ok(r1 && r1.sSide === 1080 && r1.sx === 0 && r1.sy === 420 && r1.dSide === 512,
    '竖图 1080×1920：居中取 1080 方形（sy=420）并下采样 512');
  const r2 = core.avatarCropRect(300, 200, 512);
  ok(r2 && r2.sSide === 200 && r2.sx === 50 && r2.sy === 0 && r2.dSide === 200,
    '小图 300×200：居中取 200 方形，≤512 不放大');
  const r3 = core.avatarCropRect(1024, 1024, 512);
  ok(r3 && r3.sx === 0 && r3.sy === 0 && r3.dSide === 512, '正方形图：零偏移 + 恰下采样');
  ok(core.avatarCropRect(0, 100, 512) === null && core.avatarCropRect(-5, 'x', 512) === null,
    '非法尺寸 → null（调用方静默保持原图）');
  const r4 = core.avatarCropRect(1000, 1000);
  ok(r4 && r4.dSide === 512, 'maxDim 缺省 512');
})();

console.log('\n========== 个人中心核心逻辑测试：' + passed + ' 通过 / ' + failed + ' 失败 ==========');
process.exit(failed ? 1 : 0);
